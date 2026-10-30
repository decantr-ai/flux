import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildOverview } from '../src/overview.mjs';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const decode = value => String(value).replace(/&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
  if (entity[0] === '#') return String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity.toLowerCase()];
}).replace(/&#39;/g, "'");

// This deliberately small DOM facade executes the shipped IIFE. Replacing innerHTML
// removes its old descendants; selectors and events operate on the live tree only.
class Element {
  constructor(document, tag, attrs = {}) {
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.tabIndex = Number(attrs.tabindex || 0);
    this.checked = 'checked' in attrs;
    this.disabled = 'disabled' in attrs;
    this._value = attrs.value;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        const enabled = force === undefined ? !names.has(name) : Boolean(force);
        if (enabled) names.add(name); else names.delete(name);
        this.className = [...names].join(' ');
        return enabled;
      },
      add: (...names) => names.forEach(name => this.classList.toggle(name, true)),
      remove: (...names) => names.forEach(name => this.classList.toggle(name, false)),
    };
  }
  get id() { return this.attrs.id || ''; }
  get type() { return this.attrs.type || ''; }
  get className() { return this.attrs.class || ''; }
  set className(value) { this.attrs.class = String(value); }
  get firstChild() { return this.children[0] ?? null; }
  get hidden() { return 'hidden' in this.attrs; }
  set hidden(value) { if (value) this.attrs.hidden = ''; else delete this.attrs.hidden; }
  get open() { return 'open' in this.attrs; }
  set open(value) { if (value) this.attrs.open = ''; else delete this.attrs.open; }
  get dataset() {
    return Object.fromEntries(Object.entries(this.attrs).filter(([name]) => name.startsWith('data-')).map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase()), value]));
  }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT') {
      const options = this.querySelectorAll('option');
      const option = options.find(node => node.hasAttribute('selected')) || options[0];
      return option ? option.getAttribute('value') ?? option.textContent : '';
    }
    return this.tagName === 'TEXTAREA' || this.tagName === 'OPTION' ? this.textContent : '';
  }
  set value(value) { this._value = String(value); }
  get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value) { this.children = [String(value)]; }
  get innerHTML() { return this._html ?? this.textContent; }
  set innerHTML(value) {
    this._html = String(value);
    this.children = [];
    parse(this.ownerDocument, this, this._html);
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  hasAttribute(name) { return name in this.attrs; }
  removeAttribute(name) { delete this.attrs[name]; }
  insertBefore(node, reference) {
    const index = reference === null ? -1 : this.children.indexOf(reference);
    node.parentElement = this;
    if (index < 0) this.children.push(node); else this.children.splice(index, 0, node);
    return node;
  }
  addEventListener(name, callback) {
    const callbacks = this.listeners.get(name) || [];
    callbacks.push(callback);
    this.listeners.set(name, callbacks);
  }
  contains(node) { return node === this || this.children.some(child => typeof child !== 'string' && child.contains(node)); }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (matches(node, selector)) return node; return null; }
  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (typeof child === 'string') continue;
      if (matches(child, selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  select() { this.focus(); this.setSelectionRange(0, this.value.length); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
class InputElement extends Element {}

function matches(node, selectors) {
  return selectors.split(',').some(part => {
    const selector = part.trim();
    if (selector.includes('>')) {
      const [parent, child] = selector.split('>').map(value => value.trim());
      return matches(node, child) && Boolean(node.parentElement && matches(node.parentElement, parent));
    }
    assert.ok(!/[ +~]/.test(selector.replace(/\[[^\]]*\]/g, '')), `Unsupported DOM selector: ${selector}`);
    const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    for (const match of selector.matchAll(/#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
      if (match[1] && node.id !== match[1]) return false;
      if (match[2] && !node.classList.contains(match[2])) return false;
      if (match[3] && (!node.hasAttribute(match[3]) || (match[4] !== undefined && node.getAttribute(match[3]) !== match[4]))) return false;
    }
    return true;
  });
}
function parse(document, parent, markup) {
  const stack = [parent];
  const voidTags = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);
  for (const token of markup.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][^>]*>|[^<]+/gi)) {
    const text = token[0];
    if (text.startsWith('<!')) continue;
    if (text.startsWith('</')) {
      const tag = text.match(/^<\/([\w-]+)/)[1].toUpperCase();
      const index = stack.findLastIndex(node => node.tagName === tag);
      if (index > 0) stack.length = index;
      continue;
    }
    if (!text.startsWith('<')) { stack.at(-1).children.push(decode(text)); continue; }
    const [, tag, attributes] = text.match(/^<([\w-]+)([\s\S]*?)\/?\s*>$/);
    const attrs = {};
    for (const attr of attributes.matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) attrs[attr[1]] = decode(attr[2] ?? attr[3] ?? attr[4] ?? '');
    const node = new (tag.toLowerCase() === 'input' ? InputElement : Element)(document, tag, attrs);
    node.parentElement = stack.at(-1);
    node.parentElement.children.push(node);
    if (!voidTags.has(node.tagName) && !text.endsWith('/>')) stack.push(node);
  }
}
function documentFixture() {
  const document = new Element(null, 'document');
  document.ownerDocument = document;
  document.createElement = tag => new Element(document, tag);
  document.getElementById = id => document.querySelectorAll('[id]').find(node => node.id === id) || null;
  document.activeElement = null;
  document.innerHTML = html;
  return document;
}

