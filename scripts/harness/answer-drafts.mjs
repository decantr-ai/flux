import { cpSync, existsSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Reuses the existing four-native-question fixture and its capture assertions.
// All interaction is with marked synthetic data. No answer-send adapter exists.
const script = fileURLToPath(import.meta.url);
const repository = resolve(dirname(script), '../..');
const marker = '.answer-drafts-lab';
const readJSON = file => JSON.parse(readFileSync(file, 'utf8'));
const writeJSON = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
function validate(directory) {
  const lab = realpathSync(directory);
  if (!lab.startsWith('/private/tmp/flux-incoming-questions-') || !existsSync(join(lab, marker))) throw Error('Expected a marked synthetic answer-drafts lab.');
  return lab;
}
const [mode, directory] = process.argv.slice(2);
if (mode === '--prepare') {
  const result = spawnSync(process.execPath, [join(repository, 'scripts/harness/incoming-questions.mjs'), '--prepare'], { cwd: repository, encoding: 'utf8' });
  if (result.status !== 0) throw Error(result.stderr || result.stdout || 'Incoming fixture preparation failed.');
  const prepared = JSON.parse(result.stdout), lab = prepared.lab;
  writeFileSync(join(lab, marker), 'Synthetic answer draft/copy/recovery fixture v1\n');
  cpSync(script, join(lab, 'answer-drafts.mjs'));
  const fixture = readJSON(join(lab, 'fixture.json'));
  fixture.answerDraftsStorageKey = `flux:answer-drafts:v1:${JSON.stringify([fixture.projectId, fixture.sessionId])}`;
  fixture.answerDraftsScope = 'Draft and clipboard browser checks only; native Send remains unavailable and is never enabled by this fixture.';
  writeJSON(join(lab, 'fixture.json'), fixture);
  const { createStore } = await import(pathToFileURL(join(lab, 'baseline/src/store.mjs')));
  const store = createStore(fixture.dataDir);
  store.setProject({ ...store.snapshot().project, title: 'Synthetic · Answer drafts', goal: 'Check independent answer drafts, copying and recovery without sending' });
  writeJSON(join(lab, 'answer-drafts-results.json'), { scope: fixture.answerDraftsScope, initial: { pending: store.snapshot().incomingQuestions.pending.length, history: store.snapshot().incomingQuestions.history.length }, browserChecks: 'Not yet run', nativeSendAttempts: 0 });
  console.log(JSON.stringify({ ...prepared, storageKey: fixture.answerDraftsStorageKey, launch: `node ${join(lab, 'answer-drafts.mjs')} --launch ${lab}`, externalReply: `node ${join(lab, 'answer-drafts.mjs')} --reply-one ${lab}` }, null, 2));
} else if (mode === '--launch') {
  const lab = validate(directory);
  const child = spawn(process.execPath, [join(lab, 'answer-drafts.mjs'), '--serve', lab], { cwd: lab, detached: true, stdio: ['ignore', openSync(join(lab, 'server.log'), 'a'), openSync(join(lab, 'server-error.log'), 'a')] });
  child.unref();
  const processInfo = { lab, pid: child.pid, cleanup: `kill -TERM ${child.pid}` };
  writeJSON(join(lab, 'process.json'), processInfo);
  console.log(JSON.stringify(processInfo));
} else if (mode === '--serve' || mode === '--reply-one') {
  const lab = validate(directory);
  // Run the frozen fixture's existing server or native-wrapper importer in this
  // process. --serve keeps one exact PID; queue sends remain rejected there.
  process.argv = [process.execPath, join(lab, 'incoming-questions.mjs'), mode, lab];
  await import(pathToFileURL(join(lab, 'incoming-questions.mjs')));
} else {
  throw Error('Usage: answer-drafts.mjs --prepare | --launch <lab> | --serve <lab> | --reply-one <lab>');
}
