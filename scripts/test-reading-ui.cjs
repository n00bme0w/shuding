// Run after npm run build. On headless Linux: xvfb-run -a npm run test:ui.
// The production renderer runs against a fixture PDF and an isolated mock bridge.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'shuding-reading-ui-'));
app.setPath('userData', temporary);
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

function createPdf() {
  const stream = (text) => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 560] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream('BT /F1 16 Tf 40 490 Td (An exact supporting sentence.) Tj 0 -28 Td (Another sentence to ask about.) Tj ET'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 560] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    stream('BT /F1 16 Tf 40 490 Td (A useful definition on the next page.) Tj 0 -28 Td (The terrestrial animals live on land.) Tj 0 -28 Td (The terrestrial planets have solid surfaces.) Tj ET')
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

function installMockBridge(pdfPath) {
  const { contextBridge } = require('electron');
  const fs = require('node:fs');
  const sessions = new Map();
  const listeners = new Set();
  const voices = new Set();
  const activity = new Map();
  const resumeDelays = new Map();
  const state = { sends: [], highlights: [], notes: [], opened: 0, openCalls: [] };
  const emit = (event) => listeners.forEach((listener) => listener(event));
  const now = () => new Date().toISOString();
  const api = {
    version: 'test',
    listRecentDocuments: async () => [],
    openDocument: async () => ({ id: 'book', fingerprint: 'fixture-book', name: 'Reading fixture.pdf', data: Uint8Array.from(fs.readFileSync(pdfPath)).buffer }),
    loadAnchors: async () => state.highlights,
    loadNotes: async () => state.notes,
    getReadingState: async () => null,
    saveReadingState: async (input) => input,
    getBookIndexStatus: async () => 'ready',
    getAiSettings: async () => ({ baseUrl: 'https://example.test', modelId: 'mock', hasApiKey: true, keyStorageAvailable: true }),
    subscribeVoiceEvents: (listener) => { voices.add(listener); return () => voices.delete(listener); },
    subscribeConversationEvents: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    listConversationSessions: async () => [...sessions.values()].filter((session) => session.messages.some((message) => message.role === 'user')).sort((a, b) => activity.get(b.conversationId) - activity.get(a.conversationId)).map((session) => ({ conversationId: session.conversationId, documentFingerprint: 'fixture-book', contextKind: 'document', quote: '', title: session.messages.find((message) => message.role === 'user')?.content ?? '新的阅读讨论', pageIndex: 0, status: session.status, lastUsedAt: new Date(activity.get(session.conversationId)).toISOString() })),
    openConversation: async (context) => {
      state.openCalls.push(context);
      const draft = [...sessions.values()].find((session) => session.messages.length === 0);
      if (draft) return draft;
      if (!context.fresh && sessions.size) return [...sessions.values()].at(-1);
      const snapshot = { conversationId: `chat-${++state.opened}`, status: 'idle', context, messages: [], contextAnchors: [], pendingProposal: null };
      sessions.set(snapshot.conversationId, snapshot);
      return snapshot;
    },
    resumeConversation: async ({ conversationId }) => {
      const snapshot = sessions.get(conversationId);
      await new Promise((resolve) => setTimeout(resolve, resumeDelays.get(conversationId) ?? 0));
      return snapshot;
    },
    deleteConversationSession: async (id) => sessions.delete(id),
    sendConversationMessage: async (input) => {
      state.sends.push(input);
      const session = sessions.get(input.conversationId);
      activity.set(input.conversationId, Date.now());
      session.messages.push({ id: `user-${state.sends.length}`, role: 'user', content: input.content, createdAt: now() });
      session.status = 'running';
      emit({ type: 'status', conversationId: input.conversationId, status: 'running' });
      emit({ type: 'tool', conversationId: input.conversationId, toolName: 'get_anchor_context', status: 'running' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const reading = input.readingContext;
      if (reading) {
        const quote = reading.kind === 'selection' ? reading.quote : reading.quote.split('. ')[0].replace(/\.$/, '') + '.';
        let anchor = session.contextAnchors.find((anchor) => anchor.pageIndex === reading.pageIndex && anchor.quote === quote);
        if (!anchor) {
          anchor = { id: `context-${session.contextAnchors.length}`, documentFingerprint: 'fixture-book', pageIndex: reading.pageIndex, quote, normalizedQuote: quote, source: reading.kind === 'selection' ? 'selection' : 'current-page', createdAt: now() };
          session.contextAnchors.push(anchor);
          emit({ type: 'context_anchor', conversationId: input.conversationId, anchor });
        }
        session.activeContextAnchorId = anchor.id;
      }
      session.messages.push({ id: `tool-${state.sends.length}`, role: 'toolResult', toolName: 'get_anchor_context', content: '{"internal_tool_json":true}', createdAt: now() });
      const content = 'Here is a clear explanation of the source passage.';
      emit({ type: 'assistant_delta', conversationId: input.conversationId, delta: content });
      session.messages.push({ id: `answer-${state.sends.length}`, role: 'assistant', content, createdAt: now() });
      session.status = 'idle';
      emit({ type: 'status', conversationId: input.conversationId, status: 'idle' });
    },
    saveConversationNote: async (input) => {
      const anchor = { ...input.highlight, id: `highlight-${state.highlights.length}`, createdAt: now(), updatedAt: now() };
      const note = { id: `note-${state.notes.length}`, anchorId: anchor.id, body: input.body, createdAt: now(), updatedAt: now() };
      state.highlights.push(anchor); state.notes.push(note);
      return { anchor, note };
    },
    startVoiceStream: async () => {
      setTimeout(() => voices.forEach((listener) => listener({ type: 'commit', text: '为什么这个定义成立？' })), 50);
      setTimeout(() => voices.forEach((listener) => listener({ type: 'commit', text: '能举个例子吗？' })), 100);
    },
    pushVoiceAudio: async () => {},
    stopVoiceStream: async () => voices.forEach((listener) => listener({ type: 'final', text: '' })),
    __setResumeDelay: (id, delay) => resumeDelays.set(id, delay),
    __setConversationMessages: (id, messages) => { const session = sessions.get(id); if (session) session.messages = messages; },
    __getState: () => ({ ...state, sessionCount: sessions.size })
  };
  contextBridge.exposeInMainWorld('shuding', api);
}

const pdfPath = path.join(temporary, 'fixture.pdf');
const preload = path.join(temporary, 'preload.cjs');
fs.writeFileSync(pdfPath, createPdf());
fs.writeFileSync(preload, `(${installMockBridge.toString()})(${JSON.stringify(pdfPath)});`);

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1320, height: 900, show: false, webPreferences: { preload, contextIsolation: true, sandbox: false } });
  const errors = [];
  window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  const evaluate = (code) => window.webContents.executeJavaScript(code, true);
  const waitFor = async (code) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (await evaluate(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${code}`);
  };
  const clickText = (text) => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)}); if (!button) throw new Error('Missing button'); button.click(); })()`);
  const enter = (text) => evaluate(`(() => { const input = document.querySelector('textarea[aria-label="向 AI 提问"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  const draft = (text) => evaluate(`(() => { const input = document.querySelector('textarea[aria-label="向 AI 提问"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  let exitCode = 0;
  try {
    await window.loadFile(path.join(__dirname, '../out/renderer/index.html'));
    await clickText('导入 PDF');
    await waitFor(`document.querySelectorAll('[data-page-index="0"] .text-layer span').length >= 2`);
    await evaluate(`(() => { const span = document.querySelector('[data-page-index="0"] .text-layer span'); const range = document.createRange(); range.selectNodeContents(span); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('.selection-action-bar') !== null`);
    await clickText('解释一下');
    await waitFor(`document.querySelector('.answer-save-note') !== null && document.querySelector('.answer-save-note')?.disabled === false`);
    let state = await evaluate('window.shuding.__getState()');
    assert.equal(state.sends[0].readingContext.kind, 'selection');
    assert.equal(state.sends[0].readingContext.selectedSentence, 'An exact supporting sentence.');
    assert.ok(state.sends[0].readingContext.surroundingText.includes('Another sentence to ask about.'));
    assert.equal(state.highlights.length, 0);
    assert.equal(await evaluate(`document.body.textContent.includes('internal_tool_json')`), false);
    await enter('请再举一个例子');
    await waitFor(`window.shuding.__getState().sends.length === 2 && document.querySelector('.answer-save-note')?.disabled === false`);
    state = await evaluate('window.shuding.__getState()');
    assert.equal(state.sessionCount, 1);
    assert.equal(state.sends[1].conversationId, state.sends[0].conversationId);
    assert.equal(state.sends[1].readingContext.kind, 'page');
    await clickText('存为笔记');
    await waitFor(`window.shuding.__getState().notes.length === 1`);
    state = await evaluate('window.shuding.__getState()');
    assert.equal(state.highlights.length, 1);
    assert.ok(state.highlights[0].normalizedRects.length > 0);
    assert.ok(state.highlights[0].normalizedRect.height < 0.15, 'save only the source passage, not an entire page');
    await evaluate(`(() => { const highlight = document.querySelector('.anchor-highlight'); const rect = highlight.getBoundingClientRect(); const options = { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }; highlight.dispatchEvent(new MouseEvent('mousedown', options)); highlight.dispatchEvent(new MouseEvent('mouseup', options)); })()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await evaluate('window.shuding.__getState()')).openCalls.length, 1, 'clicking a highlight must not switch the discussion');
    await evaluate(`document.querySelector('button[aria-label="下一页"]').click()`);
    await waitFor(`document.querySelector('[data-page-index="1"] .text-layer span') !== null`);
    await evaluate(`(() => {
      navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
      window.AudioContext = class { constructor() { this.audioWorklet = { addModule: async () => {} }; this.destination = {}; } createMediaStreamSource() { return { connect() {}, disconnect() {} }; } close() { return Promise.resolve(); } };
      window.AudioWorkletNode = class { constructor() { this.port = { postMessage() {} }; } connect() {} disconnect() {} };
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyY', bubbles: true }));
    })()`);
    await waitFor(`document.querySelector('textarea[aria-label="向 AI 提问"]').value.includes('能举个例子吗')`);
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyY', bubbles: true }))`);
    await waitFor(`window.shuding.__getState().sends.length === 3 && document.querySelector('.answer-save-note')?.disabled === false`);
    state = await evaluate('window.shuding.__getState()');
    assert.equal(state.sends[2].conversationId, state.sends[0].conversationId);
    assert.equal(state.sends[2].readingContext.pageIndex, 1);
    assert.equal(state.sends[2].readingContext.mode, 'voice-page');
    assert.ok(state.sends[2].content.includes('为什么这个定义成立？'));
    assert.ok(state.sends[2].content.includes('能举个例子吗？'), 'do not lose committed voice segments when the final chunk is empty');
    await clickText('问 AI');
    await clickText('问 AI');
    await waitFor(`document.querySelector('textarea[aria-label="向 AI 提问"]') !== null`);
    assert.equal((await evaluate('window.shuding.__getState()')).sessionCount, 1);
    await draft('原话题草稿');
    await clickText('新话题');
    await waitFor(`window.shuding.__getState().sessionCount === 2`);
    await waitFor(`document.querySelector('textarea[aria-label="向 AI 提问"]').value === ''`);
    await clickText('新话题');
    assert.equal((await evaluate('window.shuding.__getState()')).sessionCount, 2, 'reuse the empty new topic');
    await clickText('历史');
    await waitFor(`document.querySelectorAll('.session-item').length === 1`);
    await clickText('对话');
    await evaluate(`(() => { const span = [...document.querySelectorAll('[data-page-index="1"] .text-layer span')].find(span => span.textContent.includes('planets')); const node = span.firstChild; const start = node.textContent.indexOf('terrestrial'); const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 'terrestrial'.length); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('.selection-action-bar') !== null`);
    await enter('翻译这个词');
    await waitFor(`window.shuding.__getState().sends.length === 4 && document.querySelector('.answer-save-note')?.disabled === false`);
    state = await evaluate('window.shuding.__getState()');
    assert.equal(state.sends[3].readingContext.quote, 'terrestrial');
    assert.equal(state.sends[3].readingContext.selectedSentence, 'The terrestrial planets have solid surfaces.', 'use the selected occurrence, not the earlier biological usage');
    await draft('新话题草稿');
    await evaluate(`window.shuding.__setResumeDelay('chat-1', 300)`);
    await clickText('历史');
    await waitFor(`document.querySelectorAll('.session-item').length === 2`);
    await evaluate(`(() => { const rows = [...document.querySelectorAll('.session-main')]; rows.find(row => !row.textContent.includes('翻译这个词')).click(); rows.find(row => row.textContent.includes('翻译这个词')).click(); })()`);
    await waitFor(`document.querySelector('textarea[aria-label="向 AI 提问"]')?.value === '新话题草稿'`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="向 AI 提问"]').value`), '新话题草稿', 'a slower earlier restore must not replace the last choice');
    await evaluate(`window.shuding.__setResumeDelay('chat-1', 0)`);
    await clickText('历史');
    await evaluate(`[...document.querySelectorAll('.session-main')].find(row => !row.textContent.includes('翻译这个词')).click()`);
    await waitFor(`document.querySelector('textarea[aria-label="向 AI 提问"]')?.value === '原话题草稿'`);
    await clickText('历史');
    await evaluate(`document.querySelector('.session-item.active .session-delete').click()`);
    await clickText('删除对话');
    await waitFor(`document.querySelector('textarea[aria-label="向 AI 提问"]')?.value === '新话题草稿'`);
    state = await evaluate('window.shuding.__getState()');
    assert.equal(state.sessionCount, 1);
    assert.equal(state.highlights.length, 1);
    assert.equal(state.notes.length, 1, 'deleting history preserves saved annotations');
    await evaluate(`window.shuding.__setConversationMessages('chat-2', Array.from({ length: 30 }, (_, index) => ({ id: 'long-' + index, role: index % 2 ? 'assistant' : 'user', content: ('第 ' + index + ' 轮对话内容。').repeat(8), createdAt: new Date().toISOString() })))`);
    await clickText('问 AI');
    await clickText('问 AI');
    await waitFor(`document.querySelector('.conversation-messages') !== null`);
    await waitFor(`(() => { const list = document.querySelector('.conversation-messages'); return list && list.scrollHeight - list.scrollTop - list.clientHeight < 5; })()`);
    await evaluate(`document.querySelector('.conversation-messages').scrollTop = 0`);
    await clickText('问 AI');
    await clickText('问 AI');
    await waitFor(`(() => { const list = document.querySelector('.conversation-messages'); return list && list.scrollHeight - list.scrollTop - list.clientHeight < 5; })()`);
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Reading UI passed: continuous chat, notes, voice, exact selected sentence, empty topics, history restore races, per-chat drafts, and deletion fallback.');
  } catch (error) {
    exitCode = 1;
    console.error(error);
    console.error(errors.join('\n'));
  } finally {
    window.destroy();
    fs.rmSync(temporary, { recursive: true, force: true });
    app.exit(exitCode);
  }
});
