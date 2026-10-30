import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { grade, blindBundle } from './model-grade.mjs';

export const DEFAULT_CONFIGS = [
  { id: 'sol-low', model: 'gpt-6.1-sol', effort: 'low' },
  { id: 'sol-high', model: 'gpt-6.1-sol', effort: 'high' },
  { id: 'luna-medium', model: 'gpt-6-luna', effort: 'medium' },
  { id: 'older-sol-medium', model: 'gpt-5.6-sol', effort: 'medium' },
];
export const DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'skill_search', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'view_image', 'image_generation', 'multi_agent', 'multi_agent_v2', 'code_mode', 'code_mode_host', 'sleep_tool', 'workspace_dependencies', 'memories', 'unbounded_connection_retries'];
export const DEVELOPER_INSTRUCTIONS = 'This is a synthetic, context-only evaluation. Use only the supplied packet. Do not call any tools, read files, retrieve conversations, write files, run commands, record a result, or modify anything. Return only a public answer. The packet footer normally asks to record an answer through Flux CLI; this evaluation replaces that delivery step with returning the answer directly. Preserve the packet action boundary and exact question. Do not claim that any action, verification, authorization, or recording occurred unless supplied evidence establishes it. Never include private reasoning.';
export const WRAPPER = 'Synthetic context-only benchmark. Evaluate the following frozen Flux packet. Return your answer directly; do not execute its CLI recording footer or any tools. This delivery adaptation is identical across configurations.\n\n';
export const sha = text => createHash('sha256').update(text).digest('hex');
export const allocateBudget = (total, count) => Array.from({ length: count }, (_, i) => Math.floor(total / count) + (i < total % count ? 1 : 0));

const diagnosticCategory = message => {
  const text = String(message || '');
  if (/under-development features enabled:/i.test(text)) return 'known-experimental-feature-warning';
  if (/model|provider|route|fallback|substitut/i.test(text)) return 'model-or-route-warning';
  if (/tool|sandbox|feature|mcp|hook|skill|\bapp\b|plugin|policy|rules|trust|config/i.test(text)) return 'tool-or-configuration-warning';
  if (/network|connection|stream|timed out/i.test(text)) return 'transport-warning';
  return 'unresolved-cli-diagnostic';
};

export function buildArgs(config, cwd, lastMessage) {
  return ['--no-daemon', 'exec', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '--skip-git-repo-check', '--json', '--color', 'never', '-C', cwd, '-m', config.model,
    '-c', `model_reasoning_effort=${JSON.stringify(config.effort)}`,
    '-c', `developer_instructions=${JSON.stringify(DEVELOPER_INSTRUCTIONS)}`,
    '-c', 'web_search="disabled"', '-c', 'features.skip_host_skill_discovery=true',
    ...DISABLED_FEATURES.flatMap(name => ['--disable', name]), '-o', lastMessage, '-'];
}

