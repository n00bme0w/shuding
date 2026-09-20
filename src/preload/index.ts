import { contextBridge, ipcRenderer } from 'electron';
import type {
  Anchor,
  AnchorDraft,
  AiSettings,
  ConfirmNoteProposalInput,
  ConversationEvent,
  ConversationSessionSummary,
  ConversationSnapshot,
  FinalizeEphemeralInput,
  FinalizeEphemeralResult,
  OpenConversationInput,
  ListConversationSessionsInput,
  DeleteAnchorInput,
  Note,
  OpenedDocument,
  RecentDocument,
  ReadingState,
  SaveAiSettingsInput,
  SaveNoteInput,
  SaveReadingStateInput,
  SendConversationInput,
  BookSearchInput,
  BookSearchResult,
  DocumentChunkInput,
  BookIndexConsentInput,
  BookIndexStatus
} from '../shared';

const conversationListeners = new Set<(event: ConversationEvent) => void>();
const voiceListeners = new Set<(event: { type: 'partial' | 'commit' | 'final'; text: string }) => void>();

ipcRenderer.on('conversation:event', (_event, payload: unknown) => {
  if (typeof payload !== 'object' || payload === null || !('type' in payload) || !('conversationId' in payload)) {
    return;
  }
  for (const listener of conversationListeners) {
    listener(payload as ConversationEvent);
  }
});

ipcRenderer.on('voice:event', (_event, payload: unknown) => {
  if (typeof payload !== 'object' || payload === null || !('type' in payload) || !('text' in payload)) return;
  for (const listener of voiceListeners) listener(payload as { type: 'partial' | 'commit' | 'final'; text: string });
});

contextBridge.exposeInMainWorld('shuding', {
  version: '0.1.0',
  openDocument: (path?: string) => ipcRenderer.invoke('document:open', path) as Promise<OpenedDocument | null>,
  listRecentDocuments: () => ipcRenderer.invoke('document:recent-list') as Promise<RecentDocument[]>,
  openRecentDocument: (id: string) =>
    ipcRenderer.invoke('document:recent-open', id) as Promise<OpenedDocument | null>,
  getReadingState: (documentFingerprint: string) =>
    ipcRenderer.invoke('reader:state-get', documentFingerprint) as Promise<ReadingState | null>,
  saveReadingState: (input: SaveReadingStateInput) =>
    ipcRenderer.invoke('reader:state-save', input) as Promise<ReadingState>,
  indexDocumentChunks: (chunks: DocumentChunkInput[]) =>
    ipcRenderer.invoke('book:index-chunks', chunks) as Promise<void>,
  searchBook: (input: BookSearchInput) =>
    ipcRenderer.invoke('book:search', input) as Promise<BookSearchResult[]>,
  setBookIndexConsent: (input: BookIndexConsentInput) =>
    ipcRenderer.invoke('book:index-consent', input) as Promise<void>,
  getBookIndexStatus: (documentFingerprint: string) =>
    ipcRenderer.invoke('book:index-status', documentFingerprint) as Promise<BookIndexStatus>,
  resetBookIndexStatus: (documentFingerprint: string) =>
    ipcRenderer.invoke('book:index-reset', documentFingerprint) as Promise<void>,
  saveAnchor: (anchor: AnchorDraft) => ipcRenderer.invoke('anchor:save', anchor) as Promise<Anchor>,
  saveNote: (input: SaveNoteInput) => ipcRenderer.invoke('note:save', input) as Promise<Note>,
  deleteAnchor: (input: DeleteAnchorInput) => ipcRenderer.invoke('anchor:delete', input) as Promise<void>,
  deleteAnchorCascade: (input: DeleteAnchorInput) => ipcRenderer.invoke('anchor:delete-cascade', input) as Promise<void>,
  deleteNote: (noteId: string) => ipcRenderer.invoke('note:delete', noteId) as Promise<void>,
  loadAnchors: (documentId: string) =>
    ipcRenderer.invoke('anchor:list-by-document', documentId) as Promise<Anchor[]>,
  loadNotes: (anchorIds: string[]) =>
    ipcRenderer.invoke('note:list-by-anchor-ids', anchorIds) as Promise<Note[]>,
  getAiSettings: () => ipcRenderer.invoke('ai:settings-get') as Promise<AiSettings>,
  saveAiSettings: (input: SaveAiSettingsInput) =>
    ipcRenderer.invoke('ai:settings-save', input) as Promise<AiSettings>,
  openConversation: (context: OpenConversationInput) =>
    ipcRenderer.invoke('conversation:open', context) as Promise<ConversationSnapshot>,
  listConversationSessions: (input: ListConversationSessionsInput) =>
    ipcRenderer.invoke('conversation:list-by-document', input) as Promise<ConversationSessionSummary[]>,
  sendConversationMessage: (input: SendConversationInput) =>
    ipcRenderer.invoke('conversation:send', input) as Promise<void>,
  startVoiceStream: () => ipcRenderer.invoke('voice:start') as Promise<void>,
  pushVoiceAudio: (audio: ArrayBuffer) => ipcRenderer.invoke('voice:chunk', audio) as Promise<void>,
  stopVoiceStream: () => ipcRenderer.invoke('voice:stop') as Promise<void>,
  subscribeVoiceEvents: (listener: (event: { type: 'partial' | 'commit' | 'final'; text: string }) => void) => {
    voiceListeners.add(listener);
    return () => voiceListeners.delete(listener);
  },
  abortConversation: (conversationId: string) =>
    ipcRenderer.invoke('conversation:abort', conversationId) as Promise<void>,
  abandonEphemeralConversation: (conversationId: string) =>
    ipcRenderer.invoke('conversation:abandon-ephemeral', conversationId) as Promise<void>,
  confirmNoteProposal: (input: ConfirmNoteProposalInput) =>
    ipcRenderer.invoke('conversation:confirm-note', input) as Promise<Note>,
  discardNoteProposal: (proposalId: string) =>
    ipcRenderer.invoke('conversation:discard-note', proposalId) as Promise<void>,
  finalizeEphemeral: (input: FinalizeEphemeralInput) =>
    ipcRenderer.invoke('conversation:finalize-ephemeral', input) as Promise<FinalizeEphemeralResult>,
  discardConversation: (conversationId: string) =>
    ipcRenderer.invoke('conversation:discard', conversationId) as Promise<void>,
  deleteConversationSession: (conversationId: string) =>
    ipcRenderer.invoke('conversation:delete-session', conversationId) as Promise<void>,
  subscribeConversationEvents: (listener: (event: ConversationEvent) => void) => {
    conversationListeners.add(listener);
    return () => conversationListeners.delete(listener);
  }
});

