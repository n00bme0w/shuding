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
  SaveAiSettingsInput,
  SaveNoteInput,
  SendConversationInput
} from '../shared';

const conversationListeners = new Set<(event: ConversationEvent) => void>();

ipcRenderer.on('conversation:event', (_event, payload: unknown) => {
  if (typeof payload !== 'object' || payload === null || !('type' in payload) || !('conversationId' in payload)) {
    return;
  }
  for (const listener of conversationListeners) {
    listener(payload as ConversationEvent);
  }
});

contextBridge.exposeInMainWorld('shuding', {
  version: '0.1.0',
  openDocument: (path?: string) => ipcRenderer.invoke('document:open', path) as Promise<OpenedDocument | null>,
  listRecentDocuments: () => ipcRenderer.invoke('document:recent-list') as Promise<RecentDocument[]>,
  openRecentDocument: (id: string) =>
    ipcRenderer.invoke('document:recent-open', id) as Promise<OpenedDocument | null>,
  saveAnchor: (anchor: AnchorDraft) => ipcRenderer.invoke('anchor:save', anchor) as Promise<Anchor>,
  saveNote: (input: SaveNoteInput) => ipcRenderer.invoke('note:save', input) as Promise<Note>,
  deleteAnchor: (input: DeleteAnchorInput) => ipcRenderer.invoke('anchor:delete', input) as Promise<void>,
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
  saveAnchor(anchor: AnchorDraft): Promise<Anchor>;
  saveNote(input: SaveNoteInput): Promise<Note>;
  deleteAnchor(input: DeleteAnchorInput): Promise<void>;
  loadAnchors(documentId: string): Promise<Anchor[]>;
  loadNotes(anchorIds: string[]): Promise<Note[]>;
  getAiSettings(): Promise<AiSettings>;
  saveAiSettings(input: SaveAiSettingsInput): Promise<AiSettings>;
  openConversation(context: OpenConversationInput): Promise<ConversationSnapshot>;
  listConversationSessions(input: ListConversationSessionsInput): Promise<ConversationSessionSummary[]>;
  sendConversationMessage(input: SendConversationInput): Promise<void>;
  abortConversation(conversationId: string): Promise<void>;
  abandonEphemeralConversation(conversationId: string): Promise<void>;
  confirmNoteProposal(input: ConfirmNoteProposalInput): Promise<Note>;
  discardNoteProposal(proposalId: string): Promise<void>;
  finalizeEphemeral(input: FinalizeEphemeralInput): Promise<FinalizeEphemeralResult>;
  discardConversation(conversationId: string): Promise<void>;
  subscribeConversationEvents(listener: (event: ConversationEvent) => void): () => void;
};

declare global {
  interface Window {
    shuding: ShudingApi;
  }
}
