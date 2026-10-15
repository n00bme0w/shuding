# Shuding (书钉)

[简体中文](README.zh-CN.md) | English

A local-first AI PDF reader for serious book reading.

Shuding turns "select → ask → summarize → archive" into one workflow: select a passage, discuss it with an AI, then pin the resulting summary as a note back onto the original text.

## Features

- **High-quality PDF reading**
  - PDF.js rendering with high-DPI sharpness (internal render scale follows device pixel ratio)
  - Continuous vertical scrolling with zoom (25% – 400%)
  - Windowed rendering: only pages near the viewport are rendered, keeping memory stable during long sessions
- **Precise text selection**
  - Live highlight while dragging; multi-line selections are merged per line without overlapping or broken fragments
  - Anchors are stored as page index + page-local normalized coordinates, so zoom and scroll never break them
- **Quotes and notes**
  - Select text → "Add note" from the selection action bar to create a permanent anchor (yellow highlight)
  - The annotations drawer lists all book quotes and notes; clicking one scrolls back to the source page
  - Quotes and notes are keyed by the PDF content fingerprint (SHA-256), so reopening the same book keeps everything
- **AI reading companion (Pi core)**
  - Agent runtime built on `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`
  - Any OpenAI-compatible endpoint (OpenAI, DeepSeek, SiliconFlow, etc.)
  - Multi-turn conversation, streaming replies, abort support
  - Open Ask AI and ask directly: selected text or the current page is supplied automatically; page changes, new selections, and hold-Y voice questions continue the same discussion
  - One-click explanations, Enter to send, Shift+Enter for a new line, and saving answers as notes at their source; New topic preserves the previous discussion
  - AI replies render Markdown — code blocks, lists, and quotes display cleanly in the panel
  - History is ordered by the last question; viewing an old discussion does not reorder it, and empty new topics reuse a draft
  - History is persisted in local SQLite without automatic deletion limits; idle memory caches are evicted independently, and failures, stops, and window closure retain received messages
  - AI can capture source passages as context anchors with page numbers and provenance, reuse them in follow-up replies, and restore them with the conversation; inspect them and jump to the source in the chat panel
  - Context anchors are independent of PDF highlights; permanent annotations are created only when you explicitly add a highlight, save a reference, or save a note
- **Local-first & privacy**
  - All data (anchors, notes, recent documents, AI settings) lives in local SQLite
  - API keys are used only in the Electron main process, encrypted with the system keyring; the renderer never sees them
  - The agent registers no shell/filesystem/network tools; it can only propose a note summary, and the app performs the confirmed write
- **Drawer-first reading UI**
  - Default layout is library + wide reader; the right drawer opens on demand
  - The panel is part of the layout: opening it squeezes the PDF reader and never covers the top toolbar
  - Panel width is draggable (300px – 560px) for roomy reading or long conversations
  - Annotations / Note / AI are mutually exclusive drawer modes — one task at a time
  - The AI drawer lets you switch between the active conversation and the session list
  - AI configuration lives in a dedicated settings modal, not the reading surface

## UI navigation

| Entry | Purpose |
| --- | --- |
| Import PDF | Opens the system file picker (via main process, so recents can be recorded) |
| Recent documents | Up to 8 entries; reopen by internal ID |
| Top bar · Annotations | Opens the full annotation/note index drawer |
| Top bar · Note | Note drawer for the current selection / anchor |
| Top bar · AI | AI conversation drawer for the current context (with per-book history) |
| Top bar · Settings | AI configuration (Base URL / model / API key) |
| Selection action bar | Add note · Ask AI · Copy |

Keyboard:

- `Escape`: closes settings modal, then drawer, then selection action bar

## Requirements

- Node.js >= 22.19 (Electron 38 embeds Node 22.22.0, which satisfies this)
- Local builds of `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` (see dependency note below)
- On Linux, saving the API key requires a working Secret Service:
  - GNOME Keyring, KWallet (with Secret Service enabled), or KeePassXC with Secret Service integration
  - The app appends `--password-store=gnome-libsecret` automatically
  - If secure storage is unavailable, Base URL and model are still saved; the API key is never written to disk

## Install & develop

```bash
npm install        # postinstall rebuilds better-sqlite3 for the Electron ABI
npm run dev        # start Electron + renderer dev server

# Optional: register a global command and desktop launcher for this checkout
npm run install:launcher
# Then run it from any directory:
shuding
npm run typecheck  # TypeScript check
npm run build      # production build
npm run rebuild:native  # recompile native modules for the Electron ABI
```

If the local `@earendil-works/*` packages are not built yet, build them in their source directories first:

```bash
cd ../pi/packages/ai && npm run build:offline
cd ../pi/packages/agent && npm run build
```

## AI configuration

1. Open the top bar → Settings
2. Fill in the OpenAI-compatible endpoint:
   - Base URL (e.g. `https://api.deepseek.com/v1`)
   - Model ID (e.g. `deepseek-chat`)
   - API key (saved to system secure storage only)
3. Open Ask AI and ask directly, select a passage for a one-click explanation, or hold Y to speak
4. Continue asking or select another passage; the app supplies the current reading context. Use New topic to start a separate discussion
5. Save a useful answer or an edited AI summary as a note; the app locates and attaches it to the supporting source passage

## Data & storage

- Database location: `shuding.sqlite3` in the Electron `userData` directory
- Stored: anchors, notes, recent documents, AI settings (including the encrypted API key)
- AI conversations: history is persisted in the `conversations` table, grouped per book, without automatic retention limits. Clearing idle caches never deletes history; a new topic enters history after its first question
- After a restart, exact conversation IDs restore messages and context anchors. Deleting a discussion preserves saved annotations, and deleting a highlight preserves its AI history and source context. Input drafts are kept per discussion while switching history
- See [AI conversation and context anchors](docs/ai-context-flow.md) for the implementation workflow (Chinese)

## Tech stack

- Electron 38 + electron-vite + Vite
- React 19 + TypeScript (strict)
- PDF.js 4.x (rendering, text layer)
- better-sqlite3 (local storage)
- @earendil-works/pi-agent-core + @earendil-works/pi-ai (agent runtime)

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for third-party attribution.

## Current status

- 0.1.0 prototype stage
- Done: PDF rendering, continuous scroll, zoom, selection/anchor/notes, recent documents, Pi-powered multi-turn AI chat, per-book conversation history, session history persistence, drawer-first UI, secure credential storage
- Not yet: local OCR for scanned PDFs, formula OCR, book-wide `search_document`, web research tool, packaging/distribution