const at = minute => `2026-10-14T14:${String(minute).padStart(2, '0')}:00.000Z`;
function snapshotFixture() {
  const events = [
    { id: 'direction-old', kind: 'message.user', provenance: 'user', actor: 'user', sessionId: 'chat', at: at(0), summary: 'Make work understandable', text: 'Make the current work understandable before adding more features.' },
    { id: 'focus-source', kind: 'item_updated', provenance: 'agent_report', actor: 'Codex', sessionId: 'chat', at: at(1), summary: 'Build a clear Overview', text: 'I am building an Overview so the approved work is easy to follow.' },
    { id: 'decision-source', kind: 'decision_recorded', provenance: 'agent_report', actor: 'Codex', sessionId: 'chat', at: at(2), summary: 'Keep detailed views', text: 'Keep the detailed views available so history and evidence remain inspectable.' },
    { id: 'historical-source', kind: 'message.assistant', provenance: 'agent_report', actor: 'Codex', sessionId: 'chat', at: at(3), summary: 'Pilot was reported complete', text: 'The initial pilot was reported complete; current verification remains separate.' },
    { id: 'tool-source', kind: 'tool.started', provenance: 'observed', actor: 'tool', sessionId: 'chat', at: at(4), summary: 'NATIVE_TOOL_SENTINEL', data: { toolName: 'exec_command' } },
    { id: 'token-source', kind: 'usage.tokens', provenance: 'observed', actor: 'system', sessionId: 'chat', at: at(5), summary: 'NATIVE_TOKEN_SENTINEL', data: { usage: { input_tokens: 80, cached_input_tokens: 40, output_tokens: 20, total_tokens: 100 } } },
    { id: 'queued-diagnostic', kind: 'message.user', provenance: 'user', actor: 'user', sessionId: 'chat', at: at(6), summary: 'Flux diagnostic unrelated-check', text: 'Flux diagnostic unrelated-check\nFind unfinished work in an earlier project.', data: { requestId: 'unrelated-check' } },
  ];
  const snapshot = {
    revision: 7,
    contextRevision: 3,
    csrfToken: 'offline-csrf',
    runtime: {modelVersion:2, restartRequired:false},
    coverage: { adapter: 'local transcript', summary: 'Partial capture of public messages' },
    project: {
      id: 'frontend-fixture', title: 'Flux UX fixture', goal: 'Make work understandable', sessionId: 'chat',
      latestIntent: events[0].text, latestIntentSourceId: events[0].id, latestIntentSourceIds: [events[0].id],
      sessions: [{ id: 'chat', title: 'Approved UX work' }],
      focus: { title: 'Building a clear Overview', sourceIds: ['direction-old', 'focus-source'], intentSourceId: 'direction-old', next: { text: 'Dogfood the revised Overview with this chat.', status: 'planned' }, why: 'The user needs to understand the work before adding features.', updatedAt: at(1), status: 'active' },
      items: [
        { id: 'build-overview', title: 'Build a clear Overview', status: 'ready_for_review', purpose: 'Show the current work, rationale, and suggested next move.', sourceIds: ['focus-source'], provenance: 'agent_report', at: at(1) },
        { id: 'historical-pilot', title: 'Initial pilot', status: 'complete', sourceIds: ['historical-source'], provenance: 'agent_report', at: at(3) },
        { id: 'parked-feature', title: 'Park advanced features', status: 'parked', returnCondition: 'Return after the UX is dogfooded.', sourceIds: ['direction-old'], provenance: 'agent_report', at: at(1) },
        { id: 'proposed-feature', title: 'Suggested automation', status: 'proposed', sourceIds: ['decision-source'], provenance: 'agent_report', at: at(2) },
      ],
      plans: [
        { id: 'plan-old', title: 'Original pilot plan', at: at(0), kind: 'curated_history', sourceIds: ['historical-source'], steps: [{ id: 'stable-step', title: 'Build the original pilot', status: 'pending', sourceIds: ['historical-source'] }] },
        { id: 'plan-current', title: 'Approved Overview plan', at: at(1), sourceIds: ['focus-source'], steps: [{ id: 'stable-step', title: 'Build the original pilot', status: 'complete', sourceIds: ['historical-source'] }, { id: 'overview-step', title: 'Make current work understandable', status: 'active', sourceIds: ['focus-source'] }] },
      ],
      decisions: [{ id: 'keep-history', title: 'Keep the detailed views', rationale: 'History and sources should remain inspectable.', status: 'approved', at: at(2), sourceIds: ['decision-source'] }],
    },
    events,
    requests: [{ id: 'unrelated-check', question: 'UNRELATED_DIAGNOSTIC_SENTINEL', status: 'queued', at: at(6), revision: 7, contextRevision: 3, recordIds: [] }],
  };
  return projectOverview(snapshot);
}
function projectOverview(snapshot) { snapshot.overview = buildOverview(snapshot); return snapshot; }

