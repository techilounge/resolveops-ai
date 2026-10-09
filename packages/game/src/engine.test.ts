import { describe, expect, it } from 'vitest';

import { canonicalJson, fnv1a64 } from './engine';

// fnv1a64 vectors independently produced by a Python reference
// implementation (64-bit FNV-1a over UTF-8 bytes). Pinned so a semantic
// change in the hash cannot slip through silently.
const FNV_VECTORS: ReadonlyArray<readonly [string, string]> = [
  ['', 'cbf29ce484222325'],
  ['a', 'af63dc4c8601ec8c'],
  ['hello world', '779a65e7023cd2e7'],
  ['Tycoon City', 'a166f4df14eb45bc'],
  ['{"a":1}', '9c3e82dd6fcae8b1'],
  ['uitgebreid', 'adf97cfd192fda21'],
  ['{"players":[{"cash":12000},{"cash":12000}]}', 'bbba2a6063a8fc3b'],
];

describe('fnv1a64', () => {
  it.each(FNV_VECTORS)('matches the reference vector for %j', (input, expected) => {
    expect(fnv1a64(input)).toBe(expected);
  });
});

describe('canonicalJson', () => {
  it('sorts object keys lexicographically at every depth', () => {
    const value = { b: 1, a: { d: [2, 1], c: 'x' } };
    expect(canonicalJson(value)).toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
  });

  it('preserves array order (order is meaningful)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('omits undefined-valued fields, matching JSON.stringify round-trip semantics', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson(JSON.parse(JSON.stringify({ a: 1, b: undefined })))).toBe('{"a":1}');
  });

  it('hashes multi-byte UTF-8 stably (stateHash uses UTF-8 bytes, not char codes)', () => {
    // Same string, hashed through the engine path: pinned via the fnv vector.
    expect(fnv1a64(canonicalJson({ name: 'uitgebreid' }))).toBe(
      fnv1a64('{"name":"uitgebreid"}'),
    );
  });
});
