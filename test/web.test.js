'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeEntities, extractSearchResults, htmlToText } = require('../src/lib/web');

test('HTML extraction removes scripts, markup, and decodes common entities', () => {
  const text = htmlToText('<h1>Report &amp; analysis</h1><script>steal()</script><p>Read&nbsp;this</p><ul><li>One</li><li>Two</li></ul>');
  assert.match(text, /Report & analysis/);
  assert.match(text, /Read this/);
  assert.match(text, /One/);
  assert.doesNotMatch(text, /steal/);
});

test('entity decoding handles decimal and hexadecimal code points', () => {
  assert.equal(decodeEntities('&#1044; &#x41; &quot;x&quot;'), 'Д A "x"');
});

test('DuckDuckGo result extraction returns titles and safe links', () => {
  const html = '<a class="result__a" href="https://example.com/article">Example &amp; guide</a><div class="result__snippet">A short description.</div>';
  const results = extractSearchResults(html);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Example & guide');
  assert.equal(results[0].url, 'https://example.com/article');
  assert.equal(results[0].snippet, 'A short description.');
});
