import { app, BrowserWindow, dialog, ipcMain, session, type IpcMainInvokeEvent, type WebContents } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
  createAnchor,
  deleteAnchor,
  deleteNote,
  getAnchorsByDocumentId,
  getNotesByAnchorIds,
  getReadingState,
  getRecentDocumentById,
  listRecentDocuments,
  saveAnchor,
  saveBookIndexStatus,
  getBookIndexStatus,
  resetBookIndexStatus,
  saveNote,
  saveReadingState,
  replaceDocumentChunks,
  searchDocumentChunks,
  recoverInterruptedBookIndexes,
  upsertRecentDocument
} from '../db/store';
import {
  abandonEphemeralConversation,
  abortConversation,
  confirmNoteProposal,
  deleteAnchorCascade,
  deleteConversationSession,
  deleteNoteEntry,
  discardConversation,
  discardNoteProposal,
  finalizeEphemeral,
  getSettings,
  listConversationSessions,
  openConversation,
  removeConversationOwner,
  saveSettings,
  sendConversationMessage
} from './ai/service';
import { pushVoiceAudio, startVoiceStream, stopVoiceService, stopVoiceStream } from './asr/service';
import type {
  AnchorDraft,
  ConfirmNoteProposalInput,
  ConversationContext,
  ConversationEvent,
  DeleteAnchorInput,
  FinalizeEphemeralInput,
  ListConversationSessionsInput,
  OpenedDocument,
  SaveAiSettingsInput,
  SaveNoteInput,
  SaveReadingStateInput,
  SendConversationInput,
  BookSearchInput,
  DocumentChunkInput,
  BookIndexConsentInput
} from '../shared';
import { startEmbeddingService, stopEmbeddingService } from './embedding/service';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (process.platform === 'linux' && !process.argv.some((argument) => argument.startsWith('--password-store='))) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}

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
  win.webContents.once('destroyed', () => removeConversationOwner(win.webContents.id));
}

function assertTrustedSender(event: IpcMainInvokeEvent) {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner.isDestroyed()) {
    throw new Error('Untrusted IPC sender');
  }
  return event.sender;
}

function eventOwner(webContents: WebContents) {
  return {
    webContentsId: webContents.id,
    emit(event: ConversationEvent) {
      if (!webContents.isDestroyed()) {
        webContents.send('conversation:event', event);
      }
    }
  };
}