async function browser(snapshot = snapshotFixture(), saved = null, { viewportWidth = Infinity } = {}) {
  const document = documentFixture();
  const storage = new Map(saved ? [[`flux:${snapshot.project.id}`, JSON.stringify(saved)]] : []);
  const calls = [], streams = [], clipboard = [], timers = [];
  let state = clone(snapshot);
  let requestNumber = 0;
  class EventSource {
    constructor(url) { this.url = url; this.listeners = new Map(); streams.push(this); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    close() { this.closed = true; }
    emit(name) { this.listeners.get(name)?.({ type: name }); }
  }
  const window = {
    EventSource,
    listeners: new Map(),
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    matchMedia(query) { return { matches: /max-width:\s*900px/.test(query) && viewportWidth <= 900 }; },
  };
  async function fetch(url, options = {}) {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, options, body });
    if (url === '/api/state') return { ok: true, json: async () => clone(state) };
    if(url==='/api/reviews'){
      assert.equal(options.headers['X-Flux-CSRF'], snapshot.csrfToken);
      assert.equal(body.expectedRevision, state.contextRevision);
      const item=state.project.items.find(item=>item.id===body.itemId);
      assert.equal(item.status,'ready_for_review');
      item.status=body.outcome==='accepted'?'completed':'in_progress';
      item.review={outcome:body.outcome,note:body.note,at:at(12)};
      state.contextRevision++;state.revision++;projectOverview(state);
      return {ok:true,json:async()=>({})};
    }
    assert.equal(url, '/api/diagnostics', 'The UI must only use its local API');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-Flux-CSRF'], snapshot.csrfToken);
    let result;
    if (body.requestId !== undefined) {
      assert.equal(body.dispatch, true);
      const reviewed = state.requests.find(request => request.id === body.requestId);
      assert.ok(reviewed, 'Queue must identify an existing reviewed draft');
      assert.equal(body.question, reviewed.question);
      assert.deepEqual(body.recordIds, reviewed.recordIds);
      assert.equal(body.selectedItemId ?? null, reviewed.selectedItemId);
      assert.equal(body.baselinePlanId ?? null, reviewed.baselinePlanId);
      result = { ...reviewed, status: ['queued', 'acknowledged', 'completed'].includes(reviewed.status) ? reviewed.status : 'queued' };
    } else {
      assert.equal(body.dispatch, false, 'The browser must review a draft before queueing its request ID');
      result = {
        id: `offline-request-${++requestNumber}`, question: body.question, status: 'prepared',
        at: at(8), contextRevision: state.contextRevision, recordIds: body.recordIds,
        selectedItemId: body.selectedItemId ?? null, baselinePlanId: body.baselinePlanId ?? null,
        prompt: `${body.question}\nLatest direction: ${state.overview.direction.text}\n${body.recordIds.map(id => `[${id}] ${state.events.find(event => event.id === id)?.text || ''}`).join('\n')}`,
      };
    }
    state.revision++;
    result.revision = state.revision;
    state.requests = [...state.requests.filter(request => request.id !== result.id), result];
    return { ok: true, json: async () => clone(result) };
  }
  const context = vm.createContext({
    document, window, EventSource, fetch, HTMLInputElement: InputElement,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    navigator: { clipboard: { writeText: async text => clipboard.push(text) } },
    setTimeout: callback => timers.push(callback), clearTimeout() {},
    console, Intl, Date, Map, Set, Array, String, Number, JSON, Boolean, Promise,
  });
  vm.runInContext(script, context, { filename: 'public/app.js' });
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
  const node = selector => { const element = document.querySelector(selector); assert.ok(element, `Missing live UI control: ${selector}`); return element; };
  const dispatch = (type, target, extra = {}) => {
    assert.ok(document.contains(target), 'Only live DOM nodes can receive an interaction');
    const event = { target, key: '', preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (let current = target; current; current = current.parentElement) for (const listener of current.listeners.get(type) || []) listener(event);
  };
  const click = async selector => { const target = node(selector); assert.equal(target.disabled, false, `Disabled control: ${selector}`); dispatch('click', target); await settle(); };
  const change = async (selector, value) => { const target = node(selector); if (target.type === 'checkbox') target.checked = value; else target.value = value; dispatch('change', target); await settle(); };
  const input = async (selector, value, caret = value.length) => { const target = node(selector); target.value = value; target.focus(); target.setSelectionRange(caret, caret); dispatch('input', target); await settle(); };
  await settle();
  assert.equal(calls[0]?.url, '/api/state');
  assert.doesNotMatch(node('#work-view').textContent, /Could not load/);
  assert.equal(streams[0]?.url, '/api/events');
  return {
    document, node, calls, streams, storage, clipboard, click, change, input, dispatch, settle,
    panel: () => node('#work-view').textContent,
    snapshot: () => clone(state),
    preferences: () => JSON.parse(storage.get(`flux:${snapshot.project.id}`) || 'null'),
    diagnostics: () => calls.filter(call => call.url === '/api/diagnostics'),
    async update(next) { state = clone(projectOverview(next)); streams[0].emit('update'); await settle(); },
  };
}
const sourceSelector = id => `[data-select-type="event"][data-select="${id}"]`;
const contextSelector = id => `[data-context="${id}"]`;

