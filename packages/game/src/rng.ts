// Tycoon City — Phase 1 seeded PRNG: xoshiro128** (spec §3.9).
//
// The engine's single source of randomness. Every dice roll and shuffle
// draws through this module; the generator's full 128-bit state lives
// inside GameState.rngState (32 hex chars) so replays are byte-exact on
// any machine. No Math.random, no Date.now, no ambient entropy.

import type { Die } from './types';

export type RngWords = readonly [number, number, number, number];

const WORDS = 4;
const HEX_PER_WORD = 8;

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** 32-bit FNV-1a — expands the string seed into PRNG words. */
function fnv1a32(text: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** splitmix32 — deterministic expansion of one seed word into the state words. */
function splitmix32(seedWord: number): () => number {
  let a = seedWord >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x7a35a7d6);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export function stateToWords(state: string): RngWords {
  const words: number[] = [];
  for (let i = 0; i < WORDS; i++) {
    // Unsigned: words are 32-bit unsigned by definition, so the hex round-trip
    // is exact even for values ≥ 2³¹ (| 0 would sign-flip them).
    words.push(parseInt(state.slice(i * HEX_PER_WORD, (i + 1) * HEX_PER_WORD), 16) >>> 0);
  }
  return [words[0], words[1], words[2], words[3]];
}

export function wordsToState(words: RngWords): string {
  return words.map(w => (w >>> 0).toString(16).padStart(HEX_PER_WORD, '0')).join('');
}

/** Serialised initial generator state for a seed string. Deterministic;
 *  never the all-zero forbidden state of xoshiro128**. */
export function initialRngState(seed: string): string {
  const next = splitmix32(fnv1a32(seed));
  const words: RngWords = [next(), next(), next(), next()];
  if ((words[0] | words[1] | words[2] | words[3]) === 0) {
    // Forbidden-state guard (unreachable for any realistic seed; kept total).
    return wordsToState([0x9e3779b9, 0x7f4a7c15, 0xd1b54a32, 0x2545f491]);
  }
  return wordsToState(words);
}

/**
 * One xoshiro128** step. Pure: the input state string is never mutated; the
 * output carries the 32-bit result word and the advanced state.
 */
export function stepRng(state: string): { readonly value: number; readonly state: string } {
  const [s0, s1, s2, s3] = stateToWords(state);
  const value = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
  const t = (s1 << 9) >>> 0;
  const n2 = (s2 ^ s0) >>> 0;
  const n3 = (s3 ^ s1) >>> 0;
  const n1 = (s1 ^ n2) >>> 0;
  const n0 = (s0 ^ n3) >>> 0;
  const n2b = (n2 ^ t) >>> 0;
  const n3b = rotl(n3, 11);
  return { value, state: wordsToState([n0, n1, n2b, n3b]) };
}

/**
 * Draw in [0, n): one word modulo n. 2^32 is not a multiple of n, giving a
 * sub-ppm bias — irrelevant to play and pinned by the determinism tests,
 * which matter more than perfect uniformity.
 */
export function drawBelow(state: string, n: number): { readonly value: number; readonly state: string } {
  const r = stepRng(state);
  return { value: r.value % n, state: r.state };
}

function dieFromWord(word: number): Die {
  // 0..5 → 1..6 — the single cast on the die path, guarded by the modulo.
  return ((word % 6) + 1) as Die;
}

/** Roll 2d6: two PRNG steps, dice returned with the advanced state. */
export function rollTwoDice(state: string): { readonly d1: Die; readonly d2: Die; readonly state: string } {
  const a = stepRng(state);
  const b = stepRng(a.state);
  return { d1: dieFromWord(a.value), d2: dieFromWord(b.value), state: b.state };
}

/**
 * Fisher–Yates over the engine PRNG: a permutation of 0..n-1 plus the
 * advanced state. Powers turn order at game start (spec §3.1).
 */
export function shuffledRange(state: string, n: number): { readonly order: readonly number[]; readonly state: string } {
  const order: number[] = Array.from({ length: n }, (_, i) => i);
  let s = state;
  for (let i = n - 1; i >= 1; i--) {
    const r = drawBelow(s, i + 1);
    s = r.state;
    const j = r.value;
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  return { order, state: s };
}
