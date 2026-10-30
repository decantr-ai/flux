import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createStore } from './store.mjs';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
export function projectPath(input) {
  if (!input) throw new Error('--project is required');
  const result = fs.realpathSync(path.resolve(input));
  if (!fs.statSync(result).isDirectory()) throw new Error('--project must be an existing directory');
  return result;
}
function safeDirectory(dir, create = false) {
  try { const st = fs.lstatSync(dir); if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Unsafe workspace directory: ${dir}`); }
  catch (error) { if (error.code !== 'ENOENT' || !create) throw error; try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } const st = fs.lstatSync(dir); if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Unsafe workspace directory: ${dir}`); }
}
export function workspace(project, session, { create = false, validate = false } = {}) {
  if (typeof session !== 'string' || !session.trim() || session.length > 1000) throw new Error('--session is required');
  const components = [path.join(project, '.flux'), path.join(project, '.flux', 'chats'), path.join(project, '.flux', 'chats', hash(session))];
  if (create || validate) for (const dir of components) safeDirectory(dir, create);
  if (create) {
    const ignore = path.join(components[0], '.gitignore');
    try { fs.writeFileSync(ignore, '*\n', { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; const st = fs.lstatSync(ignore); if (st.isSymbolicLink() || !st.isFile()) throw new Error('Unsafe .flux/.gitignore'); }
  }
  return components[2];
}
export function readEnrollment(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'enrollment.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('Chat is not connected; run flux connect first'); throw error; }
}
export function requireEnrollment(project, session, { enabled = true } = {}) {
  const dir = workspace(project, session, { validate: true }), enrollment = readEnrollment(dir);
  if (enrollment.project !== project || enrollment.sessionId !== session || enrollment.projectId !== hash(project)) throw new Error('Enrollment identity mismatch');
  if (enabled && !enrollment.enabled) throw new Error('Chat is disconnected; run flux connect to reconnect');
  return { dir, enrollment };
}
export function writeEnrollment(dir, enrollment) {
  const file = path.join(dir, 'enrollment.json'), temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(enrollment, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function connect(project, session, transcriptInput, title) {
  workspace(project, session);
  if (!transcriptInput) throw new Error('connect requires --transcript');
  const transcript = fs.realpathSync(path.resolve(transcriptInput));
  if (!fs.statSync(transcript).isFile()) throw new Error('--transcript must be a file');
  const records = fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(row => row?.type === 'session_meta');
  if (!records.length || records.some(row => (row.payload?.session_id || row.payload?.id) !== session)) throw new Error('Transcript session_meta does not match --session');
  const dir = workspace(project, session, { create: true }), file = path.join(dir, 'enrollment.json');
  const lock = path.join(dir, 'lifecycle.lock');
  let acquired = false;
  for (let n = 0; n < 200; n++) { try { fs.mkdirSync(lock, { mode: 0o700 }); acquired = true; break; } catch (error) { if (error.code !== 'EEXIST') throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } }
  if (!acquired) throw new Error('Timed out waiting for lifecycle lock');
  try {
  if (fs.existsSync(file)) {
    const { enrollment } = requireEnrollment(project, session, { enabled: false });
    if (enrollment.transcript !== transcript) throw new Error('Enrollment already bound to a different transcript');
    const store = createStore(dir), saved = store.snapshot().project;
    if (saved.id !== enrollment.projectId || saved.sessionId !== session || saved.directory !== project || saved.transcriptPath !== transcript) throw new Error('Project identity mismatch');
    const binding = { version: 1, cliPath: fileURLToPath(new URL('../bin/flux.mjs', import.meta.url)), projectRoot: project, sessionId: session };
    if (JSON.stringify(saved.fluxConnection) !== JSON.stringify(binding)) store.setProject({ ...saved, fluxConnection: binding });
    if (!enrollment.enabled || !enrollment.generation) { enrollment.enabled = true; enrollment.generation = randomUUID(); writeEnrollment(dir, enrollment); }
    return enrollment;
  }
  if (fs.existsSync(path.join(dir, 'project.json')) || fs.existsSync(path.join(dir, 'events.jsonl'))) throw new Error('Existing unbound workspace data; refusing to overwrite');
  const enrollment = { version: 1, project, projectId: hash(project), sessionId: session, transcript, enabled: true, generation: randomUUID() };
  const store = createStore(dir);
  store.setProject({ id: enrollment.projectId, title: title || path.basename(project), goal: '', sessionId: session, transcriptPath: transcript, directory: project, fluxConnection: { version: 1, cliPath: fileURLToPath(new URL('../bin/flux.mjs', import.meta.url)), projectRoot: project, sessionId: session }, sessions: [{ id: session, title: title || session }], items: [], plans: [], decisions: [], constraints: [] });
  writeEnrollment(dir, enrollment);
  return enrollment;
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