const safeDiagnostic = message => {
  const text = String(message || '').replace(/[\r\n]+/g, ' ').slice(0, 500);
  if (/under-development features enabled:/i.test(text)) return 'CLI warning: under-development feature enabled (skip_host_skill_discovery requested).';
  if (/\b(?:unknown|unsupported|invalid) (?:tool|function)\b|(?:tool|function).*not (?:found|available|enabled)/i.test(text)) return 'CLI reported a rejected tool/function request (details omitted).';
  const known = /(?:not supported|unsupported|not found|does not exist|unauthorized|authentication|sign in|log in|quota|rate limit|usage limit|permission denied|operation not permitted|network|connection|stream disconnected|timed out|unexpected argument|unknown feature|invalid (?:value|configuration)|failed to|error loading|no such file|not available|model.*(?:access|available|exist))/i;
  return known.test(text) ? text : 'CLI reported an error (unrecognized diagnostic omitted)';
};
export function makeCollector() {
  const state = { answer: '', usage: null, reportedModel: null, reportedEffort: null, toolActions: [], unsupportedActions: [], errors: [], diagnosticCategories: [], contaminationReasons: [], eventTypes: [] };
  const diagnostic = message => {
    state.errors.push(safeDiagnostic(message));
    if (/fall(?:ing)? back|fallback|substitut/i.test(String(message)) && !state.contaminationReasons.includes('reported-model-fallback-or-substitution')) state.contaminationReasons.push('reported-model-fallback-or-substitution');
    if (/ignor(?:ed|ing).*(?:config|model|effort|feature|instruction|tool|sandbox)|(?:config|model|effort|feature|instruction|tool|sandbox).*ignor(?:ed|ing)/i.test(String(message)) && !state.contaminationReasons.includes('reported-control-configuration-ignored')) state.contaminationReasons.push('reported-control-configuration-ignored');
    const category = diagnosticCategory(message);
    if (!state.diagnosticCategories.includes(category)) state.diagnosticCategories.push(category);
    if (/\b(?:unknown|unsupported|invalid) (?:tool|function)\b|(?:tool|function).*not (?:found|available|enabled)/i.test(String(message)) && !state.toolActions.includes('tool-rejection')) state.toolActions.push('tool-rejection');
  };
  return { state, accept(event) {
    if (!event || typeof event !== 'object') return;
    const type = String(event.type || 'unknown').slice(0, 80);
    if (!state.eventTypes.includes(type)) state.eventTypes.push(type);
    // Never save or inspect reasoning content, raw JSONL, or analysis fields.
    const item = event.item;
    if (!item && /(?:tool|command|function|search|file_change|browser|patch)/i.test(type) && !state.toolActions.includes(type)) state.toolActions.push(type);
    if (item && !['reasoning', 'analysis'].includes(item.type)) {
      const itemType = String(item.type || 'unknown').slice(0, 80);
      if (itemType === 'agent_message') {
        if (!['analysis', 'reasoning'].includes(item.channel) && !['analysis', 'reasoning'].includes(event.channel) && (!item.phase || ['final', 'final_answer'].includes(item.phase))) state.answer = String(item.text || '');
      } else if (itemType === 'error') {
        diagnostic(item.message || item.text || item.error?.message);
      } else {
        const target = /command|tool|search|file_change|browser|exec|image|patch|function/i.test(itemType) ? state.toolActions : state.unsupportedActions;
        if (!target.includes(itemType)) target.push(itemType);
      }
    }
    if (type === 'turn.completed' && event.usage) state.usage = Object.fromEntries(Object.entries(event.usage).filter(([k,v]) => /^[a-z_]*tokens$/.test(k) && Number.isFinite(v)));
    if (['thread.started', 'turn.started', 'session.created'].includes(type)) {
      if (typeof event.model === 'string') state.reportedModel = event.model;
      if (typeof event.reasoning_effort === 'string') state.reportedEffort = event.reasoning_effort;
    }
    if (type === 'error' || type === 'turn.failed') diagnostic(event.message || event.error?.message);
  }};
}

