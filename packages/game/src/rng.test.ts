import { describe, expect, it } from 'vitest';

import {
  drawBelow,
  initialRngState,
  rollTwoDice,
  shuffledRange,
  stateToWords,
  stepRng,
  wordsToState,
} from './rng';

// Vectors independently produced by a Python mirror of the exact pipeline:
// FNV-1a32(seed) → splitmix32 expansion → xoshiro128**. Pinned so any drift
// in seeding, word order, or the step function fails loudly here.
const VECTOR_TYCOON = {
  seed: 'tycoon-city-2026',
  initState: 'cc97ec784a0a845a7282c990296eefef',
  firstRoll: { d1: 4, d2: 5 } as const,
  afterRoll: '78b18d64f0f1b7973bad722510554eba',
};
const VECTOR_LAB = {
  seed: 'rules-lab',
  initState: '75fde4a2053507222e1b4eeac4d37adb',
  firstRoll: { d1: 4, d2: 4 } as const,
  afterRoll: 'd927fa3edb20da7922a9a313e31b2b69',
};

describe('initialRngState', () => {
  it('matches the reference vectors', () => {
    expect(initialRngState(VECTOR_TYCOON.seed)).toBe(VECTOR_TYCOON.initState);
    expect(initialRngState(VECTOR_LAB.seed)).toBe(VECTOR_LAB.initState);
  });

  it('is 32 hex chars and deterministic per seed', () => {
    expect(initialRngState('abc')).toMatch(/^[0-9a-f]{32}$/);
    expect(initialRngState('abc')).toBe(initialRngState('abc'));
    expect(initialRngState('abc')).not.toBe(initialRngState('abd'));
  });

  it('never produces the forbidden all-zero state', () => {
    for (const seed of ['0', 'zero', '', 'tycoon-city-2026']) {
      expect(stateToWords(initialRngState(seed))).not.toEqual([0, 0, 0, 0]);
    }
  });
});

describe('stepRng', () => {
  it('is pure: the input state is never mutated', () => {
    const before = VECTOR_TYCOON.initState;
    stepRng(before);
    expect(before).toBe(VECTOR_TYCOON.initState);
  });

  it('advances deterministically (same input, same output)', () => {
    const a = stepRng(VECTOR_TYCOON.initState);
    const b = stepRng(VECTOR_TYCOON.initState);
    expect(a).toEqual(b);
  });

  it('round-trips words through the hex state', () => {
    const words = [0x01234567, 0x89abcdef, 0x00000001, 0xffffffff] as const;
    expect(stateToWords(wordsToState(words))).toEqual(words);
  });
});

describe('rollTwoDice', () => {
  it('matches the reference vectors', () => {
    const a = rollTwoDice(VECTOR_TYCOON.initState);
    expect(a.d1).toBe(VECTOR_TYCOON.firstRoll.d1);
    expect(a.d2).toBe(VECTOR_TYCOON.firstRoll.d2);
    expect(a.state).toBe(VECTOR_TYCOON.afterRoll);

    const b = rollTwoDice(VECTOR_LAB.initState);
    expect(b.d1).toBe(VECTOR_LAB.firstRoll.d1);
    expect(b.d2).toBe(VECTOR_LAB.firstRoll.d2);
    expect(b.state).toBe(VECTOR_LAB.afterRoll);
  });

  it('advances the stream: consecutive rolls differ', () => {
    const first = rollTwoDice(VECTOR_TYCOON.initState);
    const second = rollTwoDice(first.state);
    const repeat = rollTwoDice(VECTOR_TYCOON.initState);
    expect(second).not.toEqual(repeat); // the stream moved on
  });

  it('yields fair-ish dice over 10k rolls (3σ band)', () => {
    let s = VECTOR_TYCOON.initState;
    const faces = new Array(7).fill(0) as number[];
    let doubles = 0;
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const r = rollTwoDice(s);
      s = r.state;
      faces[r.d1]++;
      faces[r.d2]++;
      if (r.d1 === r.d2) doubles++;
    }
    for (let face = 1; face <= 6; face++) {
      // Two dice per roll → 2N draws, p = 1/6, σ = sqrt(2N·p·(1−p)) ≈ 52.7; 3σ ≈ 158
      expect(Math.abs(faces[face] - N / 3)).toBeLessThan(160);
    }
    // p = 1/6 per roll, σ ≈ 26.4; 3σ ≈ 80
    expect(Math.abs(doubles - N / 6)).toBeLessThan(85);
  });
});

describe('drawBelow', () => {
  it('stays in [0, n) and is deterministic', () => {
    const a = drawBelow(VECTOR_TYCOON.initState, 5);
    const b = drawBelow(VECTOR_TYCOON.initState, 5);
    expect(a).toEqual(b);
    expect(a.value).toBeGreaterThanOrEqual(0);
    expect(a.value).toBeLessThan(5);
  });
});

describe('shuffledRange', () => {
  it('returns a permutation of 0..n-1 deterministically', () => {
    const a = shuffledRange(VECTOR_TYCOON.initState, 5);
    const b = shuffledRange(VECTOR_TYCOON.initState, 5);
    expect(a.order).toEqual(b.order);
    expect([...a.order].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);
    expect(a.state).not.toBe(VECTOR_TYCOON.initState);
  });

  it('handles the trivial single-element case', () => {
    const r = shuffledRange(VECTOR_TYCOON.initState, 1);
    expect(r.order).toEqual([0]);
  });
});
