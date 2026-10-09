import { describe, expect, it } from 'vitest';
import { RESERVED_ROUTES } from './route-map';

describe('RESERVED_ROUTES', () => {
  it('transcribes exactly the 13 non-R1 rows of the Blueprint §11 table', () => {
    expect(RESERVED_ROUTES).toHaveLength(13);
  });

  it('is fully reserved: /api/v1 paths, valid methods, unique method+path pairs', () => {
    const seen = new Set<string>();
    for (const route of RESERVED_ROUTES) {
      expect(route.path.startsWith('/api/v1/')).toBe(true);
      expect(['GET', 'POST', 'PATCH']).toContain(route.method);
      expect(route.blueprintPhase).toBeGreaterThanOrEqual(1);
      const key = `${route.method} ${route.path}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('covers every later-phase family the spec names', () => {
    const families = new Set(RESERVED_ROUTES.map((route) => route.family));
    for (const family of ['integrations', 'investigations', 'proposals', 'approvals', 'audit', 'usage']) {
      expect(families.has(family)).toBe(true);
    }
  });
});
