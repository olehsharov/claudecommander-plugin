import { expect, test } from 'vitest';
import { isValidOpaqueId, OPAQUE_ID_PATTERN } from './ids.js';

// The same cases as the private repository's shared/src/ids.test.ts: the
// plugin keeps its own copy of the check because the public repository must
// not depend on the private one.

test('accepts letters, digits, underscore and dash up to 64 characters', () => {
  expect(isValidOpaqueId('m_01JABC-xyz')).toBe(true);
  expect(isValidOpaqueId('a'.repeat(64))).toBe(true);
});

test('rejects empty, too long, non-string and markup-carrying ids', () => {
  for (const bad of ['', 'a'.repeat(65), 42, null, undefined, 'm"1', 'm 1', 'm<1', 'm\n1']) expect(isValidOpaqueId(bad)).toBe(false);
});

test('rejects ids Firestore reserves (__anything__), in the pattern as well as the function', () => {
  for (const reserved of ['__x__', '____', '__name__', '__' + 'a'.repeat(60) + '__']) {
    expect(isValidOpaqueId(reserved), reserved).toBe(false);
    expect(OPAQUE_ID_PATTERN.test(reserved), reserved).toBe(false);
  }
  // Underscores elsewhere stay fine, including ids that only start or only end with two.
  for (const fine of ['__x', 'x__', '_x_', '___', 'a__b']) expect(isValidOpaqueId(fine), fine).toBe(true);
});