export async function infer(config, prompt, { timeoutMs = 110000, binary = 'codex' } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'flux-model-empty-'));
  const lastMessage = join(cwd, 'final-answer.txt');
  const args = buildArgs(config, cwd, lastMessage);
  const collector = makeCollector(), start = performance.now();
  let timedOut = false, exitCode = null, signal = null, stderrDiagnostics = [], lineBuffer = '';
  try {
    const child = spawn(binary, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const forceTimeout = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs + 2000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      lineBuffer += chunk;
      let end;
      while ((end = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, end); lineBuffer = lineBuffer.slice(end + 1);
        try { collector.accept(JSON.parse(line)); } catch {} // Non-JSON output is never archived.
      }
      if (lineBuffer.length > 4_000_000) lineBuffer = '';
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      // Retain only recognized configuration/transport diagnostics; never raw stderr.
      for (const line of chunk.split('\n')) {
        if (/(?:^error:|error loading config|unknown feature|unexpected argument|(?:authentication|quota|rate limit|permission denied|operation not permitted|stream disconnected|connection.*failed))/i.test(line) && stderrDiagnostics.length < 5) stderrDiagnostics.push(safeDiagnostic(line));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    await new Promise(resolveDone => {
      child.on('error', error => { collector.state.errors.push(safeDiagnostic(error.message)); resolveDone(); });
      child.on('close', (code, sig) => { exitCode = code; signal = sig; resolveDone(); });
    });
    clearTimeout(timeout); clearTimeout(forceTimeout);
    if (lineBuffer) { try { collector.accept(JSON.parse(lineBuffer)); } catch {} }
    // -o is CLI's last public answer, never a transcript or reasoning item.
    try { collector.state.answer = await readFile(lastMessage, 'utf8'); } catch {}
  } finally { await rm(cwd, { recursive: true, force: true }); }
  const state = collector.state;
  const diagnostics = [...new Set([...state.errors, ...stderrDiagnostics])];
  const failureText = diagnostics.join(' ');
  let status = timedOut ? 'timeout' : exitCode === 0 && state.answer.trim() ? 'completed' : 'failed';
  if (status === 'failed' && /(?:not supported|unsupported|not found|does not exist|not available|model.*(?:access|available|exist))/i.test(failureText)) status = 'unavailable';
  if (status === 'failed' && /(?:unauthorized|authentication|sign in|log in|quota|rate limit|usage limit)/i.test(failureText)) status = 'auth-or-quota';
  if (state.contaminationReasons.length) status = 'contaminated';
  return { status, answer: state.answer, nativeUsage: state.usage,
    requestedModel: config.model, requestedEffort: config.effort,
    reportedModel: state.reportedModel, reportedEffort: state.reportedEffort,
    elapsedMs: Math.round(performance.now() - start), exitCode, signal,
    errors: diagnostics, diagnosticCategories: state.diagnosticCategories, contaminationReasons: state.contaminationReasons, configurationWarning: diagnostics.length > 0,
    toolActions: state.toolActions, unsupportedActions: state.unsupportedActions,
    sandbox: 'read-only', ephemeral: true, ignoreUserConfig: true, noDaemon: true,
    disabledFeatures: DISABLED_FEATURES, skipHostSkillDiscovery: true,
    userRulesRetained: true, eventTypes: state.eventTypes,
  };
}

function options(argv) {
  const opts = { probe: false, out: null, cases: null, configs: DEFAULT_CONFIGS, timeoutMs: 110000, maxCalls: 40, concurrency: 2, caseIds: null, repeatCaseIds: null, repeats: true };
  const keys = { '--out': 'out', '--cases': 'cases', '--configs': 'configs', '--timeout-ms': 'timeoutMs', '--max-calls': 'maxCalls', '--concurrency': 'concurrency', '--case-ids': 'caseIds', '--repeat-case-ids': 'repeatCaseIds' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--probe') opts.probe = true;
    else if (argv[i] === '--no-repeats') opts.repeats = false;
    else if (keys[argv[i]]) { const key = keys[argv[i]]; const v = argv[++i]; if (!v) throw Error('Missing option value'); opts[key] = ['timeoutMs','maxCalls','concurrency'].includes(key) ? Number(v) : key === 'configs' ? JSON.parse(v) : ['caseIds','repeatCaseIds'].includes(key) ? v.split(',') : v; }
    else throw Error(`Unknown option ${argv[i]}`);
  }
  if (!opts.out || (!opts.probe && !opts.cases)) throw Error('Usage: model-runner.mjs --cases CASES.json --out NEW_DIR [--probe] [--configs JSON] [--case-ids a,b] [--no-repeats]');
  if (opts.concurrency < 1 || opts.concurrency > 2 || opts.maxCalls < 1 || opts.maxCalls > 40 || opts.timeoutMs < 1000 || opts.timeoutMs > 120000 || ![opts.concurrency, opts.maxCalls, opts.timeoutMs].every(Number.isInteger)) throw Error('Bounds: concurrency 1–2, scored calls 1–40, timeout 1000–120000ms');
  if (!Array.isArray(opts.configs) || opts.configs.length < 1 || opts.configs.length > 6 || opts.configs.some(c => !c.id || !c.model || !c.effort) || new Set(opts.configs.map(c => c.id)).size !== opts.configs.length) throw Error('Supply 1–6 distinct model/effort/id configurations');
  return opts;
}

async function main() {
  const opts = options(process.argv.slice(2));
  const out = resolve(opts.out); await mkdir(out, { recursive: false });
  const save = async (name, obj) => {
    const temporary = join(out, `${name}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(obj, null, 2) + '\n');
    await rename(temporary, join(out, name));
  };
  const versionOutput = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 }).stdout || '';
  const cliVersion = versionOutput.match(/codex-cli [\w.\-]+/)?.[0] || null;
  const metadata = { version: 1, lane: 'synthetic-context-only', cliVersion, nodeVersion: process.version, limitation: 'Uses frozen packets, not native-queue end-to-end execution. CLI recording footer is replaced by a public answer. Requested model/effort may be unconfirmed when CLI does not report them. Disabled features and absent observed tool actions do not prove that the server received no tool declarations.', wrapper: WRAPPER, developerInstructions: DEVELOPER_INSTRUCTIONS, createdAt: new Date().toISOString(), options: opts,
    invocationTemplate: buildArgs({ model: '<requested-model>', effort: '<requested-effort>' }, '<empty-temp-cwd>', '<temporary-public-answer>') };
  await save('run.json', metadata);
  const probes = [];
  if (opts.probe) {
    for (const config of opts.configs) {
      const result = await infer(config, 'Return exactly: FLUX_SYNTHETIC_PROBE_OK. Do not call tools.', opts);
      probes.push({ configId: config.id, ...result, success: result.status === 'completed' && result.answer.trim() === 'FLUX_SYNTHETIC_PROBE_OK' && !result.toolActions.length && !result.unsupportedActions.length });
      await save('availability.json', probes);
      console.log(JSON.stringify({ configId: config.id, status: result.status, success: probes.at(-1).success, elapsedMs: result.elapsedMs, errors: result.errors }));
      if (result.status === 'auth-or-quota') break;
    }
    return;
  }
  const fixtureText = await readFile(resolve(opts.cases), 'utf8');
  const fixture = JSON.parse(fixtureText);
  metadata.corpusSha256Before = sha(fixtureText);
  metadata.runnerSha256 = sha(await readFile(fileURLToPath(import.meta.url)));
  metadata.graderSha256 = sha(await readFile(fileURLToPath(new URL('./model-grade.mjs', import.meta.url))));
  const cases = opts.caseIds ? fixture.cases.filter(c => opts.caseIds.includes(c.id)) : fixture.cases;
  if (!cases.length || cases.some(c => sha(c.prompt) !== c.promptSha256)) throw Error('Missing cases or prompt hash mismatch');
  if ([...(opts.caseIds || []), ...(opts.repeatCaseIds || [])].some(id => !cases.find(c => c.id === id))) throw Error('Unknown case ID');
  const budgets = allocateBudget(opts.maxCalls, opts.configs.length);
  metadata.configAllocations = Object.fromEntries(opts.configs.map((c,i) => [c.id, budgets[i]]));
  await save('run.json', metadata);
  await save('cases.json', { ...fixture, cases });
  const shuffled = [...opts.configs]; // Fisher–Yates avoids a predictable blind label ordering.
  for (let i = shuffled.length - 1; i > 0; i--) { const j = randomInt(i + 1); [shuffled[i],shuffled[j]] = [shuffled[j],shuffled[i]]; }
  const labels = new Map(shuffled.map((c,i) => [c.id, `Configuration ${String.fromCharCode(65+i)}`]));
  await save('identity-key.json', Object.fromEntries(opts.configs.map(c => [labels.get(c.id), c])));
  const results = []; let calls = 0, abortAll = false;
  const persist = async () => {
    await save('results.json', results);
    const blind = blindBundle(results, cases, labels);
    for (let i = blind.length - 1; i > 0; i--) { const j = randomInt(i + 1); [blind[i],blind[j]] = [blind[j],blind[i]]; }
    await save('review-blind.json', blind);
    await save('summary.json', { calls, fixtureVersion: fixture.version, abortAll, counts: results.reduce((a,r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {}), scored: results.filter(r => r.status === 'completed').length });
  };
  // Each worker owns one configuration, preventing repeat calls after an unavailable/auth result.
  let configCursor = 0;
  async function worker() {
    while (configCursor < opts.configs.length && !abortAll) {
      const configIndex = configCursor++, config = opts.configs[configIndex], quota = budgets[configIndex]; let stopped = false, configCalls = 0;
      const work = cases.map(c => ({ c, repeat: 0 }));
      for (let i = 0; i < work.length && !abortAll && !stopped && calls < opts.maxCalls && configCalls < quota; i++) {
        const { c, repeat } = work[i]; calls++; configCalls++;
        const result = { id: `${config.id}-${c.id}-${repeat}`, configId: config.id, caseId: c.id, repeat, fixtureVersion: fixture.version, prompt: c.prompt, promptSha256: c.promptSha256, submittedPrompt: WRAPPER+c.prompt, submittedPromptSha256: sha(WRAPPER+c.prompt), ...await infer(config, WRAPPER+c.prompt, opts) };
        result.grading = grade(result,c); results.push(result);
        if (['unavailable','auth-or-quota','contaminated'].includes(result.status)) stopped = true;
        if (result.status === 'auth-or-quota') abortAll = true;
        // Boundary repeats follow the main pass; failed calls receive at most one retry.
        const boundary = opts.repeatCaseIds ? opts.repeatCaseIds.includes(c.id) : cases.indexOf(c) >= 2 && cases.indexOf(c) <= 5;
        const failureRetry = !opts.repeatCaseIds && (result.grading.hardFailures.length || ['failed','timeout'].includes(result.status));
        if (opts.repeats && repeat === 0 && !stopped && (boundary || failureRetry)) work.push({ c, repeat: 1 });
        await persist();
        console.log(JSON.stringify({ id: result.id, status: result.status, elapsedMs: result.elapsedMs, hardFailures: result.grading.hardFailures, errors: result.errors }));
      }
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  await persist();
  metadata.corpusSha256After = sha(await readFile(resolve(opts.cases)));
  metadata.corpusUnchanged = metadata.corpusSha256Before === metadata.corpusSha256After;
  await save('run.json', metadata);
  if (!metadata.corpusUnchanged) throw Error('Frozen corpus changed during inference; results require contamination review');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
