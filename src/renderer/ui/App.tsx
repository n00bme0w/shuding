import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import { normalizeQuote } from '../../shared';
import type { Anchor, Note, OpenedDocument, RecentDocument } from '../../shared';

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString();

type PdfSelection = {
  quote: string;
  pageIndex: number;
  pageRect: { x: number; y: number; width: number; height: number };
  normalizedRect: { x: number; y: number; width: number; height: number };
};

type DraftSelection = PdfSelection & {
  documentId: string;
};

const DEFAULT_SCALE = 1.5;
const MIN_SCALE = 0.75;
const MAX_SCALE = 2.5;
const ZOOM_STEP = 0.25;
const PAGE_WINDOW_RADIUS = 3;
const MAX_OUTPUT_SCALE = 2;
const FALLBACK_PAGE_DIMENSIONS = { width: 612, height: 792 };

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
        {anchors.map((anchor) => (
          <div
            className={`anchor-highlight${anchor.id === activeAnchorId ? ' active' : ''}`}
            key={anchor.id}
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
  const [noteBody, setNoteBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [noteSaveError, setNoteSaveError] = useState<string | null>(null);
  const [noteSaved, setNoteSaved] = useState(false);
  const [loadingDocument, setLoadingDocument] = useState(false);
  const [recentDocuments, setRecentDocuments] = useState<RecentDocument[]>([]);
  const [recentDocumentsExpanded, setRecentDocumentsExpanded] = useState(false);
  const [recentDocumentsError, setRecentDocumentsError] = useState<string | null>(null);
  const outputScale = useOutputScale();
  const pageSurfaceRef = useRef<HTMLElement>(null);
  const openedDocumentRef = useRef<OpenedDocument | null>(null);

  useEffect(() => {
    openedDocumentRef.current = openedDocument;
  }, [openedDocument]);

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
    await refreshRecentDocuments();
  }, [refreshRecentDocuments]);

  useEffect(() => {
    void refreshRecentDocuments();
  }, [refreshRecentDocuments]);

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

  const summary = useMemo(() => normalizeQuote(selectionText), [selectionText]);
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
        return;
      }

      const text = selection.toString().trim();
      if (!text) {
        return;
      }

      const range = selection.getRangeAt(0);
      const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer as Element
        : range.startContainer.parentElement;
      const pageWrapper = startElement?.closest<HTMLElement>('[data-page-index]');
      if (!pageWrapper) {
        return;
      }

      const selectedRect = range.getBoundingClientRect();
      const pageBounds = pageWrapper.getBoundingClientRect();
      const left = Math.max(selectedRect.left, pageBounds.left);
      const top = Math.max(selectedRect.top, pageBounds.top);
      const right = Math.min(selectedRect.right, pageBounds.right);
      const bottom = Math.min(selectedRect.bottom, pageBounds.bottom);
      if (right <= left || bottom <= top) {
        return;
      }

      const pageRect = {
        x: left - pageBounds.left,
        y: top - pageBounds.top,
        width: right - left,
        height: bottom - top
      };

      const normalizedRect = {
        x: pageRect.x / Math.max(pageBounds.width, 1),
        y: pageRect.y / Math.max(pageBounds.height, 1),
        width: pageRect.width / Math.max(pageBounds.width, 1),
        height: pageRect.height / Math.max(pageBounds.height, 1)
      };

      const nextSelection: PdfSelection = {
        quote: text,
        pageIndex: Number(pageWrapper.dataset.pageIndex),
        pageRect,
        normalizedRect
      };

      const documentId = openedDocumentRef.current?.fingerprint;
      if (!documentId) {
        return;
      }

      setSelectionText(text);
      setActiveAnchor(null);
      setDraftSelection({ ...nextSelection, documentId });
      setNoteBody('');
      setNoteSaveError(null);
      setNoteSaved(false);
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
       setAnchors([]);
       setNotesByAnchorId({});
       setActiveAnchor(null);
       setDraftSelection(null);
       setNoteBody('');
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
      return;
    }

    let cancelled = false;
     setAnchors([]);
     setNotesByAnchorId({});
     setActiveAnchor(null);
     setDraftSelection(null);
     setNoteBody('');

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

  async function deleteCurrentAnchor(anchor: Anchor) {
    if (!window.confirm('删除这条标注及其笔记？')) {
      return;
    }

    await window.shuding.deleteAnchor({ anchorId: anchor.id });
    if (openedDocumentRef.current?.fingerprint !== anchor.documentId) {
      return;
    }

    setAnchors((current) => current.filter((candidate) => candidate.id !== anchor.id));
    setNotesByAnchorId((current) => {
      const next = { ...current };
      delete next[anchor.id];
      return next;
    });
    if (activeAnchor?.id === anchor.id) {
      setActiveAnchor(null);
      setSelectionText('选中一句话后在这里生成锚点');
      setNoteBody('');
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
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
          <button className="ghost" type="button">笔记</button>
        </div>
      </aside>

      <main className="reader">
        <header className="topbar">
          <div>
            <div className="doc-title">{openedDocument?.name ?? '未打开文档'}</div>
            <div className="doc-meta">{pageCount > 0 ? `第 ${currentPage} / ${pageCount} 页` : '等待导入 PDF'}</div>
          </div>
          <div className="topbar-actions">
            <div className="zoom-controls" aria-label="缩放控制">
              <button type="button" aria-label="缩小" onClick={() => setScale((value) => Math.max(MIN_SCALE, value - ZOOM_STEP))} disabled={!pdf || scale <= MIN_SCALE}>-</button>
              <button type="button" className="zoom-reset" onClick={() => setScale(DEFAULT_SCALE)} disabled={!pdf || scale === DEFAULT_SCALE}>{Math.round(scale * 100)}%</button>
              <button type="button" aria-label="放大" onClick={() => setScale((value) => Math.min(MAX_SCALE, value + ZOOM_STEP))} disabled={!pdf || scale >= MAX_SCALE}>+</button>
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
                  onVisible={setCurrentPage}
                  onViewportChange={onViewportChange}
                />
              ))}
            </div>
          )}
        </section>
      </main>

      <aside className="inspector">
        {!bridgeAvailable ? <div className="bridge-error">桌面桥接未加载，笔记无法保存。请完全重启应用。</div> : null}
        <div className="panel">
          <h2>引用</h2>
          <p>{summary}</p>
          {activeAnchor ? <p className="anchor-meta">页 {activeAnchor.pageIndex + 1} · {activeAnchor.kind}</p> : null}
        </div>

        <div className="panel">
          <h2>标注</h2>
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
                    <button
                      className={`annotation-note${anchor.id === activeAnchor?.id && note.body === noteBody ? ' active' : ''}`}
                      key={note.id}
                      type="button"
                      onClick={() => activateAnchor(anchor, true, note)}
                    >
                      {note.body}
                    </button>
                  ))}
                </div>
              );
            })}
            {openedDocument && anchors.length === 0 ? <p className="annotation-empty">此文档还没有标注。</p> : null}
          </div>
        </div>

        <div className="panel">
          <h2>笔记</h2>
          <textarea value={noteBody} onChange={(event) => setNoteBody(event.target.value)} placeholder="在这里记录这一段的想法" />
          <button className="primary full" onClick={() => void saveCurrentNote()} disabled={(!activeAnchor && !draftSelection) || !noteBody.trim() || saving}>
            {saving ? '保存中' : '保存笔记'}
          </button>
          {noteSaveError ? <p className="note-status error">{noteSaveError}</p> : null}
          {noteSaved ? <p className="note-status">已保存</p> : null}
        </div>
      </aside>
    </div>
  );
}