// Fixture wording is distinctive so an old plan, tool row, or queued question
// cannot accidentally satisfy a current Overview assertion.
test('legacy preferences open Overview, and all six actual views remain usable', async () => {
  const app = await browser(snapshotFixture(), { tab: 'Plan', selected: { type: 'item', id: 'historical-pilot' }, included: ['focus-source'] });
  assert.equal(app.node('#work-view').getAttribute('aria-labelledby'), 'tab-overview');
  assert.equal(app.node('#inspector').hidden, true);
  assert.equal(app.node('.shell').classList.contains('has-inspector'), false);
  assert.match(app.panel(), /Now/i);
  assert.ok(app.node('details.overview-settled').querySelector('[data-flux-chevron]'), 'Expandable sections show a Lucide disclosure marker');
  assert.match(app.panel(), /Why/i);
  assert.match(app.panel(), /Next/i);
  assert.match(app.panel(), /Building a clear Overview|Build a clear Overview/);
  const audit = app.node('details.overview-audit');
  assert.match(audit.textContent, /How we got here/);
  assert.match(audit.textContent, /Make work understandable/);
  assert.equal(audit.querySelectorAll('.audit-source').length, 2, 'Rationale and direction share one de-duplicated evidence trail');
  assert.match(audit.querySelectorAll('.audit-source')[0].textContent, /Make work understandable/, 'Evidence is ordered oldest to newest');
  assert.doesNotMatch(app.panel(), /Basis for this work|Inspect current direction/, 'The separate source accordions are replaced by one audit trail');
  assert.doesNotMatch(app.panel(), /Source for next step/, 'The next-step evidence is included in the same trail');
  assert.match(app.panel(), /Parked/);
  assert.match(app.panel(), /Suggestions/);
  assert.match(app.panel(), /Not approved/);
  const reviewRow = app.node('[data-select="build-overview"]');
  assert.match(reviewRow.textContent, /Ready for review/);
  assert.match(reviewRow.textContent, /Agent report/);
  assert.equal(reviewRow.querySelectorAll('.overview-status-chip').length, 1);
  assert.equal(reviewRow.querySelectorAll('.overview-provenance-chip').length, 1, 'Progress and evidence source are separate visible signals');
  assert.match(app.node('details.overview-settled').textContent, /Complete · reported/i);
  assert.doesNotMatch(app.node('details.overview-settled').textContent, /checks recorded.*Initial pilot/i, 'An old report does not establish verification');
  assert.doesNotMatch(app.node('#goal').textContent, /Initial pilot|UNRELATED_DIAGNOSTIC/);
  assert.doesNotMatch(app.panel(), /UNRELATED_DIAGNOSTIC_SENTINEL|Find unfinished work in an earlier project/);
  const tabNames = app.node('#tabs').querySelectorAll('[data-tab][role="tab"]').map(node => node.dataset.tab);
  assert.deepEqual(tabNames, ['Overview', 'Plan', 'Timeline', 'Changes', 'Decisions', 'Context']);
  for (const tab of tabNames) {
    await app.click(`#tab-${tab.toLowerCase()}`);
    assert.equal(app.node('#work-view').getAttribute('aria-labelledby'), `tab-${tab.toLowerCase()}`);
    assert.equal(app.node(`#tab-${tab.toLowerCase()}`).getAttribute('aria-selected'), 'true');
    assert.ok(app.panel().trim().length > 80, `Empty ${tab} view`);
  }
  const saved = app.preferences();
  assert.equal(saved.version, 2);
  const reopened = await browser(snapshotFixture(), saved);
  assert.equal(reopened.node('#work-view').getAttribute('aria-labelledby'), 'tab-context');
});

test('connection status names the detected client and refreshes when client metadata changes', async () => {
  const app = await browser(snapshotFixture(), null, { viewportWidth: 360 });
  const connection = app.node('#connection');
  assert.equal(connection.textContent, 'Reconnecting to Flux');
  assert.equal(connection.getAttribute('aria-label'), 'Reconnecting to Flux');
  assert.equal(connection.getAttribute('data-compact'), 'Codex');
  app.streams[0].onopen();
  assert.equal(connection.textContent, 'Reading Codex chat');

  const next = app.snapshot();
  next.project.clientName = 'Claude Code';
  await app.update(next);
  assert.equal(connection.textContent, 'Reading Claude Code chat');
  assert.equal(connection.getAttribute('data-compact'), 'Claude Code');
});

