import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = f => JSON.parse(readFileSync(path.join(root, f), 'utf8'));
const chrome = read('manifest.json');
const firefox = read('manifest-firefox.json');
const pkg = read('package.json');
const content = readFileSync(path.join(root, 'content_chesscom.js'), 'utf8');

describe('manifests', () => {
  it('agree with package.json on the version', () => {
    // package.sh names the zips from manifest.json; a mismatch ships a file
    // whose name lies about its contents.
    expect(chrome.version).toBe(pkg.version);
    expect(firefox.version).toBe(pkg.version);
  });

  // Continuing from any position in the move list reads the page harder than
  // before, and the temptation is to reach for a permission to do it. It needs
  // none: everything comes from the DOM the content script is already in.
  it.each([['chrome', chrome], ['firefox', firefox]])(
    'ask for nothing beyond storage, on nothing beyond the two game paths (%s)',
    (_name, m) => {
      expect(m.permissions).toEqual(['storage']);
      expect(m.host_permissions).toBeUndefined();
      expect(m.optional_permissions).toBeUndefined();
      expect(m.optional_host_permissions).toBeUndefined();
      expect(m.content_scripts.flatMap(c => c.matches).sort())
        .toEqual(['*://*.chess.com/game/*', '*://*.chess.com/play/*']);
      expect(m.content_security_policy.extension_pages)
        .toBe("script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
    },
  );

  it.each([['chrome', chrome], ['firefox', firefox]])(
    'expose every engine file the content script asks for (%s)',
    (_name, m) => {
      const exposed = m.web_accessible_resources.flatMap(r => r.resources);
      for (const f of ['stockfish.js', 'stockfish.wasm']) {
        expect(content).toContain(`getURL('${f}')`);
        expect(exposed).toContain(f);
      }
    },
  );

  it.each([['chrome', chrome], ['firefox', firefox]])(
    'allow WebAssembly, which the engine now needs (%s)',
    (_name, m) => {
      // The engine is the WASM build: without this the worker cannot compile it.
      expect(m.content_security_policy.extension_pages).toContain("'wasm-unsafe-eval'");
    },
  );

  it('hands the .wasm location to the worker, which cannot resolve it alone', () => {
    // A blob worker has no base URL, so the loader reads the address from the
    // fragment of its own URL. Drop this and the engine hangs at startup.
    expect(content).toMatch(/new Worker\(blobUrl \+ '#' \+ encodeURIComponent\(wasmUrl\)\)/);
  });

  it('declares data collection for Firefox, which AMO now requires', () => {
    expect(firefox.browser_specific_settings.gecko.data_collection_permissions)
      .toEqual({ required: ['none'] });
  });

  it('keeps the two manifests identical apart from the known divergences', () => {
    const strip = m => {
      const c = structuredClone(m);
      delete c.background; delete c.browser_specific_settings;
      return c;
    };
    expect(strip(firefox)).toEqual(strip(chrome));
  });
});
