'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');

test('renderer menu exposes working workspace actions, keyboard navigation, and visible separators', () => {
  assert.match(html, /id="app-menu-toggle"[^>]*aria-controls="app-menu"/);
  assert.match(html, /id="app-menu"[^>]*role="menu"/);
  assert.match(html, /class="topbar-divider" role="separator" aria-orientation="vertical"/);
  assert.ok((html.match(/class="app-menu-separator" role="separator"/g) || []).length >= 3);
  assert.match(styles, /\.topbar-divider\s*\{[^}]*width:\s*1px/);
  assert.match(styles, /\.app-menu-separator\s*\{[^}]*height:\s*1px/);

  const actionBlock = renderer.match(/const appMenuActions = \{([\s\S]*?)\n  \};/);
  assert.ok(actionBlock, 'every menu item must be routed to an application action');
  const actions = [...html.matchAll(/data-app-action="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(actions).size, actions.length, 'menu action identifiers must be unique');
  for (const action of actions) {
    assert.ok(actionBlock[1].includes(`'${action}':`) || actionBlock[1].includes(`${action}:`), `menu action "${action}" has no handler`);
  }

  assert.match(renderer, /event\.key === 'ArrowDown'/);
  assert.match(renderer, /event\.key === 'ArrowUp'/);
  assert.match(renderer, /event\.key === 'Escape'/);
  assert.match(renderer, /!view\.appMenu\.contains\(event\.target\)/);
});