test('saved plan history keeps its own historical status and pinned selection on passive updates', async () => {
  const app = await browser();
  await app.click('#tab-plan');
  await app.change('#plan-select', 'plan-old');
  assert.equal(app.node('#plan-select').value, 'plan-old');
  assert.match(app.panel(), /Original pilot plan/);
  await app.click('[data-select-type="step"][data-select="stable-step"][data-select-plan="plan-old"]');
  assert.equal(app.node('#inspector').hidden, false);
  assert.match(app.node('#inspector').textContent, /Original pilot plan/);
  assert.match(app.node('#inspector').textContent, /Pending/i);
  assert.doesNotMatch(app.node('#inspector').textContent, /Recorded status\s*Complete|State in that plan\s*Complete/i);
  const next = snapshotFixture();
  next.revision++;
  next.project.plans.push({ id: 'plan-newer', title: 'Later unselected plan', at: at(9), sourceIds: ['focus-source'], steps: [{ id: 'stable-step', title: 'Build the original pilot', status: 'verified' }] });
  await app.update(next);
  assert.equal(app.node('#plan-select').value, 'plan-old');
  assert.match(app.panel(), /Newer plan available/);
  assert.match(app.node('#inspector').textContent, /Pending/i);
  await app.click('#tab-changes');
  await app.change('#baseline-plan', 'plan-old');
  await app.change('#current-plan', 'plan-current');
  assert.match(app.panel(), /Original pilot plan/);
  assert.match(app.panel(), /Approved Overview plan/);
  assert.match(app.panel(), /Retained.*updated|Updated/is);
});

test('Overview asks open a scoped composer directly without dispatching', async () => {
  const app = await browser(snapshotFixture(), { version: 2, tab: 'Overview', included: ['token-source'] });
  await app.click('[data-overview-ask="Why are we working on this now?"]');
  assert.equal(app.node('#inspector').hidden, true);
  assert.equal(app.node('#diagnostic-dialog').open, true);
  assert.equal(app.node('#composer-question').value, 'Why are we working on this now?');
  assert.equal(app.diagnostics().length, 1);
  const draft=app.diagnostics()[0].body;
  assert.equal(draft.dispatch, false);
  assert.ok(draft.recordIds.includes('focus-source'));
  assert.ok(!draft.recordIds.includes('token-source'), 'An unrelated old selection must not leak into a new project question');
  assert.equal(draft.baselinePlanId, undefined);
});

test('narrow panes keep filters and selected-work details in one layer at a time', async () => {
  const app = await browser(snapshotFixture(), null, { viewportWidth: 520 });
  await app.click('#scope-toggle');
  assert.equal(app.node('#sidebar').hidden, false);
  assert.equal(app.node('#scope-close').textContent, 'Done');
  await app.click('#scope-close');
  assert.equal(app.node('#sidebar').hidden, true);

  await app.click('[data-select-type="item"][data-select="proposed-feature"]');
  assert.equal(app.node('#inspector').hidden, false);
  await app.click('#scope-toggle');
  assert.equal(app.node('#inspector').hidden, true, 'Opening narrow filters closes selected-work details');
  assert.equal(app.node('#sidebar').hidden, false);

  await app.click('[data-select-type="item"][data-select="proposed-feature"]');
  assert.equal(app.node('#sidebar').hidden, true, 'Opening selected-work details closes narrow filters');
  assert.equal(app.node('#inspector').hidden, false);
});

test('tabs retain keyboard navigation and proposed work inspects the item that was selected', async () => {
  const app = await browser();
  app.dispatch('keydown', app.node('#tab-overview'), { key: 'ArrowRight' });
  assert.equal(app.node('#work-view').getAttribute('aria-labelledby'), 'tab-plan');
  assert.equal(app.document.activeElement, app.node('#tab-plan'));
  app.dispatch('keydown', app.node('#tab-plan'), { key: 'Home' });
  assert.equal(app.node('#work-view').getAttribute('aria-labelledby'), 'tab-overview');
  await app.click('[data-select-type="item"][data-select="proposed-feature"]');
  assert.match(app.node('#inspector').textContent, /Suggested automation/);
  assert.match(app.node('#inspector').textContent, /Proposed/);
  assert.match(app.node('#inspector').textContent, /Keep detailed views/);
});

