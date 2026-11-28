import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The page CSP is style-src 'self': a style attribute, a <style> element or cssText is blocked by the browser, and
// NfftDom.el() throws on a `style` key. CSSOM writes (node.style.left = ...) are allowed. Keep the markup free of
// inline styles so no render path (the stagger input crashed the Schedule tab and the graphic with it) can hit that.
const STATIC = path.join(__dirname, '..', 'static');
const own = (/** @type {string} */ f) => !f.startsWith('vendor') && !f.startsWith('demo-');
const files = (/** @type {string} */ ext) => fs.readdirSync(STATIC).filter((f) => f.endsWith(ext) && own(f));

test('static pages have no style attribute or style element', () => {
  for (const f of files('.html')) {
    const html = fs.readFileSync(path.join(STATIC, f), 'utf8');
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${f} has an inline style attribute`);
    assert.doesNotMatch(html, /<style[\s>]/i, `${f} has a <style> element`);
  }
});

test('page scripts never set an inline style attribute', () => {
  for (const f of files('.js')) {
    const src = fs.readFileSync(path.join(STATIC, f), 'utf8');
    assert.doesNotMatch(src, /\bstyle\s*:\s*['"`]/, `${f} passes a style string to el()/svg()`);
    assert.doesNotMatch(src, /setAttribute\(\s*['"`]style['"`]/, `${f} calls setAttribute('style')`);
    assert.doesNotMatch(src, /\.style\.cssText|\.style\.setProperty\(\s*['"`]--/, `${f} writes cssText`);
    assert.doesNotMatch(src, /\sstyle=["'\\]/, `${f} builds markup with a style attribute`);
  }
});

test('the stagger-minutes input is styled by a class defined in app.css', () => {
  const view = fs.readFileSync(path.join(STATIC, 'schedule-view.js'), 'utf8');
  const css = fs.readFileSync(path.join(STATIC, 'app.css'), 'utf8');
  assert.match(view, /class:\s*'stagger-input'/);
  assert.match(css, /\.stagger-input\s*\{[^}]*width:\s*5rem/);
});