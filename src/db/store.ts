import Database from 'better-sqlite3';
import path from 'node:path';
import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import type { Anchor, AnchorDraft, ConversationContext, Note, ReadingState, RecentDocument, Rect, SaveReadingStateInput } from '../shared';

let db: Database.Database | null = null;

function getDb() {
  if (db) {
    return db;
  }

  const dir = app.getPath('userData');
  const file = path.join(dir, 'shuding.sqlite3');
  db = new Database(file);
  db.exec(`
    pragma foreign_keys = on;
    create table if not exists schemaMigrations (
      version integer primary key,
      appliedAt text not null
    );
    create table if not exists anchors (
      id text primary key,
      documentId text not null,
      pageIndex integer not null,
      kind text not null,
      quote text not null,
      normalizedQuote text not null,
      pageRect text not null,
      normalizedRect text not null,
      confidence real,
      createdAt text not null,
      updatedAt text not null
    );
    create table if not exists notes (
      id text primary key,
      anchorId text not null references anchors(id) on delete cascade,
      body text not null,
      createdAt text not null,
      updatedAt text not null
    );
    create table if not exists recentDocuments (
      id text primary key,
      path text not null unique,
      name text not null,
      fingerprint text not null unique,
      openedAt text not null
    );
    create index if not exists recentDocuments_openedAt_idx on recentDocuments (openedAt desc);
  `);
  migrate(db);

  return db;
}

const MIGRATIONS: ReadonlyArray<{ version: number; up: (database: Database.Database) => void }> = [
  {
    version: 1,
    up(database) {
      database.exec(`
        create table if not exists aiSettings (
          id integer primary key check (id = 1),
          baseUrl text not null,
          modelId text not null,
          encryptedApiKey text,
          updatedAt text not null
        );
        create table if not exists conversations (
          id text primary key,
          anchorId text not null unique references anchors(id) on delete cascade,
          createdAt text not null,
          updatedAt text not null
        );
        create table if not exists conversationMessages (
          id text primary key,
          conversationId text not null references conversations(id) on delete cascade,
          role text not null check (role in ('user', 'assistant', 'toolResult')),
          content text not null,
          toolName text,
          createdAt text not null,
          payload text not null
        );
        create index if not exists conversationMessages_conversationId_createdAt_idx
          on conversationMessages (conversationId, createdAt);
      `);
    }
  },
  {
    version: 2,
    up(database) {
      // v1 left unused conversation tables whose schema (anchorId NOT NULL) cannot
      // represent ephemeral-selection contexts. Replace them with a durable,
      // context-aware conversations table used to persist session transcripts.
      database.exec(`
        drop table if exists conversationMessages;
        drop table if exists conversations;
        create table if not exists conversations (
          id text primary key,
          documentFingerprint text not null,
          contextKind text not null,
          anchorId text,
          contextJson text not null,
          sourceJson text not null,
          quote text not null,
          pageIndex integer not null,
          messagesJson text not null,
          lastUsedAt text not null,
          createdAt text not null,
          updatedAt text not null
        );
        create index if not exists conversations_document_lastused_idx
          on conversations (documentFingerprint, lastUsedAt desc);
      `);
    }
  },
  {
    version: 3,
    up(database) {
      database.exec(`
        create table if not exists readingStates (
          documentFingerprint text primary key,
          scale real not null,
          currentPage integer not null,
          scrollTop real not null default 0,
          updatedAt text not null
        );
        create index if not exists readingStates_updatedAt_idx
          on readingStates (updatedAt desc);
      `);
    }
  },
  {
    version: 4,
    up(database) {
      const columns = database.prepare('pragma table_info(readingStates)').all() as Array<{ name: string }>;
      const hasScrollTop = columns.some((column) => column.name === 'scrollTop');
      if (!hasScrollTop) {
        database.exec('alter table readingStates add column scrollTop real not null default 0;');
      }
    }
  },
  {
    version: 5,
    up(database) {
      // Enforce one conversation per saved anchor for the Plan-A (quote as axis)
      // invariant. Partial unique index so ephemeral-selection rows (anchorId NULL)
      // coexist freely.
      database.transaction(() => {
        // Drop orphaned saved-anchor rows with no bound anchor.
        database.exec(`
          delete from conversations
          where contextKind = 'saved-anchor'
            and (anchorId is null or anchorId = '');
        `);

        // Keep only the most recently used row per anchorId so the 1:1 index holds.
        const duplicates = database.prepare(`
          select anchorId
          from conversations
          where anchorId is not null and anchorId != ''
          group by anchorId
          having count(*) > 1
        `).all() as Array<{ anchorId: string }>;
        if (duplicates.length > 0) {
          const listConversations = database.prepare(`
            select id, lastUsedAt
            from conversations
            where anchorId = @anchorId
            order by lastUsedAt desc, id desc
          `);
          const deleteRow = database.prepare('delete from conversations where id = @id');
          for (const row of duplicates) {
            const candidates = listConversations.all({ anchorId: row.anchorId }) as Array<{ id: string }>;
            for (const candidate of candidates.slice(1)) {
              deleteRow.run({ id: candidate.id });
            }
          }
        }

        database.exec(`
          create unique index if not exists conversations_anchor_unique
            on conversations (anchorId)
            where anchorId is not null and anchorId != '';
        `);
      })();
    }
  },
  {
    version: 6,
    up(database) {
      database.exec(`
        create table if not exists documentChunks (
          id text primary key,
          documentFingerprint text not null,
          pageIndex integer not null,
          chunkIndex integer not null,
          text text not null,
          createdAt text not null,
          unique(documentFingerprint, pageIndex, chunkIndex)
        );
        create index if not exists documentChunks_document_idx
          on documentChunks (documentFingerprint, pageIndex);
        create virtual table if not exists documentChunksFts using fts5(
          text,
          content='documentChunks',
          content_rowid='rowid'
        );
      `);
      database.exec(`
        insert into documentChunksFts(rowid, text)
        select rowid, text from documentChunks
        where rowid not in (select rowid from documentChunksFts);
      `);
    }
  },
  {
    version: 7,
    up(database) {
      database.exec(`
        create table if not exists bookIndexes (
          documentFingerprint text primary key,
          status text not null check (status in ('building', 'ready', 'declined')),
          chunkCount integer not null default 0,
          updatedAt text not null
        );
      `);
    }
  },
  {
    version: 8,
    up(database) {
      database.exec('alter table readingStates add column pageOffset real;');
    }
  }
];