test('timeline begins with meaningful activity and detailed mode reveals native metadata', async () => {
  const app = await browser();
  await app.click('#tab-timeline');
  assert.equal(app.node('#timeline-mode').value, 'meaningful');
  assert.match(app.panel(), /Make work understandable|Build a clear Overview/);
  assert.doesNotMatch(app.panel(), /NATIVE_TOOL_SENTINEL|NATIVE_TOKEN_SENTINEL/);
  await app.change('#timeline-mode', 'all');
  assert.match(app.panel(), /NATIVE_TOOL_SENTINEL/);
  assert.match(app.panel(), /NATIVE_TOKEN_SENTINEL/);
  await app.input('#timeline-search', 'NATIVE_TOKEN', 4);
  await app.change('#kind-filter', 'usage.tokens');
  const next = snapshotFixture();
  next.revision++;
  next.events.push({ id: 'passive-tool', kind: 'tool.returned', provenance: 'observed', actor: 'tool', at: at(9), sessionId: 'chat', summary: 'Another native tool returned' });
  await app.update(next);
  assert.equal(app.node('#timeline-mode').value, 'all');
  assert.equal(app.node('#kind-filter').value, 'usage.tokens');
  assert.equal(app.node('#timeline-search').value, 'NATIVE_TOKEN');
  assert.match(app.panel(), /NATIVE_TOKEN_SENTINEL/);
  assert.doesNotMatch(app.panel(), /NATIVE_TOOL_SENTINEL|Another native tool returned/);
});

test('source inspection is on demand and never changes included diagnostic evidence', async () => {
  const app = await browser(snapshotFixture(), { version: 2, tab: 'Overview', included: ['focus-source', 'decision-source'] });
  assert.equal(app.node('#inspector').hidden, true);
  await app.click('#tab-context');
  await app.change(contextSelector('decision-source'), false);
  assert.equal(app.node(contextSelector('decision-source')).checked, false);
  await app.click(sourceSelector('decision-source'));
  assert.equal(app.node('#inspector').hidden, false);
  assert.equal(app.node('.shell').classList.contains('has-inspector'), true);
  assert.match(app.node('#inspector').textContent, /Keep detailed views/);
  assert.equal(app.node(contextSelector('decision-source')).checked, false);
  assert.deepEqual(app.preferences().included, ['focus-source']);
  await app.change('#question', 'Why are we working on this now?');
  await app.click('#preview-question');
  assert.equal(app.diagnostics().length, 1);
  const request = app.diagnostics()[0].body;
  assert.equal(request.dispatch, false);
  assert.deepEqual(request.recordIds, ['focus-source']);
  assert.match(request.question, /event reference decision-source/);
  assert.doesNotMatch(app.node('#diagnostic-prompt').value, /\[decision-source\]/);
  assert.equal(app.node('#diagnostic-dialog').open, true);
  await app.click('[data-close-dialog]');
  await app.click('[data-close-inspector]');
  assert.equal(app.node('#inspector').hidden, true);
  assert.equal(app.node('.shell').classList.contains('has-inspector'), false);
  assert.equal(app.node(contextSelector('decision-source')).checked, false);
});

test('a later human direction makes recorded focus stale while queued diagnostics do not', async () => {
  const original = snapshotFixture();
  const app = await browser(original);
  assert.equal(original.overview.focus.status, 'current');
  assert.doesNotMatch(app.node('#goal').textContent, /UNRELATED_DIAGNOSTIC/);
  const next = snapshotFixture();
  next.revision++;
  next.contextRevision++;
  next.events.push({ id: 'direction-new', kind: 'message.user', provenance: 'user', actor: 'user', sessionId: 'chat', at: at(10), summary: 'Pause feature work and audit the evidence', text: 'Pause feature work and audit the evidence before implementing more.' });
  await app.update(next);
  assert.equal(next.overview.focus.status, 'needs_update');
  assert.match(app.panel(), /Pause feature work and audit the evidence/);
  assert.match(app.panel(), /needs.*update|changed|stale|reconcile/i);
  assert.doesNotMatch(app.node('#goal').textContent, /UNRELATED_DIAGNOSTIC|Find unfinished work in an earlier project/);
});

test('preview and queue have separate requests and queued UI waits for a result', async () => {
  const app = await browser(snapshotFixture(), { version: 2, tab: 'Context', included: ['focus-source'] });
  await app.click(sourceSelector('focus-source'));
  await app.click('#preview-question');
  assert.equal(app.diagnostics().length, 1);
  assert.equal(app.diagnostics()[0].body.dispatch, false);
  assert.equal(app.node('#queue-prompt').disabled, false);
  assert.match(app.node('#diagnostic-message').textContent, /Prepared|review/i);
  const preview = app.snapshot().requests.at(-1);
  await app.click('#queue-prompt');
  assert.equal(app.diagnostics().length, 2);
  assert.equal(app.diagnostics()[1].body.dispatch, true);
  assert.equal(app.diagnostics()[1].body.requestId, preview.id);
  assert.deepEqual(app.diagnostics()[1].body.recordIds, ['focus-source']);
  assert.equal(app.diagnostics()[1].body.expectedRevision, 3);
  assert.equal(app.node('#queue-prompt').disabled, true);
  assert.match(app.node('#diagnostic-message').textContent, /queue.*Waiting/is);
  assert.doesNotMatch(app.node('#diagnostic-message').textContent, /complete|finished|answered/i);
  assert.match(app.node('#inspector').textContent, /No answer recorded yet/i);
});

