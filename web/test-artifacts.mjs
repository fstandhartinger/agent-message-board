import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function app(search = '') {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', checked: false,
      addEventListener() {}, classList: { add() {}, toggle() {} }, dataset: {} });
    return elements.get(id);
  };
  const context = { URLSearchParams, Intl, Date, Map, Set, location: { search, hash: '', pathname: '/' },
    localStorage: { getItem() { return null; }, setItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    window: { addEventListener() {} },
    document: { documentElement: { dataset: {} }, querySelector: get, querySelectorAll: () => [],
      addEventListener() {}, body: { classList: { toggle() {} } } } };
  vm.createContext(context);
  let source = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
  source = source.replace('  load();\n  setInterval(load, 60000);\n  setInterval(renderSync, 15000);',
    '  globalThis.api = { entryArtifacts, artifactFilter, filtersMatch, entryCard, renderList, render, state };');
  vm.runInContext(source, context);
  return { api: context.api, get };
}
const entry = (id, artifact_ids) => ({ id, artifact_ids, author: 'codex:test', kind: 'note', body: 'Example', createdAt: '2026-10-31', addresses: [] });
const thread = (id, entries) => ({ id, title: 'Thread ' + id, entries, tags: [], archived: false, pinned: false, lastActivity: '2026-10-31' });

test('lowercase ids render muted at the right; absent or malformed fields are safe', () => {
  const { api } = app();
  const html = api.entryCard(entry('1', ['B8C3FF', '00ff12', '<script>', 'B8C3FF']));
  assert.match(html, /class="artifact-ids">a#b8c3ff · a#00ff12<\/span>/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(api.entryCard(entry('2')), /class="artifact-ids"/);
  assert.doesNotMatch(api.entryCard(entry('2', 'not-an-array')), /class="artifact-ids"/);
  const css = fs.readFileSync(new URL('./public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.artifact-ids \{[^}]*color: var\(--muted\)[^}]*margin-left: auto/);
});

test('?artifact filters entries and thread sidebar, including old snapshots', () => {
  const { api, get } = app('?artifact=B8C3FF');
  assert.equal(api.artifactFilter(), 'b8c3ff');
  assert.equal(api.filtersMatch(entry('1', ['b8c3ff'])), true);
  assert.equal(api.filtersMatch(entry('2', ['00ff12'])), false);
  assert.equal(api.filtersMatch(entry('3')), false);
  api.state.board = { groups: {}, threads: [thread('10', [entry('1', ['b8c3ff'])]), thread('11', [entry('2')])] };
  api.renderList('');
  assert.match(get('#thread-list').innerHTML, /Thread 10/);
  assert.doesNotMatch(get('#thread-list').innerHTML, /Thread 11/);
  // Invalid URL ids never silently turn the filter off.
  assert.equal(app('?artifact=bad').api.filtersMatch(entry('1', ['b8c3ff'])), false);
  assert.equal(app().api.filtersMatch(entry('3')), true);
  assert.equal(app('?artifact=a%23B8C3FF').api.filtersMatch(entry('1', ['b8c3ff'])), true);
});

test('artifact landing page shows matching entry cards without a text query', () => {
  const { api, get } = app('?artifact=b8c3ff');
  const t = thread('10', [entry('1', ['b8c3ff']), entry('2', ['00ff12'])]);
  api.state.board = { groups: {}, threads: [t] };
  api.state.entries = t.entries.map((e) => ({ ...e, thread: t }));
  api.render();
  assert.match(get('#panel').innerHTML, /Artifact: a#b8c3ff/);
  assert.match(get('#panel').innerHTML, /id="e1"/);
  assert.doesNotMatch(get('#panel').innerHTML, /id="e2"/);
});