function migrate(database: Database.Database) {
  const applied = database.prepare('select version from schemaMigrations order by version').all() as Array<{ version: number }>;
  const appliedVersions = new Set(applied.map((row) => row.version));

  database.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }
      migration.up(database);
      database.prepare(
        'insert into schemaMigrations (version, appliedAt) values (@version, @appliedAt)'
      ).run({ version: migration.version, appliedAt: new Date().toISOString() });
    }
  })();
}

type StoredRecentDocument = Omit<RecentDocument, 'unavailable'> & {
  path: string;
};

export function upsertRecentDocument(document: Omit<StoredRecentDocument, 'openedAt' | 'id'>) {
  const database = getDb();
  const openedAt = new Date().toISOString();
  const id = randomUUID();
  database.transaction(() => {
    const existing = database
      .prepare(
        `select id
         from recentDocuments
         where fingerprint = @fingerprint or path = @path
         order by openedAt desc
         limit 1`
      )
      .get(document) as { id: string } | undefined;

    if (existing) {
      database.prepare(
        `delete from recentDocuments
         where (path = @path or fingerprint = @fingerprint) and id != @id`
      ).run({ ...document, id: existing.id });
      database.prepare(
        `update recentDocuments
         set path = @path, name = @name, fingerprint = @fingerprint, openedAt = @openedAt
         where id = @id`
      ).run({ id: existing.id, ...document, openedAt });
      return;
    }

    database.prepare(
      `insert into recentDocuments (id, path, name, fingerprint, openedAt)
       values (@id, @path, @name, @fingerprint, @openedAt)`
    ).run({ id, ...document, openedAt });
  })();

  const saved = getRecentDocumentByFingerprint(document.fingerprint);
  return withoutPath(saved);
}