test('the open queued question shows its own recorded answer after passive refresh without redelivery', async () => {
  const app = await browser(snapshotFixture(), { version: 2, tab: 'Context', included: ['focus-source'] });
  await app.click(sourceSelector('focus-source'));
  await app.click('#preview-question');
  const preview = app.snapshot().requests.at(-1);
  await app.click('#queue-prompt');
  assert.equal(app.diagnostics()[1].body.requestId, preview.id);
  assert.equal(app.snapshot().requests.at(-1).id, preview.id);
  assert.equal(app.snapshot().requests.length, 2, 'Preview and queue must leave one question alongside the unrelated fixture request');
  assert.equal(app.node('#diagnostic-answer').hidden, true);

  const unrelated = app.snapshot();
  unrelated.revision++;
  Object.assign(unrelated.requests.find(request => request.id === 'unrelated-check'), { status: 'completed', result: 'UNRELATED_ANSWER_SENTINEL' });
  await app.update(unrelated);
  assert.equal(app.node('#diagnostic-answer').hidden, true, 'Another request’s result must not answer the open question');
  assert.doesNotMatch(app.node('#diagnostic-dialog').textContent, /UNRELATED_ANSWER_SENTINEL/);

  const completed = app.snapshot();
  const answer = 'The approved Overview is ready for dogfooding; current verification is incomplete.';
  completed.revision++;
  Object.assign(completed.requests.find(request => request.id === preview.id), { status: 'completed', result: answer, updatedAt: at(12) });
  await app.update(completed);
  assert.equal(app.node('#diagnostic-dialog').open, true);
  assert.equal(app.node('#diagnostic-answer').hidden, false);
  assert.equal(app.node('#diagnostic-answer-text').textContent, answer);
  assert.equal(app.node('#diagnostic-prompt').value, preview.prompt);
  assert.equal(app.node('#queue-prompt').textContent, 'Answered');
  assert.equal(app.node('#queue-prompt').disabled, true);
  assert.match(app.node('#diagnostic-message').textContent, /answer.*recorded/i);

  // Native clicks cannot activate a disabled button. Also exercise the delegated
  // handler directly so it guards an already-completed request itself.
  app.dispatch('click', app.node('#queue-prompt'));
  await app.settle();
  assert.equal(app.diagnostics().length, 2, 'An answered question must not be posted again');
  assert.equal(app.node('#diagnostic-answer-text').textContent, answer);
});

test('passive refresh preserves context selection, search caret, source expansion, and chosen question', async () => {
  const app = await browser(snapshotFixture(), { version: 2, tab: 'Context', included: ['focus-source', 'decision-source'] });
  await app.change(contextSelector('decision-source'), false);
  await app.click(sourceSelector('focus-source'));
  await app.change('#question', 'Challenge the evidence for completion');
  const sourceCard = app.node('details.source-card');
  sourceCard.open = true;
  await app.input('#context-search', 'Overview', 3);
  const next = snapshotFixture();
  next.revision++;
  next.events.push({ id: 'new-evidence', kind: 'verification', provenance: 'agent_report', actor: 'Codex', sessionId: 'chat', at: at(11), summary: 'New Overview update', text: 'New evidence must be deliberately included.' });
  await app.update(next);
  assert.equal(app.node('#context-search').value, 'Overview');
  assert.equal(app.document.activeElement, app.node('#context-search'));
  assert.equal(app.node('#context-search').selectionStart, 3);
  assert.equal(app.node('#question').value, 'Challenge the evidence for completion');
  assert.equal(app.node('details.source-card').open, true);
  assert.equal(app.node(contextSelector('focus-source')).checked, true);
  assert.equal(app.node(contextSelector('new-evidence')).checked, false);
  assert.deepEqual(app.preferences().included, ['focus-source']);
  await app.input('#context-search', '');
  assert.equal(app.node(contextSelector('decision-source')).checked, false);
  await app.click('#preview-question');
  assert.deepEqual(app.diagnostics().at(-1).body.recordIds, ['focus-source']);
});

test('new human direction invalidates an open preview before any dispatch', async () => {
  const app = await browser(snapshotFixture(), { version: 2, tab: 'Context', included: ['focus-source'] });
  await app.click(sourceSelector('focus-source'));
  await app.click('#preview-question');
  const next = snapshotFixture();
  next.revision++;
  next.contextRevision++;
  next.events.push({ id: 'direction-new', kind: 'message.user', provenance: 'user', actor: 'user', sessionId: 'chat', at: at(12), summary: 'Inspect sources first', text: 'Inspect sources first before continuing the build.' });
  await app.update(next);
  assert.match(app.node('#diagnostic-message').textContent, /changed.*prepare|changed.*review/is);
  await app.click('#queue-prompt');
  assert.equal(app.diagnostics().length, 2);
  assert.ok(app.diagnostics().every(call => call.body.dispatch === false), 'A stale preview must not dispatch automatically');
  assert.equal(app.diagnostics().at(-1).body.expectedRevision, 4);
  assert.match(app.node('#diagnostic-prompt').value, /Inspect sources first before continuing the build/);
  assert.deepEqual(app.diagnostics().at(-1).body.recordIds, ['focus-source']);
});

