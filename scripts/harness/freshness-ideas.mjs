import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, openSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url), repository = resolve(dirname(script), '../..');
const marker = '.freshness-ideas-lab';
const writeJSON = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const readJSON = file => JSON.parse(readFileSync(file, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function validate(directory) {
  const lab = realpathSync(directory);
  if (!lab.startsWith('/private/tmp/flux-freshness-ideas-') || !existsSync(join(lab, marker))) throw Error('Expected a marked synthetic freshness/ideas lab.');
  return lab;
}
async function load(lab) {
  const fixture = readJSON(join(lab, 'fixture.json'));
  const [{ createStore }, { buildOverview }, { runDiagnostic }] = await Promise.all(['store.mjs', 'overview.mjs', 'diagnostics.mjs'].map(file => import(pathToFileURL(join(lab, 'baseline/src', file)))));
  return { fixture, store: createStore(fixture.dataDir), buildOverview, runDiagnostic };
}
function checkpoint(version, sessionId) {
  return { id: `p${version}`, title: `Synthetic checkpoint P${version}`, sessionId, scopeId: 'synthetic-shared-work', at: new Date(Date.UTC(2026, 9, 20 + version, 12)).toISOString(), sourceIds: [`checkpoint-p${version}`], steps: [
    { id: 'discover', title: 'Discover the synthetic requirements', status: version === 1 ? 'todo' : 'completed' },
    { id: 'build', title: 'Build the synthetic interface', status: version === 1 ? 'todo' : version === 2 ? 'in_progress' : 'completed' },
    { id: 'check', title: `Inspect the synthetic interface · saved in P${version}`, status: version < 3 ? 'todo' : version === 3 ? 'in_progress' : 'completed' },
  ] };
}
function state(lab, stage, store, buildOverview) {
  const snapshot = store.snapshot();
  const calls = existsSync(join(lab, 'blocked-queue-calls.jsonl')) ? readFileSync(join(lab, 'blocked-queue-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length : 0;
  const result = { stage, planIds: snapshot.project.plans.map(plan => plan.id), proposals: (snapshot.proposals ?? []).map(value => ({ id: value.id, kind: value.kind, disposition: value.disposition, plannedItemId: value.plannedItemId, proposedBy: value.proposedBy, proposedAt: value.proposedAt, implementation: value.implementation })), queueCalls: calls, nativeCalls: 0, snapshot: { ...snapshot, overview: buildOverview(snapshot) } };
  const path = join(lab, `evidence-${stage}.json`); writeJSON(path, result);
  return { planIds: result.planIds, proposals: result.proposals.map(({ id, disposition, plannedItemId }) => ({ id, disposition, plannedItemId })), queueCalls: calls, nativeCalls: 0, evidencePath: path };
}
async function prepareContext(lab, store, fixture, runDiagnostic) {
  const snapshot = store.snapshot(), current = snapshot.project.plans.at(-1);
  const recordIds = [`checkpoint-${current.id}`, 'current-open-work', 'context-boundary', ...Array.from({ length: 20 }, (_, index) => `pressure-check-${index}`)];
  const result = await runDiagnostic(store, { question: 'Synthetic pressure preview: summarize the selected current plan, open work and recorded checks while naming context gaps.', baselinePlanId: current.id, recordIds, expectedRevision: snapshot.contextRevision, dispatch: false }, { queueCommand: async () => { throw Error('No queue calls are allowed for a context preview.'); }, projectDir: lab });
  writeJSON(join(lab, `context-preview-${result.id}.json`), result);
  fixture.contextPreviewId = result.id; writeJSON(join(lab, 'fixture.json'), fixture);
  return { requestId: result.id, manifest: result.contextManifest, promptSHA256: sha(result.prompt) };
}
const [mode, directory, argument] = process.argv.slice(2);
if (mode === '--prepare') {
  const { initializeLab } = await import(pathToFileURL(join(repository, 'scripts/harness/fixtures.mjs')));
  const lab = initializeLab(`/private/tmp/flux-freshness-ideas-20261029-${randomUUID().slice(0, 8)}`);
  writeFileSync(join(lab, marker), 'Synthetic checkpoint/coverage/proposal browser fixture v1\n');
  cpSync(join(repository, 'src'), join(lab, 'baseline/src'), { recursive: true });
  cpSync(join(repository, 'public'), join(lab, 'baseline/public'), { recursive: true });
  symlinkSync(join(repository, 'node_modules'), join(lab, 'baseline/node_modules'), 'dir');
  cpSync(script, join(lab, 'freshness-ideas.mjs'));
  const fixture = { lab, projectId: 'synthetic-freshness-ideas', sessionId: 'synthetic-freshness-chat', dataDir: join(lab, 'data'), nextVersion: 4 };
  writeJSON(join(lab, 'fixture.json'), fixture);
  const { store, buildOverview, runDiagnostic } = await load(lab);
  const owner = { projectId: fixture.projectId, sessionId: fixture.sessionId };
  store.setProject({ id: owner.projectId, title: 'Synthetic · Checkpoints and ideas', goal: 'Inspect following, pinned history, bounded context and recorded idea choices', directory: lab, sessionId: owner.sessionId, sessions: [{ id: owner.sessionId, title: 'Synthetic checkpoint and idea fixture' }], items: [], plans: [], decisions: [], constraints: [] });
  store.append({ ...owner, id: 'human-direction', kind: 'message.user', provenance: 'user', actor: 'You', at: '2026-10-20T12:00:00Z', text: 'Synthetic fixture only. Inspect history and optional ideas; no real work or messages are authorized.' });
  store.append({ ...owner, id: 'focus', kind: 'project_patch', provenance: 'agent_report', actor: 'Synthetic planner', data: { patch: { focus: { title: 'Inspect the selected checkpoint and optional ideas', status: 'in_progress', sessionId: owner.sessionId, intentSourceId: 'human-direction', sourceIds: ['human-direction'], updatedAt: '2026-10-23T12:00:00Z', why: { text: 'Check that current history and user choices remain distinct.' }, next: { text: 'Use the synthetic controls to inspect following and pinned history.', status: 'planned' } } } } });
  for (let version = 1; version <= 3; version++) store.append({ ...owner, id: `checkpoint-p${version}`, kind: 'plan_saved', provenance: 'agent_report', actor: 'Synthetic planner', at: checkpoint(version, owner.sessionId).at, summary: `Synthetic checkpoint P${version}`, data: { plan: checkpoint(version, owner.sessionId) } });
  store.append({ ...owner, id: 'current-open-work', kind: 'item_updated', provenance: 'agent_report', actor: 'Synthetic planner', text: 'Current synthetic work is inspecting the interface; the saved checkpoint steps retain their historical statuses.', data: { item: { id: 'check', title: 'Inspect the synthetic interface · current work', status: 'in_progress', sessionId: owner.sessionId, sourceIds: ['current-open-work'] } } });
  store.append({ ...owner, id: 'parked-work', kind: 'item_updated', provenance: 'agent_report', actor: 'Synthetic planner', data: { item: { id: 'parked', title: 'Synthetic committed work parked for later', status: 'parked', returnCondition: 'The recorded prerequisite is supplied.', sessionId: owner.sessionId, sourceIds: ['parked-work'] } } });
  store.append({ ...owner, id: 'idea-partial-original', kind: 'decision_recorded', provenance: 'agent_report', actor: 'Synthetic planner', at: '2026-10-01T12:00:00Z', text: 'Original synthetic suggestion: expand the fixture inspection controls.', data: { decision: { id: 'idea-partial', title: 'Expand synthetic inspection controls', status: 'proposed', rationale: 'Keep inspection choices explicit while preserving recorded source evidence.', sourceIds: ['idea-partial-original'] } } });
  store.append({ ...owner, id: 'partial-assessment-source', kind: 'verification', provenance: 'observed', actor: 'Synthetic reviewer', at: '2026-10-28T12:00:00Z', text: 'Synthetic source only: draft inspection controls are recorded. Automatic coverage is not established by this fixture.' });
  store.append({ ...owner, id: 'idea-partial-assessment', kind: 'decision_recorded', provenance: 'agent_report', actor: 'Synthetic reviewer', at: '2026-10-29T12:00:00Z', text: 'A later assessment must not replace the original suggestion actor or date.', data: { decision: { id: 'idea-partial', title: 'Expand synthetic inspection controls', status: 'proposed', rationale: 'Keep inspection choices explicit while preserving recorded source evidence.', sourceIds: ['idea-partial-original'], implementation: { status: 'partial', completedText: 'Draft inspection controls are recorded in this synthetic fixture.', remainingText: 'Automatic coverage remains unassessed.', provenance: 'agent_report', sourceIds: ['partial-assessment-source'] } } } });
  store.append({ ...owner, id: 'idea-unknown-original', kind: 'decision_recorded', provenance: 'agent_report', actor: 'Synthetic design review', at: '2026-10-02T12:00:00Z', text: 'Original unassessed synthetic suggestion.', data: { decision: { id: 'idea-unknown', title: 'Explore another synthetic presentation', status: 'proposed', rationale: 'Consider separately from committed work. No implementation assessment is recorded.', sourceIds: ['idea-unknown-original'] } } });
  store.append({ ...owner, id: 'context-boundary', kind: 'decision_recorded', provenance: 'user', actor: 'You', text: 'Keep the synthetic original checkpoints inspectable. Do not queue any native messages.', data: { decision: { id: 'context-boundary-choice', title: 'Preserve historical checkpoint evidence', status: 'user_direction', sourceIds: ['context-boundary'] } } });
  for (let index = 0; index < 20; index++) store.append({ ...owner, id: `pressure-check-${index}`, kind: 'verification', provenance: 'observed', actor: 'Synthetic checker', summary: `Synthetic pressure check ${index}`, text: `Synthetic check ${index} has limited fixture scope. ` + 'This recorded check does not establish full completion or native message delivery. '.repeat(35), data: { details: 'Synthetic bounded-scope check. '.repeat(60) } });
  const contextPreview = await prepareContext(lab, store, fixture, runDiagnostic);
  const html = readFileSync(join(lab, 'baseline/public/build/index.html'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="\/(build\/assets\/index-[^"/]+\.(?:js|css))"/g)].map(match => match[1]);
  const manifest = { lab, synthetic: true, nativeCalls: 0, uiSourceHashes: Object.fromEntries(['ui/src/lib/checkpoint-selection.ts','ui/src/components/CheckpointPicker.tsx','ui/src/components/ProposalList.tsx','ui/src/components/ContextCoverage.tsx','ui/src/views/Plan.tsx','ui/src/views/Changes.tsx','ui/src/views/Overview.tsx','ui/src/views/Decisions.tsx','ui/src/shell/FluxApp.tsx','ui/src/styles.css'].map(file => [file,sha(readFileSync(join(repository,file)))])), sourceHashes: Object.fromEntries(['store.mjs','overview.mjs','context.mjs','proposals.mjs','server.mjs'].map(file => [file, sha(readFileSync(join(lab, 'baseline/src', file)))])), assets: assets.map(path => ({ path, SHA256: sha(readFileSync(join(lab, 'baseline/public', path))), matchesCurrentBuild: sha(readFileSync(join(lab, 'baseline/public', path))) === sha(readFileSync(join(repository, 'public', path))) })), contextPreview };
  writeJSON(join(lab, 'manifest.json'), manifest);
  assert.equal(store.snapshot().proposals.length, 2);
  assert.equal(store.snapshot().project.plans.length, 3);
  console.log(JSON.stringify({ lab, ...state(lab, 'initial', store, buildOverview), manifest: join(lab, 'manifest.json'), launch: `node ${join(lab, 'freshness-ideas.mjs')} --launch ${lab}`, append: `node ${join(lab, 'freshness-ideas.mjs')} --append-checkpoint ${lab}`, removePinnedP2: `node ${join(lab, 'freshness-ideas.mjs')} --remove-pinned ${lab} p2`, contextPreviewId: contextPreview.requestId }, null, 2));
} else if (mode === '--launch') {
  const lab = validate(directory);
  const child = spawn(process.execPath, [join(lab, 'freshness-ideas.mjs'), '--serve', lab], { cwd: lab, detached: true, stdio: ['ignore', openSync(join(lab, 'server.log'), 'a'), openSync(join(lab, 'server-error.log'), 'a')] }); child.unref();
  writeJSON(join(lab, 'process.json'), { lab, pid: child.pid, cleanup: `kill -TERM ${child.pid}` }); console.log(JSON.stringify({ lab, pid: child.pid }));
} else if (mode === '--serve') {
  const lab = validate(directory), { fixture, store } = await load(lab);
  const { startServer } = await import(pathToFileURL(join(lab, 'baseline/src/server.mjs')));
  const queueCommand = async request => { appendFileSync(join(lab, 'blocked-queue-calls.jsonl'), JSON.stringify(request) + '\n'); throw Error('Synthetic freshness/idea fixture rejects all native sends.'); };
  const app = await startServer({ dataDir: fixture.dataDir, store, port: 0, watch: true, publicDir: join(lab, 'baseline/public'), queueCommand, contentOptions: { reveal: async () => { throw Error('Native reveal is disabled in this synthetic fixture.'); } } });
  const response = await fetch(app.address + '/api/state'); assert.equal(response.status, 200); writeJSON(join(lab, 'initial-http-state.json'), await response.json());
  const connection = { lab, pid: process.pid, url: app.address, transcriptWatcher: false, journalRefreshWatcher: true, nativeCalls: 0, cleanup: `kill -TERM ${process.pid}` }; writeJSON(join(lab, 'connection.json'), connection); console.log(JSON.stringify(connection, null, 2));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
} else if (mode === '--append-checkpoint' || mode === '--remove-pinned' || mode === '--prepare-context' || mode === '--state') {
  const lab = validate(directory), { fixture, store, buildOverview, runDiagnostic } = await load(lab);
  let stage = 'current';
  if (mode === '--append-checkpoint') {
    const previous = store.snapshot().project.plans, version = fixture.nextVersion++;
    assert(!previous.some(plan => plan.id === `p${version}`));
    store.append({ id: `checkpoint-p${version}`, projectId: fixture.projectId, sessionId: fixture.sessionId, kind: 'plan_saved', actor: 'Synthetic planner', provenance: 'agent_report', summary: `Synthetic checkpoint P${version}`, at: checkpoint(version, fixture.sessionId).at, data: { plan: checkpoint(version, fixture.sessionId) } });
    for (const old of previous) assert.deepEqual(store.snapshot().project.plans.find(value => value.id === old.id), old, 'Appending never alters old checkpoint steps.');
    writeJSON(join(lab, 'fixture.json'), fixture); stage = `appended-p${version}`;
  }
  if (mode === '--remove-pinned') {
    assert(typeof argument === 'string' && /^p\d+$/.test(argument), 'Name the exact synthetic checkpoint ID.');
    const plans = store.snapshot().project.plans; assert(plans.some(plan => plan.id === argument));
    store.append({ id: `remove-checkpoint-${argument}`, projectId: fixture.projectId, sessionId: fixture.sessionId, kind: 'project_patch', actor: 'Synthetic fixture', provenance: 'observed', summary: `Synthetic read-model removal of ${argument}; original journal evidence retained`, data: { patch: { plans: plans.filter(plan => plan.id !== argument) } } }); stage = `removed-${argument}`;
  }
  if (mode === '--prepare-context') console.log(JSON.stringify(await prepareContext(lab, store, fixture, runDiagnostic), null, 2));
  console.log(JSON.stringify({ lab, ...state(lab, stage, store, buildOverview) }, null, 2));
} else throw Error('Usage: freshness-ideas.mjs --prepare | --launch <lab> | --serve <lab> | --append-checkpoint <lab> | --remove-pinned <lab> pN | --prepare-context <lab> | --state <lab>');
