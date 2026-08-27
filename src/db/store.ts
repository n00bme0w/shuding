import Database from 'better-sqlite3';
import path from 'node:path';
import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import type { Anchor, AnchorDraft, Note, RecentDocument, Rect } from '../shared';

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

function migrate(database: Database.Database) {
  const alreadyApplied = database
    .prepare('select version from schemaMigrations where version = @version')
    .get({ version: 1 }) as { version: number } | undefined;
  if (alreadyApplied) {
    return;
  }

  database.transaction(() => {
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
    database.prepare(
      'insert into schemaMigrations (version, appliedAt) values (@version, @appliedAt)'
    ).run({ version: 1, appliedAt: new Date().toISOString() });
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
