import { describe, expect, it } from 'vitest';
import { main, resolveMigrateUrl } from './cli';

describe('resolveMigrateUrl', () => {
  it('prefers the direct DATABASE_URL over the pooled app URL', () => {
    expect(resolveMigrateUrl({ DATABASE_URL: 'postgresql://direct', APP_DATABASE_URL: 'postgresql://pooled' })).toBe('postgresql://direct');
  });

  it('falls back to APP_DATABASE_URL when no direct URL exists', () => {
    expect(resolveMigrateUrl({ APP_DATABASE_URL: 'postgresql://pooled' })).toBe('postgresql://pooled');
  });

  it('treats an empty variable as absent', () => {
    expect(resolveMigrateUrl({ DATABASE_URL: '', APP_DATABASE_URL: 'postgresql://pooled' })).toBe('postgresql://pooled');
  });

  it('fails with actionable guidance when neither URL is set', () => {
    expect(() => resolveMigrateUrl({})).toThrow(/DATABASE_URL.*APP_DATABASE_URL/s);
  });
});

describe('main', () => {
  it('propagates connection failures loudly (an unreachable migrator target must fail the deploy step)', async () => {
    const lines: string[] = [];
    // A port nothing listens on: fails fast with ECONNREFUSED regardless of
    // whether a local Postgres is running (CI's container uses 5432).
    await expect(
      main(
        { DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:59999/resolveops_missing' },
        (line) => lines.push(line),
      ),
    ).rejects.toThrow();
    expect(lines).toHaveLength(0);
  });
});
