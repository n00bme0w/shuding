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
  path: string;
  data: ArrayBuffer;
};

export type RecentDocument = {
  id: string;
  path: string;
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

export type Conversation = {
  id: string;
  anchorId: string;
  prompt: string;
  response: string;
  createdAt: string;
};