function withoutPath(document: StoredRecentDocument): RecentDocument {
  const { path: _path, ...safeDocument } = document;
  return safeDocument;
}

export function listRecentDocuments(limit: number): RecentDocument[] {
  const database = getDb();
  const boundedLimit = Math.max(0, Math.min(Math.floor(limit), 50));
  const rows = database
    .prepare(
      `select id, path, name, fingerprint, openedAt
       from recentDocuments
       order by openedAt desc
       limit @limit`
    )
    .all({ limit: boundedLimit }) as StoredRecentDocument[];
  return rows.map(withoutPath);
}

export function getRecentDocumentById(id: string): StoredRecentDocument | null {
  const database = getDb();
  const row = database
    .prepare(
      `select id, path, name, fingerprint, openedAt
       from recentDocuments
       where id = @id`
    )
    .get({ id }) as StoredRecentDocument | undefined;
  return row ?? null;
}

function getRecentDocumentByFingerprint(fingerprint: string): StoredRecentDocument {
  const database = getDb();
  const row = database
    .prepare(
      `select id, path, name, fingerprint, openedAt
       from recentDocuments
       where fingerprint = @fingerprint`
    )
    .get({ fingerprint }) as StoredRecentDocument | undefined;
  if (!row) {
    throw new Error('Recent document was not persisted');
  }
  return row;
}

type StoredAnchor = Omit<Anchor, 'pageRect' | 'normalizedRect'> & {
  pageRect: string;
  normalizedRect: string;
};

function isRect(value: unknown): value is Rect {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const rect = value as Record<string, unknown>;
  return (
    typeof rect.x === 'number' &&
    typeof rect.y === 'number' &&
    typeof rect.width === 'number' &&
    typeof rect.height === 'number'
  );
}

function parseRect(value: string, field: string): Rect {
  const parsed: unknown = JSON.parse(value);
  if (!isRect(parsed)) {
    throw new Error(`Invalid ${field} stored in anchors`);
  }
  return parsed;
}

function hydrateAnchor(row: StoredAnchor): Anchor {
  return {
    ...row,
    pageRect: parseRect(row.pageRect, 'pageRect'),
    normalizedRect: parseRect(row.normalizedRect, 'normalizedRect')
  };
}

export function saveAnchor(anchor: Anchor) {
  const database = getDb();
  database.prepare(
    `insert into anchors (
      id, documentId, pageIndex, kind, quote, normalizedQuote,
      pageRect, normalizedRect, confidence, createdAt, updatedAt
    ) values (
      @id, @documentId, @pageIndex, @kind, @quote, @normalizedQuote,
      @pageRect, @normalizedRect, @confidence, @createdAt, @updatedAt
    )`
  ).run({
    ...anchor,
    pageRect: JSON.stringify(anchor.pageRect),
    normalizedRect: JSON.stringify(anchor.normalizedRect),
    confidence: anchor.confidence ?? null
  });
}

export function deleteAnchor(anchorId: string) {
  const database = getDb();
  database.prepare('delete from anchors where id = @anchorId').run({ anchorId });
}

export function deleteNote(noteId: string) {
  const database = getDb();
  database.prepare('delete from notes where id = @noteId').run({ noteId });
}

export function getAnchorsByDocumentId(documentId: string): Anchor[] {
  const database = getDb();
  const rows = database
    .prepare(
      `select id, documentId, pageIndex, kind, quote, normalizedQuote, pageRect, normalizedRect, confidence, createdAt, updatedAt
       from anchors
       where documentId = @documentId
       order by pageIndex asc, createdAt asc`
    )
    .all({ documentId }) as StoredAnchor[];

  return rows.map(hydrateAnchor);
}

export function getAnchorById(anchorId: string): Anchor | null {
  const database = getDb();
  const row = database
    .prepare(
      `select id, documentId, pageIndex, kind, quote, normalizedQuote, pageRect, normalizedRect, confidence, createdAt, updatedAt
       from anchors
       where id = @anchorId`
    )
    .get({ anchorId }) as StoredAnchor | undefined;
  return row ? hydrateAnchor(row) : null;
}

