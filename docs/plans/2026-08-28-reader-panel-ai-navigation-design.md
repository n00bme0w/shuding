# Reader Panel and AI Navigation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make contextual right panels resizable in-flow siblings of the PDF reader, improve zoom precision and range, and make AI chat/list navigation and long quote context compact and intentional.

**Architecture:** Keep the existing `DrawerMode` as the sole decision for whether a contextual panel is open. Add local renderer state for the right-panel width, drag lifecycle, AI sub-view (`chat` or `list`), and quote expansion; preserve all PDF rendering, SQLite, IPC, Pi session, and LRU behavior. The PDF reader remains a shrinkable CSS grid column; the drawer becomes a resizable grid column across usable desktop/tablet widths instead of an overlay.

**Tech Stack:** Electron 38, React 19, TypeScript strict mode, PDF.js, CSS grid, Pointer Events.

---

### Task 1: Add renderer state and pure interaction helpers

**Files:**
- Modify: `src/renderer/ui/App.tsx`

**Step 1: Add type-safe constants and local state**

Add constants for the right-panel width range and default (`300`, `380`, `560`), a local `AiView = 'chat' | 'list'` type, and state for `drawerWidth`, `isResizingDrawer`, `aiView`, and compact quote expansion. Keep `drawerMode` as the only source of truth for whether the drawer is open.

**Step 2: Add pointer-based resize lifecycle**

Implement pointer down / move / up handlers that clamp the drawer width to the stated bounds, calculate width from the viewport right edge, capture and release the pointer safely, and clear the resizing state on pointer end/cancel.

**Step 3: Add zoom helpers**

Replace fixed coarse zoom math with a pure helper that uses 5% increments below 100%, 10% increments from 100% to 200%, and 25% increments above 200%, with hard bounds of 25% and 400%.

**Step 4: Adjust AI state transitions**

Set `aiView` to `chat` when a selection starts or activates an AI conversation. Set it to `list` when the user opens AI with no active conversation. Ensure opening a list item activates that conversation and returns to chat.

**Step 5: Run TypeScript diagnostics**

Run: `npm run typecheck`

Expected: exit code 0.

### Task 2: Restructure the contextual drawer markup

**Files:**
- Modify: `src/renderer/ui/App.tsx`

**Step 1: Make the right panel width a CSS custom property**

Set `--drawer-width` on the shell only while `drawerMode` is non-null. Preserve the existing sidebar, reader, and drawer sibling ordering.

**Step 2: Add resize handle**

Render an accessible left-edge drawer resize control with a clear `aria-label`, pointer handlers, and keyboard-independent fallback behavior. Do not place it above or inside the PDF surface.

**Step 3: Add AI sub-navigation**

Replace the always-visible session queue above the chat with a two-button tab control: `对话` and `会话`. The `对话` tab renders only active-chat content; the `会话` tab renders only the session list. Preserve existing session status, last-used ordering, click handlers, and empty state behavior.

**Step 4: Compact conversation quote context**

Replace the full always-expanded `quote-context` display in the AI chat with a compact metadata row: page metadata when available, quote length, a two-line preview, and a labeled expand/collapse button. Keep the full quote in existing conversation context state; do not change IPC or shared model types.

**Step 5: Expand zoom controls**

Keep +/- and reset, add a numeric/selectable zoom control that can select the supported range, and add a readable percent indicator. Preserve zoom focus/scroll position behavior.

**Step 6: Run TypeScript diagnostics**

Run: `npm run typecheck`

Expected: exit code 0.

### Task 3: Rework layout and visual styling

**Files:**
- Modify: `src/renderer/styles.css`

**Step 1: Make the drawer an in-flow grid column**

Use `--drawer-width` in `.shell.drawer-open` for the third CSS-grid column. Retain `.reader { min-width: 0; }` and `.page-surface` scroll ownership so an open drawer narrows the PDF viewport rather than covering it.

**Step 2: Remove fixed drawer overlay behavior**

Replace the `max-width: 880px` `.drawer { position: fixed; inset: ...; z-index: ...; }` rule with an in-flow responsive layout. If the viewport cannot fit sidebar, reader minimum, and drawer simultaneously, keep the panel in document flow and allow horizontal application-level layout as needed; do not cover toolbar controls.

**Step 3: Style the resize affordance**

Add a restrained vertical grip at the drawer's left edge with visible hover/active feedback and `cursor: col-resize`. Avoid a heavy visual divider.

**Step 4: Style AI tabs and compact quote**

Add coherent tab styling, active state, focus-visible state, compact quote preview clamping, and expanded state. Keep messages as the dominant visual surface in chat view.

**Step 5: Make the drawer internally structured**

Ensure drawer header remains visible while drawer content scrolls. Avoid setting arbitrary low maximum heights on the active conversation message list; give the chat area flexible height so it uses the available panel space.

**Step 6: Verify responsive breakpoints**

Inspect at approximately 1440px, 1120px, and 880px widths. Confirm that the right panel never covers the top toolbar and that the reader width adjusts.

### Task 4: Validate behavior and update documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Step 1: Document the UI behavior**

Update both READMEs to state that the contextual panel is resizable and in-flow, AI has separate chat/session views, and zoom supports 25%–400%.

**Step 2: Run static verification**

Run:

```bash
npm run typecheck
npm run build
```

Expected: all commands exit code 0.

**Step 3: Perform interaction verification**

Run `npm run dev` and verify manually:

1. Opening annotations, note, and AI narrows the PDF reader rather than overlaying it.
2. Dragging the divider obeys 300px–560px bounds.
3. Topbar AI/settings controls remain reachable while a panel is open.
4. AI opens in chat for an active/new conversation and list when no conversation is active.
5. Selecting a list entry switches to chat.
6. Long quote context is collapsed by default and expands deliberately.
7. Zoom supports 25%–400% and follows the stated fine/coarse step behavior.
