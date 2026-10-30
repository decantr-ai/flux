import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { auditHelp, loadHelpAuditInputs } from '../scripts/audit-help.mjs';

const inputs = await loadHelpAuditInputs();

test('maintained help manifest covers its 26 topics and all declared source placements', async () => {
  const report = await auditHelp(inputs);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.topicCount, 26);
  assert.equal(report.sourcePlacementCount, report.declaredPlacementCount);
  assert.equal(new Set(inputs.manifest.placements.map(placement => placement.surface)).size, inputs.manifest.placements.length);
});

test('source coverage audit rejects removed coverage, unknown topics and undeclared additions', async () => {
  const file = 'ui/src/views/Context.tsx';
  const original = inputs.sources.get(file);
  const changed = new Map(inputs.sources);
  changed.set(file, original.replace('<HelpHint topic="source-selection" />', ''));
  const missing = await auditHelp({ ...inputs, sources: changed });
  assert.equal(missing.ok, false);
  assert(missing.errors.some(error => error.code === 'missing-placement' && error.surfaces.includes('context-source-selection')));

  changed.set(file, original.replace('topic="source-selection"', 'topic="unknown-fixture-topic"'));
  const unknown = await auditHelp({ ...inputs, sources: changed });
  assert(unknown.errors.some(error => error.code === 'unknown-topic' && error.topic === 'unknown-fixture-topic'));
  assert(unknown.errors.some(error => error.code === 'unmatched-placement'));

  changed.set(file, original.replace('<HelpHint topic="source-selection" />', '<HelpHint topic="source-selection" /><HelpHint topic="source-selection" />'));
  const added = await auditHelp({ ...inputs, sources: changed });
  assert(added.errors.some(error => error.code === 'unmatched-placement'));
});

test('source coverage audit rejects unused registered topics and nonliteral tags', async () => {
  const changed = new Map(inputs.sources);
  const file = 'ui/src/views/Timeline.tsx';
  changed.set(file, changed.get(file).replace('topic="timeline"', 'topic={selectedTopic}'));
  const result = await auditHelp({ ...inputs, sources: changed });
  assert(result.errors.some(error => error.code === 'nonliteral-topic'));
  assert(result.errors.some(error => error.code === 'unused-topic' && error.topic === 'timeline'));
});

// Compile the actual view against the same installed React runtime as the
// renderer. SSR verifies state-dependent presentation, not browser interactions.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../ui/src/views/Overview.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', target: 'es2022', format: 'cjs',
  jsx: 'automatic', packages: 'external',
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { Overview } = compiled.exports;
const card = (text, status = 'in_progress') => ({ text, status, sourceIds: [], provenance: 'agent_report' });
const work = (id, status) => ({ id, title: `Visible ${id}`, status, sourceIds: [], provenance: 'agent_report', returnCondition: status === 'parked' ? `Return for ${id}` : undefined });
function snapshot({ stale = false, parked = [], proposals = [] } = {}) {
  return {
    project: { id: 'test-project', items: [], plans: [] },
    events: [], requests: [],
    overview: {
      focus: { title: 'Recorded focus', status: stale ? 'needs_update' : 'current', workStatus: 'in_progress' },
      now: card('Current recorded work'), why: card('Recorded reason'), next: card('Recommended work', 'planned'),
      direction: card('New user request', 'user_direction'),
      events: [], workItems: [], openWork: { active: [], parked, proposals },
    },
  };
}
function render(options) {
  return renderToStaticMarkup(React.createElement(Overview, { snapshot: snapshot(options), onReview() {}, onAsk() {}, onSelect() {}, questionHistory: null }));
}

test('Overview distinguishes current focus from a newer request and stale recommendation', () => {
  const current = render();
  assert.match(current, />Now<\/span>/);
  assert(current.includes('Recommended next step'));
  assert(!current.includes('Your latest request'));
  assert(!current.includes('Previously recommended next step'));

  const stale = render({ stale: true });
  assert(stale.includes('Your latest request'));
  assert(stale.includes('New user request'));
  assert(stale.includes('Last recorded'));
  assert(stale.includes('Previously recommended next step'));
  assert(stale.includes('Current recorded work'));
  assert(stale.includes('Recorded reason'));
});

test('Overview keeps parked-only, ideas-only, mixed and empty states separate', () => {
  for (const [parkedCount, ideaCount] of [[1, 0], [0, 1], [2, 2], [0, 0]]) {
    const parked = Array.from({ length: parkedCount }, (_, index) => work(`parked-${index}`, 'parked'));
    const proposals = Array.from({ length: ideaCount }, (_, index) => work(`idea-${index}`, 'proposed'));
    const html = render({ parked, proposals });
    assert.equal(html.includes('>Parked work<'), parkedCount > 0);
    assert.equal(html.includes('>Other ideas<'), ideaCount > 0);
    for (const item of [...parked, ...proposals]) assert(html.includes(item.title), `${item.title} stays visible`);
    for (const item of parked) assert(html.includes(item.returnCondition));
    assert.equal(html.includes('data-solo-column="true"'), parkedCount === 0);
  }
});

test('Overview retains every proposal and its true total when parked work exceeds the old preview limit', () => {
  const parked = Array.from({ length: 5 }, (_, index) => work(`parked-${index}`, 'parked'));
  const proposals = Array.from({ length: 6 }, (_, index) => work(`idea-${index}`, 'proposed'));
  const html = render({ parked, proposals });
  assert.match(html, /<h3>Other ideas<\/h3><span[^>]*>6<\/span>/);
  assert.match(html, />Parked work<span[^>]*>5<\/span>/);
  for (const item of [...parked, ...proposals]) assert(html.includes(item.title), `${item.title} remains inspectable`);
});
