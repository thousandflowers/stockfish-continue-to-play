import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const html = readFileSync(path.join(root, 'popup.html'), 'utf8');
const js = readFileSync(path.join(root, 'popup.js'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));

describe('popup', () => {
  it('does not hardcode a version number', () => {
    // v3.0.0 sat in the footer through the whole 3.1.0 release.
    expect(html).not.toMatch(/v\d+\.\d+\.\d+/);
  });

  it('fills the version from the manifest at runtime', () => {
    expect(html).toContain('id="version"');
    expect(js).toContain('chrome.runtime.getManifest().version');
  });

  it('names the injected button exactly as the content script does', () => {
    const content = readFileSync(path.join(root, 'content_chesscom.js'), 'utf8');
    const label = content.match(/textContent = '♟ (Continue vs [^']+)'/)?.[1];
    expect(label).toBeTruthy();
    expect(html).toContain(`"${label}"`);
  });

  it('offers a strength option for every documented level', () => {
    for (const v of ['auto', '800', '1200', '1600', '2000', 'max']) {
      expect(html).toContain(`value="${v}"`);
    }
  });

  it('declares every permission the popup actually uses', () => {
    if (/chrome\.storage/.test(js)) expect(manifest.permissions).toContain('storage');
  });
});