export type ShudingApi = {
  version: string;
  openDocument(path?: string): Promise<OpenedDocument | null>;
  listRecentDocuments(): Promise<RecentDocument[]>;
  openRecentDocument(id: string): Promise<OpenedDocument | null>;
  getReadingState(documentFingerprint: string): Promise<ReadingState | null>;
  saveReadingState(input: SaveReadingStateInput): Promise<ReadingState>;
  indexDocumentChunks(chunks: DocumentChunkInput[]): Promise<void>;
  searchBook(input: BookSearchInput): Promise<BookSearchResult[]>;
  setBookIndexConsent(input: BookIndexConsentInput): Promise<void>;
  getBookIndexStatus(documentFingerprint: string): Promise<BookIndexStatus>;
  resetBookIndexStatus(documentFingerprint: string): Promise<void>;
  saveAnchor(anchor: AnchorDraft): Promise<Anchor>;
  saveNote(input: SaveNoteInput): Promise<Note>;
  deleteAnchor(input: DeleteAnchorInput): Promise<void>;
  deleteAnchorCascade(input: DeleteAnchorInput): Promise<void>;
  deleteNote(noteId: string): Promise<void>;
  loadAnchors(documentId: string): Promise<Anchor[]>;
  loadNotes(anchorIds: string[]): Promise<Note[]>;
  getAiSettings(): Promise<AiSettings>;
  saveAiSettings(input: SaveAiSettingsInput): Promise<AiSettings>;
  openConversation(context: OpenConversationInput): Promise<ConversationSnapshot>;
  listConversationSessions(input: ListConversationSessionsInput): Promise<ConversationSessionSummary[]>;
  sendConversationMessage(input: SendConversationInput): Promise<void>;
  startVoiceStream(): Promise<void>;
  pushVoiceAudio(audio: ArrayBuffer): Promise<void>;
  stopVoiceStream(): Promise<void>;
  subscribeVoiceEvents(listener: (event: { type: 'partial' | 'commit' | 'final'; text: string }) => void): () => void;
  abortConversation(conversationId: string): Promise<void>;
  abandonEphemeralConversation(conversationId: string): Promise<void>;
  confirmNoteProposal(input: ConfirmNoteProposalInput): Promise<Note>;
  discardNoteProposal(proposalId: string): Promise<void>;
  finalizeEphemeral(input: FinalizeEphemeralInput): Promise<FinalizeEphemeralResult>;
  discardConversation(conversationId: string): Promise<void>;
  deleteConversationSession(conversationId: string): Promise<void>;
  subscribeConversationEvents(listener: (event: ConversationEvent) => void): () => void;
};

declare global {
  interface Window {
    shuding: ShudingApi;
  }
}
