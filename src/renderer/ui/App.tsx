import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import { marked } from 'marked';
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
  activeAnchorId: string | null;
  draftRects: NormalizedRect[];
  onVisible: (pageNumber: number) => void;
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
  activeAnchorId,
  draftRects,
  onVisible,
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
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          onVisible(pageIndex + 1);
        }
      },
      { root: scrollRoot, threshold: [0, 0.5] }
    );

    observer.observe(frame);
    return () => {
      observer.disconnect();
      onViewportChange(pageIndex, false);
    };
  }, [onViewportChange, onVisible, pageIndex, scrollRootRef]);

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
      <div className="anchor-overlay" aria-hidden="true">
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
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [notesByAnchorId, setNotesByAnchorId] = useState<Record<string, Note[]>>({});
  const [activeAnchor, setActiveAnchor] = useState<Anchor | null>(null);
  const [draftSelection, setDraftSelection] = useState<DraftSelection | null>(null);
  const [selectionPreview, setSelectionPreview] = useState<{ pageIndex: number; rects: NormalizedRect[] } | null>(null);
  const [noteBody, setNoteBody] = useState('');
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
  const [assistantDraft, setAssistantDraft] = useState('');
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [conversationNotice, setConversationNotice] = useState<string | null>(null);
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
  const drawerResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const restoredDocumentRef = useRef<string | null>(null);
  const readingSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    openedDocumentRef.current = openedDocument;
  }, [openedDocument]);

  useEffect(() => {
    assistantDraftRef.current = assistantDraft;
  }, [assistantDraft]);

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
    setConversationNotice(null);
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
    setConversationNotice(null);
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
      } else if (event.type === 'error') {
        setConversationError(event.message);
      }
    });
  }, [bridgeAvailable, refreshConversationSessions]);

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
  }, [drawerMode, settingsOpen]);

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
    const findAnchorElement = (x: number, y: number): HTMLElement | null => {
      const candidates = document.elementsFromPoint(x, y);
      for (const element of candidates) {
        if (element instanceof HTMLElement && element.matches('.anchor-highlight')) {
          return element;
        }
      }
      return null;
    };

    const activateFromClick = (element: HTMLElement) => {
      const anchorId = element.dataset.anchorId;
      if (!anchorId) return;
      const anchor = anchors.find((item) => item.id === anchorId);
      if (!anchor) return;
      activateAnchor(anchor);
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
      }, 0);
    };

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('dblclick', onDoubleClick);
    document.addEventListener('mousemove', onMouseMove);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('dblclick', onDoubleClick);
      document.removeEventListener('mousemove', onMouseMove);
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

    const onMouseUp = () => {
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
      return;
    }
    void refreshConversationSessions(openedDocument.fingerprint);
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
      if (cancelled || !state || openedDocumentRef.current?.fingerprint !== fingerprint) {
        return;
      }
      restoredDocumentRef.current = fingerprint;
      if (state.scale >= MIN_SCALE && state.scale <= MAX_SCALE) {
        setScale(state.scale);
      }
      if (state.currentPage >= 1 && state.currentPage <= pageCount) {
        setCurrentPage(state.currentPage);
      }
      const restoreScroll = () => {
        const pageSurface = pageSurfaceRef.current;
        if (pageSurface) {
          pageSurface.scrollTo({ top: Math.max(state.scrollTop ?? 0, 0), behavior: 'auto' });
        }
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
    if (readingSaveTimerRef.current) {
      clearTimeout(readingSaveTimerRef.current);
    }
    readingSaveTimerRef.current = setTimeout(() => {
      const pageSurface = pageSurfaceRef.current;
      const scrollTop = pageSurface?.scrollTop ?? 0;
      void window.shuding.saveReadingState({ documentFingerprint: fingerprint, scale, currentPage, scrollTop }).catch((error: unknown) => {
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

    const body = noteBody.trim();
    const currentDocumentId = openedDocumentRef.current?.fingerprint;
    if (!body || !currentDocumentId) {
      return;
    }

    const selectionToSave = draftSelection;
    const anchorToUpdate = activeAnchor;
    if ((!selectionToSave || selectionToSave.documentId !== currentDocumentId) &&
      (!anchorToUpdate || anchorToUpdate.documentId !== currentDocumentId)) {
      return;
    }

    setSaving(true);
    setNoteSaveError(null);
    setNoteSaved(false);
    let createdAnchor: Anchor | null = null;
    try {
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
        }
        setNotesByAnchorId((current) => ({
          ...current,
          [savedNote.anchorId]: [...(current[savedNote.anchorId] ?? []), savedNote]
        }));
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
      if (!window.confirm('停止当前 AI 对话并改问新选区？')) {
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
      const context = cachedContext ?? (savedAnchor ? { kind: 'saved-anchor' as const, anchorId: savedAnchor.id } : null);
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

  function toggleDrawer(mode: Exclude<DrawerMode, null>) {
    setDrawerMode((current) => {
      const next = current === mode ? null : mode;
      if (next === 'ai') {
        setAiView(conversation ? 'chat' : 'list');
      }
      return next;
    });
    if (mode === 'ai') {
      void refreshConversationSessions();
    }
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
    if (!window.confirm('删除这条引用？其笔记和与之关联的 AI 对话也会一并删除。')) {
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

  async function sendConversationMessage() {
    if (!conversationId || !conversationDraft.trim() || conversationRunning || !bridgeAvailable) {
      return;
    }
    const currentConversationId = conversationId;
    const currentConversation = conversation;
    const content = conversationDraft.trim();
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
      if (currentConversation?.context.kind === 'saved-anchor') {
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

  async function confirmProposal() {
    if (!pendingProposal || !bridgeAvailable) {
      return;
    }
    setSavingProposal(true);
    setConversationError(null);
    try {
      const savedNote = await window.shuding.confirmNoteProposal({
        conversationId: pendingProposal.conversationId,
        proposalId: pendingProposal.id
      });
      setNotesByAnchorId((current) => ({
        ...current,
        [savedNote.anchorId]: [...(current[savedNote.anchorId] ?? []), savedNote]
      }));
      setPendingProposal(null);
      void refreshConversationSessions();
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
      setPendingProposal(null);
      void refreshConversationSessions();
    } catch (error: unknown) {
      const details = error instanceof Error ? error.message : '未知错误';
      setConversationError(`丢弃建议失败：${details}`);
    }
  }

  async function deleteConversationSession(conversationId: string) {
    if (!bridgeAvailable) {
      return;
    }
    if (!window.confirm('删除这条 AI 对话？其引用与笔记将保留。')) {
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

  async function finalizeEphemeral(saveSummary: boolean) {
    if (!conversationId || conversation?.context.kind !== 'ephemeral-selection' || !bridgeAvailable) return;
    const currentConversationId = conversationId;
    const documentFingerprint = openedDocumentRef.current?.fingerprint;
    if (!documentFingerprint || documentFingerprint !== conversation.context.selection.documentFingerprint) {
      setConversationError('当前文档已更改，无法保存临时对话引用。');
      return;
    }
    const body = saveSummary ? (ephemeralSummary.trim() || pendingProposal?.body) : undefined;
    if (saveSummary && !body) {
      setConversationError('请输入或先生成要保存的笔记摘要。');
      return;
    }
    setSavingProposal(true);
    setConversationError(null);
    try {
      const result = await window.shuding.finalizeEphemeral({
        conversationId: currentConversationId,
        documentFingerprint,
        ...(saveSummary ? { body, proposalId: pendingProposal?.id } : {})
      });
      if (conversationIdRef.current !== currentConversationId || openedDocumentRef.current?.fingerprint !== documentFingerprint) return;
      setAnchors((current) => [...current, result.anchor]);
      if (result.note) {
        setNotesByAnchorId((current) => ({ ...current, [result.note!.anchorId]: [...(current[result.note!.anchorId] ?? []), result.note!] }));
      }
      setActiveAnchor(result.anchor);
      setSelectionText(result.anchor.quote);
      setDraftSelection(null);
      setSelectionActionPosition(null);
      clearEphemeralConversationLocal();
      setConversationNotice('临时对话未保存到引用历史；已保存的引用可继续开始新对话。');
      void refreshConversationSessions();
    } catch (error: unknown) {
      const details = error instanceof Error ? error.message : '未知错误';
      if (conversationIdRef.current === currentConversationId) setConversationError(`保存临时对话失败：${details}`);
    } finally {
      setSavingProposal(false);
    }
  }

  async function discardEphemeralConversation() {
    if (!conversationId || conversation?.context.kind !== 'ephemeral-selection' || !bridgeAvailable) return;
    const currentConversationId = conversationId;
    clearEphemeralConversationLocal();
    setDrawerMode(null);
    try {
      await window.shuding.discardConversation(currentConversationId);
      conversationSnapshotsRef.current.delete(currentConversationId);
      await refreshConversationSessions();
      if (!draftSelectionRef.current) {
        setSelectionText('选中一句话后在这里生成锚点');
      }
    } catch (error: unknown) {
      const details = error instanceof Error ? error.message : '未知错误';
      setSelectionActionError(`临时对话清理失败：${details}`);
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
          <p className="sidebar-copy">阅读、选句、存档，一次完成。</p>
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
            >
              {sidebarCollapsed ? '☰' : '☰'}
            </button>
            <div className="doc-meta">{pageCount > 0 ? `第 ${currentPage} / ${pageCount} 页` : '等待导入 PDF'}</div>
          </div>
          <div className="topbar-actions">
            <div className="drawer-controls" aria-label="阅读工具">
              <button
                type="button"
                aria-expanded={drawerMode === 'annotations'}
                aria-controls="contextual-drawer"
                onClick={() => toggleDrawer('annotations')}
              >
                标注
              </button>
              <button
                type="button"
                aria-expanded={drawerMode === 'note'}
                aria-controls="contextual-drawer"
                onClick={() => toggleDrawer('note')}
              >
                笔记
              </button>
              <button
                type="button"
                aria-expanded={drawerMode === 'ai'}
                aria-controls="contextual-drawer"
                onClick={() => toggleDrawer('ai')}
              >
                AI
              </button>
              <button
                ref={settingsTriggerRef}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen(true)}
              >
                设置
              </button>
            </div>
            <div className="zoom-controls" aria-label="缩放控制">
              <button type="button" aria-label="缩小" onClick={() => setScale((value) => nextZoom(value, -1))} disabled={!pdf || scale <= MIN_SCALE}>-</button>
              <button type="button" className="zoom-reset" onClick={() => setScale(DEFAULT_SCALE)} disabled={!pdf || scale === DEFAULT_SCALE}>{Math.round(scale * 100)}%</button>
              <button type="button" aria-label="放大" onClick={() => setScale((value) => nextZoom(value, 1))} disabled={!pdf || scale >= MAX_SCALE}>+</button>
            </div>
          </div>
        </header>

        <section className="page-surface" ref={pageSurfaceRef}>
          {!pdf ? (
            <div className="page-placeholder">
              PDF 页面将在这里渲染
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
                   activeAnchorId={activeAnchor?.id ?? null}
                   draftRects={selectionPreview?.pageIndex === pageIndex
                     ? selectionPreview.rects
                     : draftSelection?.pageIndex === pageIndex
                       ? draftSelection.normalizedClientRects
                       : []}
                  onVisible={setCurrentPage}
                  onViewportChange={onViewportChange}
                />
              ))}
            </div>
          )}
        </section>
      </main>

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
          <section className="drawer-section">
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
                      <span>{normalizeQuote(anchor.quote)}</span>
                      <small>页 {anchor.pageIndex + 1} · {anchorNotes.length} 条笔记</small>
                    </button>
                    <button className="delete-anchor" type="button" onClick={() => void deleteCurrentAnchor(anchor)} aria-label="删除标注">
                      删除
                    </button>
                  </div>
                  {anchorNotes.map((note) => (
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
              <p className="quote-context-label">当前引用</p>
              <p>{summary}</p>
              {activeAnchor ? <p className="anchor-meta">页 {activeAnchor.pageIndex + 1} · {activeAnchor.kind}</p> : null}
            </section>
          ) : null}
          <section className="drawer-section note-composer">
          <h3>手动笔记</h3>
          <textarea value={noteBody} onChange={(event) => setNoteBody(event.target.value)} placeholder="在这里记录这一段的想法" />
          <button className="primary full note-save" type="button" onClick={() => void saveCurrentNote()} disabled={(!activeAnchor && !draftSelection) || !noteBody.trim() || saving}>
            {saving ? '保存中' : '保存笔记'}
          </button>
          {noteSaveError ? <p className="note-status error">{noteSaveError}</p> : null}
          {noteSaved ? <p className="note-status">已保存</p> : null}
          {activeAnchor ? (
            <div className="saved-notes">
              <h3>已保存笔记</h3>
              {notesForAnchor(activeAnchor.id).map((note) => (
                <div className="annotation-note-row" key={note.id}>
                  <button className="annotation-note" type="button" onClick={() => activateAnchor(activeAnchor, false, note)}>
                    {note.body}
                  </button>
                  <button
                    className="note-delete"
                    type="button"
                    aria-label="删除这条笔记"
                    onClick={() => void deleteNoteForAnchor(note.id, activeAnchor.id)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {notesForAnchor(activeAnchor.id).length === 0 ? <p className="annotation-empty">当前引用还没有手动笔记。</p> : null}
            </div>
          ) : null}
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
                        <span className="session-quote">{normalizeQuote(session.quote)}</span>
                        <small>页 {session.pageIndex + 1} · {formatSessionTime(session.lastUsedAt)} · {session.status === 'running' ? '运行中' : '已暂停'}</small>
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
            </section>
          ) : null}
          {conversation ? (
          <section className="drawer-section conversation-panel">
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
            {conversationNotice ? <p className="note-status">{conversationNotice}</p> : null}
            <textarea value={conversationDraft} onChange={(event) => setConversationDraft(event.target.value)} placeholder="围绕当前引用提问" disabled={conversationRunning} />
            <div className="conversation-actions">
              <button className="primary" type="button" onClick={() => void sendConversationMessage()} disabled={conversationRunning || !conversationDraft.trim() || !aiSettings?.hasApiKey}>
                发送
              </button>
              <button type="button" onClick={() => conversationId && void window.shuding.abortConversation(conversationId)} disabled={!conversationRunning}>
                停止
              </button>
            </div>
            {!aiSettings?.hasApiKey ? <p className="note-status error">保存安全 API Key 后即可开始对话。</p> : null}
            {conversationError ? <p className="note-status error">{conversationError}</p> : null}
            {pendingProposal ? (
              <div className="proposal-preview">
                <h3>AI 笔记建议</h3>
             {conversation.context.kind === 'ephemeral-selection' ? (
                  <textarea value={ephemeralSummary} onChange={(event) => setEphemeralSummary(event.target.value)} placeholder={pendingProposal.body} />
                ) : <p>{pendingProposal.body}</p>}
                <div className="conversation-actions">
                  {conversation.context.kind === 'ephemeral-selection' ? (
                    <button className="primary" type="button" onClick={() => void finalizeEphemeral(true)} disabled={savingProposal}>
                      {savingProposal ? '保存中' : '保存摘要为笔记'}
                    </button>
                  ) : (
                    <button className="primary" type="button" onClick={() => void confirmProposal()} disabled={savingProposal}>
                      {savingProposal ? '保存中' : '保存为笔记'}
                    </button>
                  )}
                  <button type="button" onClick={() => void discardProposal()} disabled={savingProposal}>丢弃</button>
                </div>
              </div>
            ) : null}
            {conversation.context.kind === 'ephemeral-selection' ? (
              <div className="conversation-actions ephemeral-actions">
                <button type="button" onClick={() => void finalizeEphemeral(false)} disabled={conversationRunning || savingProposal}>保存引用</button>
                <button type="button" onClick={() => void finalizeEphemeral(true)} disabled={conversationRunning || savingProposal || (!ephemeralSummary.trim() && !pendingProposal)}>保存摘要为笔记</button>
                <button type="button" onClick={() => void discardEphemeralConversation()} disabled={conversationRunning || savingProposal}>丢弃</button>
              </div>
            ) : null}
          </section>
          ) : (
            <section className="drawer-section ai-empty-state">
              <p>先选中一段文字并使用“Ask AI”，或从标注中选择已保存引用。</p>
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
          <button type="button" onClick={() => { setDrawerMode('note'); setSelectionActionPosition(null); }}>添加笔记</button>
          <button type="button" onClick={() => void askAiAboutDraft()}>Ask AI</button>
          <button type="button" onClick={() => void copyDraftSelection()}>复制</button>
        </div>
      ) : null}
      {selectionActionError ? <p className="selection-action-error" role="status">{selectionActionError}</p> : null}
      {settingsOpen ? (
        <div className="settings-backdrop" role="presentation" onMouseDown={closeSettings}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2 id="settings-title">AI 设置</h2>
              <button type="button" className="drawer-close" onClick={closeSettings} aria-label="关闭 AI 设置">关闭</button>
            </div>
            <div className="ai-settings-panel">
              <label>
                Base URL
                <input value={aiBaseUrl} onChange={(event) => setAiBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
              </label>
              <label>
                模型 ID
                <input value={aiModelId} onChange={(event) => setAiModelId(event.target.value)} placeholder="gpt-4o-mini" />
              </label>
              <label>
                API Key
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
