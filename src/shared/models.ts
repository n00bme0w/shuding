export type AnchorKind = 'text' | 'ocr' | 'hybrid';

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// Legacy storage name: these are user-saved PDF highlights, not AI context anchors.
export type Anchor = {
  id: string;
  documentId: string;
  pageIndex: number;
  kind: AnchorKind;
  quote: string;
  normalizedQuote: string;
  pageRect: Rect;
  normalizedRect: Rect;
  normalizedRects?: Rect[];
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
  normalizedRects?: Rect[];
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
  interrupted?: boolean;
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
    normalizedRects?: Rect[];
    mode?: 'voice-page';
  };
};

export type DocumentConversationContext = {
  kind: 'document';
  documentFingerprint: string;
  fresh?: boolean;
};

export type ConversationContext =
  | SavedAnchorConversationContext
  | EphemeralSelectionConversationContext
  | DocumentConversationContext;

export type ConversationAnchor = {
  id: string;
  documentFingerprint: string;
  pageIndex: number;
  quote: string;
  surroundingText?: string;
  selectedSentence?: string;
  normalizedQuote: string;
  source: 'selection' | 'highlight' | 'current-page' | 'search';
  createdAt: string;
};

export type ConversationReadingContext = {
  documentFingerprint: string;
  pageIndex: number;
  quote: string;
  surroundingText?: string;
  selectedSentence?: string;
  kind: 'selection' | 'page';
  mode?: 'voice-page';
};

export type ConversationSnapshot = {
  conversationId: string;
  status: ConversationStatus;
  streamingText?: string;
  context: ConversationContext;
  messages: ConversationMessage[];
  contextAnchors: ConversationAnchor[];
  activeContextAnchorId?: string;
  pendingProposal: PendingNoteProposal | null;
};

export type ConversationStatus = 'running' | 'idle';

export type ConversationSessionSummary = {
  conversationId: string;
  documentFingerprint: string;
  contextKind: ConversationContext['kind'];
  quote: string;
  title: string;
  pageIndex: number;
  lastUsedAt: string;
  status: ConversationStatus;
};

export type ConversationEvent =
  | { type: 'status'; conversationId: string; status: 'running' | 'idle' }
  | { type: 'assistant_delta'; conversationId: string; delta: string }
  | { type: 'tool'; conversationId: string; toolName: string; status: 'running' | 'completed' | 'failed' }
  | { type: 'proposal'; conversationId: string; proposal: PendingNoteProposal }
  | { type: 'error'; conversationId: string; message: string }
  | { type: 'index_consent'; conversationId: string; documentFingerprint: string; estimatedDiskBytes: number }
  | { type: 'context_anchor'; conversationId: string; anchor: ConversationAnchor }
  | { type: 'navigate_to_page'; conversationId: string; documentFingerprint: string; page: number; reason?: string; quote?: string };

export type ConfirmNoteProposalInput = {
  conversationId: string;
  proposalId: string;
};

export type OpenConversationInput = ConversationContext;

export type ResumeConversationInput = {
  conversationId: string;
  documentFingerprint: string;
};

export type ListConversationSessionsInput = {
  documentFingerprint: string;
};

export type SendConversationInput = {
  conversationId: string;
  content: string;
  readingContext?: ConversationReadingContext;
};

export type SaveConversationNoteInput = {
  conversationId: string;
  contextAnchorId: string;
  highlight: AnchorDraft;
  body: string;
  proposalId?: string;
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

export type ReadingState = {
  documentFingerprint: string;
  scale: number;
  currentPage: number;
  scrollTop: number;
  pageOffset?: number;
};

export type SaveReadingStateInput = {
  documentFingerprint: string;
  scale: number;
  currentPage: number;
  scrollTop: number;
  pageOffset?: number;
};

export type DocumentChunkInput = {
  documentFingerprint: string;
  pageIndex: number;
  chunkIndex: number;
  text: string;
};

export type BookSearchInput = {
  documentFingerprint: string;
  query: string;
  limit?: number;
};

export type BookSearchResult = DocumentChunkInput & {
  id: string;
  score: number;
};

export type BookIndexConsentInput = {
  documentFingerprint: string;
  allowed: boolean;
};

export type BookIndexStatus = 'building' | 'ready' | 'declined' | 'missing';
