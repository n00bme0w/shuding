import { safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import { streamSimple as streamOpenAiCompletions } from '@earendil-works/pi-ai/api/openai-completions';
import { createModels, createProvider, Type, type Model, type Static } from '@earendil-works/pi-ai';
import type {
  AiSettings,
  ConfirmNoteProposalInput,
  ConversationContext,
  ConversationEvent,
  ConversationMessage,
  ConversationSessionSummary,
  ConversationSnapshot,
  FinalizeEphemeralInput,
  FinalizeEphemeralResult,
  PendingNoteProposal,
  SaveAiSettingsInput
} from '../../shared';
import {
  createAnchor,
  deleteAnchor,
  deleteConversation,
  deleteNote,
  getAiSettings,
  getBookIndexStatus,
  getAnchorById,
  getNotesByAnchorIds,
  listConversationsByDocument,
  searchDocumentChunks,
  saveAiSettings,
  saveAnchor,
  saveConversation,
  saveNote,
  type StoredConversation
} from '../../db/store';

const PROVIDER_ID = 'shuding-openai-compatible';
const MAX_MESSAGE_LENGTH = 8_000;
const MAX_TOOL_OUTPUT_LENGTH = 6_000;
const MAX_SESSIONS_PER_DOCUMENT = 10;
const PROPOSAL_TTL_MS = 15 * 60 * 1_000;

type ConversationOwner = { webContentsId: number; emit: (event: ConversationEvent) => void };
type ActiveConversation = {
  agent: Agent;
  settlement: Promise<void>;
  resolveSettlement: () => void;
};
type ProposalRecord = PendingNoteProposal & { ownerWebContentsId: number };
type Session = {
  id: string;
  context: ConversationContext;
  documentFingerprint: string;
  source: { quote: string; pageIndex: number; kind: string; documentFingerprint: string };
  owner: ConversationOwner;
  messages: AgentMessage[];
  lastUsedAt: number;
  status: 'running' | 'idle';
  removed: boolean;
};

const activeConversations = new Map<string, ActiveConversation>();
const sessions = new Map<string, Session>();
const sessionsByDocument = new Map<string, Set<string>>();
const proposals = new Map<string, ProposalRecord>();
const discarding = new Map<string, Promise<void>>();
const documentMutations = new Map<string, Promise<void>>();

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n[truncated]`;
}

function requireText(value: unknown, field: string, maxLength = MAX_MESSAGE_LENGTH) {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) throw new Error(`Invalid ${field}`);
  return trimmed;
}

function validateBaseUrl(value: unknown) {
  const baseUrl = requireText(value, 'base URL', 1_000).replace(/\/$/, '');
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new Error('Base URL must be a valid URL'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Base URL must use http or https');
  return baseUrl;
}

function safeSettings(): AiSettings {
  const saved = getAiSettings();
  return {
    baseUrl: saved?.baseUrl ?? '',
    modelId: saved?.modelId ?? '',
    hasApiKey: Boolean(saved?.encryptedApiKey),
    keyStorageAvailable: safeStorage.isEncryptionAvailable(),
    keyStorageBackend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'system'
  };
}

function getApiKey() {
  const saved = getAiSettings();
  if (!saved?.encryptedApiKey) throw new Error('Configure an API key before starting a conversation');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this device');
  return safeStorage.decryptString(Buffer.from(saved.encryptedApiKey, 'base64'));
}

function messageText(message: AgentMessage) {
  if (message.role === 'user') return typeof message.content === 'string' ? message.content : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
  if (message.role !== 'assistant' && message.role !== 'toolResult') return '';
  return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
}

function toConversationMessages(messages: AgentMessage[]): ConversationMessage[] {
  return messages
    .filter((message): message is Extract<AgentMessage, { role: 'user' | 'assistant' | 'toolResult' }> => message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult')
    .map((message) => ({ id: randomUUID(), role: message.role, content: truncate(messageText(message), MAX_MESSAGE_LENGTH), toolName: message.role === 'toolResult' ? message.toolName : undefined, createdAt: new Date(message.timestamp).toISOString() }));
}

function documentFingerprint(context: ConversationContext) {
  if (context.kind === 'ephemeral-selection') return context.selection.documentFingerprint;
  if (context.kind === 'document') return context.documentFingerprint;
  const anchor = getAnchorById(context.anchorId);
  if (!anchor) throw new Error('Anchor not found');
  if (context.selection && context.selection.documentFingerprint !== anchor.documentId) throw new Error('Selection does not belong to the anchor document');
  return anchor.documentId;
}

function contextForTool(context: ConversationContext) {
  if (context.kind === 'ephemeral-selection') return { ...context.selection, kind: 'text' };
  if (context.kind === 'document') return { quote: 'Whole document conversation', pageIndex: 0, kind: 'document', documentFingerprint: context.documentFingerprint };
  if (context.selection) return { ...context.selection, kind: 'text' };
  const anchor = getAnchorById(context.anchorId);
  if (!anchor) throw new Error('Anchor no longer exists');
  return { quote: anchor.quote, pageIndex: anchor.pageIndex, kind: anchor.kind, documentFingerprint: anchor.documentId };
}

function mutateDocument<T>(documentId: string, operation: () => Promise<T>): Promise<T> {
  const previous = documentMutations.get(documentId) ?? Promise.resolve();
  const mutation = previous.then(operation, operation);
  const cleanup = mutation.then(() => undefined, () => undefined);
  documentMutations.set(documentId, cleanup);
  void cleanup.finally(() => {
    if (documentMutations.get(documentId) === cleanup) documentMutations.delete(documentId);
  });
  return mutation;
}

const anchorSchema = Type.Object({ anchor: Type.String({ minLength: 1, maxLength: 128 }) });
const proposalSchema = Type.Object({ anchor: Type.String({ minLength: 1, maxLength: 128 }), summary: Type.String({ minLength: 1, maxLength: 2_000 }) });
const bookSearchSchema = Type.Object({ anchor: Type.String({ minLength: 1, maxLength: 128 }), query: Type.String({ minLength: 1, maxLength: 1_000 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) });
const bookIndexSchema = Type.Object({ anchor: Type.String({ minLength: 1, maxLength: 128 }) });
const navigatePageSchema = Type.Object({
  anchor: Type.String({ minLength: 1, maxLength: 128 }),
  page: Type.Integer({ minimum: 1, maximum: 100_000 }),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  quote: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 }))
});
const autoAnchorSchema = Type.Object({
  anchor: Type.String({ minLength: 1, maxLength: 128 }),
  page: Type.Integer({ minimum: 1, maximum: 100_000 }),
  quote: Type.String({ minLength: 8, maxLength: 1_000 })
});
type AnchorParams = Static<typeof anchorSchema>;
type BookSearchParams = Static<typeof bookSearchSchema>;
type BookIndexParams = Static<typeof bookIndexSchema>;
type NavigatePageParams = Static<typeof navigatePageSchema>;
type AutoAnchorParams = Static<typeof autoAnchorSchema>;

function getLiveSession(conversationId: string, ownerWebContentsId?: number) {
  const session = sessions.get(conversationId);
  if (!session || session.removed || (ownerWebContentsId !== undefined && session.owner.webContentsId !== ownerWebContentsId)) return null;
  return session;
}

function touch(session: Session) { session.lastUsedAt = Date.now(); }

function persistSession(session: Session) {
  const context = session.context.kind === 'document'
    ? { kind: 'document' as const, documentFingerprint: session.context.documentFingerprint }
    : session.context;
  saveConversation({ id: session.id, documentFingerprint: session.documentFingerprint, context, source: session.source, messages: session.messages, lastUsedAt: session.lastUsedAt });
}

function hydrateSession(stored: StoredConversation, owner: ConversationOwner): Session {
  const context = JSON.parse(stored.contextJson) as ConversationContext;
  const source = JSON.parse(stored.sourceJson) as Session['source'];
  return {
    id: stored.id,
    context,
    documentFingerprint: stored.documentFingerprint,
    source,
    owner,
    messages: JSON.parse(stored.messagesJson) as AgentMessage[],
    lastUsedAt: new Date(stored.lastUsedAt).getTime(),
    status: 'idle',
    removed: false
  };
}

function loadSessionsForDocument(documentId: string, webContentsId: number) {
  if (sessionsByDocument.has(documentId)) {
    return;
  }
  const owner: ConversationOwner = { webContentsId, emit: () => {} };
  const storedSessions = listConversationsByDocument(documentId, MAX_SESSIONS_PER_DOCUMENT);
  for (const stored of storedSessions) {
    if (sessions.has(stored.id)) {
      continue;
    }
    const session = hydrateSession(stored, owner);
    sessions.set(session.id, session);
    const documentSessions = sessionsByDocument.get(documentId) ?? new Set<string>();
    documentSessions.add(session.id);
    sessionsByDocument.set(documentId, documentSessions);
  }
}

function emitIfLive(session: Session, event: ConversationEvent) {
  if (sessions.get(session.id) === session && !session.removed) session.owner.emit(event);
}

function removeSession(session: Session) {
  if (sessions.get(session.id) !== session) return;
  session.removed = true;
  sessions.delete(session.id);
  const documentSessions = sessionsByDocument.get(session.documentFingerprint);
  documentSessions?.delete(session.id);
  if (documentSessions?.size === 0) sessionsByDocument.delete(session.documentFingerprint);
  proposals.delete(session.id);
}

async function discardSession(session: Session, deleteFromDisk = false) {
  const ongoing = discarding.get(session.id);
  if (ongoing) return ongoing;
  const discard = (async () => {
    session.removed = true;
    proposals.delete(session.id);
    const active = activeConversations.get(session.id);
    if (active) {
      active.agent.abort();
      await active.settlement;
    }
    removeSession(session);
    if (deleteFromDisk) deleteConversation(session.id);
  })();
  discarding.set(session.id, discard);
  try { await discard; } finally { discarding.delete(session.id); }
}

async function makeRoom(documentId: string) {
  const documentSessions = sessionsByDocument.get(documentId);
  if (!documentSessions || documentSessions.size < MAX_SESSIONS_PER_DOCUMENT) return;
  const lru = Array.from(documentSessions, (id) => sessions.get(id)).filter((session): session is Session => Boolean(session)).sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.id.localeCompare(b.id))[0];
  if (lru) await discardSession(lru, true);
}

function pendingFor(session: Session) {
  const proposal = proposals.get(session.id);
  return proposal && proposal.ownerWebContentsId === session.owner.webContentsId && new Date(proposal.expiresAt).getTime() > Date.now() ? proposal : null;
}

function snapshot(session: Session): ConversationSnapshot {
  const proposal = pendingFor(session);
  return { conversationId: session.id, context: session.context, messages: toConversationMessages(session.messages), pendingProposal: proposal ? { id: proposal.id, conversationId: proposal.conversationId, anchorId: proposal.anchorId, body: proposal.body, expiresAt: proposal.expiresAt } : null };
}

function summary(session: Session): ConversationSessionSummary {
  return { conversationId: session.id, documentFingerprint: session.documentFingerprint, contextKind: session.context.kind, quote: session.source.quote, pageIndex: session.source.pageIndex, lastUsedAt: new Date(session.lastUsedAt).toISOString(), status: session.status };
}

function hasMatchingSource(existing: Session, context: ConversationContext) {
  if (existing.context.kind !== 'saved-anchor' || context.kind !== 'saved-anchor' || existing.context.anchorId !== context.anchorId) return false;
  const existingSelection = existing.context.selection;
  const nextSelection = context.selection;
  if (!existingSelection || !nextSelection) return !existingSelection && !nextSelection;
  return existingSelection.documentFingerprint === nextSelection.documentFingerprint && existingSelection.pageIndex === nextSelection.pageIndex && existingSelection.quote === nextSelection.quote && existingSelection.normalizedQuote === nextSelection.normalizedQuote;
}

function findSavedAnchorSession(documentFingerprint: string, anchorId: string, webContentsId: number) {
  return Array.from(sessionsByDocument.get(documentFingerprint) ?? [], (id) => sessions.get(id))
    .find((session) => session && !session.removed && session.owner.webContentsId === webContentsId && session.context.kind === 'saved-anchor' && session.context.anchorId === anchorId) ?? null;
}

function assertValidEphemeralContext(context: Extract<ConversationContext, { kind: 'ephemeral-selection' }>) {
  const selection = context.selection;
  requireText(selection.documentFingerprint, 'document fingerprint', 256);
  requireText(selection.quote, 'selection quote');
  requireText(selection.normalizedQuote, 'normalized selection quote');
  if (!Number.isInteger(selection.pageIndex) || selection.pageIndex < 0) throw new Error('Invalid selection page');
  for (const rect of [selection.pageRect, selection.normalizedRect]) if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) throw new Error('Invalid selection rectangle');
}

function createTools(session: Session): AgentTool[] {
  const assertScope = (params: AnchorParams) => { if (params.anchor !== session.id) throw new Error('This conversation can only access its own context'); };
  const getAnchorContext: AgentTool<typeof anchorSchema, { text: string }> = {
    name: 'get_anchor_context', label: 'Get anchor context', description: 'Get the quote and page context for this conversation. The anchor argument must be the current conversation ID.', parameters: anchorSchema, executionMode: 'sequential',
    async execute(_toolCallId, params) { assertScope(params); const text = truncate(JSON.stringify({ quote: session.source.quote, page: session.source.pageIndex + 1, kind: session.source.kind, documentFingerprint: session.source.documentFingerprint }), MAX_TOOL_OUTPUT_LENGTH); return { content: [{ type: 'text' as const, text }], details: { text } }; }
  };
  const listAnchorNotes: AgentTool<typeof anchorSchema, { text: string }> = {
    name: 'list_anchor_notes', label: 'List anchor notes', description: 'List saved notes for this conversation. Temporary selection conversations have no saved notes.', parameters: anchorSchema, executionMode: 'sequential',
    async execute(_toolCallId, params) { assertScope(params); const notes = session.context.kind === 'saved-anchor' ? getNotesByAnchorIds([session.context.anchorId]).map((note) => note.body) : []; const text = truncate(JSON.stringify({ notes }), MAX_TOOL_OUTPUT_LENGTH); return { content: [{ type: 'text' as const, text }], details: { text } }; }
  };
  const proposeNoteSummary: AgentTool<typeof proposalSchema, { text: string }> = {
    name: 'propose_note_summary', label: 'Propose note summary', description: 'Propose a concise note summary. It is never saved until the user explicitly confirms it in the app.', parameters: proposalSchema, executionMode: 'sequential',
    async execute(_toolCallId, params) { assertScope(params); if (!getLiveSession(session.id, session.owner.webContentsId)) throw new Error('Conversation was discarded'); const proposal: ProposalRecord = { id: randomUUID(), conversationId: session.id, anchorId: session.context.kind === 'saved-anchor' ? session.context.anchorId : undefined, body: params.summary.trim(), expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(), ownerWebContentsId: session.owner.webContentsId }; proposals.set(session.id, proposal); emitIfLive(session, { type: 'proposal', conversationId: session.id, proposal: { id: proposal.id, conversationId: proposal.conversationId, anchorId: proposal.anchorId, body: proposal.body, expiresAt: proposal.expiresAt } }); const text = 'A note proposal is ready for user review. It has not been saved.'; return { content: [{ type: 'text' as const, text }], details: { text } }; }
  };
  const searchBook: AgentTool<typeof bookSearchSchema, { text: string }> = {
    name: 'search_book',
    label: 'Search book',
    description: 'Search the current PDF using a small local index. Use this when the user asks where a definition, theorem, or concept appears. Search results include page numbers and short source passages; do not pretend the entire book was provided.',
    parameters: bookSearchSchema,
    executionMode: 'sequential',
    async execute(_toolCallId, params: BookSearchParams) {
      assertScope(params);
      if (getBookIndexStatus(session.documentFingerprint) !== 'ready') throw new Error('Book index is not ready; call ensure_book_index before searching.');
      const rows = searchDocumentChunks(session.documentFingerprint, params.query, params.limit ?? 8);
      const text = truncate(JSON.stringify({ results: rows.map((row) => ({ page: row.pageIndex + 1, quote: row.text, score: row.score })) }), MAX_TOOL_OUTPUT_LENGTH);
      return { content: [{ type: 'text' as const, text }], details: { text } };
    }
  };
  const ensureBookIndex: AgentTool<typeof bookIndexSchema, { text: string }> = {
    name: 'ensure_book_index',
    label: 'Prepare book search',
    description: 'Check whether the current PDF has a local search index. If it is missing, this asks the user for permission before any book text is indexed. Call this before search_book.',
    parameters: bookIndexSchema,
    executionMode: 'sequential',
    async execute(_toolCallId, params: BookIndexParams) {
      assertScope(params);
      const status = getBookIndexStatus(session.documentFingerprint);
      if (status === 'ready') {
        const text = JSON.stringify({ status: 'ready' });
        return { content: [{ type: 'text' as const, text }], details: { text } };
      }
      if (status === 'building') {
        const text = JSON.stringify({ status: 'building', message: 'The local index is still being prepared. Tell the user it will be ready shortly.' });
        return { content: [{ type: 'text' as const, text }], details: { text } };
      }
      if (status === 'declined') {
        const text = JSON.stringify({ status: 'declined', message: 'The user previously declined indexing this book. The app provides a retry authorization action.' });
        return { content: [{ type: 'text' as const, text }], details: { text } };
      }
      emitIfLive(session, { type: 'index_consent', conversationId: session.id, documentFingerprint: session.documentFingerprint, estimatedDiskBytes: 80 * 1024 * 1024 });
      const text = JSON.stringify({ status: 'consent_required', message: 'Ask the user to approve the local index card shown in the app before searching.' });
      return { content: [{ type: 'text' as const, text }], details: { text } };
    }
  };
  const navigateToPage: AgentTool<typeof navigatePageSchema, { text: string }> = {
    name: 'navigate_to_page',
    label: 'Navigate to page',
    description: 'Ask the app to navigate the reader to a page in the current PDF. Page numbers are 1-based. Use this after search_book identifies the most relevant definition, theorem, or passage, and include a short reason and the exact supporting quote when available. This changes only the reader viewport; it does not create a highlight.',
    parameters: navigatePageSchema,
    executionMode: 'sequential',
    async execute(_toolCallId, params: NavigatePageParams) {
      assertScope(params);
      emitIfLive(session, {
        type: 'navigate_to_page',
        conversationId: session.id,
        documentFingerprint: session.documentFingerprint,
        page: params.page,
        reason: params.reason,
        quote: params.quote ?? session.source.quote
      });
      const text = JSON.stringify({ status: 'navigation_requested', page: params.page });
      return { content: [{ type: 'text' as const, text }], details: { text } };
    }
  };
  const createAutoAnchor: AgentTool<typeof autoAnchorSchema, { text: string }> = {
    name: 'create_auto_anchor',
    label: 'Create source highlight',
    description: 'Create a saved source highlight for a passage found with search_book. Call this only after search results identify a page and quote. The app resolves the quote to its exact PDF text geometry and saves the highlight; do not invent a quote.',
    parameters: autoAnchorSchema,
    executionMode: 'sequential',
    async execute(_toolCallId, params: AutoAnchorParams) {
      assertScope(params);
      emitIfLive(session, { type: 'auto_anchor', conversationId: session.id, documentFingerprint: session.documentFingerprint, page: params.page, quote: params.quote.trim() });
      const text = JSON.stringify({ status: 'anchor_requested', page: params.page, quote: params.quote.trim() });
      return { content: [{ type: 'text' as const, text }], details: { text } };
    }
  };
  return [getAnchorContext, listAnchorNotes, ensureBookIndex, searchBook, navigateToPage, createAutoAnchor, proposeNoteSummary];
}

function createAgent(session: Session) {
  const settings = getAiSettings();
  if (!settings?.baseUrl || !settings.modelId) throw new Error('Configure a base URL and model ID before starting a conversation');
  const model: Model<'openai-completions'> = { id: settings.modelId, name: settings.modelId, api: 'openai-completions', provider: PROVIDER_ID, baseUrl: settings.baseUrl, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8_192 };
  const models = createModels();
  models.setProvider(createProvider({ id: PROVIDER_ID, name: 'Shuding OpenAI-compatible', baseUrl: model.baseUrl, auth: { apiKey: { name: 'Shuding API key', resolve: async () => ({ auth: { apiKey: getApiKey() } }) } }, models: [model], api: { stream: streamOpenAiCompletions, streamSimple: streamOpenAiCompletions } }));
  const isVoicePage = session.context.kind === 'ephemeral-selection' && session.context.selection.mode === 'voice-page';
  const sourcePolicy = isVoicePage
    ? 'This is a push-to-talk question about the page currently being read. The supplied quote is the complete current-page text and is your only source. Do not search the book or navigate elsewhere. Before answering, identify an exact supporting sentence or exercise fragment from that page and call create_auto_anchor with its current page and verbatim quote. If the page does not support the question, say so and do not create an anchor.'
    : 'When locating a concept in the book, call ensure_book_index first. Only if it reports ready may you call search_book. If it reports consent_required, explain that the app is awaiting the user choice; never claim that you searched the book. When search results identify the relevant passage, choose an exact supporting quote, call navigate_to_page, then call create_auto_anchor with that same page and quote before answering.';
  return new Agent({ initialState: { systemPrompt: `You are a reading companion for the current PDF selection. Use only the available context tools when needed. The current conversation ID is ${session.id}; provide it as the anchor argument to every context tool. Do not claim to browse the web or access files. ${sourcePolicy} Never invent a quote or page. A proposed note is never saved until the user confirms it in the app.`, model, messages: session.messages, tools: createTools(session), thinkingLevel: 'off' }, streamFn: models.streamSimple.bind(models), toolExecution: 'sequential', sessionId: session.id });
}

export function getSettings() { return safeSettings(); }

export function saveSettings(input: SaveAiSettingsInput) {
  const baseUrl = validateBaseUrl(input.baseUrl); const modelId = requireText(input.modelId, 'model ID', 300); const previous = getAiSettings(); let encryptedApiKey = previous?.encryptedApiKey ?? null;
  if (input.clearApiKey) encryptedApiKey = null;
  if (input.apiKey !== undefined) {
    const apiKey = requireText(input.apiKey, 'API key', 4_000);
    if (safeStorage.isEncryptionAvailable()) {
      encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64');
    } else {
      saveAiSettings({ baseUrl, modelId, encryptedApiKey });
      throw new Error('Base URL and model were saved, but the Secret Service keyring is unavailable for the API key');
    }
  }
  saveAiSettings({ baseUrl, modelId, encryptedApiKey }); return safeSettings();
}

export async function openConversation(context: ConversationContext, owner: ConversationOwner): Promise<ConversationSnapshot> {
  if (context.kind === 'ephemeral-selection') assertValidEphemeralContext(context);
  if (context.kind === 'saved-anchor' && context.selection) assertValidEphemeralContext({ kind: 'ephemeral-selection', selection: context.selection });
  const fingerprint = documentFingerprint(context);
  const source = contextForTool(context);
  return await mutateDocument(fingerprint, async () => {
    loadSessionsForDocument(fingerprint, owner.webContentsId);
    if (context.kind === 'document' && !context.fresh) {
      const existing = Array.from(sessionsByDocument.get(fingerprint) ?? [], (id) => sessions.get(id))
        .find((session) => session && !session.removed && session.owner.webContentsId === owner.webContentsId && session.context.kind === 'document');
      if (existing) { touch(existing); persistSession(existing); return snapshot(existing); }
    }
    if (context.kind === 'saved-anchor') {
      const existing = findSavedAnchorSession(fingerprint, context.anchorId, owner.webContentsId) ??
        Array.from(sessionsByDocument.get(fingerprint) ?? [], (id) => sessions.get(id)).find((session) => session && !session.removed && session.owner.webContentsId === owner.webContentsId && hasMatchingSource(session, context));
      if (existing) { touch(existing); persistSession(existing); return snapshot(existing); }
    }
    if (context.kind !== 'ephemeral-selection') await makeRoom(fingerprint);
    const session: Session = { id: randomUUID(), context, documentFingerprint: fingerprint, source, owner, messages: [], lastUsedAt: Date.now(), status: 'idle', removed: false };
    sessions.set(session.id, session);
    if (context.kind !== 'ephemeral-selection') {
      const documentSessions = sessionsByDocument.get(fingerprint) ?? new Set<string>();
      documentSessions.add(session.id); sessionsByDocument.set(fingerprint, documentSessions);
      persistSession(session);
    }
    return snapshot(session);
  });
}

export function listConversationSessions(documentId: string, webContentsId: number): ConversationSessionSummary[] {
  requireText(documentId, 'document fingerprint', 256);
  loadSessionsForDocument(documentId, webContentsId);
  return Array.from(sessionsByDocument.get(documentId) ?? [], (id) => getLiveSession(id, webContentsId)).filter((session): session is Session => Boolean(session)).sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.id.localeCompare(b.id)).map(summary);
}

export async function sendConversationMessage(conversationId: string, content: string, owner: ConversationOwner) {
  const prompt = requireText(content, 'message'); const session = getLiveSession(conversationId, owner.webContentsId);
  if (!session) throw new Error('Conversation not found');
  if (activeConversations.has(conversationId)) throw new Error('This conversation is already running');
  touch(session);
  const agent = createAgent(session);
  const unsubscribe = agent.subscribe((event) => {
    if (!getLiveSession(session.id, owner.webContentsId)) return;
    touch(session);
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') emitIfLive(session, { type: 'assistant_delta', conversationId, delta: event.assistantMessageEvent.delta });
    if (event.type === 'tool_execution_start') emitIfLive(session, { type: 'tool', conversationId, toolName: event.toolName, status: 'running' });
    if (event.type === 'tool_execution_end') emitIfLive(session, { type: 'tool', conversationId, toolName: event.toolName, status: event.isError ? 'failed' : 'completed' });
  });
  let resolveSettlement!: () => void; const settlement = new Promise<void>((resolve) => { resolveSettlement = resolve; });
  activeConversations.set(conversationId, { agent, settlement, resolveSettlement }); session.status = 'running'; emitIfLive(session, { type: 'status', conversationId, status: 'running' });
  try {
    await agent.prompt(prompt);
    if (getLiveSession(conversationId, owner.webContentsId)) { session.messages = agent.state.messages; touch(session); persistSession(session); if (agent.state.errorMessage && !agent.signal?.aborted) emitIfLive(session, { type: 'error', conversationId, message: agent.state.errorMessage }); }
  } catch (error: unknown) {
    if (getLiveSession(conversationId, owner.webContentsId)) emitIfLive(session, { type: 'error', conversationId, message: error instanceof Error ? error.message : 'Conversation failed' });
    throw error;
  } finally {
    unsubscribe(); activeConversations.delete(conversationId); session.status = 'idle'; if (getLiveSession(conversationId, owner.webContentsId)) emitIfLive(session, { type: 'status', conversationId, status: 'idle' }); resolveSettlement();
  }
}

export function abortConversation(conversationId: string, webContentsId: number) { const session = getLiveSession(conversationId, webContentsId); const active = activeConversations.get(conversationId); if (session && active) active.agent.abort(); }

export function confirmNoteProposal(input: ConfirmNoteProposalInput, webContentsId: number) {
  const proposal = proposals.get(input.conversationId);
  if (!proposal || proposal.id !== input.proposalId || proposal.ownerWebContentsId !== webContentsId) throw new Error('Note proposal not found');
  proposals.delete(input.conversationId);
  if (new Date(proposal.expiresAt).getTime() <= Date.now()) throw new Error('Note proposal expired');
  if (!proposal.anchorId || !getAnchorById(proposal.anchorId)) throw new Error('Anchor not found');
  return saveNote(proposal.anchorId, proposal.body);
}

export function discardNoteProposal(proposalId: string, webContentsId: number) { for (const [conversationId, proposal] of proposals) if (proposal.id === proposalId && proposal.ownerWebContentsId === webContentsId) proposals.delete(conversationId); }

export async function finalizeEphemeral(input: FinalizeEphemeralInput, webContentsId: number): Promise<FinalizeEphemeralResult> {
  const session = getLiveSession(input.conversationId, webContentsId);
  if (!session || session.context.kind !== 'ephemeral-selection') throw new Error('Temporary conversation not found');
  if (activeConversations.has(session.id)) throw new Error('Stop the active response before saving the temporary conversation');
  if (session.documentFingerprint !== input.documentFingerprint) throw new Error('Document changed; temporary selection is no longer valid');
  const proposal = input.proposalId ? proposals.get(session.id) : undefined;
  if (input.proposalId && (!proposal || proposal.id !== input.proposalId || new Date(proposal.expiresAt).getTime() <= Date.now())) throw new Error('Note proposal expired or unauthorized');
  const body = input.body?.trim(); if (body !== undefined && !body) throw new Error('Note body is required');
  const selection = session.context.selection;
  // Plan-A: turning a temporary selection into a saved anchor promotes the session's
  // context to 'saved-anchor' (keeping its transcript) instead of deleting it, so a
  // quote keeps continuing context when reopened.
  await makeRoom(session.documentFingerprint);
  const anchor = createAnchor({ documentId: selection.documentFingerprint, pageIndex: selection.pageIndex, kind: 'text', quote: selection.quote, normalizedQuote: selection.normalizedQuote, pageRect: selection.pageRect, normalizedRect: selection.normalizedRect });
  saveAnchor(anchor);
  session.context = { kind: 'saved-anchor', anchorId: anchor.id };
  session.source = { quote: anchor.quote, pageIndex: anchor.pageIndex, kind: anchor.kind, documentFingerprint: anchor.documentId };
  const documentSessions = sessionsByDocument.get(session.documentFingerprint) ?? new Set<string>();
  documentSessions.add(session.id); sessionsByDocument.set(session.documentFingerprint, documentSessions);
  const note = body || proposal ? saveNote(anchor.id, body ?? proposal!.body) : null;
  if (proposal) proposals.delete(session.id);
  touch(session);
  try { persistSession(session); } catch (error: unknown) { deleteAnchor(anchor.id); throw error; }
  return { anchor, note };
}

export async function discardConversation(conversationId: string, webContentsId: number) { const session = getLiveSession(conversationId, webContentsId); if (session) await discardSession(session, true); }
export function abandonEphemeralConversation(conversationId: string, webContentsId: number) { return discardConversation(conversationId, webContentsId); }

export async function deleteNoteEntry(noteId: string) {
  deleteNote(noteId);
}

export async function deleteConversationSession(conversationId: string, webContentsId: number) {
  const session = getLiveSession(conversationId, webContentsId);
  if (session) await discardSession(session, true);
}

export async function deleteAnchorCascade(anchorId: string, webContentsId: number) {
  const anchor = getAnchorById(anchorId);
  if (!anchor) return;
  const bound = Array.from(sessions.values()).find((session) => session.context.kind === 'saved-anchor' && session.context.anchorId === anchorId && !session.removed);
  if (bound) await discardSession(bound, true);
  deleteAnchor(anchorId);
}
export function removeConversationOwner(webContentsId: number) { for (const session of Array.from(sessions.values())) if (session.owner.webContentsId === webContentsId) void discardSession(session); }