export function createAnchor(draft: AnchorDraft): Anchor {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    ...draft,
    createdAt: now,
    updatedAt: now
  };
}

export function saveNote(anchorId: string, body: string): Note {
  const database = getDb();
  const now = new Date().toISOString();
  const note: Note = {
    id: randomUUID(),
    anchorId,
    body,
    createdAt: now,
    updatedAt: now
  };

  database.prepare(
    `insert into notes (id, anchorId, body, createdAt, updatedAt)
     values (@id, @anchorId, @body, @createdAt, @updatedAt)`
  ).run(note);

  return note;
}

export function getNotesByAnchorIds(anchorIds: string[]): Note[] {
  if (anchorIds.length === 0) {
    return [];
  }

  const database = getDb();
  const placeholders = anchorIds.map((_, index) => `@anchorId${index}`);
  const parameters = Object.fromEntries(
    anchorIds.map((anchorId, index) => [`anchorId${index}`, anchorId])
  );
  return database
    .prepare(
      `select id, anchorId, body, createdAt, updatedAt
       from notes
       where anchorId in (${placeholders.join(', ')})
       order by createdAt asc`
    )
    .all(parameters) as Note[];
}

export type StoredAiSettings = {
  baseUrl: string;
  modelId: string;
  encryptedApiKey: string | null;
};

export function getAiSettings(): StoredAiSettings | null {
  const database = getDb();
  return (database.prepare(
    'select baseUrl, modelId, encryptedApiKey from aiSettings where id = 1'
  ).get() as StoredAiSettings | undefined) ?? null;
}

export function saveAiSettings(settings: StoredAiSettings) {
  const database = getDb();
  database.prepare(
    `insert into aiSettings (id, baseUrl, modelId, encryptedApiKey, updatedAt)
     values (1, @baseUrl, @modelId, @encryptedApiKey, @updatedAt)
     on conflict(id) do update set
       baseUrl = excluded.baseUrl,
       modelId = excluded.modelId,
       encryptedApiKey = excluded.encryptedApiKey,
       updatedAt = excluded.updatedAt`
  ).run({ ...settings, updatedAt: new Date().toISOString() });
}