async function readDocument(requestedPath: string): Promise<OpenedDocument> {
  const data = await fs.readFile(requestedPath);
  const fingerprint = createHash('sha256').update(data).digest('hex');
  const document = {
    id: randomUUID(),
    fingerprint,
    name: path.basename(requestedPath),
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  };
  upsertRecentDocument({
    path: path.resolve(requestedPath),
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

ipcMain.handle('reader:state-get', async (_event, documentFingerprint: string) => {
  return getReadingState(documentFingerprint);
});

ipcMain.handle('reader:state-save', async (_event, input: SaveReadingStateInput) => {
  return saveReadingState(input);
});

ipcMain.handle('book:index-chunks', async (event, chunks: DocumentChunkInput[]) => {
  assertTrustedSender(event);
  if (!Array.isArray(chunks) || chunks.length === 0) return;
  const documentFingerprint = chunks[0]?.documentFingerprint;
  if (!documentFingerprint || chunks.some((chunk) => chunk.documentFingerprint !== documentFingerprint)) {
    throw new Error('Invalid document index payload');
  }
  replaceDocumentChunks(documentFingerprint, chunks);
});

ipcMain.handle('book:search', async (event, input: BookSearchInput) => {
  assertTrustedSender(event);
  return searchDocumentChunks(input.documentFingerprint, input.query, input.limit);
});

ipcMain.handle('book:index-consent', async (event, input: BookIndexConsentInput) => {
  assertTrustedSender(event);
  if (input.allowed) {
    const available = await startEmbeddingService();
    if (!available) throw new Error('本地语义检索服务无法启动');
  }
  saveBookIndexStatus(input.documentFingerprint, input.allowed ? 'building' : 'declined');
});

ipcMain.handle('book:index-status', async (event, documentFingerprint: string) => {
  assertTrustedSender(event);
  return getBookIndexStatus(documentFingerprint);
});

ipcMain.handle('book:index-reset', async (event, documentFingerprint: string) => {
  assertTrustedSender(event);
  resetBookIndexStatus(documentFingerprint);
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

ipcMain.handle('ai:settings-get', async (event) => {
  assertTrustedSender(event);
  return getSettings();
});

ipcMain.handle('ai:settings-save', async (event, input: SaveAiSettingsInput) => {
  assertTrustedSender(event);
  return saveSettings(input);
});

ipcMain.handle('conversation:open', async (event, context: ConversationContext) => {
  const sender = assertTrustedSender(event);
  return await openConversation(context, eventOwner(sender));
});

ipcMain.handle('conversation:list-by-document', async (event, input: ListConversationSessionsInput) => {
  const sender = assertTrustedSender(event);
  return listConversationSessions(input.documentFingerprint, sender.id);
});

ipcMain.handle('conversation:send', async (event, input: SendConversationInput) => {
  const sender = assertTrustedSender(event);
  await sendConversationMessage(input.conversationId, input.content, eventOwner(sender));
});

ipcMain.handle('voice:start', async (event) => {
  const sender = assertTrustedSender(event);
  await startVoiceStream((voiceEvent) => {
    if (!sender.isDestroyed()) sender.send('voice:event', voiceEvent);
  });
});

ipcMain.handle('voice:chunk', async (event, audio: ArrayBuffer) => {
  assertTrustedSender(event);
  pushVoiceAudio(audio);
});

ipcMain.handle('voice:stop', async (event) => {
  assertTrustedSender(event);
  stopVoiceStream();
});

ipcMain.handle('conversation:abort', async (event, conversationId: string) => {
  const sender = assertTrustedSender(event);
  abortConversation(conversationId, sender.id);
});

ipcMain.handle('conversation:abandon-ephemeral', async (event, conversationId: string) => {
  const sender = assertTrustedSender(event);
  await abandonEphemeralConversation(conversationId, sender.id);
});

ipcMain.handle('conversation:confirm-note', async (event, input: ConfirmNoteProposalInput) => {
  const sender = assertTrustedSender(event);
  return confirmNoteProposal(input, sender.id);
});

ipcMain.handle('conversation:discard-note', async (event, proposalId: string) => {
  const sender = assertTrustedSender(event);
  discardNoteProposal(proposalId, sender.id);
});

ipcMain.handle('conversation:finalize-ephemeral', async (event, input: FinalizeEphemeralInput) => {
  const sender = assertTrustedSender(event);
  return await finalizeEphemeral(input, sender.id);
});

ipcMain.handle('conversation:discard', async (event, conversationId: string) => {
  const sender = assertTrustedSender(event);
  await discardConversation(conversationId, sender.id);
});

ipcMain.handle('note:delete', async (_event, noteId: string) => {
  await deleteNoteEntry(noteId);
});

ipcMain.handle('conversation:delete-session', async (event, conversationId: string) => {
  const sender = assertTrustedSender(event);
  await deleteConversationSession(conversationId, sender.id);
});

ipcMain.handle('anchor:delete-cascade', async (event, input: DeleteAnchorInput) => {
  const sender = assertTrustedSender(event);
  await deleteAnchorCascade(input.anchorId, sender.id);
});

app.whenReady().then(() => {
  // SpeechRecognition requests microphone access from Chromium's renderer. Only
  // grant it to our own application window, never to an arbitrary web origin.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' && BrowserWindow.fromWebContents(webContents) !== null);
  });
  recoverInterruptedBookIndexes();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void stopEmbeddingService().finally(() => app.quit());
  }
});

app.on('before-quit', () => {
  stopVoiceService();
  void stopEmbeddingService();
});
