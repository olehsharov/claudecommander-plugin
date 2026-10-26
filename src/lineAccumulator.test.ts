import { expect, test } from 'vitest';
import { createLineAccumulator } from './lineAccumulator.js';

function collectLines(): { lines: string[]; feed: (chunk: Buffer | string) => void } {
  const lines: string[] = [];
  return { lines, feed: createLineAccumulator((line) => lines.push(line)) };
}

// Same case as acp/src/orchestrator.test.ts ("reassembles a UTF-8 character
// split across two stdout chunks"): a pipe can split a chunk in the middle of
// a multi-byte character, and decoding each chunk alone corrupts it.
test('a UTF-8 character split across two chunks is reassembled', () => {
  const { lines, feed } = collectLines();
  const lineWithCyrillicText = JSON.stringify({ type: 'tool_use', name: 'Привет мир' });
  const lineBytes = Buffer.from(lineWithCyrillicText + '\n', 'utf8');
  // 'П' (U+041F) encodes as two UTF-8 bytes; split right between them.
  const firstCyrillicCharacterByteOffset = lineBytes.indexOf(Buffer.from('П', 'utf8'));
  const splitPoint = firstCyrillicCharacterByteOffset + 1;

  feed(lineBytes.subarray(0, splitPoint));
  feed(lineBytes.subarray(splitPoint));

  expect(lines).toEqual([lineWithCyrillicText]);
});

test('a line split across chunks is delivered once, when its newline arrives', () => {
  const { lines, feed } = collectLines();
  feed('first ha');
  expect(lines).toEqual([]);
  feed('lf\nsecond\nthi');
  expect(lines).toEqual(['first half', 'second']);
  feed('rd\n');
  expect(lines).toEqual(['first half', 'second', 'third']);
});

test('empty lines are skipped', () => {
  const { lines, feed } = collectLines();
  feed(Buffer.from('\n\none\n\n', 'utf8'));
  expect(lines).toEqual(['one']);
});
