import { contextBridge, ipcRenderer } from 'electron';
import type {
  Anchor,
  AnchorDraft,
  DeleteAnchorInput,
  Note,
  OpenedDocument,
  RecentDocument,
  SaveNoteInput
} from '../shared';

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
    ipcRenderer.invoke('note:list-by-anchor-ids', anchorIds) as Promise<Note[]>
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
};

declare global {
  interface Window {
    shuding: ShudingApi;
  }
}
