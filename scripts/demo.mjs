#!/usr/bin/env node
// Actual Flux UI with a disposable fictional project. No real chat is read or sent to.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStore } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';

const root = resolve(import.meta.dirname, '..');
if (!existsSync(join(root, 'public/build/index.html'))) throw new Error('Run npm run build before starting the demo.');
const directory = mkdtempSync(join(tmpdir(), 'flux-demo-'));
const store = createStore(directory);
const sessionId = 'example-checkout-chat', projectId = 'example-checkout';
const now = Date.now(), stamp = minutes => new Date(now - minutes * 60000).toISOString();
const source = { type: 'synthetic_example', ref: 'checkout-demo' };
const add = (id, kind, data, extra = {}) => store.append({ id, kind, projectId, sessionId, actor: 'Codex', provenance: 'agent_report', source, at: stamp(5), data, ...extra });
store.setProject({ id: projectId, title: 'Example · Checkout redesign', goal: 'Make checkout clear on every screen.', goalSourceId: 'direction', directory, sessionId, sessions: [{ id: sessionId, title: 'Example checkout project' }], items: [], plans: [], decisions: [], constraints: [] });
add('direction', 'message.user', {}, { actor: 'You', provenance: 'user', at: stamp(20), text: 'Refine the checkout for smaller screens. Keep the shared payment flow and existing components. Review the result before publishing.' });
const work = [
  { id: 'inspect', title: 'Inspect the existing checkout', status: 'completed', purpose: 'Find the shared fields, buttons and payment behavior.' },
  { id: 'layout', title: 'Refine the mobile checkout', status: 'in_progress', purpose: 'Improve field spacing and keep the order summary readable.' },
  { id: 'review', title: 'Review keyboard and small-screen behavior', status: 'pending', purpose: 'Verify the complete interaction before accepting the update.' },
];
work.forEach(item => add('work-' + item.id, 'item_updated', { item: { ...item, kind: 'work', sessionId, owner: 'Codex', sourceIds: ['direction'], returnCondition: 'Review the recorded result and its evidence.' } }));
add('plan-first', 'plan_saved', { plan: { id: 'v1', title: 'Checkout refinement', scopeId: 'checkout', at: stamp(18), steps: work.map(item => ({ id: item.id, title: item.title, status: 'pending' })), sourceIds: ['direction'] } }, { at: stamp(18) });
add('decision-components', 'decision_recorded', { decision: { id: 'reuse', title: 'Keep the shared payment flow', status: 'user_direction', rationale: 'The requested update changes presentation; payment behavior and existing components remain the baseline.', sourceIds: ['direction'] } }, { at: stamp(16) });
add('plan-current', 'plan_saved', { plan: { id: 'v2', title: 'Mobile layout, then interaction review', scopeId: 'checkout', at: stamp(4), steps: work.map(({ id, title, status }) => ({ id, title, status })), sourceIds: ['direction', 'work-inspect'] } }, { at: stamp(4) });
add('focus', 'project_patch', { patch: { focus: { title: 'Refining the mobile checkout', status: 'in_progress', sessionId, intentSourceId: 'direction', updatedAt: stamp(3), sourceIds: ['direction', 'plan-current'], why: { text: 'Keep fields and the order summary clear in a narrow window.', provenance: 'agent_report', sourceIds: ['direction'] }, next: { text: 'Review keyboard navigation and the small-screen layout.', status: 'planned', provenance: 'agent_report', sourceIds: ['plan-current'] } } } }, { at: stamp(3), summary: 'Current work and the next review step recorded' });
add('question-one', 'question_recorded', { question: { id: 'priority', origin: 'recorded', text: 'Which screen should we review first?', options: ['Inline browser', 'Mobile', 'Desktop'], sourceIds: ['direction'] } }, { at: stamp(2), summary: 'Choose the first review size' });
add('question-two', 'question_recorded', { question: { id: 'summary', origin: 'recorded', text: 'Should the order summary stay visible while entering payment details?', options: ['Keep it visible', 'Collapse on small screens'], sourceIds: ['direction'] } }, { at: stamp(1), summary: 'Choose how the order summary behaves' });

const refuse = async () => { throw new Error('Example project: delivery and native actions are disabled. Connect your own chat to use them.'); };
const app = await startServer({ dataDir: directory, store, publicDir: join(root, 'public'), port: 0, queueCommand: refuse, contentOptions: { reveal: refuse } });
console.log(JSON.stringify({ url: app.address, example: true, deliveryEnabled: false, records: 'Disposable synthetic project', stop: 'Press Ctrl+C to stop and remove the example records.' }, null, 2));
let closing = false;
const close = async () => { if (closing) return; closing = true; await app.close(); rmSync(directory, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', close); process.on('SIGTERM', close);
