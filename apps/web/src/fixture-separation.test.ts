// Fixture-separation invariant (spec §4.4): the live client and live screens
// have NO import path to the demo's fixture data. Enforced at the source
// graph level — demo.tsx imports data/incident; nothing else outside the
// demo's own modules may. The demo mounts only through main.tsx's dynamic
// import, so the live bundle cannot even reach the fixture chunk.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The test lives in src/, so src/ is this file's own directory — resolve
// from __dirname, never the vitest CWD, which varies by invocation.
const SRC_ROOT = __dirname;

/** Live modules that must never touch the demo or its fixture chain. */
const LIVE_TREES = ['api', 'auth', 'guard', 'onboarding', 'pages', 'session', 'shell', 'states'];
const LIVE_ROOT_FILES = ['routes.tsx', 'live.css'];

const FORBIDDEN_LIVE_PATTERNS: RegExp[] = [
  /data\/incident/, // the fixture module itself
  /lib\/(assessment|inventory)/, // demo-only logic modules
];

function listFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

describe('fixture separation (spec §4.4)', () => {
  const allSourceFiles = listFiles(SRC_ROOT).filter((file) => /\.(ts|tsx)$/.test(file));

  it('has the demo boundary modules this test premises itself on', () => {
    expect(allSourceFiles).toContain(join(SRC_ROOT, 'demo.tsx'));
    expect(allSourceFiles).toContain(join(SRC_ROOT, 'data', 'incident.ts'));
  });

  it('demo.tsx is the ONLY module importing the fixture data', () => {
    for (const file of allSourceFiles) {
      const relative = file.slice(SRC_ROOT.length + 1);
      // Test files legitimately name the boundary they enforce.
      if (/\.test\.(ts|tsx)$/.test(relative)) {
        continue;
      }
      const contents = readFileSync(file, 'utf8');
      if (relative === 'demo.tsx') {
        expect(contents, 'demo.tsx must keep importing its fixture').toMatch(/data\/incident/);
        continue;
      }
      if (relative.startsWith('data/') || relative.startsWith('lib/') || relative === 'types.ts') {
        continue; // demo-side trees: the fixture data and its PROD-003 shims
      }
      for (const pattern of FORBIDDEN_LIVE_PATTERNS) {
        expect(contents, `${relative} must not reference demo-only modules`).not.toMatch(pattern);
      }
    }
  });

  it('live trees have no import path to the demo module', () => {
    for (const tree of LIVE_TREES) {
      for (const file of listFiles(join(SRC_ROOT, tree))) {
        const contents = readFileSync(file, 'utf8');
        expect(contents, `${file} must not import the demo`).not.toMatch(/from\s+'[^']*\bdemo\b/);
        expect(contents, `${file} must not dynamically import the demo`).not.toMatch(
          /import\(\s*['"][^'']*demo['"]\s*\)/,
        );
      }
    }
    for (const name of LIVE_ROOT_FILES) {
      const contents = readFileSync(join(SRC_ROOT, name), 'utf8');
      // Import statements only — prose comments may name the boundary.
      expect(contents, `${name} must not import the demo`).not.toMatch(/from\s+'[^']*\bdemo\b/);
      expect(contents, `${name} must not dynamically import the demo`).not.toMatch(
        /import\(\s*['"][^'']*demo['"]\s*\)/,
      );
    }
  });

  it('main.tsx mounts the demo only through a dynamic import', () => {
    const contents = readFileSync(join(SRC_ROOT, 'main.tsx'), 'utf8');
    expect(contents).toMatch(/import\(\s*'\.\/demo'\s*\)/);
    // No static demo import: `import ... from './demo'` would pull the
    // fixture chunk into the live bundle.
    expect(contents).not.toMatch(/import\s+[^;]*from\s+'\.\/demo'/);
  });
});