test('edited questions and excluded sources require a new preview before sending', async () => {
  const app=await browser();
  await app.click('[data-overview-ask="Where are we with the current plan?"]');
  const first=app.snapshot().requests.at(-1);
  await app.input('#composer-question','What evidence supports the review?');
  await app.change('[data-composer-source="focus-source"]',false);
  assert.match(app.node('#queue-prompt').textContent,/Update preview/);
  await app.click('#queue-prompt');
  const revised=app.snapshot().requests.at(-1);
  assert.notEqual(first.id,revised.id);
  assert.equal(revised.question,'What evidence supports the review?');
  assert.ok(!revised.recordIds.includes('focus-source'));
  assert.ok(app.diagnostics().every(call=>!call.body.dispatch));
  await app.click('#queue-prompt');
  assert.equal(app.diagnostics().at(-1).body.requestId,revised.id);
  assert.equal(app.diagnostics().at(-1).body.question,revised.question);
  assert.deepEqual(app.diagnostics().at(-1).body.recordIds,revised.recordIds);
});

test('Context opens the same composer with exactly the explicitly selected sources', async () => {
  const app=await browser(snapshotFixture(),{version:2,tab:'Context',included:['historical-source']});
  await app.click('[data-context-ask]');
  assert.deepEqual(app.diagnostics()[0].body.recordIds,['historical-source']);
  assert.equal(app.diagnostics()[0].body.selectedItemId,undefined);
  assert.equal(app.node('#diagnostic-dialog').open,true);
});

test('review decisions leave the queue, retain notes, and never manufacture verification', async () => {
  for(const outcome of ['accepted','changes_requested']){
    const app=await browser();
    assert.equal(app.node('.attention-section').querySelectorAll('[data-select]').length,1);
    await app.click('[data-select="build-overview"]');
    await app.input('#review-note','Checked the flow; follow up on mobile.');
    const passive=app.snapshot();passive.revision++;await app.update(passive);
    assert.equal(app.node('#review-note').value,'Checked the flow; follow up on mobile.');
    await app.click(`[data-review-outcome="${outcome}"]`);
    const item=app.snapshot().project.items.find(item=>item.id==='build-overview');
    assert.equal(item.status,outcome==='accepted'?'completed':'in_progress');
    assert.equal(item.review.note,'Checked the flow; follow up on mobile.');
    assert.equal(app.node('.attention-section').querySelectorAll('[data-select]').length,0);
    assert.match(app.node('#inspector').textContent,outcome==='accepted'?/Accepted by you/:/Changes requested/);
    assert.doesNotMatch(app.node('#inspector').textContent,/Complete · checks recorded/);
    assert.equal(app.diagnostics().length,0,'A review decision does not silently message Codex');
  }
});

test('audit expansion survives passive refresh and all review and proposal rows remain reachable', async () => {
  const fixture=snapshotFixture();
  for(let i=0;i<8;i++)fixture.project.items.push({id:'review-'+i,title:'Review '+i,status:'ready_for_review',sourceIds:['focus-source']});
  for(let i=0;i<4;i++)fixture.project.items.push({id:'idea-'+i,title:'Idea '+i,status:'proposed',sourceIds:['decision-source']});
  const app=await browser(projectOverview(fixture));
  app.node('details.overview-audit').open=true;
  await app.update(app.snapshot());
  assert.equal(app.node('details.overview-audit').open,true);
  assert.equal(app.node('.attention-section').querySelectorAll('[data-select]').length,9);
  assert.equal(app.node('.overview-suggestions').querySelectorAll('[data-select]').length,5);
});

test('unrelated checkpoints do not imply deleted work and work-map nodes use the same inspector', async () => {
  const fixture=snapshotFixture();
  fixture.project.plans.push({id:'other-scope',scopeId:'branding',title:'Branding work',steps:[{id:'logo',title:'Logo'}]});
  fixture.project.items[0].parentId='historical-pilot';
  const app=await browser(projectOverview(fixture));
  await app.click('#tab-changes');
  assert.match(app.panel(),/different or unknown work scopes/);
  assert.equal(app.document.querySelectorAll('.change-step.removed').length,0);
  await app.click('#tab-plan');
  await app.click('[data-plan-view="map"]');
  assert.match(app.node('.work-map').textContent,/recorded parent relationships/);
  assert.equal(app.node('.work-map').querySelectorAll('[data-select]').length,4);
  await app.click('[data-select="build-overview"]');
  assert.match(app.node('#inspector').textContent,/Review this work/);
  assert.ok(app.node('[data-review-outcome="accepted"]'));
});

test('raw token records remain available but do not lead the Context view', async () => {
  const app=await browser();await app.click('#tab-context');
  assert.equal(app.document.querySelector(contextSelector('token-source')),null);
  await app.change('#context-mode','all');
  assert.ok(app.node(contextSelector('token-source')));
});
