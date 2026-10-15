import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';

function loadSource(path, require = () => {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  runInThisContext(`(function(require, exports) { ${compiled}\n})`)(require, module.exports);
  return module.exports;
}
const shared = loadSource('../src/shared/text.ts');
const { findQuoteOffsets } = loadSource('../src/renderer/ui/quoteGeometry.ts', () => shared);
const { extractSelectionContext } = loadSource('../src/renderer/ui/readingContext.ts');

test('locates an exact fragment spanning multiple PDF text nodes', () => {
  assert.deepEqual(findQuoteOffsets(['A first sentence. An exact', 'supporting sentence.', 'Another passage.'], 'exact supporting sentence.'), { start: { chunkIndex: 0, offset: 21 }, end: { chunkIndex: 1, offset: 20 } });
});

test('matches Chinese text split across nodes without adding visible spaces', () => {
  assert.deepEqual(findQuoteOffsets(['这是一段', '需要解释的原文', '，后面还有文字。'], '需要解释的原文'), { start: { chunkIndex: 1, offset: 0 }, end: { chunkIndex: 1, offset: 7 } });
  assert.deepEqual(findQuoteOffsets(['这是一段', '需要解释的原文'], '一段需要解释'), { start: { chunkIndex: 0, offset: 2 }, end: { chunkIndex: 1, offset: 4 } });
});

test('normalizes whitespace and typographic quotes while preserving Range offsets', () => {
  assert.deepEqual(findQuoteOffsets(['An  “exact”\n sentence.'], '"exact" sentence.'), { start: { chunkIndex: 0, offset: 4 }, end: { chunkIndex: 0, offset: 22 } });
});

test('refuses unmatched passages instead of highlighting an arbitrary nearby span', () => {
  assert.equal(findQuoteOffsets(['An actual supporting sentence.'], 'An invented supporting sentence.'), null);
  assert.equal(findQuoteOffsets(['A sentence.'], '   '), null);
});

test('a repeated word uses the actual selected sentence and neighboring context', () => {
  const text = 'The terrestrial animals live on land. The terrestrial planets have solid surfaces. Venus is one example.';
  const start = text.lastIndexOf('terrestrial');
  const context = extractSelectionContext(text, start, start + 'terrestrial'.length);
  assert.equal(context.selectedSentence, 'The terrestrial planets have solid surfaces.');
  assert.ok(context.surroundingText.includes('Venus is one example.'));
});

test('saving a repeated word locates its selected sentence instead of the first occurrence', () => {
  const chunks = ['The terrestrial animals live on land.', 'The terrestrial planets have solid surfaces.'];
  assert.deepEqual(findQuoteOffsets(chunks, 'terrestrial', chunks[1]), { start: { chunkIndex: 1, offset: 4 }, end: { chunkIndex: 1, offset: 15 } });
  assert.equal(findQuoteOffsets(chunks, 'terrestrial', 'A missing sentence.'), null);
});

test('selected Chinese sentences are recognized without spaces after punctuation', () => {
  const text = '这里在讨论天体。类地行星具有固体表面。金星就是一个例子。';
  const start = text.indexOf('类地');
  assert.equal(extractSelectionContext(text, start, start + 2).selectedSentence, '类地行星具有固体表面。');
});

test('selection context stays centered on a word near the end of a long page', () => {
  const text = `${'Long unrelated material. '.repeat(500)}The terrestrial planets have solid surfaces. Next sentence.`;
  const start = text.indexOf('terrestrial');
  const context = extractSelectionContext(text, start, start + 'terrestrial'.length);
  assert.equal(context.selectedSentence, 'The terrestrial planets have solid surfaces.');
  assert.ok(context.surroundingText.length < 4_000);
});
