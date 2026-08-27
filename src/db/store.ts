import Database from 'better-sqlite3';
import path from 'node:path';
import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import type { Anchor, AnchorDraft, ConversationContext, Note, RecentDocument, Rect } from '../shared';

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
