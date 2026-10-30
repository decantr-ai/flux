import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.mjs';
import { startServer } from './server.mjs';
import { watchTranscript } from './transcript.mjs';
import { readEnrollment, writeEnrollment } from './workspaces.mjs';

const cli = fileURLToPath(new URL('../bin/flux.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const runtimeFile = dir => path.join(dir, 'runtime.json');
function readRuntime(dir) { try { return JSON.parse(fs.readFileSync(runtimeFile(dir), 'utf8')); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; } }
export async function identity(runtime, enrollment) {
  if (!runtime || typeof runtime.token !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.url)) return null;
  try {
    const response = await fetch(`${runtime.url}/api/control`, { headers: { 'x-flux-control': runtime.token }, signal: AbortSignal.timeout(800) });
    if (!response.ok) return null;
    const value = await response.json();
    return value.instanceId === runtime.instanceId && value.pid === runtime.pid && value.projectId === enrollment.projectId && value.sessionId === enrollment.sessionId && value.generation === enrollment.generation ? value : null;
  } catch { return null; }
}
async function portOpen(runtime) {
  const match = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(runtime?.url || ''); if (!match) return false;
  return new Promise(resolve => { const socket = netConnect({ host: '127.0.0.1', port: Number(match[1]) }); socket.setTimeout(800); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); socket.once('timeout', () => { socket.destroy(); resolve(true); }); });
}
async function locked(dir, fn) {
  const lock = path.join(dir, 'lifecycle.lock');
  for (let n = 0; n < 200; n++) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (n === 199) throw new Error('Timed out waiting for lifecycle lock');
      await pause(50);
    }
  }
  try { return await fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
export async function status(dir, enrollment) {
  const runtime = readRuntime(dir), live = await identity(runtime, enrollment);
  const unverified = !live && (await portOpen(runtime) || (enrollment.preferredPort && await portOpen({ url: `http://127.0.0.1:${enrollment.preferredPort}` })));
  return { ...enrollment, running: !!live, state: live ? 'running' : unverified ? 'unverified' : 'stopped', ...(unverified ? { message: 'A saved runtime port is occupied, but service identity could not be verified.' } : {}), ...(live ? { url: runtime.url, pid: runtime.pid, instanceId: runtime.instanceId } : {}) };
}
export async function start(dir, enrollment, port) {
  return locked(dir, async () => {
    const current = readEnrollment(dir); if (!current.enabled) throw new Error('Chat is disconnected');
    const existing = readRuntime(dir);
    if (await identity(existing, current)) return status(dir, current);
    if (await portOpen(existing) || (current.preferredPort && await portOpen({ url: `http://127.0.0.1:${current.preferredPort}` }))) throw new Error('Existing runtime port is occupied but its identity could not be verified; refusing to start another service');
    if (port !== undefined && (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535)) throw new Error('--port must be an integer from 1 to 65535');
    const instanceId = randomUUID(), token = randomBytes(32).toString('hex');
    const marker = path.join(dir, `start-${instanceId}.json`);
    const child = spawn(process.execPath, [cli, '_serve', '--data-dir', dir, '--port', String(port ?? current.preferredPort ?? 0), '--instance', instanceId, '--marker', marker, '--deadline', String(Date.now() + 8000)], { detached: true, stdio: 'ignore', env: { ...process.env, FLUX_CONTROL_TOKEN: token }, shell: false });
    let launchError; child.on('error', error => { launchError = error; }); child.unref();
    for (let n = 0; n < 200; n++) {
      await pause(50);
      if (launchError) throw launchError;
      if (fs.existsSync(marker)) {
        const result = JSON.parse(fs.readFileSync(marker, 'utf8')); fs.rmSync(marker, { force: true });
        if (result.error) throw new Error(result.error);
        const runtime = readRuntime(dir);
        if (runtime?.instanceId === instanceId && await identity(runtime, current)) {
          const actualPort = Number(new URL(runtime.url).port), originChanged = !!current.preferredPort && current.preferredPort !== actualPort;
          current.preferredPort = actualPort; writeEnrollment(dir, current);
          return { ...await status(dir, current), originChanged };
        }
        throw new Error('Started service failed identity verification');
      }
    }
    fs.rmSync(marker, { force: true });
    throw new Error('Timed out starting Flux');
  });
}
async function stopUnlocked(dir, enrollment) {
  const runtime = readRuntime(dir);
  if (!await identity(runtime, enrollment)) return { stopped: false };
  const response = await fetch(`${runtime.url}/api/control`, { method: 'POST', headers: { 'x-flux-control': runtime.token }, signal: AbortSignal.timeout(1000) });
  if (!response.ok) throw new Error('Service rejected stop request');
  for (let n = 0; n < 100 && await identity(runtime, enrollment); n++) await pause(50);
  if (await identity(runtime, enrollment)) throw new Error('Service did not stop');
  const now = readRuntime(dir); if (now?.instanceId === runtime.instanceId) fs.rmSync(runtimeFile(dir), { force: true });
  return { stopped: true };
}
export async function stop(dir, enrollment) { return locked(dir, () => stopUnlocked(dir, enrollment)); }
export async function disconnect(dir, enrollment) {
  return locked(dir, async () => {
    await stopUnlocked(dir, enrollment);
    const current = readEnrollment(dir); current.enabled = false; current.generation = randomUUID();
    writeEnrollment(dir, current);
    return { disconnected: true };
  });
}
export async function serve(dir, port, instanceId, marker, deadline) {
  const token = process.env.FLUX_CONTROL_TOKEN;
  const timeout = setTimeout(() => { try { fs.writeFileSync(marker, JSON.stringify({ error: 'Service startup deadline expired' }), { mode: 0o600 }); } finally { process.exit(1); } }, Math.max(1, Number(deadline) - Date.now()));
  let app, guard, stopWatch = () => {}, closing = false;
  try {
    const enrollment = readEnrollment(dir); if (!enrollment.enabled || !token) throw new Error('Invalid managed service configuration');
    const store = createStore(dir);
    const project = store.snapshot().project;
    if (project.id !== enrollment.projectId || project.sessionId !== enrollment.sessionId || project.directory !== enrollment.project || project.transcriptPath !== enrollment.transcript) throw new Error('Project identity mismatch');
    if (Date.now() > Number(deadline)) throw new Error('Service startup deadline expired');
    const shutdown = async () => { if (closing) return; closing = true; stopWatch(); clearInterval(guard); await app.close(); process.exit(0); };
    const identity = { instanceId, pid: process.pid, version: '0.1.0', projectId: enrollment.projectId, sessionId: enrollment.sessionId, generation: enrollment.generation };
    app = await startServer({ dataDir: dir, port: Number(port), store, control: { token, identity, shutdown } });
    const scopedStore = { ...store, append: event => { const e = readEnrollment(dir); if (!e.enabled || e.projectId !== enrollment.projectId || e.sessionId !== enrollment.sessionId || e.project !== enrollment.project || e.transcript !== enrollment.transcript || e.generation !== enrollment.generation) throw new Error('Enrollment disabled or changed'); return store.append({ ...event, projectId: enrollment.projectId, sessionId: enrollment.sessionId }); } };
    if (Date.now() > Number(deadline)) throw new Error('Service startup deadline expired');
    stopWatch = watchTranscript(scopedStore, enrollment.transcript, { sessionId: enrollment.sessionId, intervalMs: 1000 });
    guard = setInterval(() => { try { const e = readEnrollment(dir); if (!e.enabled || e.projectId !== enrollment.projectId || e.sessionId !== enrollment.sessionId || e.project !== enrollment.project || e.transcript !== enrollment.transcript || e.generation !== enrollment.generation) shutdown(); } catch { shutdown(); } }, 250); guard.unref();
    fs.writeFileSync(runtimeFile(dir), JSON.stringify({ ...identity, url: app.address, token }, null, 2), { mode: 0o600 });
    fs.writeFileSync(marker, JSON.stringify({ ok: true }), { mode: 0o600 });
    clearTimeout(timeout);
    process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  } catch (error) {
    stopWatch(); clearInterval(guard);
    if (app) { try { await app.close(); } catch {} }
    const runtime = readRuntime(dir); if (runtime?.instanceId === instanceId) fs.rmSync(runtimeFile(dir), { force: true });
    clearTimeout(timeout);
    fs.writeFileSync(marker, JSON.stringify({ error: error.message }), { mode: 0o600 }); process.exitCode = 1;
  }
}
