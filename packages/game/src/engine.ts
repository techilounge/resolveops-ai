// Tycoon City — Phase 1 engine facade (spec §4).
//
// Determinism machinery: canonical JSON (recursively sorted keys,
// undefined-valued object fields skipped) + 64-bit FNV-1a. Replay
// contract — createGame(seed, names) plus the ordered action log
// reproduces an identical stateHash on any machine, and the hash is
// stable under a JSON round-trip of the state.

import type { GameState } from './types';

export {
  applyAction,
  createGame,
  getLegalActions,
  TRANSITION_TABLE,
} from './state-machine';

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

/**
 * Canonical JSON: object keys sorted lexicographically, arrays order-
 * preserved, `undefined`-valued object fields omitted (matching
 * JSON.stringify semantics so a parse/stringify round-trip can never
 * change the hash). GameState is plain JSON data by construction.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(v => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  // Functions/symbols never appear in GameState; fail loudly rather than hash silently.
  throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
}

/** 64-bit FNV-1a over UTF-8 bytes, as 16 lowercase hex chars. */
export function fnv1a64(text: string): string {
  let h = FNV64_OFFSET;
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    h ^= BigInt(byte);
    h = (h * FNV64_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

/** Stable content hash of a game state (spec §3.9). */
export function stateHash(state: GameState): string {
  return fnv1a64(canonicalJson(state));
}
