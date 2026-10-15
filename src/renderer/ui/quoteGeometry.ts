import { normalizeQuote, type AnchorDraft, type ConversationAnchor, type Rect } from '../../shared';

// TextLayer nodes may split a sentence at arbitrary boundaries. Keep offsets
// into the original nodes while normalizing whitespace for an exact Range.
export function findQuoteOffsets(chunks: string[], quote: string, selectedSentence?: string) {
  const target = normalizeQuote(quote);
  const sentence = normalizeQuote(selectedSentence ?? '');
  if (!target) return null;
  for (const separator of [' ', '']) {
    let text = '';
    const positions: Array<{ chunkIndex: number; offset: number }> = [];
    const append = (char: string, chunkIndex: number, offset: number) => {
      const normalized = /\s/.test(char) ? ' ' : char.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
      if (normalized === ' ' && text.endsWith(' ')) return;
      text += normalized;
      positions.push({ chunkIndex, offset });
    };
    chunks.forEach((chunk, chunkIndex) => {
      if (chunkIndex > 0 && separator) append(separator, chunkIndex, 0);
      for (let offset = 0; offset < chunk.length; offset++) append(chunk[offset], chunkIndex, offset);
    });
    const sentenceStart = sentence ? text.indexOf(sentence) : -1;
    if (sentence && sentenceStart < 0) continue;
    const startIndex = text.indexOf(target, Math.max(sentenceStart, 0));
    if (startIndex < 0) continue;
    if (sentence && startIndex + target.length > sentenceStart + sentence.length) continue;
    const start = positions[startIndex];
    const last = positions[startIndex + target.length - 1];
    return { start, end: { chunkIndex: last.chunkIndex, offset: last.offset + 1 } };
  }
  return null;
}

export function resolveQuoteHighlight(pageFrame: HTMLElement, anchor: ConversationAnchor): AnchorDraft | null {
  const textLayer = pageFrame.querySelector('.text-layer');
  if (!textLayer) return null;
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent) nodes.push(node as Text);
  const offsets = findQuoteOffsets(nodes.map((node) => node.data), anchor.quote, anchor.selectedSentence);
  if (!offsets) return null;
  const range = document.createRange();
  range.setStart(nodes[offsets.start.chunkIndex], offsets.start.offset);
  range.setEnd(nodes[offsets.end.chunkIndex], offsets.end.offset);
  const bounds = pageFrame.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const rects: Rect[] = Array.from(range.getClientRects()).flatMap((rect) => {
    const left = Math.max(bounds.left, rect.left);
    const top = Math.max(bounds.top, rect.top);
    const right = Math.min(bounds.right, rect.right);
    const bottom = Math.min(bounds.bottom, rect.bottom);
    return right > left && bottom > top ? [{ x: left - bounds.left, y: top - bounds.top, width: right - left, height: bottom - top }] : [];
  });
  if (rects.length === 0) return null;
  const bands: Rect[] = [];
  for (const rect of rects.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const band = bands.find((candidate) => Math.min(candidate.y + candidate.height, rect.y + rect.height) - Math.max(candidate.y, rect.y) >= Math.min(candidate.height, rect.height) * 0.6 && rect.x <= candidate.x + candidate.width + rect.height * 2);
    if (band) {
      const right = Math.max(band.x + band.width, rect.x + rect.width);
      const bottom = Math.max(band.y + band.height, rect.y + rect.height);
      band.x = Math.min(band.x, rect.x);
      band.y = Math.min(band.y, rect.y);
      band.width = right - band.x;
      band.height = bottom - band.y;
    } else bands.push({ ...rect });
  }
  const x = Math.min(...bands.map((rect) => rect.x));
  const y = Math.min(...bands.map((rect) => rect.y));
  const pageRect = { x, y, width: Math.max(...bands.map((rect) => rect.x + rect.width)) - x, height: Math.max(...bands.map((rect) => rect.y + rect.height)) - y };
  const normalize = (rect: Rect): Rect => ({ x: rect.x / bounds.width, y: rect.y / bounds.height, width: rect.width / bounds.width, height: rect.height / bounds.height });
  return { documentId: anchor.documentFingerprint, pageIndex: anchor.pageIndex, kind: 'text', quote: anchor.quote, normalizedQuote: anchor.normalizedQuote, pageRect, normalizedRect: normalize(pageRect), normalizedRects: bands.map(normalize) };
}
