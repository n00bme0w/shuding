import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import 'katex/dist/katex.min.css';
import { normalizeQuote } from '../../shared';
import type {
  AiSettings,
  Anchor,
  ConversationEvent,
  ConversationMessage,
  ConversationSessionSummary,
  ConversationSnapshot,
  Note,
  OpenedDocument,
  PendingNoteProposal,
  RecentDocument
} from '../../shared';

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString();

marked.setOptions({ breaks: true, gfm: true });
marked.use(markedKatex({ throwOnError: false }));

// Lightweight, safe-enough markdown rendering for assistant replies.
// We disallow raw HTML by escaping it first so model output can't inject scripts.
function renderMarkdown(source: string) {
  const escaped = source
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return marked.parse(escaped, { async: false }) as string;
}

function MarkdownContent({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  // eslint-disable-next-line react/no-danger
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

type PageRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type NormalizedRect = PageRect;

type PdfSelection = {
  quote: string;
  pageIndex: number;
  pageRect: PageRect;
  normalizedRect: NormalizedRect;
  normalizedClientRects: NormalizedRect[];
};

type DraftSelection = PdfSelection & {
  documentId: string;
};

type DrawerMode = 'annotations' | 'note' | 'ai' | null;

type SelectionActionPosition = {
  left: number;
  top: number;
};

type AnchorContextMenu = SelectionActionPosition & {
  anchorId: string;
};

type BookIndexConsent = {
  conversationId: string;
  documentFingerprint: string;
  estimatedDiskBytes: number;
};

type BookIndexProgress = {
  current: number;
  total: number;
  phase: 'extracting' | 'saving';
};

type ConfirmationRequest = {
  title: string;
  message: string;
  confirmLabel?: string;
};

function findTextLayerTarget(pageFrame: HTMLElement, quote: string) {
  const spans = Array.from(pageFrame.querySelectorAll<HTMLElement>('.text-layer span'));
  const normalizedQuote = normalizeQuote(quote);
  if (!normalizedQuote || spans.length === 0) return null;
  const tokens = normalizedQuote.split(/\s+/).filter((token) => token.length >= 8).sort((a, b) => b.length - a.length);
  const candidates = tokens.length > 0 ? tokens : [normalizedQuote.slice(0, 24)];
  return spans.find((span) => {
    const text = normalizeQuote(span.textContent ?? '');
    return candidates.some((candidate) => text.includes(candidate));
  }) ?? null;
}

type SelectionGeometry = {
  pageIndex: number;
  pageBounds: DOMRect;
  selectedRect: DOMRect;
  clientRects: DOMRect[];
};

const DEFAULT_SCALE = 1.5;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const PAGE_WINDOW_RADIUS = 3;
const MAX_OUTPUT_SCALE = 2;
const FALLBACK_PAGE_DIMENSIONS = { width: 612, height: 792 };
const MIN_SELECTION_RECT_SIZE = 0.5;
const SELECTION_LINE_TOLERANCE = 3;
const SELECTION_MERGE_GAP = 6;
const SELECTION_HORIZONTAL_PADDING = 1.5;
const SELECTION_VERTICAL_PADDING = 1;

const DRAWER_MIN = 300;
const DRAWER_DEFAULT = 380;
const DRAWER_MAX = 560;

type AiView = 'chat' | 'list';

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function nextZoom(current: number, direction: -1 | 1) {
  const floor = Math.round(current * 100);
  let step = 5;
  if (floor >= 100 && floor <= 200) step = 10;
  if (floor > 200) step = 25;
  const next = floor + direction * step;
  return clamp(next / 100, MIN_SCALE, MAX_SCALE);
}

function getSelectionGeometry(selection: Selection): SelectionGeometry | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer as Element
    : range.startContainer.parentElement;
  const pageWrapper = startElement?.closest<HTMLElement>('[data-page-index]');
  if (!pageWrapper) {
    return null;
  }

  const pageBounds = pageWrapper.getBoundingClientRect();
  const selectedRect = range.getBoundingClientRect();
  const clientRects = Array.from(range.getClientRects());
  if (pageBounds.width <= 0 || pageBounds.height <= 0 || clientRects.length === 0) {
    return null;
  }

  const pageIndex = Number(pageWrapper.dataset.pageIndex);
  return Number.isInteger(pageIndex) ? { pageIndex, pageBounds, selectedRect, clientRects } : null;
}

function normalizeSelectionRects({ pageBounds, clientRects }: SelectionGeometry): NormalizedRect[] {
  const clippedRects = clientRects.flatMap((clientRect) => {
    const left = clamp(clientRect.left, pageBounds.left, pageBounds.right);
    const top = clamp(clientRect.top, pageBounds.top, pageBounds.bottom);
    const right = clamp(clientRect.right, pageBounds.left, pageBounds.right);
    const bottom = clamp(clientRect.bottom, pageBounds.top, pageBounds.bottom);
    const width = right - left;
    const height = bottom - top;
    if (width < MIN_SELECTION_RECT_SIZE || height < MIN_SELECTION_RECT_SIZE) {
      return [];
    }

    return [{ left, top, right, bottom }];
  });

  const lines: Array<{ top: number; bottom: number; rects: typeof clippedRects }> = [];
  for (const rect of clippedRects.sort((left, right) => left.top - right.top || left.left - right.left)) {
    const line = lines.find((candidate) => (
      Math.abs(candidate.top - rect.top) <= SELECTION_LINE_TOLERANCE &&
      Math.abs(candidate.bottom - rect.bottom) <= SELECTION_LINE_TOLERANCE
    ));
    if (line) {
      line.rects.push(rect);
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else {
      lines.push({ top: rect.top, bottom: rect.bottom, rects: [rect] });
    }
  }

  return lines.flatMap((line) => {
    const bands: Array<{ left: number; top: number; right: number; bottom: number }> = [];
    for (const rect of line.rects.sort((left, right) => left.left - right.left)) {
      const previous = bands.at(-1);
      if (previous && rect.left - previous.right <= SELECTION_MERGE_GAP) {
        previous.right = Math.max(previous.right, rect.right);
        previous.top = Math.min(previous.top, rect.top);
        previous.bottom = Math.max(previous.bottom, rect.bottom);
      } else {
        bands.push({ ...rect });
      }
    }

    return bands.map((band) => {
      const left = clamp(band.left - SELECTION_HORIZONTAL_PADDING, pageBounds.left, pageBounds.right);
      const top = clamp(band.top - SELECTION_VERTICAL_PADDING, pageBounds.top, pageBounds.bottom);
      const right = clamp(band.right + SELECTION_HORIZONTAL_PADDING, pageBounds.left, pageBounds.right);
      const bottom = clamp(band.bottom + SELECTION_VERTICAL_PADDING, pageBounds.top, pageBounds.bottom);
      return {
        x: (left - pageBounds.left) / pageBounds.width,
        y: (top - pageBounds.top) / pageBounds.height,
        width: (right - left) / pageBounds.width,
        height: (bottom - top) / pageBounds.height
      };
    });
  });
}

function hasSameSelectionPreview(
  current: { pageIndex: number; rects: NormalizedRect[] } | null,
  nextPageIndex: number,
  nextRects: NormalizedRect[]
) {
  return current?.pageIndex === nextPageIndex &&
    current.rects.length === nextRects.length &&
    current.rects.every((rect, index) => {
      const nextRect = nextRects[index];
      return rect.x === nextRect.x &&
        rect.y === nextRect.y &&
        rect.width === nextRect.width &&
        rect.height === nextRect.height;
    });
}

  function formatRecentOpenedAt(openedAt: string) {
  const date = new Date(openedAt);
  if (Number.isNaN(date.getTime())) {
    return '打开时间未知';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function formatSessionTime(lastUsedAt: string) {
  const date = new Date(lastUsedAt);
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

type PageDimensions = {
  width: number;
  height: number;
};

type PdfPageProps = {
  pdf: PDFDocumentProxy;
  pageIndex: number;
  scale: number;
  outputScale: number;
  dimensions: PageDimensions | undefined;
  renderPriority: number | undefined;
  scrollRootRef: RefObject<HTMLElement | null>;
  anchors: Anchor[];
  notesByAnchorId: Record<string, Note[]>;
  activeAnchorId: string | null;
  hoveredAnchorId: string | null;
  draftRects: NormalizedRect[];
  onViewportChange: (pageIndex: number, isVisible: boolean) => void;
};

function getOutputScale() {
  return Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE);
}

function useOutputScale() {
  const [outputScale, setOutputScale] = useState(getOutputScale);

  useEffect(() => {
    let resolutionQuery: MediaQueryList | null = null;

    const updateOutputScale = () => {
      const devicePixelRatio = window.devicePixelRatio || 1;
      const nextOutputScale = Math.min(devicePixelRatio, MAX_OUTPUT_SCALE);
      setOutputScale((currentOutputScale) => (
        currentOutputScale === nextOutputScale ? currentOutputScale : nextOutputScale
      ));

      resolutionQuery?.removeEventListener('change', updateOutputScale);
      resolutionQuery = window.matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
      resolutionQuery.addEventListener('change', updateOutputScale);
    };

    updateOutputScale();
    window.addEventListener('resize', updateOutputScale);

    return () => {
      window.removeEventListener('resize', updateOutputScale);
      resolutionQuery?.removeEventListener('change', updateOutputScale);
    };
  }, []);

  return outputScale;
}

function PdfPage({
  pdf,
  pageIndex,
  scale,
  outputScale,
  dimensions,
  renderPriority,
  scrollRootRef,
  anchors,
  notesByAnchorId,
  activeAnchorId,
  hoveredAnchorId,
  draftRects,
  onViewportChange
}: PdfPageProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const pageDimensions = dimensions ?? FALLBACK_PAGE_DIMENSIONS;

  useEffect(() => {
    const frame = frameRef.current;
    const scrollRoot = scrollRootRef.current;
    if (!frame || !scrollRoot) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        onViewportChange(pageIndex, entry.isIntersecting);
      },
      { root: scrollRoot, threshold: [0, 0.5] }
    );

    observer.observe(frame);
    return () => {
      observer.disconnect();
      onViewportChange(pageIndex, false);
    };
  }, [onViewportChange, pageIndex, scrollRootRef]);

  useEffect(() => {
    if (renderPriority === undefined) {
      return;
    }

    const canvas = canvasRef.current;
    const textLayer = textLayerRef.current;
    if (!canvas || !textLayer) {
      return;
    }

    let cancelled = false;
    let renderTask: ReturnType<PDFPageProxy['render']> | null = null;
    let textLayerTask: TextLayer | null = null;
    let page: PDFPageProxy | null = null;
    let startTimer: number | null = null;

    const renderPage = async () => {
      try {
        page = await pdf.getPage(pageIndex + 1);
        if (cancelled) {
          return;
        }

        const viewport = page.getViewport({ scale });
        const context = canvas.getContext('2d');
        if (!context) {
          return;
        }

        frameRef.current?.style.setProperty('width', `${viewport.width}px`);
        frameRef.current?.style.setProperty('min-height', `${viewport.height}px`);
        frameRef.current?.style.setProperty('--scale-factor', `${scale}`);
        canvas.width = Math.ceil(viewport.width * outputScale);
        canvas.height = Math.ceil(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        textLayer.replaceChildren();
        textLayer.style.width = `${viewport.width}px`;
        textLayer.style.height = `${viewport.height}px`;

        renderTask = page.render({
          canvasContext: context,
          viewport,
          transform: [outputScale, 0, 0, outputScale, 0, 0]
        });
        textLayerTask = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: textLayer,
          viewport
        });
        void textLayerTask.render().catch((error: unknown) => {
          if (!cancelled) {
            console.error(`Unable to render PDF text layer for page ${pageIndex + 1}.`, error);
          }
        });
        await renderTask.promise;
      } catch (error) {
        if (!cancelled) {
          console.error(`Unable to render PDF page ${pageIndex + 1}.`, error);
        }
      }
    };

    if (renderPriority === 0) {
      void renderPage();
    } else {
      startTimer = window.setTimeout(() => {
        startTimer = null;
        void renderPage();
      }, Math.min(renderPriority * 75, 500));
    }

    return () => {
      cancelled = true;
      if (startTimer !== null) {
        window.clearTimeout(startTimer);
      }
      renderTask?.cancel();
      textLayerTask?.cancel();
      page?.cleanup();
      canvas.width = 0;
      canvas.height = 0;
      canvas.style.width = '';
      canvas.style.height = '';
      textLayer.replaceChildren();
    };
  }, [outputScale, pageIndex, pdf, renderPriority, scale]);

  return (
    <div
      className="page-frame"
      data-page-index={pageIndex}
      ref={frameRef}
      style={{
        width: `${pageDimensions.width * scale}px`,
        minHeight: `${pageDimensions.height * scale}px`
      }}
    >
      {renderPriority !== undefined ? (
        <>
          <canvas className="page-canvas" ref={canvasRef} />
          <div className="text-layer" ref={textLayerRef} />
        </>
      ) : null}
      <div className="anchor-overlay">
        {draftRects.map((rect, index) => (
          <div
            className="draft-highlight"
            key={`draft-${index}`}
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`
            }}
          />
        ))}
        {anchors.map((anchor) => (
          <div
            className={`anchor-highlight${anchor.id === activeAnchorId ? ' active' : ''}`}
            key={anchor.id}
            data-anchor-id={anchor.id}
            style={{
              left: `${anchor.normalizedRect.x * 100}%`,
              top: `${anchor.normalizedRect.y * 100}%`,
              width: `${anchor.normalizedRect.width * 100}%`,
              height: `${anchor.normalizedRect.height * 100}%`
            }}
          />
        ))}
        {anchors.flatMap((anchor) => {
          const notes = notesByAnchorId[anchor.id] ?? [];
          if (notes.length === 0 || (anchor.id !== activeAnchorId && anchor.id !== hoveredAnchorId)) {
            return [];
          }
          const latestNote = notes.at(-1);
          if (!latestNote) return [];
          return [
            <div
              className="reading-note-preview"
              key={`note-preview-${anchor.id}`}
              style={{
                left: `${Math.min(anchor.normalizedRect.x + anchor.normalizedRect.width + 0.015, 0.68) * 100}%`,
                top: `${Math.min(anchor.normalizedRect.y, 0.82) * 100}%`
              }}
            >
              <div className="reading-note-preview-header">
                <span>笔记</span>
                <span>{notes.length} 条</span>
              </div>
              <p>{latestNote.body}</p>
            </div>
          ];
        })}
      </div>
    </div>
  );
}

export function App() {
  const bridgeAvailable = typeof window.shuding !== 'undefined';
  const [selectionText, setSelectionText] = useState('选中一句话后在这里生成锚点');
  const [openedDocument, setOpenedDocument] = useState<OpenedDocument | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageDimensions, setPageDimensions] = useState<Map<number, PageDimensions>>(() => new Map());
  const [visiblePageIndices, setVisiblePageIndices] = useState<Set<number>>(() => new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [notesByAnchorId, setNotesByAnchorId] = useState<Record<string, Note[]>>({});
  const [activeAnchor, setActiveAnchor] = useState<Anchor | null>(null);
  const [hoveredAnchorId, setHoveredAnchorId] = useState<string | null>(null);
  const [draftSelection, setDraftSelection] = useState<DraftSelection | null>(null);
  const [selectionPreview, setSelectionPreview] = useState<{ pageIndex: number; rects: NormalizedRect[] } | null>(null);
  const [noteBody, setNoteBody] = useState('');
  const [noteEditorOpen, setNoteEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [noteSaveError, setNoteSaveError] = useState<string | null>(null);
  const [noteSaved, setNoteSaved] = useState(false);
  const [loadingDocument, setLoadingDocument] = useState(false);
  const [recentDocuments, setRecentDocuments] = useState<RecentDocument[]>([]);
  const [recentDocumentsExpanded, setRecentDocumentsExpanded] = useState(false);
  const [recentDocumentsError, setRecentDocumentsError] = useState<string | null>(null);
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [aiModelId, setAiModelId] = useState('');
  const [aiApiKey, setAiApiKey] = useState('');
  const [savingAiSettings, setSavingAiSettings] = useState(false);
  const [aiSettingsError, setAiSettingsError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<ConversationSnapshot | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [activeConversationContext, setActiveConversationContext] = useState<ConversationSnapshot['context'] | null>(null);
  const [conversationSessions, setConversationSessions] = useState<ConversationSessionSummary[]>([]);
  const [conversationDraft, setConversationDraft] = useState('');
  const [conversationRunning, setConversationRunning] = useState(false);
  const [speechRecognitionState, setSpeechRecognitionState] = useState<'idle' | 'listening' | 'transcribing'>('idle');
  const [speechRecognitionError, setSpeechRecognitionError] = useState<string | null>(null);
  const [assistantDraft, setAssistantDraft] = useState('');
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [pendingProposal, setPendingProposal] = useState<PendingNoteProposal | null>(null);
  const [savingProposal, setSavingProposal] = useState(false);
  const [ephemeralSummary, setEphemeralSummary] = useState('');
  const [drawerMode, setDrawerMode] = useState<DrawerMode>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(DRAWER_DEFAULT);
  const [isResizingDrawer, setIsResizingDrawer] = useState(false);
  const [aiView, setAiView] = useState<AiView>('chat');
  const [quoteExpanded, setQuoteExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectionActionPosition, setSelectionActionPosition] = useState<SelectionActionPosition | null>(null);
  const [selectionActionError, setSelectionActionError] = useState<string | null>(null);
  const [anchorContextMenu, setAnchorContextMenu] = useState<AnchorContextMenu | null>(null);
  const [bookIndexConsent, setBookIndexConsent] = useState<BookIndexConsent | null>(null);
  const [bookIndexStatus, setBookIndexStatus] = useState<'building' | 'ready' | 'declined' | 'missing'>('missing');
  const [buildingBookIndex, setBuildingBookIndex] = useState(false);
  const [bookIndexProgress, setBookIndexProgress] = useState<BookIndexProgress | null>(null);
  const [navigationNotice, setNavigationNotice] = useState<{ page: number; reason?: string } | null>(null);
  const [confirmationRequest, setConfirmationRequest] = useState<ConfirmationRequest | null>(null);
  const outputScale = useOutputScale();
  const pageSurfaceRef = useRef<HTMLElement>(null);
  const openedDocumentRef = useRef<OpenedDocument | null>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const assistantDraftRef = useRef('');
  const selectionPreviewFrameRef = useRef<number | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const conversationRunningRef = useRef(false);
  const conversationRef = useRef<ConversationSnapshot | null>(null);
  const conversationSnapshotsRef = useRef(new Map<string, ConversationSnapshot>());
  const draftSelectionRef = useRef<DraftSelection | null>(null);
  const anchorClickDownRef = useRef<{ x: number; y: number } | null>(null);
  const anchorClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveredAnchorIdRef = useRef<string | null>(null);
  const drawerResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const restoredDocumentRef = useRef<string | null>(null);
  const readingStateReadyRef = useRef<string | null>(null);
  const readingSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigationHistoryRef = useRef<Array<{ documentFingerprint: string; page: number; scrollTop: number }>>([]);
  const speechBaseDraftRef = useRef('');
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioWorkletRef = useRef<AudioWorkletNode | null>(null);
  const voiceChunkQueueRef = useRef(Promise.resolve());
  const speechCommittedRef = useRef('');
  const speechAutoSendRef = useRef(false);
  const speechStateRef = useRef<'idle' | 'listening' | 'transcribing'>('idle');
  const pushToTalkHeldRef = useRef(false);
  const sendConversationMessageRef = useRef<(content?: string) => Promise<void>>(async () => {});
  const confirmationResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const confirmationReturnFocusRef = useRef<HTMLElement | null>(null);

  function requestConfirmation(request: ConfirmationRequest) {
    return new Promise<boolean>((resolve) => {
      confirmationReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      confirmationResolverRef.current = resolve;
      setConfirmationRequest(request);
    });
  }

  function resolveConfirmation(confirmed: boolean) {
    confirmationResolverRef.current?.(confirmed);
    confirmationResolverRef.current = null;
    setConfirmationRequest(null);
    window.setTimeout(() => confirmationReturnFocusRef.current?.focus(), 0);
    confirmationReturnFocusRef.current = null;
  }

  useEffect(() => {
    openedDocumentRef.current = openedDocument;
  }, [openedDocument]);

  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  function jumpToPage(value: string) {
    const page = Number.parseInt(value, 10);
    if (!Number.isFinite(page) || page < 1 || page > pageCount) {
      setPageInput(String(currentPage));
      return;
    }
    const frame = pageSurfaceRef.current?.querySelector<HTMLElement>(`[data-page-index="${page - 1}"]`);
    if (frame) pageSurfaceRef.current?.scrollTo({ top: frame.offsetTop - 24, behavior: 'smooth' });
    setCurrentPage(page);
  }

  function fitPageWidth() {
    if (!pdf || !pageSurfaceRef.current) return;
    const page = pageDimensions.get(Math.max(currentPage - 1, 0));
    if (!page) return;
    const available = Math.max(pageSurfaceRef.current.clientWidth - 80, 320);
    setScale(clamp(available / page.width, MIN_SCALE, MAX_SCALE));
  }

  function fitWholePage() {
    if (!pdf || !pageSurfaceRef.current) return;
    const page = pageDimensions.get(Math.max(currentPage - 1, 0));
    if (!page) return;
    const availableWidth = Math.max(pageSurfaceRef.current.clientWidth - 80, 320);
    const availableHeight = Math.max(pageSurfaceRef.current.clientHeight - 64, 320);
    setScale(clamp(Math.min(availableWidth / page.width, availableHeight / page.height), MIN_SCALE, MAX_SCALE));
  }

  useEffect(() => {
    if (!confirmationRequest) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        resolveConfirmation(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [confirmationRequest]);

  useEffect(() => {
    assistantDraftRef.current = assistantDraft;
  }, [assistantDraft]);

  useEffect(() => {
    speechStateRef.current = speechRecognitionState;
  }, [speechRecognitionState]);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    conversationRef.current = conversation;
    if (conversation) {
      conversationSnapshotsRef.current.set(conversation.conversationId, conversation);
    }
  }, [conversation]);

  useEffect(() => {
    setQuoteExpanded(false);
  }, [activeConversationContext, conversation?.conversationId]);

  useEffect(() => {
    conversationRunningRef.current = conversationRunning;
  }, [conversationRunning]);

  useEffect(() => () => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    audioSourceRef.current?.disconnect();
    audioWorkletRef.current?.disconnect();
    void audioContextRef.current?.close();
  }, []);

  useEffect(() => window.shuding.subscribeVoiceEvents((event) => {
    const join = (left: string, right: string) => `${left}${left && right ? '\n' : ''}${right}`;
    if (event.type === 'partial') {
      setConversationDraft(join(speechBaseDraftRef.current, join(speechCommittedRef.current, event.text)));
      return;
    }
    speechCommittedRef.current = join(speechCommittedRef.current, event.text);
    setConversationDraft(join(speechBaseDraftRef.current, speechCommittedRef.current));
    if (event.type === 'final') {
      const sendAfterTranscription = speechAutoSendRef.current;
      speechAutoSendRef.current = false;
      setSpeechRecognitionState('idle');
      if (sendAfterTranscription && event.text.trim()) void sendConversationMessageRef.current(event.text);
    }
  }), []);

  useEffect(() => {
    draftSelectionRef.current = draftSelection;
  }, [draftSelection]);

  const clearEphemeralConversationLocal = useCallback(() => {
    conversationIdRef.current = null;
    conversationRef.current = null;
    conversationRunningRef.current = false;
    setConversationId(null);
    setConversation(null);
    setActiveConversationContext(null);
    setPendingProposal(null);
    setAssistantDraft('');
    setEphemeralSummary('');
    setToolStatus(null);
    setConversationError(null);
    setSelectionActionError(null);
    setConversationRunning(false);
    setConversationDraft('');
    setSavingProposal(false);
  }, []);

  const activateConversation = useCallback((snapshot: ConversationSnapshot, status: 'running' | 'idle' = 'idle') => {
    conversationIdRef.current = snapshot.conversationId;
    conversationRef.current = snapshot;
    conversationSnapshotsRef.current.set(snapshot.conversationId, snapshot);
    setConversation(snapshot);
    setConversationId(snapshot.conversationId);
    setActiveConversationContext(snapshot.context);
    setConversationRunning(status === 'running');
    setPendingProposal(snapshot.pendingProposal);
    setAssistantDraft('');
    setToolStatus(null);
    setConversationError(null);
    setEphemeralSummary('');
  }, []);

  const refreshConversationSessions = useCallback(async (documentFingerprint = openedDocumentRef.current?.fingerprint) => {
    if (!bridgeAvailable || !documentFingerprint) {
      setConversationSessions([]);
      return;
    }

    try {
      setConversationSessions(await window.shuding.listConversationSessions({ documentFingerprint }));
    } catch (error) {
      console.error('Unable to load conversation sessions.', error);
    }
  }, [bridgeAvailable]);

  useEffect(() => {
    if (conversation?.context.kind !== 'ephemeral-selection' || !conversationId || !bridgeAvailable) return;
    if (openedDocument?.fingerprint === conversation.context.selection.documentFingerprint) return;
    clearEphemeralConversationLocal();
  }, [bridgeAvailable, clearEphemeralConversationLocal, conversation, conversationId, openedDocument?.fingerprint]);

  const notesForAnchor = useCallback(
    (anchorId: string) => notesByAnchorId[anchorId] ?? [],
    [notesByAnchorId]
  );

  const refreshRecentDocuments = useCallback(async () => {
    if (!bridgeAvailable) {
      return;
    }

    try {
      setRecentDocuments(await window.shuding.listRecentDocuments());
    } catch (error) {
      console.error('Unable to load recent documents.', error);
      setRecentDocumentsError('最近文档暂时无法加载。');
    }
  }, [bridgeAvailable]);

  const activateOpenedDocument = useCallback(async (document: OpenedDocument) => {
    setOpenedDocument(document);
    setRecentDocumentsError(null);
    setDrawerMode(null);
    setDrawerWidth(DRAWER_DEFAULT);
    clearEphemeralConversationLocal();
    await refreshRecentDocuments();
  }, [clearEphemeralConversationLocal, refreshRecentDocuments]);

  useEffect(() => {
    void refreshRecentDocuments();
  }, [refreshRecentDocuments]);

  useEffect(() => {
    if (!bridgeAvailable) {
      return;
    }
    void window.shuding.getAiSettings().then((settings) => {
      setAiSettings(settings);
      setAiBaseUrl(settings.baseUrl);
      setAiModelId(settings.modelId);
    }).catch((error: unknown) => {
      console.error('Unable to load AI settings.', error);
      setAiSettingsError('AI 设置暂时无法加载。');
    });
  }, [bridgeAvailable]);

  useEffect(() => {
    if (!bridgeAvailable) {
      return;
    }
    return window.shuding.subscribeConversationEvents((event: ConversationEvent) => {
      void refreshConversationSessions();
      if (event.conversationId !== conversationIdRef.current) {
        return;
      }
      if (event.type === 'status') {
        setConversationRunning(event.status === 'running');
        if (event.status === 'idle') {
          setToolStatus(null);
          void refreshConversationSessions();
        }
      } else if (event.type === 'assistant_delta') {
        setAssistantDraft((current) => current + event.delta);
      } else if (event.type === 'tool') {
        setToolStatus(`${event.toolName}: ${event.status === 'running' ? '运行中' : event.status === 'completed' ? '完成' : '失败'}`);
      } else if (event.type === 'proposal') {
        setPendingProposal(event.proposal);
      } else if (event.type === 'index_consent') {
        setBookIndexConsent(event);
      } else if (event.type === 'navigate_to_page') {
        if (event.documentFingerprint !== openedDocumentRef.current?.fingerprint) return;
        const page = Math.max(1, Math.min(pageCount || event.page, event.page));
        const pageFrame = pageSurfaceRef.current?.querySelector<HTMLElement>(`[data-page-index="${page - 1}"]`);
        if (pageFrame && pageSurfaceRef.current) {
          navigationHistoryRef.current = [
            ...navigationHistoryRef.current,
            {
              documentFingerprint: openedDocumentRef.current?.fingerprint ?? event.documentFingerprint,
              page: currentPage,
              scrollTop: pageSurfaceRef.current.scrollTop
            }
          ].slice(-20);
          pageSurfaceRef.current.scrollTo({ top: Math.max(pageFrame.offsetTop - 28, 0), behavior: 'smooth' });
          setCurrentPage(page);
          setNavigationNotice({ page, reason: event.reason });
          window.setTimeout(() => setNavigationNotice(null), 5_000);
          if (event.quote) {
            const focusTarget = (attempt: number) => {
              const target = findTextLayerTarget(pageFrame, event.quote ?? '');
              if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
                target.classList.add('ai-navigation-target');
                window.setTimeout(() => target.classList.remove('ai-navigation-target'), 2_500);
              } else if (attempt < 3) {
                window.setTimeout(() => focusTarget(attempt + 1), 350);
              }
            };
            window.setTimeout(() => focusTarget(0), 350);
          }
        }
      } else if (event.type === 'auto_anchor') {
        if (event.documentFingerprint === openedDocumentRef.current?.fingerprint) {
          void saveAutoAnchor(event.page, event.quote);
        }
      } else if (event.type === 'error') {
        setConversationError(event.message);
      }
    });
  }, [bridgeAvailable, pageCount, refreshConversationSessions]);

  async function saveAutoAnchor(page: number, quote: string) {
    const documentId = openedDocumentRef.current?.fingerprint;
    if (!documentId || !quote.trim()) return;
    const locate = async (attempt: number): Promise<void> => {
      const pageFrame = pageSurfaceRef.current?.querySelector<HTMLElement>(`[data-page-index="${page - 1}"]`);
      const target = pageFrame ? findTextLayerTarget(pageFrame, quote) : null;
      if (!pageFrame || !target) {
        if (attempt < 8) window.setTimeout(() => { void locate(attempt + 1); }, 250);
        return;
      }
      const bounds = pageFrame.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0 || rect.width <= 0 || rect.height <= 0) return;
      const normalizedRect = {
        x: clamp((rect.left - bounds.left) / bounds.width, 0, 1),
        y: clamp((rect.top - bounds.top) / bounds.height, 0, 1),
        width: clamp(rect.width / bounds.width, 0.002, 1),
        height: clamp(rect.height / bounds.height, 0.002, 1)
      };
      try {
        const anchor = await window.shuding.saveAnchor({
          documentId,
          pageIndex: page - 1,
          kind: 'text',
          quote: quote.trim(),
          normalizedQuote: normalizeQuote(quote),
          pageRect: { x: rect.left - bounds.left, y: rect.top - bounds.top, width: rect.width, height: rect.height },
          normalizedRect,
          confidence: 1
        });
        setAnchors((current) => current.some((item) => item.documentId === anchor.documentId && item.pageIndex === anchor.pageIndex && item.normalizedQuote === anchor.normalizedQuote) ? current : [...current, anchor]);
      } catch (error: unknown) {
        setConversationError(`自动创建高亮失败：${error instanceof Error ? error.message : '未知错误'}`);
      }
    };
    await locate(0);
  }

  function restorePreviousReadingPosition() {
    const currentDocumentFingerprint = openedDocumentRef.current?.fingerprint;
    const previous = navigationHistoryRef.current.pop();
    if (!previous || previous.documentFingerprint !== currentDocumentFingerprint) return;
    const pageSurface = pageSurfaceRef.current;
    const pageFrame = pageSurface?.querySelector<HTMLElement>(`[data-page-index="${previous.page - 1}"]`);
    if (!pageSurface || !pageFrame) return;
    pageSurface.scrollTo({ top: Math.max(previous.scrollTop, 0), behavior: 'smooth' });
    setCurrentPage(previous.page);
    setNavigationNotice({ page: previous.page, reason: '已返回上一个阅读位置' });
    window.setTimeout(() => setNavigationNotice(null), 3_000);
  }

  useEffect(() => {
    navigationHistoryRef.current = [];
  }, [openedDocument?.fingerprint]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' || (!event.altKey && !event.ctrlKey && !event.metaKey)) return;
      if (navigationHistoryRef.current.length === 0) return;
      event.preventDefault();
      restorePreviousReadingPosition();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  async function respondToBookIndexConsent(allowed: boolean) {
    const request = bookIndexConsent;
    if (!request || !bridgeAvailable) return;
    setBookIndexConsent(null);
    if (!allowed) {
      await window.shuding.setBookIndexConsent({ documentFingerprint: request.documentFingerprint, allowed: false });
      setBookIndexStatus('declined');
      return;
    }
    if (!pdf || openedDocumentRef.current?.fingerprint !== request.documentFingerprint) {
      setConversationError('当前书籍已更改，无法建立索引。');
      return;
    }
    setBuildingBookIndex(true);
    setBookIndexProgress({ current: 0, total: pdf.numPages, phase: 'extracting' });
    try {
      await window.shuding.setBookIndexConsent({ documentFingerprint: request.documentFingerprint, allowed: true });
      const chunks: Array<{ documentFingerprint: string; pageIndex: number; chunkIndex: number; text: string }> = [];
      for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
        const page = await pdf.getPage(pageIndex + 1);
        const content = await page.getTextContent();
        const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ').trim();
        page.cleanup();
        setBookIndexProgress({ current: pageIndex + 1, total: pdf.numPages, phase: 'extracting' });
        const words = text.split(' ').filter(Boolean);
        for (let start = 0, chunkIndex = 0; start < words.length; start += 180, chunkIndex += 1) {
          const chunkText = words.slice(start, start + 180).join(' ');
          if (chunkText) chunks.push({ documentFingerprint: request.documentFingerprint, pageIndex, chunkIndex, text: chunkText });
        }
      }
      if (openedDocumentRef.current?.fingerprint !== request.documentFingerprint) return;
      setBookIndexProgress({ current: pdf.numPages, total: pdf.numPages, phase: 'saving' });
      await window.shuding.indexDocumentChunks(chunks);
      setBookIndexStatus('ready');
      setConversationError(null);
    } catch (error: unknown) {
      setConversationError(`书籍索引失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setBuildingBookIndex(false);
      setBookIndexProgress(null);
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (settingsOpen) {
        setSettingsOpen(false);
        window.setTimeout(() => settingsTriggerRef.current?.focus(), 0);
        return;
      }
      if (anchorContextMenu) {
        setAnchorContextMenu(null);
        return;
      }
      if (drawerMode) {
        setDrawerMode(null);
        return;
      }
      setDraftSelection(null);
      setSelectionActionPosition(null);
      window.getSelection()?.removeAllRanges();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [anchorContextMenu, drawerMode, settingsOpen]);

  useEffect(() => {
    if (!pdf) {
      return;
    }

    const updatePreview = () => {
      if (selectionPreviewFrameRef.current !== null) {
        return;
      }
      selectionPreviewFrameRef.current = window.requestAnimationFrame(() => {
        selectionPreviewFrameRef.current = null;
        const selection = window.getSelection();
        const geometry = selection ? getSelectionGeometry(selection) : null;
        if (!geometry) {
          setSelectionPreview((current) => current ? null : current);
          return;
        }

        const rects = normalizeSelectionRects(geometry);
        setSelectionPreview((current) => hasSameSelectionPreview(current, geometry.pageIndex, rects)
          ? current
          : { pageIndex: geometry.pageIndex, rects });
      });
    };

    document.addEventListener('selectionchange', updatePreview);
    return () => {
      document.removeEventListener('selectionchange', updatePreview);
      if (selectionPreviewFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionPreviewFrameRef.current);
        selectionPreviewFrameRef.current = null;
      }
    };
  }, [pdf]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!draftSelection || !(event.target instanceof Element)) {
        return;
      }
      if (event.target.closest('.text-layer, .selection-action-bar, .drawer')) {
        return;
      }

      setDraftSelection(null);
      setSelectionPreview(null);
      setSelectionActionPosition(null);
      setSelectionActionError(null);
      window.getSelection()?.removeAllRanges();
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [draftSelection]);

  useEffect(() => {
    if (!anchorContextMenu) return;
    const closeMenu = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.anchor-context-menu')) return;
      setAnchorContextMenu(null);
    };
    document.addEventListener('pointerdown', closeMenu);
    return () => document.removeEventListener('pointerdown', closeMenu);
  }, [anchorContextMenu]);

  useEffect(() => {
    if (!activeAnchor || !bridgeAvailable) {
      return;
    }
    let cancelled = false;
    void window.shuding.openConversation({ kind: 'saved-anchor', anchorId: activeAnchor.id }).then((snapshot) => {
      if (!cancelled) {
        activateConversation(snapshot);
        void refreshConversationSessions();
      }
    }).catch((error: unknown) => {
      if (!cancelled) {
        const details = error instanceof Error ? error.message : '未知错误';
        setConversationError(`对话无法打开：${details}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeAnchor?.id, activateConversation, bridgeAvailable, refreshConversationSessions]);

  const activateAnchor = useCallback((anchor: Anchor, shouldScroll = true, note?: Note, draftBody?: string) => {
    setActiveAnchor(anchor);
    setDraftSelection(null);
    setSelectionText(anchor.quote);
    const anchorNotes = notesByAnchorId[anchor.id] ?? [];
    setNoteBody(draftBody ?? note?.body ?? anchorNotes.at(-1)?.body ?? '');
    setNoteEditorOpen(Boolean(draftBody));

    if (!shouldScroll) {
      return;
    }

    const pageSurface = pageSurfaceRef.current;
    const pageFrame = pageSurface?.querySelector<HTMLElement>(`[data-page-index="${anchor.pageIndex}"]`);
    if (pageSurface && pageFrame) {
      pageSurface.scrollTo({ top: Math.max(pageFrame.offsetTop - 28, 0), behavior: 'smooth' });
    }
  }, [notesByAnchorId]);

  const onViewportChange = useCallback((pageIndex: number, isVisible: boolean) => {
    setVisiblePageIndices((current) => {
      const hasPage = current.has(pageIndex);
      if (hasPage === isVisible) {
        return current;
      }

      const next = new Set(current);
      if (isVisible) {
        next.add(pageIndex);
      } else {
        next.delete(pageIndex);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const pageSurface = pageSurfaceRef.current;
    if (!pageSurface || pageCount === 0) return;

    let frame = 0;
    const updateCurrentPage = () => {
      frame = 0;
      const surfaceTop = pageSurface.getBoundingClientRect().top;
      const frames = Array.from(pageSurface.querySelectorAll<HTMLElement>('[data-page-index]'));
      let current = 1;
      for (const pageFrame of frames) {
        const pageIndex = Number(pageFrame.dataset.pageIndex);
        if (Number.isInteger(pageIndex) && pageFrame.getBoundingClientRect().top <= surfaceTop + 32) {
          current = pageIndex + 1;
        } else {
          break;
        }
      }
      setCurrentPage((previous) => previous === current ? previous : current);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(updateCurrentPage);
    };

    updateCurrentPage();
    pageSurface.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      pageSurface.removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [pageCount, scale]);

  useEffect(() => {
    const findAnchorElement = (x: number, y: number): HTMLElement | null => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('.anchor-highlight'));
      let match: HTMLElement | null = null;
      let matchArea = Number.POSITIVE_INFINITY;
      for (const element of candidates) {
        const rect = element.getBoundingClientRect();
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
          continue;
        }
        const area = rect.width * rect.height;
        if (area < matchArea) {
          match = element;
          matchArea = area;
        }
      }
      return match;
    };

    const activateFromClick = (element: HTMLElement) => {
      const anchorId = element.dataset.anchorId;
      if (!anchorId) return;
      const anchor = anchors.find((item) => item.id === anchorId);
      if (!anchor) return;
      activateAnchor(anchor, false);
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest('.text-layer, .drawer, .selection-action-bar')) {
        anchorClickDownRef.current = { x: event.clientX, y: event.clientY };
      } else {
        anchorClickDownRef.current = null;
      }
    };

    const onMouseUp = (event: MouseEvent) => {
      const down = anchorClickDownRef.current;
      anchorClickDownRef.current = null;
      if (!down) return;
      const distance = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      if (distance > 6) return;
      const element = findAnchorElement(event.clientX, event.clientY);
      if (!element) return;
      if (anchorClickTimerRef.current !== null) clearTimeout(anchorClickTimerRef.current);
      anchorClickTimerRef.current = setTimeout(() => {
        anchorClickTimerRef.current = null;
        const fresh = findAnchorElement(event.clientX, event.clientY);
        if (fresh) activateFromClick(fresh);
      }, 220);
    };

    const onDoubleClick = () => {
      if (anchorClickTimerRef.current !== null) {
        clearTimeout(anchorClickTimerRef.current);
        anchorClickTimerRef.current = null;
      }
    };

    const onMouseMove = (event: MouseEvent) => {
      if (anchorHoverTimerRef.current !== null) clearTimeout(anchorHoverTimerRef.current);
      anchorHoverTimerRef.current = setTimeout(() => {
        anchorHoverTimerRef.current = null;
        const element = findAnchorElement(event.clientX, event.clientY);
        document.querySelectorAll('.page-frame').forEach((frame) => {
          frame.classList.toggle('has-highlight-hover', false);
        });
        const frame = element?.closest('.page-frame');
        if (frame) frame.classList.add('has-highlight-hover');
        const anchorId = element?.dataset.anchorId ?? null;
        if (hoveredAnchorIdRef.current !== anchorId) {
          hoveredAnchorIdRef.current = anchorId;
          setHoveredAnchorId(anchorId);
        }
      }, 0);
    };

    const onContextMenu = (event: MouseEvent) => {
      const element = findAnchorElement(event.clientX, event.clientY);
      if (!element) return;
      const anchorId = element.dataset.anchorId;
      const anchor = anchors.find((item) => item.id === anchorId);
      if (!anchorId || !anchor) return;

      event.preventDefault();
      activateAnchor(anchor, false);
      setAnchorContextMenu({
        anchorId,
        left: clamp(event.clientX, 8, Math.max(8, window.innerWidth - 190)),
        top: clamp(event.clientY, 8, Math.max(8, window.innerHeight - 220))
      });
    };

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('dblclick', onDoubleClick);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('contextmenu', onContextMenu);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('dblclick', onDoubleClick);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('contextmenu', onContextMenu);
      if (anchorClickTimerRef.current !== null) clearTimeout(anchorClickTimerRef.current);
      if (anchorHoverTimerRef.current !== null) clearTimeout(anchorHoverTimerRef.current);
    };
  }, [activateAnchor, anchors]);

  const summary = useMemo(() => normalizeQuote(selectionText), [selectionText]);
  const conversationQuote = activeConversationContext?.kind === 'ephemeral-selection'
    ? activeConversationContext.selection.quote
    : activeConversationContext?.kind === 'saved-anchor'
      ? anchors.find((anchor) => anchor.id === activeConversationContext.anchorId)?.quote ?? summary
      : null;
  const pageRenderPriorities = useMemo(() => {
    const visiblePages = Array.from(visiblePageIndices);
    if (visiblePages.length === 0) {
      return new Map<number, number>();
    }

    const currentPageIndex = Math.min(Math.max(currentPage - 1, 0), pageCount - 1);
    const primaryPageIndex = visiblePageIndices.has(currentPageIndex)
      ? currentPageIndex
      : visiblePages[0];
    const centers = [primaryPageIndex, ...visiblePages.filter((pageIndex) => pageIndex !== primaryPageIndex)];
    const candidates = new Set<number>();

    for (const pageIndex of centers) {
      const start = Math.max(0, pageIndex - PAGE_WINDOW_RADIUS);
      const end = Math.min(pageCount - 1, pageIndex + PAGE_WINDOW_RADIUS);
      for (let index = start; index <= end; index += 1) {
        candidates.add(index);
      }
    }

    return new Map(
      Array.from(candidates)
        .sort((left, right) => {
          const leftDistance = Math.abs(left - primaryPageIndex);
          const rightDistance = Math.abs(right - primaryPageIndex);
          if (leftDistance !== rightDistance) {
            return leftDistance - rightDistance;
          }
          return left - right;
        })
        .map((pageIndex, priority) => [pageIndex, priority])
    );
  }, [currentPage, pageCount, visiblePageIndices]);

  useEffect(() => {
    if (!pdf) {
      return;
    }

    const onMouseUp = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('.drawer, .selection-action-bar')) {
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setDraftSelection(null);
        setSelectionPreview(null);
        setSelectionActionPosition(null);
        return;
      }

      const text = selection.toString().trim();
      if (!text) {
        setDraftSelection(null);
        setSelectionPreview(null);
        setSelectionActionPosition(null);
        return;
      }

      const geometry = getSelectionGeometry(selection);
      if (!geometry) {
        setSelectionPreview(null);
        return;
      }

      const { pageBounds, selectedRect } = geometry;
      const left = Math.max(selectedRect.left, pageBounds.left);
      const top = Math.max(selectedRect.top, pageBounds.top);
      const right = Math.min(selectedRect.right, pageBounds.right);
      const bottom = Math.min(selectedRect.bottom, pageBounds.bottom);
      if (right <= left || bottom <= top) {
        setSelectionPreview(null);
        return;
      }

      const pageRect: PageRect = {
        x: left - pageBounds.left,
        y: top - pageBounds.top,
        width: right - left,
        height: bottom - top
      };

      const normalizedRect: NormalizedRect = {
        x: pageRect.x / Math.max(pageBounds.width, 1),
        y: pageRect.y / Math.max(pageBounds.height, 1),
        width: pageRect.width / Math.max(pageBounds.width, 1),
        height: pageRect.height / Math.max(pageBounds.height, 1)
      };
      const normalizedClientRects = geometry.clientRects.flatMap((clientRect) => {
        const clientLeft = Math.max(clientRect.left, pageBounds.left);
        const clientTop = Math.max(clientRect.top, pageBounds.top);
        const clientRight = Math.min(clientRect.right, pageBounds.right);
        const clientBottom = Math.min(clientRect.bottom, pageBounds.bottom);
        if (clientRight <= clientLeft || clientBottom <= clientTop) {
          return [];
        }

        return [{
          x: (clientLeft - pageBounds.left) / Math.max(pageBounds.width, 1),
          y: (clientTop - pageBounds.top) / Math.max(pageBounds.height, 1),
          width: (clientRight - clientLeft) / Math.max(pageBounds.width, 1),
          height: (clientBottom - clientTop) / Math.max(pageBounds.height, 1)
        }];
      });
      if (normalizedClientRects.length === 0) {
        setSelectionPreview(null);
        return;
      }

      const nextSelection: PdfSelection = {
        quote: text,
        pageIndex: geometry.pageIndex,
        pageRect,
        normalizedRect,
        normalizedClientRects
      };

      const documentId = openedDocumentRef.current?.fingerprint;
      if (!documentId) {
        return;
      }

       setSelectionText(text);
       setActiveAnchor(null);
       draftSelectionRef.current = { ...nextSelection, documentId };
       setDraftSelection({ ...nextSelection, documentId });
       setSelectionPreview({ pageIndex: geometry.pageIndex, rects: normalizeSelectionRects(geometry) });
       setNoteBody('');
       setNoteSaveError(null);
       setNoteSaved(false);
       setSelectionActionError(null);
       setSelectionActionPosition({
         left: Math.min(Math.max(selectedRect.left + selectedRect.width / 2, 112), window.innerWidth - 112),
         top: Math.max(selectedRect.top - 10, 12)
       });
    };

    document.addEventListener('mouseup', onMouseUp);
    return () => document.removeEventListener('mouseup', onMouseUp);
  }, [pdf]);

  useEffect(() => {
    if (!openedDocument) {
      setPdf(null);
      setPageCount(0);
      setPageDimensions(new Map());
      setVisiblePageIndices(new Set());
      setCurrentPage(1);
      setScale(DEFAULT_SCALE);
      restoredDocumentRef.current = null;
      readingStateReadyRef.current = null;
       setAnchors([]);
       setNotesByAnchorId({});
        setActiveAnchor(null);
        setDraftSelection(null);
        setNoteBody('');
        setSelectionActionPosition(null);
       return;
    }

    let cancelled = false;
    void (async () => {
      const loaded = await getDocument({ data: openedDocument.data }).promise;
      const dimensions = new Map<number, PageDimensions>();
      for (let pageNumber = 1; pageNumber <= loaded.numPages; pageNumber += 1) {
        const page = await loaded.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        page.cleanup();
        dimensions.set(pageNumber - 1, { width: viewport.width, height: viewport.height });
      }

      if (!cancelled) {
        setPageDimensions(dimensions);
        setVisiblePageIndices(new Set());
        setPdf(loaded);
        setPageCount(loaded.numPages);
        setCurrentPage(1);
        readingStateReadyRef.current = null;
      }
    })().catch((error: unknown) => {
      if (!cancelled) {
        console.error('Unable to open PDF document.', error);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [openedDocument]);

  useEffect(() => {
    if (!openedDocument) {
      setConversationSessions([]);
      setBookIndexStatus('missing');
      return;
    }
    void refreshConversationSessions(openedDocument.fingerprint);
    void window.shuding.getBookIndexStatus(openedDocument.fingerprint).then(setBookIndexStatus).catch((error: unknown) => {
      console.error('Unable to load book index status.', error);
    });
  }, [openedDocument, refreshConversationSessions]);

  useEffect(() => {
    if (!pdf || !openedDocument) {
      return;
    }
    const fingerprint = openedDocument.fingerprint;
    if (restoredDocumentRef.current === fingerprint) {
      return;
    }
    let cancelled = false;
    void window.shuding.getReadingState(fingerprint).then((state) => {
      if (cancelled || openedDocumentRef.current?.fingerprint !== fingerprint) {
        return;
      }
      if (!state) {
        restoredDocumentRef.current = fingerprint;
        readingStateReadyRef.current = fingerprint;
        return;
      }
      if (state.scale >= MIN_SCALE && state.scale <= MAX_SCALE) {
        setScale(state.scale);
      }
      if (state.currentPage >= 1 && state.currentPage <= pageCount) {
        setCurrentPage(state.currentPage);
      }
      const restoreScroll = () => {
        const pageSurface = pageSurfaceRef.current;
        if (pageSurface) {
          const pageFrame = pageSurface.querySelector<HTMLElement>(`[data-page-index="${state.currentPage - 1}"]`);
          const pageOffset = typeof state.pageOffset === 'number' && Number.isFinite(state.pageOffset)
            ? Math.max(0, Math.min(1, state.pageOffset))
            : null;
          const restoredTop = pageFrame && pageOffset !== null
            ? pageFrame.offsetTop + pageOffset * pageFrame.offsetHeight
            : state.scrollTop ?? 0;
          pageSurface.scrollTo({ top: Math.max(restoredTop, 0), behavior: 'auto' });
        }
        restoredDocumentRef.current = fingerprint;
        readingStateReadyRef.current = fingerprint;
      };
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(restoreScroll);
      });
    }).catch((error: unknown) => {
      console.error('Unable to restore reading state.', error);
    });
    return () => {
      cancelled = true;
    };
  }, [pdf, openedDocument, pageCount]);

  useEffect(() => {
    if (!openedDocument || !bridgeAvailable) {
      return;
    }
    const fingerprint = openedDocument.fingerprint;
    if (readingStateReadyRef.current !== fingerprint) {
      return;
    }
    if (readingSaveTimerRef.current) {
      clearTimeout(readingSaveTimerRef.current);
    }
    readingSaveTimerRef.current = setTimeout(() => {
      const pageSurface = pageSurfaceRef.current;
      const scrollTop = pageSurface?.scrollTop ?? 0;
      const pageFrame = pageSurface?.querySelector<HTMLElement>(`[data-page-index="${Math.max(currentPage - 1, 0)}"]`);
      const pageOffset = pageFrame && pageFrame.offsetHeight > 0
        ? Math.max(0, Math.min(1, (scrollTop - pageFrame.offsetTop) / pageFrame.offsetHeight))
        : undefined;
      void window.shuding.saveReadingState({ documentFingerprint: fingerprint, scale, currentPage, scrollTop, pageOffset }).catch((error: unknown) => {
        console.error('Unable to save reading state.', error);
      });
    }, 400);
    return () => {
      if (readingSaveTimerRef.current) {
        clearTimeout(readingSaveTimerRef.current);
      }
    };
  }, [openedDocument, scale, currentPage, bridgeAvailable]);

  useEffect(() => {
    if (!openedDocument) {
      return;
    }

    let cancelled = false;
     setAnchors([]);
     setNotesByAnchorId({});
     setActiveAnchor(null);
     setDraftSelection(null);
     setNoteBody('');
     setSelectionActionPosition(null);

    void (async () => {
      const loadedAnchors = await window.shuding.loadAnchors(openedDocument.fingerprint);
      const loadedNotes = await window.shuding.loadNotes(loadedAnchors.map((anchor) => anchor.id));
      if (cancelled) {
        return;
      }

      const groupedNotes = loadedNotes.reduce<Record<string, Note[]>>((groups, note) => {
        (groups[note.anchorId] ??= []).push(note);
        return groups;
      }, {});
      setAnchors(loadedAnchors);
      setNotesByAnchorId(groupedNotes);
    })().catch((error: unknown) => {
      if (!cancelled) {
        console.error('Unable to load document annotations.', error);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [openedDocument]);

  async function openDocument() {
    if (!bridgeAvailable) {
      setRecentDocumentsError('桌面桥接未加载，无法打开文档。');
      return;
    }

    setLoadingDocument(true);
    try {
      const document = await window.shuding.openDocument('');
      if (document) {
        await activateOpenedDocument(document);
      }
    } catch (error) {
      console.error('Unable to open document.', error);
      setRecentDocumentsError('文档无法打开。');
    } finally {
      setLoadingDocument(false);
    }
  }

  async function openRecentDocument(id: string) {
    if (!bridgeAvailable) {
      setRecentDocumentsError('桌面桥接未加载，无法打开最近文档。');
      return;
    }

    setLoadingDocument(true);
    setRecentDocumentsError(null);
    try {
      const document = await window.shuding.openRecentDocument(id);
      if (!document) {
        setRecentDocumentsError('该文件已移动、删除或无法读取。当前文档未更改。');
        await refreshRecentDocuments();
        return;
      }

      await activateOpenedDocument(document);
    } catch (error) {
      console.error('Unable to open recent document.', error);
      setRecentDocumentsError('该最近文档无法打开。当前文档未更改。');
    } finally {
      setLoadingDocument(false);
    }
  }

  async function saveCurrentNote() {
    if (!bridgeAvailable) {
      setNoteSaveError('桌面桥接未加载。请完全重启开发应用后再试。');
      return;
    }
    if (conversationRunning) {
      setNoteSaveError('请先停止当前回答，再保存笔记。');
      return;
    }

    const body = noteBody.trim();
    const currentDocumentId = openedDocumentRef.current?.fingerprint;
    if (!body) {
      setNoteSaveError('请输入笔记内容。');
      return;
    }
    if (!currentDocumentId) {
      setNoteSaveError('当前文档尚未准备好，请稍后再试。');
      return;
    }

    const selectionToSave = draftSelectionRef.current ?? draftSelection;
    const anchorToUpdate = activeAnchor;
    if ((!selectionToSave || selectionToSave.documentId !== currentDocumentId) &&
      (!anchorToUpdate || anchorToUpdate.documentId !== currentDocumentId)) {
      setNoteSaveError('当前选区已失效，请重新选中文本。');
      return;
    }

    setSaving(true);
    setNoteSaveError(null);
    setNoteSaved(false);
    let createdAnchor: Anchor | null = null;
    try {
      const currentConversation = conversationRef.current;
      const hasMatchingEphemeralConversation = Boolean(
        selectionToSave &&
        currentConversation?.context.kind === 'ephemeral-selection' &&
        currentConversation.context.selection.documentFingerprint === selectionToSave.documentId &&
        currentConversation.context.selection.pageIndex === selectionToSave.pageIndex &&
        currentConversation.context.selection.quote === selectionToSave.quote
      );

      if (hasMatchingEphemeralConversation && currentConversation) {
        const result = await window.shuding.finalizeEphemeral({
          conversationId: currentConversation.conversationId,
          documentFingerprint: currentDocumentId,
          proposalId: pendingProposal?.conversationId === currentConversation.conversationId ? pendingProposal.id : undefined,
          body
        });
        if (openedDocumentRef.current?.fingerprint !== currentDocumentId) return;
        setAnchors((current) => [...current, result.anchor]);
        if (result.note) {
          setNotesByAnchorId((current) => ({
            ...current,
            [result.note!.anchorId]: [...(current[result.note!.anchorId] ?? []), result.note!]
          }));
        }
        setActiveAnchor(result.anchor);
        setSelectionText(result.anchor.quote);
        setDraftSelection(null);
        setSelectionPreview(null);
        setSelectionActionPosition(null);
        setActiveConversationContext({ kind: 'saved-anchor', anchorId: result.anchor.id });
        setConversation((current) => current ? {
          ...current,
          context: { kind: 'saved-anchor', anchorId: result.anchor.id },
          pendingProposal: null
        } : current);
        setPendingProposal(null);
        setNoteEditorOpen(false);
        setNoteSaved(true);
        void refreshConversationSessions();
        return;
      }

      let anchor: Anchor;
      if (anchorToUpdate) {
        anchor = anchorToUpdate;
      } else if (selectionToSave) {
        const selection = selectionToSave;
        anchor = await window.shuding.saveAnchor({
          documentId: selection.documentId,
          pageIndex: selection.pageIndex,
          kind: 'text',
          quote: selection.quote,
          normalizedQuote: normalizeQuote(selection.quote),
          pageRect: selection.pageRect,
          normalizedRect: selection.normalizedRect
        });
        createdAnchor = anchor;
      } else {
        return;
      }

      if (openedDocumentRef.current?.fingerprint !== currentDocumentId) {
        if (createdAnchor) {
          await window.shuding.deleteAnchor({ anchorId: createdAnchor.id });
          createdAnchor = null;
        }
        return;
      }

      const savedNote = await window.shuding.saveNote({ anchorId: anchor.id, body });
      if (openedDocumentRef.current?.fingerprint === currentDocumentId) {
        if (createdAnchor) {
          const savedAnchor = createdAnchor;
          setAnchors((current) => [...current, savedAnchor]);
          setActiveAnchor(anchor);
          setSelectionText(anchor.quote);
          setDraftSelection(null);
          setSelectionPreview(null);
          setSelectionActionPosition(null);
        }
        setNotesByAnchorId((current) => ({
          ...current,
          [savedNote.anchorId]: [...(current[savedNote.anchorId] ?? []), savedNote]
        }));
        setNoteEditorOpen(false);
        setNoteSaved(true);
      }
    } catch (error) {
      if (createdAnchor) {
        await window.shuding.deleteAnchor({ anchorId: createdAnchor.id }).catch((cleanupError: unknown) => {
          console.error('Unable to clean up unsaved annotation.', cleanupError);
        });
      }
      console.error('Unable to save note.', error);
      const details = error instanceof Error ? error.message : '未知错误';
      setNoteSaveError(`笔记保存失败：${details}`);
    } finally {
      setSaving(false);
    }
  }

  function openDraftNoteEditor() {
    setDrawerMode('note');
    setNoteEditorOpen(true);
    setNoteSaveError(null);
    setNoteSaved(false);
    setSelectionActionPosition(null);
  }

  async function saveDraftHighlight() {
    if (!bridgeAvailable) {
      setSelectionActionError('桌面桥接未加载，无法保存高亮。');
      return;
    }

    const selection = draftSelectionRef.current;
    const currentDocumentId = openedDocumentRef.current?.fingerprint;
    if (!selection || !currentDocumentId || selection.documentId !== currentDocumentId) {
      setSelectionActionError('所选文本已不属于当前文档。');
      return;
    }

    setSelectionActionError(null);
    try {
      const anchor = await window.shuding.saveAnchor({
        documentId: selection.documentId,
        pageIndex: selection.pageIndex,
        kind: 'text',
        quote: selection.quote,
        normalizedQuote: normalizeQuote(selection.quote),
        pageRect: selection.pageRect,
        normalizedRect: selection.normalizedRect
      });

      if (openedDocumentRef.current?.fingerprint !== currentDocumentId) {
        await window.shuding.deleteAnchor({ anchorId: anchor.id });
        return;
      }

      setAnchors((current) => [...current, anchor]);
      setSelectionText(anchor.quote);
      setDraftSelection(null);
      setSelectionPreview(null);
      setSelectionActionPosition(null);
      window.getSelection()?.removeAllRanges();
    } catch (error) {
      console.error('Unable to save highlight.', error);
      const details = error instanceof Error ? error.message : '未知错误';
      setSelectionActionError(`高亮保存失败：${details}`);
    }
  }

  async function askAiAboutDraft() {
    if (!bridgeAvailable) {
      setSelectionActionError('桌面桥接未加载，无法打开 AI 对话。');
      return;
    }
    const selection = draftSelection;
    const currentDocumentId = openedDocumentRef.current?.fingerprint;
    if (!selection || !currentDocumentId || selection.documentId !== currentDocumentId) {
      setSelectionActionError('所选文本已不属于当前文档。');
      return;
    }
    const previousConversation = conversationRef.current;
    const previousConversationId = conversationIdRef.current;
    if (previousConversationId && previousConversation?.context.kind === 'ephemeral-selection' && conversationRunningRef.current) {
      if (!await requestConfirmation({ title: '切换 AI 对话？', message: '当前回答会被停止，并改为询问新选区。', confirmLabel: '切换对话' })) {
        return;
      }
      try {
        await window.shuding.discardConversation(previousConversationId);
        conversationSnapshotsRef.current.delete(previousConversationId);
        if (conversationIdRef.current === previousConversationId) {
          clearEphemeralConversationLocal();
        }
        await refreshConversationSessions();
      } catch (error: unknown) {
        const details = error instanceof Error ? error.message : '未知错误';
        setSelectionActionError(`临时对话清理失败：${details}`);
        return;
      }
    }
    if (openedDocumentRef.current?.fingerprint !== currentDocumentId) return;
    setSelectionActionError(null);
    setSelectionActionPosition(null);
    setAiView('chat');
    setDrawerMode('ai');
    try {
      const snapshot = await window.shuding.openConversation({
        kind: 'ephemeral-selection',
        selection: {
          documentFingerprint: selection.documentId,
          pageIndex: selection.pageIndex,
          quote: selection.quote,
          normalizedQuote: normalizeQuote(selection.quote),
          pageRect: selection.pageRect,
          normalizedRect: selection.normalizedRect
        }
      });
      if (openedDocumentRef.current?.fingerprint !== currentDocumentId) {
        await window.shuding.discardConversation(snapshot.conversationId);
        return;
      }
      activateConversation(snapshot);
      await refreshConversationSessions();
    } catch (error: unknown) {
      const details = error instanceof Error ? error.message : '未知错误';
      if (draftSelectionRef.current === selection) setConversationError(`对话无法打开：${details}`);
    }
  }

  async function openConversationSession(session: ConversationSessionSummary) {
    if (!bridgeAvailable || openedDocumentRef.current?.fingerprint !== session.documentFingerprint) return;
    const cached = conversationSnapshotsRef.current.get(session.conversationId);
    if (cached) {
      activateConversation(cached, session.status);
      setAiView('chat');
      setDrawerMode('ai');
      return;
    }

    try {
      const cachedContext = conversationSnapshotsRef.current.get(session.conversationId)?.context;
      const savedAnchor = session.contextKind === 'saved-anchor'
        ? anchors.find((anchor) => anchor.documentId === session.documentFingerprint && anchor.pageIndex === session.pageIndex && normalizeQuote(anchor.quote) === normalizeQuote(session.quote))
        : null;
      const context = cachedContext ?? (savedAnchor ? { kind: 'saved-anchor' as const, anchorId: savedAnchor.id } : session.contextKind === 'document' ? { kind: 'document' as const, documentFingerprint: session.documentFingerprint } : null);
      if (!context) {
        setConversationError('该对话上下文暂时无法恢复。');
        return;
      }
      if (session.contextKind === 'saved-anchor' && !savedAnchor) {
        if (context.kind !== 'saved-anchor') {
          setConversationError('该保存引用已不在当前文档中。');
          return;
        }
      }
      if (context.kind === 'ephemeral-selection' && context.selection.documentFingerprint !== session.documentFingerprint) {
        setConversationError('该对话不属于当前文档。');
        return;
      }
      const snapshot = await window.shuding.openConversation(context);
      activateConversation(snapshot, session.status);
      setAiView('chat');
      setDrawerMode('ai');
      await refreshConversationSessions();
    } catch (error: unknown) {
      const details = error instanceof Error ? error.message : '未知错误';
      setConversationError(`对话无法打开：${details}`);
    }
  }

  async function openDocumentConversation() {
    const documentFingerprint = openedDocumentRef.current?.fingerprint;
    if (!bridgeAvailable || !documentFingerprint) {
      setConversationError('请先打开一本书，再开始对话。');
      return;
    }
    setAiView('chat');
    setDrawerMode('ai');
    try {
      const snapshot = await window.shuding.openConversation({ kind: 'document', documentFingerprint });
      if (openedDocumentRef.current?.fingerprint !== documentFingerprint) return;
      activateConversation(snapshot);
      await refreshConversationSessions();
    } catch (error: unknown) {
      setConversationError(`对话无法打开：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  async function openFreshDocumentConversation() {
    const documentFingerprint = openedDocumentRef.current?.fingerprint;
    if (!bridgeAvailable || !documentFingerprint) return;
    try {
      const snapshot = await window.shuding.openConversation({ kind: 'document', documentFingerprint, fresh: true });
      if (openedDocumentRef.current?.fingerprint !== documentFingerprint) return;
      activateConversation(snapshot);
      setAiView('chat');
      setDrawerMode('ai');
      await refreshConversationSessions();
    } catch (error: unknown) {
      setConversationError(`新建对话失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  async function clearDocumentConversation() {
    const current = conversationRef.current;
    if (!current || current.context.kind !== 'document' || !bridgeAvailable) return;
    if (conversationRunningRef.current) {
      setConversationError('请先停止当前回答，再清除对话上下文。');
      return;
    }
    try {
      await window.shuding.deleteConversationSession(current.conversationId);
      conversationSnapshotsRef.current.delete(current.conversationId);
      await openFreshDocumentConversation();
    } catch (error: unknown) {
      setConversationError(`清除上下文失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  async function retryBookIndexConsent() {
    const documentFingerprint = openedDocumentRef.current?.fingerprint;
    if (!documentFingerprint || !bridgeAvailable) return;
    try {
      await window.shuding.resetBookIndexStatus(documentFingerprint);
      setBookIndexStatus('missing');
      setBookIndexConsent({ conversationId: conversationIdRef.current ?? '', documentFingerprint, estimatedDiskBytes: 80 * 1024 * 1024 });
    } catch (error: unknown) {
      setConversationError(`无法重新请求索引授权：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  async function copyDraftSelection() {
    if (!draftSelection) {
      return;
    }
    try {
      await navigator.clipboard.writeText(draftSelection.quote);
      setSelectionActionError(null);
      setSelectionActionPosition(null);
    } catch (error) {
      console.error('Unable to copy selected text.', error);
      setSelectionActionError('无法复制所选文本。');
    }
  }

  async function copyAnchorQuote(anchor: Anchor) {
    try {
      await navigator.clipboard.writeText(anchor.quote);
      setSelectionActionError(null);
    } catch (error) {
      console.error('Unable to copy anchor text.', error);
      setSelectionActionError('无法复制高亮文本。');
    } finally {
      setAnchorContextMenu(null);
    }
  }

  function openAnchorNotes(anchor: Anchor) {
    activateAnchor(anchor, false);
    setDrawerMode('note');
    setAnchorContextMenu(null);
  }

  async function openAnchorConversation(anchor: Anchor) {
    activateAnchor(anchor, false);
    setAiView('chat');
    setDrawerMode('ai');
    setAnchorContextMenu(null);
    if (!bridgeAvailable) {
      setConversationError('桌面桥接未加载，无法打开 AI 对话。');
      return;
    }
    try {
      const snapshot = await window.shuding.openConversation({ kind: 'saved-anchor', anchorId: anchor.id });
      if (openedDocumentRef.current?.fingerprint !== anchor.documentId) return;
      activateConversation(snapshot);
      await refreshConversationSessions();
    } catch (error: unknown) {
      setConversationError(`对话无法打开：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  function toggleDocumentConversation() {
    if (drawerMode === 'ai' && conversation?.context.kind === 'document') {
      setDrawerMode(null);
      return;
    }
    void openDocumentConversation();
  }

  function toggleDrawer(mode: Exclude<DrawerMode, null>) {
    setDrawerMode((current) => {
      const next = current === mode ? null : mode;
      if (next === 'ai') {
        setAiView(conversation ? 'chat' : 'list');
      }
      return next;
    });
    if (mode === 'ai') void refreshConversationSessions();
  }

  function startDrawerResize(event: React.PointerEvent<HTMLDivElement>) {
    drawerResizeRef.current = { startX: event.clientX, startWidth: drawerWidth };
    setIsResizingDrawer(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrawerResize(event: React.PointerEvent<HTMLDivElement>) {
    const drag = drawerResizeRef.current;
    if (!drag) return;
    const delta = event.clientX - drag.startX;
    setDrawerWidth(clamp(drag.startWidth - delta, DRAWER_MIN, DRAWER_MAX));
  }

  function endDrawerResize(event: React.PointerEvent<HTMLDivElement>) {
    drawerResizeRef.current = null;
    setIsResizingDrawer(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function closeSettings() {
    setSettingsOpen(false);
    window.setTimeout(() => settingsTriggerRef.current?.focus(), 0);
  }

  async function deleteCurrentAnchor(anchor: Anchor) {
    const hasNotes = notesForAnchor(anchor.id).length > 0;
    const hasConversation = conversationSessions.some((session) => (
      session.contextKind === 'saved-anchor' &&
      session.documentFingerprint === anchor.documentId &&
      session.pageIndex === anchor.pageIndex &&
      normalizeQuote(session.quote) === normalizeQuote(anchor.quote)
    )) || (
      conversationRef.current?.context.kind === 'saved-anchor' &&
      conversationRef.current.context.anchorId === anchor.id
    );

    if ((hasNotes || hasConversation) && !await requestConfirmation({ title: '删除这条高亮？', message: '关联的笔记和 AI 对话也会一并删除，此操作无法撤销。', confirmLabel: '删除高亮' })) {
      return;
    }

    await window.shuding.deleteAnchorCascade({ anchorId: anchor.id });
    if (openedDocumentRef.current?.fingerprint !== anchor.documentId) {
      return;
    }

    setAnchors((current) => current.filter((candidate) => candidate.id !== anchor.id));
    setNotesByAnchorId((current) => {
      const next = { ...current };
      delete next[anchor.id];
      return next;
    });
    if (conversationRef.current?.context.kind === 'saved-anchor' && conversationRef.current.context.anchorId === anchor.id) {
      clearEphemeralConversationLocal();
    }
    if (activeAnchor?.id === anchor.id) {
      setActiveAnchor(null);
      setSelectionText('选中一句话后在这里生成锚点');
      setNoteBody('');
    }
    void refreshConversationSessions();
  }

  async function saveAiConfiguration() {
    if (!bridgeAvailable) {
      return;
    }
    setSavingAiSettings(true);
    setAiSettingsError(null);
    try {
      const settings = await window.shuding.saveAiSettings({
        baseUrl: aiBaseUrl,
        modelId: aiModelId,
        ...(aiApiKey ? { apiKey: aiApiKey } : {})
      });
      setAiSettings(settings);
      setAiApiKey('');
    } catch (error: unknown) {
      const details = error instanceof Error ? error.message : '未知错误';
      setAiSettingsError(`AI 设置保存失败：${details}`);
    } finally {
      setSavingAiSettings(false);
    }
  }

  async function sendConversationMessage(contentOverride?: string) {
    const content = (contentOverride ?? conversationDraft).trim();
    if (!conversationId || !content || conversationRunning || !bridgeAvailable) {
      return;
    }
    const currentConversationId = conversationId;
    const currentConversation = conversation;
    setConversationDraft('');
    setConversationError(null);
    setAssistantDraft('');
    setToolStatus(null);
    setConversationRunning(true);
    setConversation((current) => current ? {
      ...current,
      messages: [...current.messages, {
        id: `pending-${Date.now()}`,
        role: 'user',
        content,
        createdAt: new Date().toISOString()
      }]
    } : current);
    try {
      await window.shuding.sendConversationMessage({ conversationId: currentConversationId, content });
      if (conversationIdRef.current !== currentConversationId) return;
      // Both saved anchors and whole-document conversations are persisted by
      // the main process. Reload them so the completed assistant message is
      // read from the source of truth; only an ephemeral selection lives solely
      // in this renderer and needs the streaming draft appended here.
      if (currentConversation && currentConversation.context.kind !== 'ephemeral-selection') {
        const snapshot = await window.shuding.openConversation(currentConversation.context);
        if (conversationIdRef.current !== currentConversationId) return;
        activateConversation(snapshot);
      } else {
        setConversation((current) => current ? {
          ...current,
          messages: [...current.messages, {
            id: `completed-${Date.now()}`,
            role: 'assistant',
            content: assistantDraftRef.current,
            createdAt: new Date().toISOString()
          }]
        } : current);
      }
      await refreshConversationSessions();
      setAssistantDraft('');
    } catch (error: unknown) {
      const details = error instanceof Error ? error.message : '未知错误';
      if (conversationIdRef.current === currentConversationId) setConversationError(`发送失败：${details}`);
    } finally {
      if (conversationIdRef.current === currentConversationId) setConversationRunning(false);
    }
  }

  // Voice events are installed once, while this function is recreated with the
  // current conversation. Keep the latest sender available to that listener.
  sendConversationMessageRef.current = sendConversationMessage;

  function stopSpeechRecognition() {
    if (speechStateRef.current !== 'listening') return;
    setSpeechRecognitionState('transcribing');
    audioWorkletRef.current?.port.postMessage('flush');
    window.setTimeout(() => {
      audioSourceRef.current?.disconnect();
      audioWorkletRef.current?.disconnect();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      void audioContextRef.current?.close();
      void voiceChunkQueueRef.current.then(() => window.shuding.stopVoiceStream()).catch((error: unknown) => {
        speechAutoSendRef.current = false;
        setSpeechRecognitionError(`无法结束实时听写：${error instanceof Error ? error.message : '未知错误'}`);
        setSpeechRecognitionState('idle');
      });
    }, 30);
  }

  function startSpeechRecognition(pushToTalk = false) {
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
        if (pushToTalk && !pushToTalkHeldRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          speechAutoSendRef.current = false;
          return;
        }
        await window.shuding.startVoiceStream();
        const context = new AudioContext();
        await context.audioWorklet.addModule(new URL('../audio/pcm-worklet.js', import.meta.url));
        const source = context.createMediaStreamSource(stream);
        const worklet = new AudioWorkletNode(context, 'pcm-capture');
        speechBaseDraftRef.current = conversationDraft;
        speechCommittedRef.current = '';
        voiceChunkQueueRef.current = Promise.resolve();
        worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
          const audio = event.data.slice().buffer as ArrayBuffer;
          voiceChunkQueueRef.current = voiceChunkQueueRef.current
            .then(() => window.shuding.pushVoiceAudio(audio))
            .catch((error: unknown) => setSpeechRecognitionError(`实时音频传输失败：${error instanceof Error ? error.message : '未知错误'}`));
        };
        source.connect(worklet);
        worklet.connect(context.destination);
        mediaStreamRef.current = stream;
        audioContextRef.current = context;
        audioSourceRef.current = source;
        audioWorkletRef.current = worklet;
        setSpeechRecognitionError(null);
        setSpeechRecognitionState('listening');
      } catch (error) {
        setSpeechRecognitionError(`无法开始实时听写：${error instanceof Error ? error.message : '未获得麦克风权限'}`);
        setSpeechRecognitionState('idle');
      }
    })();
  }

  async function startPagePushToTalk() {
    const document = openedDocumentRef.current;
    const page = currentPage;
    if (!bridgeAvailable || !document || !pdf || !aiSettings?.hasApiKey) {
      setSpeechRecognitionError('请先打开 PDF 并配置 AI，再使用按住 Y 提问。');
      return;
    }
    if (conversationRunningRef.current) {
      setSpeechRecognitionError('请等待当前回答完成后，再按住 Y 继续提问。');
      return;
    }
    try {
      let snapshot = conversationRef.current;
      const isCurrentPageVoiceSession = snapshot?.context.kind === 'ephemeral-selection' &&
        snapshot.context.selection.mode === 'voice-page' &&
        snapshot.context.selection.documentFingerprint === document.fingerprint &&
        snapshot.context.selection.pageIndex === page - 1;
      if (!isCurrentPageVoiceSession) {
        const pdfPage = await pdf.getPage(page);
        const content = await pdfPage.getTextContent();
        pdfPage.cleanup();
        const quote = content.items.map((item) => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ').trim();
        if (quote.length < 8) throw new Error('当前页没有可定位的文本');
        snapshot = await window.shuding.openConversation({
          kind: 'ephemeral-selection',
          selection: {
            documentFingerprint: document.fingerprint,
            pageIndex: page - 1,
            quote: quote.slice(0, 8_000),
            normalizedQuote: normalizeQuote(quote.slice(0, 8_000)),
            pageRect: { x: 0, y: 0, width: 1, height: 1 },
            normalizedRect: { x: 0, y: 0, width: 1, height: 1 },
            mode: 'voice-page'
          }
        });
      }
      if (openedDocumentRef.current?.fingerprint !== document.fingerprint || !snapshot) return;
      activateConversation(snapshot);
      setAiView('chat');
      setDrawerMode('ai');
      setConversationDraft('');
      speechAutoSendRef.current = true;
      if (!pushToTalkHeldRef.current) {
        speechAutoSendRef.current = false;
        return;
      }
      startSpeechRecognition(true);
    } catch (error: unknown) {
      speechAutoSendRef.current = false;
      setSpeechRecognitionError(`无法开始当前页语音提问：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  useEffect(() => {
    const isEditable = (target: EventTarget | null) => target instanceof HTMLElement && (
      target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'SELECT'
    );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'KeyY' || event.repeat || isEditable(event.target) || pushToTalkHeldRef.current) return;
      pushToTalkHeldRef.current = true;
      event.preventDefault();
      void startPagePushToTalk();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'KeyY' || !pushToTalkHeldRef.current) return;
      pushToTalkHeldRef.current = false;
      event.preventDefault();
      stopSpeechRecognition();
    };
    const onBlur = () => {
      if (!pushToTalkHeldRef.current) return;
      pushToTalkHeldRef.current = false;
      stopSpeechRecognition();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [aiSettings?.hasApiKey, bridgeAvailable, currentPage, pdf]);

  function toggleSpeechRecognition() {
    if (speechRecognitionState === 'idle') {
      startSpeechRecognition();
      return;
    }
    stopSpeechRecognition();
  }

  async function acceptProposal() {
    if (!pendingProposal || !bridgeAvailable || !conversation) {
      return;
    }

    if (conversationRunning) {
      setConversationError('请先停止当前回答，再保存这条笔记。');
      return;
    }

    setSavingProposal(true);
    setConversationError(null);
    try {
      if (conversation.context.kind === 'ephemeral-selection') {
        const documentFingerprint = openedDocumentRef.current?.fingerprint;
        const body = ephemeralSummary.trim() || pendingProposal.body;
        if (!documentFingerprint || documentFingerprint !== conversation.context.selection.documentFingerprint) {
          setConversationError('当前文档已更改，无法保存这条笔记。');
          return;
        }

        const result = await window.shuding.finalizeEphemeral({
          conversationId: pendingProposal.conversationId,
          documentFingerprint,
          proposalId: pendingProposal.id,
          body
        });
        if (openedDocumentRef.current?.fingerprint !== documentFingerprint) {
          return;
        }
        setAnchors((current) => [...current, result.anchor]);
        if (result.note) {
          setNotesByAnchorId((current) => ({
            ...current,
            [result.note!.anchorId]: [...(current[result.note!.anchorId] ?? []), result.note!]
          }));
        }
        setActiveAnchor(result.anchor);
        setSelectionText(result.anchor.quote);
        setDraftSelection(null);
        setSelectionActionPosition(null);
        setActiveConversationContext({ kind: 'saved-anchor', anchorId: result.anchor.id });
        setConversation((current) => current ? {
          ...current,
          context: { kind: 'saved-anchor', anchorId: result.anchor.id },
          pendingProposal: null
        } : current);
        setPendingProposal(null);
        setEphemeralSummary('');
        void refreshConversationSessions();
      } else {
        const savedNote = await window.shuding.confirmNoteProposal({
          conversationId: pendingProposal.conversationId,
          proposalId: pendingProposal.id
        });
        setNotesByAnchorId((current) => ({
          ...current,
          [savedNote.anchorId]: [...(current[savedNote.anchorId] ?? []), savedNote]
        }));
        setConversation((current) => current ? { ...current, pendingProposal: null } : current);
        setPendingProposal(null);
        void refreshConversationSessions();
      }
    } catch (error: unknown) {
      const details = error instanceof Error ? error.message : '未知错误';
      setConversationError(`保存建议失败：${details}`);
    } finally {
      setSavingProposal(false);
    }
  }

  async function discardProposal() {
    if (!pendingProposal || !bridgeAvailable) {
      return;
    }

    try {
      await window.shuding.discardNoteProposal(pendingProposal.id);
      setConversation((current) => current ? { ...current, pendingProposal: null } : current);
      setPendingProposal(null);
      setEphemeralSummary('');
    } catch (error: unknown) {
      const details = error instanceof Error ? error.message : '未知错误';
      setConversationError(`丢弃建议失败：${details}`);
    }
  }

  async function deleteConversationSession(conversationId: string) {
    if (!bridgeAvailable) {
      return;
    }
    if (!await requestConfirmation({ title: '删除这条 AI 对话？', message: '引用和笔记会保留，但对话记录无法恢复。', confirmLabel: '删除对话' })) {
      return;
    }
    try {
      await window.shuding.deleteConversationSession(conversationId);
      conversationSnapshotsRef.current.delete(conversationId);
      if (conversationIdRef.current === conversationId) {
        clearEphemeralConversationLocal();
      }
      await refreshConversationSessions();
    } catch (error: unknown) {
      const details = error instanceof Error ? error.message : '未知错误';
      setConversationError(`删除对话失败：${details}`);
    }
  }

  async function deleteNoteForAnchor(noteId: string, anchorId: string) {
    if (!bridgeAvailable) {
      return;
    }
    if (!await requestConfirmation({ title: '删除这条笔记？', message: '删除后无法恢复。', confirmLabel: '删除笔记' })) {
      return;
    }
    try {
      await window.shuding.deleteNote(noteId);
      setNotesByAnchorId((current) => ({
        ...current,
        [anchorId]: (current[anchorId] ?? []).filter((note) => note.id !== noteId)
      }));
    } catch (error: unknown) {
      const details = error instanceof Error ? error.message : '未知错误';
      setNoteSaveError(`删除笔记失败：${details}`);
    }
  }

  return (
    <div
      className={`shell${drawerMode ? ' drawer-open' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
      style={drawerMode ? ({ '--drawer-width': `${drawerWidth}px` } as React.CSSProperties) : undefined}
    >
      <aside className="sidebar">
        {sidebarCollapsed ? (
          <div className="sidebar-collapsed">
            <span className="sidebar-collapsed-mark" aria-hidden="true">书</span>
          </div>
        ) : (
        <>
        <div>
          <div className="brand">书钉</div>
          <p className="sidebar-copy">本地阅读与研究工作区</p>
        </div>

        <div className="sidebar-actions">
          <button className="primary" onClick={() => void openDocument()} disabled={loadingDocument}>
            {loadingDocument ? '打开中' : '导入 PDF'}
          </button>
          <div className="sidebar-status">{loadingDocument ? '请选择一个 PDF 文件' : '点击按钮后会打开系统文件选择器'}</div>
          <button
            className="ghost"
            type="button"
            aria-expanded={recentDocumentsExpanded}
            aria-controls="recent-documents-list"
            onClick={() => setRecentDocumentsExpanded((expanded) => !expanded)}
          >
            最近文档
          </button>
          {recentDocumentsExpanded ? (
            <section className="recent-documents" id="recent-documents-list" aria-label="最近文档">
              {recentDocumentsError ? <p className="recent-documents-error" role="alert">{recentDocumentsError}</p> : null}
              {recentDocuments.length > 0 ? (
                <div className="recent-documents-list">
                  {recentDocuments.slice(0, 8).map((document) => (
                    <button
                      className={`recent-document${document.fingerprint === openedDocument?.fingerprint ? ' active' : ''}`}
                      key={document.id}
                      type="button"
                      onClick={() => void openRecentDocument(document.id)}
                      disabled={loadingDocument}
                      aria-current={document.fingerprint === openedDocument?.fingerprint ? 'page' : undefined}
                    >
                      <span className="recent-document-name">{document.name}</span>
                      <small>{document.unavailable ? '文件不可用' : formatRecentOpenedAt(document.openedAt)}</small>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="recent-documents-empty">暂无最近文档。</p>
              )}
            </section>
          ) : null}
        </div>
        </>
        )}
      </aside>

      <main className="reader">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="sidebar-toggle"
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={!sidebarCollapsed}
              title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            >
              {sidebarCollapsed ? '›' : '‹'}
            </button>
            <div className="page-navigation" aria-label="页码导航">
              <button type="button" aria-label="上一页" title="上一页" onClick={() => jumpToPage(String(currentPage - 1))} disabled={!pdf || currentPage <= 1}>‹</button>
              <input aria-label="当前页码" value={pageInput} onChange={(event) => setPageInput(event.target.value)} onBlur={() => jumpToPage(pageInput)} onKeyDown={(event) => { if (event.key === 'Enter') jumpToPage(pageInput); }} disabled={!pdf} inputMode="numeric" />
              <span>/ {pageCount || '—'}</span>
              <button type="button" aria-label="下一页" title="下一页" onClick={() => jumpToPage(String(currentPage + 1))} disabled={!pdf || currentPage >= pageCount}>›</button>
            </div>
            <button
              type="button"
              className="reading-back-button"
              onClick={restorePreviousReadingPosition}
              disabled={navigationHistoryRef.current.length === 0}
              title="返回上一个阅读位置（Alt/⌘/Ctrl + ←）"
              aria-label="返回上一个阅读位置"
            >
              ↶
            </button>
          </div>
          <div className="topbar-actions">
            <div className="drawer-controls" aria-label="阅读工具">
              <button
                type="button"
                aria-expanded={drawerMode === 'annotations'}
                aria-controls="contextual-drawer"
                onClick={() => toggleDrawer('annotations')}
                title="查看文档高亮和标注"
              >
                标注
              </button>
              <button
                type="button"
                aria-expanded={drawerMode === 'note'}
                aria-controls="contextual-drawer"
                onClick={() => toggleDrawer('note')}
                title="查看或添加笔记"
              >
                笔记
              </button>
              <button
                type="button"
                aria-expanded={drawerMode === 'ai'}
                aria-controls="contextual-drawer"
                onClick={toggleDocumentConversation}
                title="打开整本书 AI 对话"
              >
                整本书
              </button>
              <button
                ref={settingsTriggerRef}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen(true)}
                title="配置 AI 服务"
              >
                设置
              </button>
            </div>
            <div className="zoom-controls" aria-label="缩放控制">
              <button type="button" aria-label="缩小" title="缩小" onClick={() => setScale((value) => nextZoom(value, -1))} disabled={!pdf || scale <= MIN_SCALE}>-</button>
              <button type="button" className="zoom-reset" title="恢复 100%" onClick={() => setScale(DEFAULT_SCALE)} disabled={!pdf || scale === DEFAULT_SCALE}>{Math.round(scale * 100)}%</button>
              <button type="button" aria-label="放大" title="放大" onClick={() => setScale((value) => nextZoom(value, 1))} disabled={!pdf || scale >= MAX_SCALE}>+</button>
              <button type="button" className="zoom-fit" title="适应阅读区宽度" onClick={fitPageWidth} disabled={!pdf}>适应宽度</button>
              <button type="button" className="zoom-fit" title="适应整页" onClick={fitWholePage} disabled={!pdf}>适应整页</button>
            </div>
          </div>
        </header>

        {navigationNotice ? (
          <div className="navigation-notice" role="status" aria-live="polite">
            <span>已跳转到第 {navigationNotice.page} 页</span>
            {navigationNotice.reason ? <small>{navigationNotice.reason}</small> : null}
          </div>
        ) : null}

        <section className="page-surface" ref={pageSurfaceRef}>
          {!pdf ? (
            <div className="page-placeholder" role="status">
              <strong>还没有打开文档</strong>
              <span>从左侧导入 PDF，开始阅读和整理标注。</span>
            </div>
          ) : (
            <div className="page-flow">
              {Array.from({ length: pageCount }, (_, pageIndex) => (
                <PdfPage
                  key={pageIndex}
                  pdf={pdf}
                  pageIndex={pageIndex}
                  scale={scale}
                  outputScale={outputScale}
                  dimensions={pageDimensions.get(pageIndex)}
                  renderPriority={pageRenderPriorities.get(pageIndex)}
                  scrollRootRef={pageSurfaceRef}
                  anchors={anchors.filter((anchor) => anchor.pageIndex === pageIndex)}
                  notesByAnchorId={notesByAnchorId}
                  activeAnchorId={activeAnchor?.id ?? null}
                  hoveredAnchorId={hoveredAnchorId}
                  draftRects={selectionPreview?.pageIndex === pageIndex
                    ? selectionPreview.rects
                    : draftSelection?.pageIndex === pageIndex
                      ? draftSelection.normalizedClientRects
                      : []}
                  onViewportChange={onViewportChange}
                />
              ))}
            </div>
          )}
        </section>
      </main>

      {drawerMode ? <button className="drawer-scrim" type="button" aria-label="关闭工作面板" onClick={() => setDrawerMode(null)} /> : null}
      {drawerMode ? (
      <aside className="drawer" id="contextual-drawer" data-resizing={isResizingDrawer || undefined} aria-label={drawerMode === 'annotations' ? '标注' : drawerMode === 'note' ? '笔记' : 'AI 对话'}>
        <div
          className="drawer-resize-handle"
          role="separator"
          aria-label="调整面板宽度"
          onPointerDown={startDrawerResize}
          onPointerMove={moveDrawerResize}
          onPointerUp={endDrawerResize}
          onPointerCancel={endDrawerResize}
          onLostPointerCapture={endDrawerResize}
        />
        <div className="drawer-header">
          <h2>{drawerMode === 'annotations' ? '标注' : drawerMode === 'note' ? '笔记' : 'AI 对话'}</h2>
          <button type="button" className="drawer-close" onClick={() => setDrawerMode(null)} aria-label="关闭侧栏">关闭</button>
        </div>
        {!bridgeAvailable ? <div className="bridge-error">桌面桥接未加载，笔记无法保存。请完全重启应用。</div> : null}
        {drawerMode === 'annotations' ? (
          <section className="drawer-section annotation-panel">
          <div className="annotation-panel-heading">
            <div>
              <p>文档标注</p>
              <strong>{anchors.length} 条高亮</strong>
            </div>
            {activeAnchor ? <span>当前：第 {activeAnchor.pageIndex + 1} 页</span> : null}
          </div>
          <div className="annotation-list">
          {anchors.map((anchor) => {
              const anchorNotes = notesForAnchor(anchor.id);
              return (
                <div className="annotation-group" key={anchor.id}>
                  <div className="annotation-heading">
                    <button
                      className={`annotation-item${anchor.id === activeAnchor?.id ? ' active' : ''}`}
                      type="button"
                      onClick={() => activateAnchor(anchor)}
                    >
                      <span className="annotation-page">{anchor.pageIndex + 1}</span>
                      <span className="annotation-copy">
                        <span className="annotation-quote">{normalizeQuote(anchor.quote)}</span>
                        <small>{anchorNotes.length > 0 ? `${anchorNotes.length} 条笔记` : '未添加笔记'}</small>
                      </span>
                    </button>
                    <button className="delete-anchor" type="button" onClick={() => void deleteCurrentAnchor(anchor)} aria-label="删除标注">
                      删除
                    </button>
                  </div>
                  {anchorNotes.slice(-2).map((note) => (
                    <div className="annotation-note-row" key={note.id}>
                      <button
                        className={`annotation-note${anchor.id === activeAnchor?.id && note.body === noteBody ? ' active' : ''}`}
                        type="button"
                        onClick={() => activateAnchor(anchor, true, note)}
                      >
                        {note.body}
                      </button>
                      <button
                        className="note-delete"
                        type="button"
                        aria-label="删除这条笔记"
                        onClick={() => void deleteNoteForAnchor(note.id, anchor.id)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  {anchorNotes.length > 2 ? <p className="annotation-more-notes">还有 {anchorNotes.length - 2} 条笔记</p> : null}
                </div>
              );
            })}
            {openedDocument && anchors.length === 0 ? <p className="annotation-empty">此文档还没有标注。</p> : null}
          </div>
          </section>
        ) : null}

        {drawerMode === 'note' ? (
          <>
          {(activeAnchor || draftSelection) ? (
            <section className="quote-context">
              <div className="quote-context-heading">
                <p className="quote-context-label">当前高亮</p>
                {activeAnchor ? <span className="anchor-meta">第 {activeAnchor.pageIndex + 1} 页</span> : draftSelection ? <span className="anchor-meta">临时选区</span> : null}
              </div>
              <p className="quote-context-preview">{summary}</p>
              {activeAnchor ? <span className="quote-context-kind">{activeAnchor.kind === 'text' ? '文本高亮' : activeAnchor.kind}</span> : null}
            </section>
          ) : null}
          <section className="drawer-section note-panel">
            <div className="note-panel-scroll">
              <div className="note-list-heading">
                <h3>笔记</h3>
                {activeAnchor ? <span>{notesForAnchor(activeAnchor.id).length} 条</span> : null}
              </div>
              {activeAnchor && notesForAnchor(activeAnchor.id).length > 0 ? (
                <div className="note-card-list">
                  {notesForAnchor(activeAnchor.id).map((note) => (
                    <article className="note-card" key={note.id}>
                      <div className="note-card-header">
                        <span>手动笔记</span>
                        <time dateTime={note.updatedAt}>{formatSessionTime(note.updatedAt)}</time>
                      </div>
                      <p>{note.body}</p>
                      <button
                        className="note-card-delete"
                        type="button"
                        aria-label="删除这条笔记"
                        onClick={() => void deleteNoteForAnchor(note.id, activeAnchor.id)}
                      >
                        删除
                      </button>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="note-empty-state">
                  <strong>{activeAnchor ? '这条高亮还没有笔记' : '先选中一段文字'}</strong>
                  <span>{activeAnchor ? '记录你对这段内容的理解' : '笔记会和高亮一起保存'}</span>
                </div>
              )}
            </div>
            {noteEditorOpen ? (
              <div className="note-editor">
                <textarea autoFocus value={noteBody} onChange={(event) => setNoteBody(event.target.value)} placeholder="记录你对这段内容的理解" />
                <div className="note-editor-actions">
                  <button type="button" onClick={() => { setNoteEditorOpen(false); setNoteBody(activeAnchor ? notesForAnchor(activeAnchor.id).at(-1)?.body ?? '' : ''); }}>取消</button>
                  <button className="primary" type="button" onClick={() => void saveCurrentNote()} disabled={(!activeAnchor && !draftSelection) || !noteBody.trim() || saving || conversationRunning}>
                    {saving ? '保存中' : '保存笔记'}
                  </button>
                </div>
                {noteSaveError ? <p className="note-status error">{noteSaveError}</p> : null}
              </div>
            ) : (
              <button className="add-note-button" type="button" onClick={() => { setNoteEditorOpen(true); setNoteSaveError(null); setNoteSaved(false); }} disabled={!activeAnchor && !draftSelection}>
                <span aria-hidden="true">+</span> 添加笔记
              </button>
            )}
            {noteSaved && !noteEditorOpen ? <p className="note-status">已保存</p> : null}
          </section>
          </>
        ) : null}

        {drawerMode === 'ai' ? (
          <>
          <div className="ai-view-tabs" role="tablist" aria-label="AI 对话视图">
            <button
              type="button"
              role="tab"
              data-active={aiView === 'chat'}
              className={`ai-view-tab${aiView === 'chat' ? ' active' : ''}`}
              aria-selected={aiView === 'chat'}
              onClick={() => setAiView('chat')}
            >
              对话
            </button>
            <button
              type="button"
              role="tab"
              data-active={aiView === 'list'}
              className={`ai-view-tab${aiView === 'list' ? ' active' : ''}`}
              aria-selected={aiView === 'list'}
              onClick={() => setAiView('list')}
            >
              会话
            </button>
          </div>
          {aiView === 'list' ? (
            <section className="session-queue" aria-labelledby="session-queue-title">
              <div className="session-queue-header">
                <h3 id="session-queue-title">最近 AI 对话</h3>
                <span>{conversationSessions.length} / 10</span>
              </div>
              {conversationSessions.length > 0 ? (
                <div className="session-list">
                  {conversationSessions.map((session) => (
                    <div
                      className={`session-item${session.conversationId === conversationId ? ' active' : ''}`}
                      key={session.conversationId}
                    >
                      <button
                        className="session-main"
                        type="button"
                        onClick={() => void openConversationSession(session)}
                        aria-current={session.conversationId === conversationId ? 'true' : undefined}
                      >
                        <span className="session-quote">{session.contextKind === 'document' ? '整本书对话' : normalizeQuote(session.quote)}</span>
                        <small>{session.contextKind === 'document' ? '未绑定引用' : `页 ${session.pageIndex + 1} · `}{formatSessionTime(session.lastUsedAt)} · {session.status === 'running' ? '运行中' : '已暂停'}</small>
                      </button>
                      <button
                        className="session-delete"
                        type="button"
                        aria-label="删除该对话"
                        onClick={() => void deleteConversationSession(session.conversationId)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="session-empty">当前文档还没有 AI 对话。</p>
              )}
            </section>
          ) : (
          <>
          {conversationQuote ? (
            <section className="quote-context">
              <p className="quote-context-label">对话引用</p>
              <div className="quote-context-meta">
                {activeConversationContext?.kind === 'ephemeral-selection'
                  ? `第 ${activeConversationContext.selection.pageIndex + 1} 页`
                  : activeConversationContext?.kind === 'saved-anchor'
                    ? `已保存引用`
                    : null}
                {typeof conversationQuote === 'string' && conversationQuote.length > 0
                  ? ` · ${conversationQuote.length} 字`
                  : null}
              </div>
              {quoteExpanded ? (
                <p className="quote-context-full">{normalizeQuote(conversationQuote)}</p>
              ) : (
                <p className="quote-context-preview">{normalizeQuote(conversationQuote)}</p>
              )}
              <button
                type="button"
                className="quote-expand-toggle"
                aria-expanded={quoteExpanded}
                onClick={() => setQuoteExpanded((value) => !value)}
              >
                {quoteExpanded ? '收起' : '展开'}
              </button>
              <button type="button" className="quote-expand-toggle quote-detach-toggle" onClick={() => void openDocumentConversation()}>
                取消引用
              </button>
            </section>
          ) : null}
          {conversation ? (
          <section className="drawer-section conversation-panel">
            {conversation.context.kind === 'document' ? (
              <div className="document-conversation-toolbar" aria-label="整本书对话操作">
                <span className="document-conversation-title">整本书对话</span>
                <div className="document-conversation-actions">
                  <button type="button" title="新建一段整本书对话" aria-label="新建对话" onClick={() => void openFreshDocumentConversation()} disabled={conversationRunning}>＋</button>
                  <button type="button" title="清除当前对话上下文" aria-label="清除上下文" onClick={() => void clearDocumentConversation()} disabled={conversationRunning}>⌫</button>
                </div>
              </div>
            ) : null}
            <div className="conversation-messages" aria-live="polite">
              {conversation?.messages.map((message: ConversationMessage) => (
                <div className={`conversation-message ${message.role}`} key={message.id}>
                  <small>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'AI' : message.toolName ?? '工具'}</small>
                  {message.role === 'assistant'
                    ? <MarkdownContent source={message.content || ''} />
                    : <p>{message.content || '已完成工具调用'}</p>}
                </div>
              ))}
              {assistantDraft ? <div className="conversation-message assistant streaming"><small>AI</small><MarkdownContent source={assistantDraft} /></div> : null}
              {!conversation && !conversationError ? <p className="annotation-empty">正在加载对话。</p> : null}
            </div>
            {toolStatus ? <p className="note-status">{toolStatus}</p> : null}
            <div className="conversation-input">
              <textarea value={conversationDraft} onChange={(event) => setConversationDraft(event.target.value)} placeholder={conversation.context.kind === 'document' ? '向这本书提问，或请 Harness 帮你查找内容' : '围绕当前引用提问'} disabled={conversationRunning || speechRecognitionState !== 'idle'} />
              <button
                className={`speech-input-button${speechRecognitionState !== 'idle' ? ' listening' : ''}`}
                type="button"
                onClick={toggleSpeechRecognition}
                disabled={conversationRunning || !aiSettings?.hasApiKey || speechRecognitionState === 'transcribing'}
                aria-label={speechRecognitionState === 'idle' ? '开始语音输入' : '停止语音输入'}
                aria-keyshortcuts="Y"
                title={speechRecognitionState === 'idle' ? '开始语音输入（按住 Y 可对当前页提问）' : '停止语音输入'}
              >
                <span aria-hidden="true">{speechRecognitionState === 'listening' ? '■' : '🎙'}</span>
              </button>
            </div>
            {speechRecognitionState === 'listening' ? <p className="voice-status" role="status">正在实时听写，临时结果会随语音修正</p> : speechRecognitionState === 'transcribing' ? <p className="voice-status" role="status">正在生成最终转写…</p> : null}
            <div className="conversation-actions">
              <button className="primary" type="button" onClick={() => void sendConversationMessage()} disabled={conversationRunning || !conversationDraft.trim() || !aiSettings?.hasApiKey}>
                发送
              </button>
              <button type="button" onClick={() => conversationId && void window.shuding.abortConversation(conversationId)} disabled={!conversationRunning}>
                停止
              </button>
            </div>
            {!aiSettings?.hasApiKey ? <p className="note-status error">保存安全 API Key 后即可开始对话。</p> : null}
            {speechRecognitionError ? <p className="note-status error">{speechRecognitionError}</p> : null}
            {conversationError ? <p className="note-status error">{conversationError}</p> : null}
            {pendingProposal ? (
              <div className="proposal-preview">
                <h3>AI 笔记建议</h3>
                {conversation.context.kind === 'ephemeral-selection' ? (
                  <textarea
                    value={ephemeralSummary}
                    onChange={(event) => setEphemeralSummary(event.target.value)}
                    placeholder={pendingProposal.body}
                    aria-label="编辑 AI 笔记建议"
                  />
                ) : <p>{pendingProposal.body}</p>}
                <div className="conversation-actions">
                  <button className="primary" type="button" onClick={() => void acceptProposal()} disabled={savingProposal || conversationRunning}>
                    {savingProposal ? '加入中' : '加入笔记'}
                  </button>
                  <button type="button" onClick={() => void discardProposal()} disabled={savingProposal}>丢弃建议</button>
                </div>
              </div>
            ) : null}
            {bookIndexConsent ? (
              <div className="book-index-consent">
                <h3>启用本书智能检索？</h3>
                <p>Harness 需要先在本机建立这本书的索引，才能查找定义、定理和相关页面。内容不会上传。</p>
                <small>预计占用约 {Math.round(bookIndexConsent.estimatedDiskBytes / 1024 / 1024)} MB 磁盘空间；构建时会使用 CPU。</small>
                <div className="conversation-actions">
                  <button className="primary" type="button" onClick={() => void respondToBookIndexConsent(true)} disabled={buildingBookIndex}>
                    {buildingBookIndex ? '正在建立索引' : '允许并建立索引'}
                  </button>
                  <button type="button" onClick={() => void respondToBookIndexConsent(false)} disabled={buildingBookIndex}>暂不启用</button>
                </div>
              </div>
            ) : null}
            {conversation.context.kind === 'document' && bookIndexStatus === 'declined' && !bookIndexConsent ? (
              <div className="book-index-declined">
                <span>你之前暂不允许建立本书索引。</span>
                <button type="button" onClick={() => void retryBookIndexConsent()}>重新允许索引</button>
              </div>
            ) : null}
            {buildingBookIndex && bookIndexProgress ? (
              <div className="book-index-progress" role="status" aria-live="polite">
                <div className="book-index-progress-heading">
                  <span>{bookIndexProgress.phase === 'saving' ? '正在保存索引' : '正在建立本书索引'}</span>
                  <strong>{bookIndexProgress.current} / {bookIndexProgress.total} 页</strong>
                </div>
                <div className="book-index-progress-track" aria-hidden="true">
                  <span style={{ width: `${Math.round((bookIndexProgress.current / Math.max(bookIndexProgress.total, 1)) * 100)}%` }} />
                </div>
                <small>{bookIndexProgress.phase === 'saving' ? '即将完成，可以继续阅读。' : '正在读取 PDF 文本，应用仍可继续使用。'}</small>
              </div>
            ) : null}
          </section>
          ) : (
            <section className="drawer-section ai-empty-state">
              <p>先选中一段文字并使用“询问 AI”，或从标注中选择已保存引用。</p>
              {!aiSettings?.hasApiKey ? <p className="note-status error">保存安全 API Key 后即可开始对话。</p> : null}
              {conversationError ? <p className="note-status error">{conversationError}</p> : null}
            </section>
          )}
          </>
          )}
          </>
        ) : null}
      </aside>
      ) : null}
      {selectionActionPosition && draftSelection ? (
        <div
          className="selection-action-bar"
          style={{ left: selectionActionPosition.left, top: selectionActionPosition.top }}
          onMouseDown={(event) => event.preventDefault()}
          role="toolbar"
          aria-label="所选文本操作"
        >
          <button type="button" onClick={() => void saveDraftHighlight()}>添加高亮</button>
          <button type="button" onClick={openDraftNoteEditor}>添加笔记</button>
          <button type="button" onClick={() => void askAiAboutDraft()}>询问 AI</button>
          <button type="button" onClick={() => void copyDraftSelection()}>复制</button>
        </div>
      ) : null}
      {selectionActionError ? <p className="selection-action-error" role="status">{selectionActionError}</p> : null}
      {anchorContextMenu ? (() => {
        const anchor = anchors.find((item) => item.id === anchorContextMenu.anchorId);
        if (!anchor) return null;
        const hasNotes = notesForAnchor(anchor.id).length > 0;
        return (
          <div
            className="anchor-context-menu"
            role="menu"
            aria-label="高亮操作"
            style={{ left: anchorContextMenu.left, top: anchorContextMenu.top }}
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button type="button" role="menuitem" onClick={() => openAnchorConversation(anchor)}>询问 AI</button>
            <button type="button" role="menuitem" onClick={() => openAnchorNotes(anchor)}>{hasNotes ? '查看笔记' : '添加笔记'}</button>
            <button type="button" role="menuitem" onClick={() => void copyAnchorQuote(anchor)}>复制高亮文本</button>
            <div className="anchor-context-divider" role="separator" />
            <button className="danger" type="button" role="menuitem" onClick={() => { setAnchorContextMenu(null); void deleteCurrentAnchor(anchor); }}>删除高亮</button>
          </div>
        );
      })() : null}
      {confirmationRequest ? (
        <div className="confirm-backdrop" role="presentation" onMouseDown={() => resolveConfirmation(false)}>
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-message"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="confirm-title">{confirmationRequest.title}</h2>
            <p id="confirm-message">{confirmationRequest.message}</p>
            <div className="confirm-actions">
              <button autoFocus type="button" onClick={() => resolveConfirmation(false)}>取消</button>
              <button className="danger" type="button" onClick={() => resolveConfirmation(true)}>
                {confirmationRequest.confirmLabel ?? '确认'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {settingsOpen ? (
        <div className="settings-backdrop" role="presentation" onMouseDown={closeSettings}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2 id="settings-title">AI 设置</h2>
              <button type="button" className="drawer-close" onClick={closeSettings} aria-label="关闭 AI 设置">关闭</button>
            </div>
            <div className="ai-settings-panel">
              <div className="settings-intro">
                <strong>连接 AI 服务</strong>
                <p>用于整本书问答、引用解释和笔记建议。配置只保存在本机。</p>
              </div>
              <div className="settings-shortcuts">
                <span>快捷键</span>
                <small>按住 Y，可对当前页进行语音提问；在输入框中不会触发。</small>
              </div>
              <label>
                <span>服务地址</span>
                <small>兼容 OpenAI 接口的服务地址</small>
                <input value={aiBaseUrl} onChange={(event) => setAiBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
              </label>
              <label>
                <span>模型 ID</span>
                <small>例如 gpt-4o-mini</small>
                <input value={aiModelId} onChange={(event) => setAiModelId(event.target.value)} placeholder="gpt-4o-mini" />
              </label>
              <label>
                <span>API Key</span>
                <small>{aiSettings?.hasApiKey ? '已有安全保存的密钥，留空则保持不变' : '仅保存在系统安全存储中'}</small>
                <input type="password" value={aiApiKey} onChange={(event) => setAiApiKey(event.target.value)} placeholder={aiSettings?.hasApiKey ? '已安全保存；留空保持不变' : '仅保存在安全存储中'} />
              </label>
              <button className="primary full" type="button" onClick={() => void saveAiConfiguration()} disabled={savingAiSettings || !aiBaseUrl.trim() || !aiModelId.trim()}>
                {savingAiSettings ? '保存中' : '保存 AI 设置'}
              </button>
              {!aiSettings?.keyStorageAvailable ? <p className="note-status error">安全凭据存储不可用（{aiSettings?.keyStorageBackend ?? 'unknown'}）。Base URL 和模型会保存，但 API Key 不会保存。</p> : null}
              {aiSettingsError ? <p className="note-status error">{aiSettingsError}</p> : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
