#!/usr/bin/env node
// Qualifies a retained archive through its installed public CLI, using synthetic data only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw Error(`Requires ${name} <path>`);
  return args[index + 1];
}
const archive = fs.realpathSync(option('--archive'));
const requestedOut = path.resolve(option('--out'));
const temporaryRoot = fs.realpathSync('/private/tmp');
const parent = fs.realpathSync(path.dirname(requestedOut));
assert.ok(parent === temporaryRoot || parent.startsWith(`${temporaryRoot}${path.sep}`), '--out must be a new directory under /private/tmp');
const out = path.join(parent, path.basename(requestedOut));
assert.equal(fs.existsSync(out), false, '--out already exists; choose a new directory');
assert.ok(fs.statSync(archive).isFile(), '--archive must name a retained package archive');
fs.mkdirSync(out, { mode: 0o700 });
fs.writeFileSync(path.join(out, '.flux-package-install-harness'), 'Synthetic installed-package verification\n');
// Keep install and inventory bound to the same bytes even if a concurrent build replaces dist/.
const archiveBytes = fs.readFileSync(archive);
const retainedArchive = path.join(out, 'retained-package.tgz');
fs.writeFileSync(retainedArchive, archiveBytes, { mode: 0o600 });
const leaveRunning = args.includes('--leave-running');
const prefix = path.join(out, 'npm-prefix');
const cache = '/private/tmp/flux-npm-cache';
const fakeBin = path.join(out, 'fake-bin');
const codexLog = path.join(out, 'codex-invocations.jsonl');
for (const dir of [prefix, fakeBin]) fs.mkdirSync(dir);
fs.writeFileSync(codexLog, '');
fs.writeFileSync(path.join(fakeBin, 'codex'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.FLUX_PACKAGE_HARNESS_CODEX_LOG, JSON.stringify({args:process.argv.slice(2)})+'\\n');\nconsole.error('Synthetic package harness refuses every Codex invocation'); process.exitCode=91;\n`, { mode: 0o755 });
const env = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`, FLUX_PACKAGE_HARNESS_CODEX_LOG: codexLog };
const report = {
  version: 1, experiment: 'installed-flux-archive-synthetic-local-qualification', status: 'running',
  startedAt: new Date().toISOString(), archive, retainedArchive, archiveSha256: hash(archiveBytes),
  harnessSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))), out, prefix, cache,
  node: process.version, platform: process.platform, leaveRunning, results: [], commands: [],
  boundaries: { syntheticProjectsOnly: true, realCodexQueue: false, diagnosticDispatch: false, sourceOrDependencySymlinks: false },
  limitations: ['Synthetic installed-package qualification, not public npm publication or native Codex queue qualification.', 'Browser appearance and native Codex skill discovery require separate review.'],
};
const save = () => fs.writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
let commandNumber = 0;
async function run(file, argv, { expected = 0, timeout = 20000 } = {}) {
  const log = `${String(++commandNumber).padStart(3, '0')}-${path.basename(file).replace(/[^a-z0-9.-]/gi, '_')}`;
  let value;
  try { value = { code: 0, ...await execute(file, argv, { cwd: out, env, timeout, maxBuffer: 12 * 1024 * 1024 }) }; }
  catch (error) { value = { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '', killed: error.killed, signal: error.signal }; }
  fs.writeFileSync(path.join(out, `${log}.stdout.txt`), value.stdout);
  fs.writeFileSync(path.join(out, `${log}.stderr.txt`), value.stderr);
  report.commands.push({ command: file, args: argv, code: value.code, stdout: `${log}.stdout.txt`, stderr: `${log}.stderr.txt` });
  if (expected === 'nonzero') assert.notEqual(value.code, 0, `Unexpected success: ${file} ${argv[0]}`);
  else assert.equal(value.code, expected, `${file} ${argv[0]} failed: ${value.stderr.slice(0, 1500)}`);
  return value;
}
async function step(id, operation) {
  const started = Date.now();
  try { const evidence = await operation(); report.results.push({ id, status: 'passed', durationMs: Date.now() - started, evidence }); save(); return evidence; }
  catch (error) { report.results.push({ id, status: 'failed', durationMs: Date.now() - started, error: error.message }); save(); throw error; }
}
const cli = path.join(prefix, 'node_modules', '.bin', 'flux');
const installed = path.join(prefix, 'node_modules', '@decantr', 'flux');
const parse = result => JSON.parse(result.stdout);
const contexts = [];
const publicState = async url => {
  const response = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200); return response.json();
};
const cliArgs = context => ['--project', context.project, '--session', context.session];
const command = async (context, verb, extra = [], options) => run(cli, [verb, ...extra, ...cliArgs(context)], options);
const snapshot = async context => parse(await command(context, 'snapshot', ['--full']));
function jsonInput(name, value) { const file = path.join(out, `${name}.json`); fs.writeFileSync(file, JSON.stringify(value, null, 2)); return file; }
function appendTranscript(file, role, text) {
  fs.appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } })}\n`);
}
try {
  await step('archive-inventory', async () => {
    const inventory = (await run('tar', ['-tzf', retainedArchive])).stdout.trim().split('\n');
    const forbidden = inventory.filter(file => !file.startsWith('package/') || file.split('/').includes('..') || /(?:^|\/)\.flux(?:\/|$)|(?:^|\/)connection\.json$|(?:^|\/)bootstrap\.mjs$|(?:^|\/)node_modules\/|^package\/plugin\/|^package\/ui\//.test(file));
    assert.deepEqual(forbidden, [], 'Archive contains excluded or unsafe paths');
    fs.writeFileSync(path.join(out, 'archive-inventory.json'), JSON.stringify(inventory, null, 2));
    report.inventory = { entries: inventory.length, file: 'archive-inventory.json' };
    return report.inventory;
  });
  await step('empty-prefix-production-install', async () => {
    assert.deepEqual(fs.readdirSync(prefix), []);
    await run('npm', ['install', '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, retainedArchive], { timeout: 150000 });
    assert.ok(fs.existsSync(cli), 'npm did not create the public flux executable');
    assert.ok(fs.realpathSync(cli).startsWith(`${installed}${path.sep}`));
    assert.equal(fs.lstatSync(path.join(installed, 'src')).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(path.join(prefix, 'node_modules')).isSymbolicLink(), false);
    return { emptyPrefix: true, executable: cli, installedRuntime: fs.realpathSync(cli) };
  });
  await step('production-dependency-tree-and-personal-data', async () => {
    const tree = parse(await run('npm', ['ls', '--prefix', prefix, '--omit=dev', '--all', '--json']));
    fs.writeFileSync(path.join(out, 'npm-production-tree.json'), JSON.stringify(tree, null, 2));
    const names = new Set();
    const visit = node => { for (const [name, child] of Object.entries(node.dependencies || {})) { names.add(name); visit(child); } };
    visit(tree);
    const forbidden = [...names].filter(name => /^(react|react-dom|vite|typescript|esbuild|tailwindcss|@vitejs\/.*|@types\/react.*|@tailwindcss\/.*)$/.test(name));
    assert.deepEqual(forbidden, [], 'Frontend development dependencies leaked into the production install');
    for (const name of ['react', 'react-dom', 'vite', 'typescript', 'esbuild']) assert.equal(fs.existsSync(path.join(prefix, 'node_modules', name)), false, `Unexpected development dependency directory: ${name}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    const inventory = JSON.parse(fs.readFileSync(path.join(out, 'archive-inventory.json'), 'utf8'));
    const personal = [];
    for (const entry of inventory) {
      const relative = entry.slice('package/'.length), file = path.join(installed, relative);
      if (!relative || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      assert.equal(fs.lstatSync(file).isSymbolicLink(), false, `Archive source is symlinked: ${relative}`);
      if (!/\.(?:mjs|js|json|md|txt|html|css)$|(?:^|\/)NOTICE$/.test(relative)) continue;
      if (/\/Users\/[^/\s"'<>]+\/|\/home\/[^/\s"'<>]+\//.test(fs.readFileSync(file, 'utf8'))) personal.push(relative);
    }
    assert.deepEqual(personal, [], 'Personal path or pilot material found in shipped text');
    report.package = { name: manifest.name, version: manifest.version, runtimeDependencies: manifest.dependencies, dependencyCount: names.size, tree: 'npm-production-tree.json' };
    assert.equal(manifest.name, '@decantr/flux');
    return { ...report.package, forbiddenDependencies: forbidden, personalPathMatches: personal };
  });
  await step('installed-cli-version-help', async () => {
    const version = (await run(cli, ['--version'])).stdout.trim();
    assert.equal(version, report.package.version);
    const help = (await run(cli, ['--help'])).stdout;
    for (const verb of ['connect', 'start', 'disconnect', 'install-skill', 'checkpoint', 'result']) assert.ok(help.includes(verb));
    return { version, installedBin: cli };
  });
  const projectA = path.join(out, 'project-a'), projectB = path.join(out, 'project-b');
  for (const project of [projectA, projectB]) fs.mkdirSync(project);
  const transcriptA = path.join(out, 'synthetic-alpha.jsonl'), transcriptB = path.join(out, 'synthetic-beta.jsonl');
  for (const [transcript, session] of [[transcriptA, 'synthetic-alpha'], [transcriptB, 'synthetic-beta']]) {
    fs.writeFileSync(transcript, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: session } })}\n`);
    appendTranscript(transcript, 'user', `Synthetic ${session} instruction: review a small checkout interface and preserve both themes.`);
    appendTranscript(transcript, 'assistant', `Synthetic ${session} public progress: preparing the review.`);
  }
  contexts.push({ project: projectA, session: 'synthetic-alpha', transcript: transcriptA }, { project: projectA, session: 'synthetic-beta', transcript: transcriptB }, { project: projectB, session: 'synthetic-alpha', transcript: transcriptA });
  const primary = contexts[0];
  let skillPath;
  await step('generic-skill-install-helper-and-conflicts', async () => {
    const result = parse(await run(cli, ['install-skill', '--project', projectA])); skillPath = result.path;
    assert.equal(parse(await run(cli, ['install-skill', '--project', projectA])).alreadyInstalled, true);
    const helper = path.join(skillPath, 'scripts', 'flux.mjs');
    assert.deepEqual(parse(await run(process.execPath, [helper, 'status'])), []);
    await run(process.execPath, [helper, 'status', '--project', projectB], { expected: 'nonzero' });
    const skill = path.join(skillPath, 'SKILL.md'), original = fs.readFileSync(skill);
    fs.appendFileSync(skill, '\nSynthetic local modification to preserve.\n');
    const modifiedHash = hash(fs.readFileSync(skill));
    await run(cli, ['install-skill', '--project', projectA], { expected: 'nonzero' });
    await run(cli, ['uninstall-skill', '--project', projectA], { expected: 'nonzero' });
    assert.equal(hash(fs.readFileSync(skill)), modifiedHash);
    fs.writeFileSync(skill, original);
    const conflict = path.join(projectB, '.agents', 'skills', 'flux'); fs.mkdirSync(conflict, { recursive: true });
    fs.writeFileSync(path.join(conflict, 'SKILL.md'), 'Unmanaged synthetic skill; preserve this.\n');
    await run(cli, ['install-skill', '--project', projectB], { expected: 'nonzero' });
    assert.equal(fs.readFileSync(path.join(conflict, 'SKILL.md'), 'utf8'), 'Unmanaged synthetic skill; preserve this.\n');
    return { path: skillPath, helperInvoked: true, boundProjectEscapeRejected: true, modifiedAndUnmanagedSkillsPreserved: true };
  });
  await step('exact-chat-connect-import-and-isolation', async () => {
    await run(cli, ['connect', '--project', projectA, '--session', 'wrong-chat', '--transcript', transcriptA], { expected: 'nonzero' });
    assert.equal(fs.existsSync(path.join(projectA, '.flux')), false);
    const identities = [];
    for (const context of contexts) {
      const enrollment = parse(await command(context, 'connect', ['--transcript', context.transcript]));
      context.enrollment = enrollment;
      context.dataDir = path.join(context.project, '.flux', 'chats', hash(context.session));
      assert.equal(enrollment.sessionId, context.session);
      assert.equal((await snapshot(context)).project.plans.length, 0, 'New enrollment invented a plan');
      await command(context, 'import');
      const state = await snapshot(context);
      assert.ok(state.events.some(event => event.text?.includes(`Synthetic ${context.session} instruction`)));
      assert.ok(!state.events.some(event => event.text?.includes(context.session === 'synthetic-alpha' ? 'Synthetic synthetic-beta' : 'Synthetic synthetic-alpha')));
      identities.push({ project: context.project, projectId: state.project.id, session: context.session, dataDir: context.dataDir });
    }
    assert.equal(new Set(identities.map(item => item.dataDir)).size, 3);
    assert.notEqual(identities[0].projectId, identities[2].projectId);
    const marker = jsonInput('isolation-event', { id: 'only-primary-record', kind: 'checkpoint', summary: 'PRIMARY_ONLY_SENTINEL' });
    await command(primary, 'record', ['--json', marker]);
    for (const other of contexts.slice(1)) assert.equal(JSON.stringify(await snapshot(other)).includes('PRIMARY_ONLY_SENTINEL'), false);
    report.identities = identities;
    return { mismatchedTranscriptRejectedWithoutEnrollment: true, identities, crossProjectAndCrossChatIsolated: true };
  });
  await step('record-focus-checkpoint-and-installed-helper', async () => {
    const before = await snapshot(primary);
    const instruction = before.events.find(event => event.kind === 'message.user'); assert.ok(instruction?.id);
    const record = jsonInput('focus', { id: 'synthetic-focus', kind: 'project_patch', actor: 'Codex', provenance: 'agent_report', summary: 'Recorded synthetic current focus', data: { patch: { focus: { title: 'Review the checkout update', status: 'in_progress', sessionId: primary.session, intentSourceId: instruction.id, sourceIds: [instruction.id], updatedAt: new Date().toISOString(), why: { text: 'Keep the shared payment flow intact', sourceIds: [instruction.id], provenance: 'agent_report' }, next: { text: 'Check the interface before accepting it', status: 'planned', sourceIds: [instruction.id], provenance: 'agent_report' } } } } });
    await command(primary, 'record', ['--json', record]);
    const checkpoint = jsonInput('checkpoint', { id: 'synthetic-plan', title: 'Checkout review', sessionId: primary.session, steps: [{ id: 'inspect', title: 'Inspect the existing interface', status: 'completed' }, { id: 'review', title: 'Review the checkout update', status: 'in_progress' }] });
    await command(primary, 'checkpoint', ['--json', checkpoint]);
    const helper = path.join(skillPath, 'scripts', 'flux.mjs');
    const state = parse(await run(process.execPath, [helper, 'snapshot', '--session', primary.session, '--full']));
    assert.equal(state.project.focus.title, 'Review the checkout update');
    assert.ok(state.project.plans.some(plan => plan.id === 'synthetic-plan'));
    const foreign = jsonInput('foreign-focus', { kind: 'project_patch', data: { patch: { focus: { title: 'Foreign focus', sessionId: 'synthetic-beta' } } } });
    await command(primary, 'record', ['--json', foreign], { expected: 'nonzero' });
    return { focus: state.project.focus.title, checkpoint: 'synthetic-plan', sourceId: instruction.id, foreignSessionRejected: true };
  });
  let firstUrl, preparedId, answer;
  await step('installed-lifecycle-health-and-built-assets', async () => {
    const running = parse(await command(primary, 'start')); firstUrl = running.url;
    assert.match(firstUrl, /^http:\/\/127\.0\.0\.1:\d+$/); assert.equal(running.running, true);
    const healthResponse = await fetch(`${firstUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    assert.equal(healthResponse.status, 200); const health = await healthResponse.json(); assert.equal(health.ok, true);
    const response = await fetch(firstUrl); assert.equal(response.status, 200); const html = await response.text();
    assert.ok(html.includes('/build/assets/'), 'Installed package did not serve the compiled dashboard');
    const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/build\/assets\/[^"?]+)"/g)].map(match => match[1]))];
    assert.ok(assets.some(asset => asset.endsWith('.js')) && assets.some(asset => asset.endsWith('.css')));
    const evidence = [];
    for (const asset of assets) {
      const fetched = await fetch(`${firstUrl}${asset}`); assert.equal(fetched.status, 200);
      const bytes = Buffer.from(await fetched.arrayBuffer());
      const packed = fs.readFileSync(path.join(installed, 'public', asset)); assert.equal(hash(bytes), hash(packed));
      evidence.push({ path: asset, bytes: bytes.length, sha256: hash(bytes), contentType: fetched.headers.get('content-type') });
    }
    const state = await publicState(firstUrl); assert.equal(state.project.sessionId, primary.session); assert.equal(state.runtime.restartRequired, false);
    return { url: firstUrl, instanceId: running.instanceId, health: health.ok, assets: evidence, compiledUiWithoutBuildTools: true };
  });
  await step('http-read-only-prepare-and-same-id-cli-result', async () => {
    const state = await publicState(firstUrl);
    const selected = state.events.filter(event => event.id === 'synthetic-focus' || event.kind === 'plan_saved').map(event => event.id);
    assert.ok(selected.length >= 2);
    const beforeWork = JSON.stringify({ focus: state.project.focus, plans: state.project.plans, items: state.project.items });
    const response = await fetch(`${firstUrl}/api/diagnostics`, { method: 'POST', signal: AbortSignal.timeout(3000), headers: { 'content-type': 'application/json', 'x-flux-csrf': state.csrfToken, origin: firstUrl }, body: JSON.stringify({ question: 'What is current, what evidence is recorded, and what should happen next?', recordIds: selected, expectedRevision: state.contextRevision, dispatch: false }) });
    assert.equal(response.status, 200); const prepared = await response.json(); preparedId = prepared.id;
    assert.equal(prepared.status, 'prepared'); assert.equal(prepared.dispatch, false); assert.ok(prepared.prompt?.includes('Review the checkout update'));
    const after = await publicState(firstUrl);
    assert.equal(JSON.stringify({ focus: after.project.focus, plans: after.project.plans, items: after.project.items }), beforeWork, 'Diagnostic preparation mutated work state');
    answer = 'The recorded focus is reviewing the checkout update to keep the shared payment flow intact. The saved checkpoint reports inspection complete and review in progress. No browser verification is supplied by those records; inspect the interface before accepting it.';
    await command(primary, 'result', [preparedId, '--text', answer]);
    const answered = await publicState(firstUrl), request = answered.requests.find(item => item.id === preparedId);
    assert.equal(request?.status, 'completed'); assert.equal(request.result, answer);
    const duplicate = parse(await command(primary, 'result', [preparedId, '--text', answer])); assert.equal(duplicate.alreadyRecorded, true);
    assert.equal(answered.events.filter(event => event.kind === 'diagnostic_result' && event.data?.requestId === preparedId).length, 1);
    fs.writeFileSync(path.join(out, 'prepared-diagnostic.json'), JSON.stringify({ ...prepared, promptSha256: hash(prepared.prompt) }, null, 2));
    report.requestId = preparedId;
    return { requestId: preparedId, prepared: prepared.status, completed: request.status, dispatch: false, workStateUnchanged: true, resultRecorder: 'installed flux result CLI', duplicateResultIdempotent: true, promptSha256: hash(prepared.prompt) };
  });
  await step('stop-restart-same-origin-and-persistence', async () => {
    assert.equal(parse(await command(primary, 'stop')).stopped, true);
    assert.equal(parse(await command(primary, 'status')).running, false);
    appendTranscript(transcriptA, 'assistant', 'Synthetic restart capture marker.');
    const restarted = parse(await command(primary, 'start')); assert.equal(restarted.url, firstUrl); assert.equal(restarted.originChanged, false);
    const state = await publicState(restarted.url);
    assert.ok(state.events.some(event => event.text === 'Synthetic restart capture marker.'));
    assert.equal(state.requests.find(item => item.id === preparedId)?.result, answer);
    return { originalUrl: firstUrl, restartedUrl: restarted.url, savedAnswerPreserved: true, newEligibleActivityImported: true };
  });
  await step('disconnect-retains-records-and-disables-capture', async () => {
    const before = await snapshot(primary), eventsFile = path.join(primary.dataDir, 'events.jsonl');
    const projectFile = path.join(primary.dataDir, 'project.json'), projectHash = hash(fs.readFileSync(projectFile));
    const eventsHash = hash(fs.readFileSync(eventsFile));
    assert.equal(parse(await command(primary, 'disconnect')).disconnected, true);
    const status = parse(await command(primary, 'status')); assert.equal(status.enabled, false); assert.equal(status.running, false);
    const priorTranscript = fs.readFileSync(transcriptA);
    appendTranscript(transcriptA, 'user', 'DISCONNECTED_CAPTURE_MUST_STAY_ABSENT');
    await command(primary, 'start', [], { expected: 'nonzero' });
    await command(primary, 'import', [], { expected: 'nonzero' });
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(hash(fs.readFileSync(eventsFile)), eventsHash);
    assert.equal(hash(fs.readFileSync(projectFile)), projectHash);
    assert.ok(fs.existsSync(path.join(primary.dataDir, 'enrollment.json')));
    fs.writeFileSync(transcriptA, priorTranscript);
    return { disconnected: true, disabled: true, eventsSha256: eventsHash, projectSha256: projectHash, preservedFocus: before.project.focus.title, recordsPreserved: true, noCaptureAfterDisconnect: true };
  });
  await step('uninstall-managed-skill-retains-chat-records', async () => {
    const eventFile = path.join(primary.dataDir, 'events.jsonl'), before = hash(fs.readFileSync(eventFile));
    assert.equal(parse(await run(cli, ['uninstall-skill', '--project', projectA])).removed, true);
    assert.equal(fs.existsSync(skillPath), false); assert.equal(hash(fs.readFileSync(eventFile)), before);
    assert.equal(parse(await run(cli, ['uninstall-skill', '--project', projectA])).removed, false);
    return { managedSkillRemoved: true, recordsRetained: true };
  });
  await step('zero-codex-invocations', async () => {
    assert.equal(fs.readFileSync(codexLog, 'utf8'), '', 'A command attempted to invoke Codex');
    return { invocations: 0, recorder: 'codex-invocations.jsonl', pathFirstRefusingStub: true };
  });
  if (leaveRunning) await step('leave-one-synthetic-dashboard', async () => {
    await command(primary, 'connect', ['--transcript', transcriptA]);
    const running = parse(await command(primary, 'start')); assert.equal(running.url, firstUrl);
    report.dashboard = { url: running.url, pid: running.pid, project: primary.project, session: primary.session, cli, stopArgs: ['stop', ...cliArgs(primary)] };
    return report.dashboard;
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.message;
} finally {
  const retained = report.status === 'passed' && leaveRunning ? contexts[0] : null;
  report.cleanup = [];
  for (const context of contexts) {
    if (context === retained || !context.enrollment) continue;
    try { report.cleanup.push({ project: context.project, session: context.session, ...parse(await command(context, 'stop')) }); }
    catch (error) { report.cleanup.push({ project: context.project, session: context.session, error: error.message }); report.status = 'failed'; }
  }
  report.codexInvocations = fs.readFileSync(codexLog, 'utf8').trim().split('\n').filter(Boolean).length;
  if (report.codexInvocations !== 0) { report.status = 'failed'; report.failure ||= 'Codex was invoked unexpectedly'; }
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ out, report: path.join(out, 'report.json'), status: report.status, archiveSha256: report.archiveSha256, checks: report.results.map(({ id, status }) => ({ id, status })), dashboard: report.dashboard, failure: report.failure }, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}
