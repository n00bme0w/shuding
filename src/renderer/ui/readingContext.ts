// Use the selected occurrence, not the first matching word on the page. The
// original selection Range is captured before clicking the AI controls clears it.
export function extractSelectionContext(text: string, start: number, end: number, maxLength = 4_000) {
  const left = Math.max(0, start - 1_200);
  const right = Math.min(text.length, Math.max(end, start + 1) + 1_200);
  const boundaries = [...text.matchAll(/(?:[.!?]["”’']?(?:\s+|$)|[。！？]["”’']?\s*)/g)].map((match) => match.index! + match[0].length);
  const sentenceStart = boundaries.filter((offset) => offset <= start && offset >= left).at(-1) ?? left;
  const sentenceEnd = boundaries.find((offset) => offset >= end && offset <= right) ?? right;
  // Include adjacent sentences to resolve references and technical subject matter.
  const contextStart = boundaries.filter((offset) => offset < sentenceStart && offset >= left).at(-1) ?? left;
  const contextEnd = boundaries.find((offset) => offset > sentenceEnd && offset <= right) ?? right;
  const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
  return {
    selectedSentence: clean(text.slice(sentenceStart, Math.min(sentenceEnd, sentenceStart + maxLength))),
    surroundingText: clean(text.slice(contextStart, Math.min(contextEnd, contextStart + maxLength)))
  };
}

export function selectionReadingContext(textLayer: Element, range: Range) {
  if (!textLayer.contains(range.startContainer) || !textLayer.contains(range.endContainer)) return undefined;
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent) nodes.push(node as Text);
  let start = -1;
  let end = -1;
  let offset = 0;
  for (const node of nodes) {
    if (node === range.startContainer) start = offset + range.startOffset;
    else if (start < 0 && range.comparePoint(node, node.length) >= 0) start = offset;
    if (node === range.endContainer) end = offset + range.endOffset;
    else if (end < 0 && range.comparePoint(node, 0) > 0) end = Math.max(0, offset - 1);
    offset += node.length + 1;
  }
  if (start < 0) return undefined;
  if (end < 0) end = offset;
  return extractSelectionContext(nodes.map((node) => node.data).join(' '), start, end);
}
