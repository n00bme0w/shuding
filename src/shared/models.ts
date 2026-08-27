export type AnchorKind = 'text' | 'ocr' | 'hybrid';

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Anchor = {
  id: string;
  documentId: string;
  pageIndex: number;
  kind: AnchorKind;
  quote: string;
  normalizedQuote: string;
  pageRect: Rect;
  normalizedRect: Rect;
  confidence?: number;
  createdAt: string;
  updatedAt: string;
};

export type Note = {
  id: string;
  anchorId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type OpenedDocument = {
  id: string;
  fingerprint: string;
  name: string;
  data: ArrayBuffer;
};

export type RecentDocument = {
  id: string;
  name: string;
  fingerprint: string;
  openedAt: string;
  unavailable?: boolean;
};

export type AnchorDraft = {
  documentId: string;
  pageIndex: number;
  kind: AnchorKind;
  quote: string;
  normalizedQuote: string;
  pageRect: Rect;
  normalizedRect: Rect;
  confidence?: number;
};

export type SaveNoteInput = {
  anchorId: string;
  body: string;
};

export type DeleteAnchorInput = {
  anchorId: string;
};

export type AiSettings = {
  baseUrl: string;
  modelId: string;
  hasApiKey: boolean;
  keyStorageAvailable: boolean;
  keyStorageBackend: string;
};

export type SaveAiSettingsInput = {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  clearApiKey?: boolean;
};

export type ConversationMessageRole = 'user' | 'assistant' | 'toolResult';

export type ConversationMessage = {
  id: string;
  role: ConversationMessageRole;
  content: string;
  createdAt: string;
  toolName?: string;
};

export type PendingNoteProposal = {
  id: string;
  conversationId: string;
  anchorId?: string;
  body: string;
  expiresAt: string;
};

export type SavedAnchorConversationContext = {
  kind: 'saved-anchor';
  anchorId: string;
  selection?: EphemeralSelectionConversationContext['selection'];
};

export type EphemeralSelectionConversationContext = {
  kind: 'ephemeral-selection';
  selection: {
    documentFingerprint: string;
    pageIndex: number;
    quote: string;
    normalizedQuote: string;
    pageRect: Rect;
    normalizedRect: Rect;
  };
};

export type ConversationContext =
  | SavedAnchorConversationContext
  | EphemeralSelectionConversationContext;

export type ConversationSnapshot = {
  conversationId: string;
  context: ConversationContext;
  messages: ConversationMessage[];
  pendingProposal: PendingNoteProposal | null;
};

export type ConversationStatus = 'running' | 'idle';

export type ConversationSessionSummary = {
  conversationId: string;
  documentFingerprint: string;
  contextKind: ConversationContext['kind'];
  quote: string;
  pageIndex: number;
  lastUsedAt: string;
  status: ConversationStatus;
};

export type ConversationEvent =
  | { type: 'status'; conversationId: string; status: 'running' | 'idle' }
  | { type: 'assistant_delta'; conversationId: string; delta: string }
  | { type: 'tool'; conversationId: string; toolName: string; status: 'running' | 'completed' | 'failed' }
  | { type: 'proposal'; conversationId: string; proposal: PendingNoteProposal }
  | { type: 'error'; conversationId: string; message: string };

export type ConfirmNoteProposalInput = {
  conversationId: string;
  proposalId: string;
};

export type OpenConversationInput = ConversationContext;

export type ListConversationSessionsInput = {
  documentFingerprint: string;
};

export type SendConversationInput = {
  conversationId: string;
  content: string;
};

export type FinalizeEphemeralInput = {
  conversationId: string;
  documentFingerprint: string;
  proposalId?: string;
  body?: string;
};

export type FinalizeEphemeralResult = {
  anchor: Anchor;
  note: Note | null;
};