export type StoredConversation = {
  id: string;
  documentFingerprint: string;
  contextKind: ConversationContext['kind'];
  anchorId: string | null;
  contextJson: string;
  sourceJson: string;
  quote: string;
  pageIndex: number;
  messagesJson: string;
  lastUsedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ConversationPersist = {
  id: string;
  documentFingerprint: string;
  context: ConversationContext;
  source: { quote: string; pageIndex: number; kind: string; documentFingerprint: string };
  messages: unknown[];
  lastUsedAt: number;
};

export function saveConversation(conversation: ConversationPersist) {
  const database = getDb();
  const now = new Date().toISOString();
  const stored: StoredConversation = {
    id: conversation.id,
    documentFingerprint: conversation.documentFingerprint,
    contextKind: conversation.context.kind,
    anchorId: conversation.context.kind === 'saved-anchor' ? conversation.context.anchorId : null,
    contextJson: JSON.stringify(conversation.context),
    sourceJson: JSON.stringify(conversation.source),
    quote: conversation.source.quote,
    pageIndex: conversation.source.pageIndex,
    messagesJson: JSON.stringify(conversation.messages),
    lastUsedAt: new Date(conversation.lastUsedAt).toISOString(),
    createdAt: now,
    updatedAt: now
  };
  database.prepare(
    `insert into conversations (
      id, documentFingerprint, contextKind, anchorId, contextJson, sourceJson,
      quote, pageIndex, messagesJson, lastUsedAt, createdAt, updatedAt
    ) values (
      @id, @documentFingerprint, @contextKind, @anchorId, @contextJson, @sourceJson,
      @quote, @pageIndex, @messagesJson, @lastUsedAt, @createdAt, @updatedAt
    )
    on conflict(id) do update set
      contextKind = excluded.contextKind,
      anchorId = excluded.anchorId,
      contextJson = excluded.contextJson,
      sourceJson = excluded.sourceJson,
      quote = excluded.quote,
      pageIndex = excluded.pageIndex,
      messagesJson = excluded.messagesJson,
      lastUsedAt = excluded.lastUsedAt,
      updatedAt = excluded.updatedAt`
  ).run(stored);
}

export function getConversation(id: string): StoredConversation | null {
  const database = getDb();
  return database.prepare(
    `select id, documentFingerprint, contextKind, anchorId, contextJson, sourceJson,
            quote, pageIndex, messagesJson, lastUsedAt, createdAt, updatedAt
     from conversations
     where id = @id`
  ).get({ id }) as StoredConversation | undefined ?? null;
}

export function listConversationsByDocument(documentFingerprint: string, limit: number): StoredConversation[] {
  const database = getDb();
  const boundedLimit = Math.max(0, Math.min(Math.floor(limit), 50));
  return database.prepare(
    `select id, documentFingerprint, contextKind, anchorId, contextJson, sourceJson,
            quote, pageIndex, messagesJson, lastUsedAt, createdAt, updatedAt
     from conversations
     where documentFingerprint = @documentFingerprint
     order by lastUsedAt desc
     limit @limit`
  ).all({ documentFingerprint, limit: boundedLimit }) as StoredConversation[];
}

export function deleteConversation(id: string) {
  const database = getDb();
  database.prepare('delete from conversations where id = @id').run({ id });
}

export type StoredReadingState = {
  documentFingerprint: string;
  scale: number;
  currentPage: number;
  scrollTop: number;
  pageOffset: number | null;
  updatedAt: string;
};

export function saveReadingState(state: SaveReadingStateInput): ReadingState {
  const database = getDb();
  const updatedAt = new Date().toISOString();
  database.prepare(
    `insert into readingStates (documentFingerprint, scale, currentPage, scrollTop, pageOffset, updatedAt)
     values (@documentFingerprint, @scale, @currentPage, @scrollTop, @pageOffset, @updatedAt)
     on conflict(documentFingerprint) do update set
       scale = excluded.scale,
       currentPage = excluded.currentPage,
       scrollTop = excluded.scrollTop,
       pageOffset = excluded.pageOffset,
       updatedAt = excluded.updatedAt`
  ).run({ ...state, pageOffset: state.pageOffset ?? null, updatedAt });
  return state;
}

export function getReadingState(documentFingerprint: string): ReadingState | null {
  const database = getDb();
  const row = database.prepare(
    'select documentFingerprint, scale, currentPage, scrollTop, pageOffset from readingStates where documentFingerprint = @documentFingerprint'
  ).get({ documentFingerprint }) as Pick<StoredReadingState, 'documentFingerprint' | 'scale' | 'currentPage' | 'scrollTop' | 'pageOffset'> | undefined;
  return row ? {
    documentFingerprint: row.documentFingerprint,
    scale: row.scale,
    currentPage: row.currentPage,
    scrollTop: row.scrollTop,
    ...(row.pageOffset === null ? {} : { pageOffset: row.pageOffset })
  } : null;
}

export type DocumentChunk = {
  id: string;
  documentFingerprint: string;
  pageIndex: number;
  chunkIndex: number;
  text: string;
};

export type BookIndexStatus = 'building' | 'ready' | 'declined' | 'missing';

export function getBookIndexStatus(documentFingerprint: string): BookIndexStatus {
  const database = getDb();
  const row = database.prepare('select status from bookIndexes where documentFingerprint = @documentFingerprint').get({ documentFingerprint }) as { status: Exclude<BookIndexStatus, 'missing'> } | undefined;
  return row?.status ?? 'missing';
}

export function saveBookIndexStatus(documentFingerprint: string, status: Exclude<BookIndexStatus, 'missing'>, chunkCount = 0) {
  const database = getDb();
  database.prepare(`
    insert into bookIndexes (documentFingerprint, status, chunkCount, updatedAt)
    values (@documentFingerprint, @status, @chunkCount, @updatedAt)
    on conflict(documentFingerprint) do update set status = excluded.status, chunkCount = excluded.chunkCount, updatedAt = excluded.updatedAt
  `).run({ documentFingerprint, status, chunkCount, updatedAt: new Date().toISOString() });
}

export function resetBookIndexStatus(documentFingerprint: string) {
  const database = getDb();
  database.prepare('delete from bookIndexes where documentFingerprint = @documentFingerprint').run({ documentFingerprint });
}

/**
 * A renderer-side index build can be interrupted when Electron is closed.
 * Never leave that book looking permanently "building" on the next launch.
 * Remove any partial rows and let the normal consent flow start a clean build.
 */
export function recoverInterruptedBookIndexes() {
  const database = getDb();
  const interrupted = database.prepare(
    `select documentFingerprint from bookIndexes where status = 'building'`
  ).all() as Array<{ documentFingerprint: string }>;
  if (interrupted.length === 0) return;

  database.transaction(() => {
    for (const { documentFingerprint } of interrupted) {
      database.prepare(
        `delete from documentChunksFts
         where rowid in (select rowid from documentChunks where documentFingerprint = @documentFingerprint)`
      ).run({ documentFingerprint });
      database.prepare('delete from documentChunks where documentFingerprint = @documentFingerprint').run({ documentFingerprint });
      database.prepare('delete from bookIndexes where documentFingerprint = @documentFingerprint').run({ documentFingerprint });
    }
  })();
}

export type BookSearchResult = DocumentChunk & { score: number };

export function replaceDocumentChunks(documentFingerprint: string, chunks: Array<Omit<DocumentChunk, 'id'>>) {
  const database = getDb();
  const insert = database.prepare(`
    insert into documentChunks (id, documentFingerprint, pageIndex, chunkIndex, text, createdAt)
    values (@id, @documentFingerprint, @pageIndex, @chunkIndex, @text, @createdAt)
  `);
  const insertFts = database.prepare('insert into documentChunksFts(rowid, text) select rowid, text from documentChunks where id = @id');
  database.transaction(() => {
    database.prepare('delete from documentChunksFts where rowid in (select rowid from documentChunks where documentFingerprint = @documentFingerprint)').run({ documentFingerprint });
    database.prepare('delete from documentChunks where documentFingerprint = @documentFingerprint').run({ documentFingerprint });
    const createdAt = new Date().toISOString();
    for (const chunk of chunks) {
      const id = randomUUID();
      insert.run({ id, ...chunk, createdAt });
      insertFts.run({ id });
    }
    saveBookIndexStatus(documentFingerprint, 'ready', chunks.length);
  })();
}

function searchTerms(query: string) {
  return query.trim().split(/\s+/).map((term) => term.replace(/["()*:^{}[\]]/g, '')).filter(Boolean);
}

export function searchDocumentChunks(documentFingerprint: string, query: string, limit = 8): BookSearchResult[] {
  const database = getDb();
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 20));
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const match = terms.map((term) => `"${term}"`).join(' OR ');
  const ftsRows = database.prepare(`
    select c.id, c.documentFingerprint, c.pageIndex, c.chunkIndex, c.text, bm25(documentChunksFts) as score
    from documentChunksFts
    join documentChunks c on c.rowid = documentChunksFts.rowid
    where documentChunksFts match @match and c.documentFingerprint = @documentFingerprint
    order by score asc
    limit @limit
  `).all({ match, documentFingerprint, limit: boundedLimit }) as BookSearchResult[];
  if (ftsRows.length >= boundedLimit) return ftsRows;
  const likeRows = database.prepare(`
    select id, documentFingerprint, pageIndex, chunkIndex, text, 0 as score
    from documentChunks
    where documentFingerprint = @documentFingerprint
      and (${terms.map((_, index) => `text like @term${index}`).join(' or ')})
    order by pageIndex asc, chunkIndex asc
    limit @limit
  `).all({ documentFingerprint, limit: boundedLimit, ...Object.fromEntries(terms.map((term, index) => [`term${index}`, `%${term}%`])) }) as BookSearchResult[];
  const seen = new Set(ftsRows.map((row) => row.id));
  return [...ftsRows, ...likeRows.filter((row) => !seen.has(row.id))].slice(0, boundedLimit);
}
