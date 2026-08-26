import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
  createAnchor,
  deleteAnchor,
  getAnchorsByDocumentId,
  getNotesByAnchorIds,
  getRecentDocumentById,
  listRecentDocuments,
  saveAnchor,
  saveNote,
  upsertRecentDocument
} from '../db/store';
import type { AnchorDraft, DeleteAnchorInput, OpenedDocument, SaveNoteInput } from '../shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow() {
  process.env.FONTCONFIG_FILE = path.join(process.cwd(), 'fontconfig', 'fonts.conf');
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    backgroundColor: '#f7f3ec',
    title: '书钉',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

async function readDocument(requestedPath: string): Promise<OpenedDocument> {
  const data = await fs.readFile(requestedPath);
  const fingerprint = createHash('sha256').update(data).digest('hex');
  const document = {
    id: randomUUID(),
    fingerprint,
    name: path.basename(requestedPath),
    path: path.resolve(requestedPath),
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  };
  upsertRecentDocument({
    path: document.path,
    name: document.name,
    fingerprint: document.fingerprint
  });
  return document;
}

ipcMain.handle('document:open', async (_event, requestedPath?: string) => {
  let pathResult = requestedPath;
  if (!pathResult) {
    const owner = BrowserWindow.fromWebContents(_event.sender);
    const selection = owner
      ? await dialog.showOpenDialog(owner, {
          properties: ['openFile'],
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        })
      : await dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        });
    pathResult = selection.canceled ? '' : selection.filePaths[0] ?? '';
  }

  if (!pathResult) {
    return null;
  }

  return readDocument(pathResult);
});

ipcMain.handle('document:recent-list', async () => listRecentDocuments(8));

ipcMain.handle('document:recent-open', async (_event, id: string) => {
  const recentDocument = getRecentDocumentById(id);
  if (!recentDocument) {
    return null;
  }

  try {
    return await readDocument(recentDocument.path);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error) {
      return null;
    }
    throw error;
  }
});

ipcMain.handle('anchor:save', async (_event, draft: AnchorDraft) => {
  const anchor = createAnchor(draft);
  saveAnchor(anchor);
  return anchor;
});

ipcMain.handle('anchor:list-by-document', async (_event, documentId: string) => {
  return getAnchorsByDocumentId(documentId);
});

ipcMain.handle('anchor:delete', async (_event, input: DeleteAnchorInput) => {
  deleteAnchor(input.anchorId);
});

ipcMain.handle('note:save', async (_event, input: SaveNoteInput) => {
  return saveNote(input.anchorId, input.body);
});

ipcMain.handle('note:list-by-anchor-ids', async (_event, anchorIds: string[]) => {
  return getNotesByAnchorIds(anchorIds);
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
