import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createStore } from './store.mjs';
import { runDiagnostic } from './diagnostics.mjs';
import { recoverAnswerReservations, submitAnswers } from './answer-submissions.mjs';
import { chooseProposal } from './proposals.mjs';
import { buildOverview } from './overview.mjs';
import { reviewWork } from './reviews.mjs';
import { reviewFeedback } from './review-feedback.mjs';
import { suggestContext } from './context.mjs';
import { inspectContentLink, readContentImage, revealContentLink } from './content-links.mjs';

const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const backendRoot = dirname(fileURLToPath(import.meta.url));
const fingerprint = async () => createHash('sha256').update((await Promise.all(['server.mjs','store.mjs','proposals.mjs','answer-submissions.mjs','incoming-questions.mjs','transcript.mjs','context.mjs','markdown.mjs','content-links.mjs','overview.mjs','reviews.mjs','review-feedback.mjs','diagnostics.mjs'].map(file => readFile(join(backendRoot,file))))).map(buffer=>buffer.toString()).join('\n')).digest('hex').slice(0,16);
const staticFiles = new Map([
  ['/', ['build/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['build/index.html', 'text/html; charset=utf-8']],
  ['/images/flux-progress-beacon.png', ['images/flux-progress-beacon.png', 'image/png']],
  ['/fonts/geist-latin.woff2', ['fonts/geist-latin.woff2', 'font/woff2']],
  ['/fonts/geist-mono-latin.woff2', ['fonts/geist-mono-latin.woff2', 'font/woff2']],
]);
const sameToken = (left, right) => typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

async function bodyJSON(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 64 * 1024) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
  }
  try { return JSON.parse(body); } catch { throw Object.assign(new Error('Invalid JSON body.'), { statusCode: 400 }); }
}

/** Binds only to loopback, exposes refresh SSE, and never invokes a shell. */
export async function startServer({ dataDir = resolve('.flux'), port = 0, store = createStore(dataDir), queueCommand, publicDir = publicRoot, watch = true, contentOptions = {}, runtimeFingerprint = fingerprint, control } = {}) {
  recoverAnswerReservations(store);
  const csrfToken = randomBytes(32).toString('hex');
  const streams = new Set();
  const buildId = await runtimeFingerprint();
  const runtimeState = async () => ({ modelVersion: 10, buildId, restartRequired: await runtimeFingerprint() !== buildId });
  let localPort;
  const json = (response, code, value) => {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
    const allowedOrigins = [`http://127.0.0.1:${localPort}`, `http://localhost:${localPort}`];
    const allowedHosts = [`127.0.0.1:${localPort}`, `localhost:${localPort}`];
    if (!allowedHosts.includes(request.headers.host)) return json(response, 403, { error: 'Unexpected Host.' });
    if (request.headers.origin && !allowedOrigins.includes(request.headers.origin)) return json(response, 403, { error: 'Unexpected Origin.' });
    const requestUrl = new URL(request.url, allowedOrigins[0]);
    const path = requestUrl.pathname;
    try {
      if (control && path === '/api/control') {
        if (!sameToken(request.headers['x-flux-control'], control.token)) return json(response, 403, { error: 'Invalid control token.' });
        if (request.method === 'GET') return json(response, 200, control.identity);
        if (request.method === 'POST') { json(response, 200, { ok: true }); setImmediate(() => control.shutdown()); return; }
      }
      if (control) {
        let active = false;
        try { const enrolled = JSON.parse(readFileSync(join(dataDir, 'enrollment.json'), 'utf8')); active = enrolled.enabled && enrolled.projectId === control.identity.projectId && enrolled.sessionId === control.identity.sessionId && enrolled.generation === control.identity.generation; } catch {}
        if (!active) return json(response, 403, { error: 'Chat is disconnected.' });
      }
      if (request.method === 'GET' && ['/api/content-link','/api/content-image'].includes(path)) {
        if (request.headers['sec-fetch-site'] === 'cross-site') return json(response,403,{error:'Open this attachment from Flux.'});
        response.setHeader('Cross-Origin-Resource-Policy','same-origin');
        const input={sourceId:requestUrl.searchParams.get('sourceId'),href:requestUrl.searchParams.get('href')};
        const snapshot=store.snapshot();
        if(path==='/api/content-link')return json(response,200,await inspectContentLink(snapshot,input,contentOptions));
        const image=await readContentImage(snapshot,input);
        response.writeHead(200,{'Content-Type':image.type,'Cache-Control':'no-store','Content-Disposition':'inline'});
        response.end(image.bytes);return;
      }
      if (request.method === 'GET' && path === '/api/state') {
        const snapshot=store.snapshot();
        const reviewIds = snapshot.project.items.filter(item=>['ready_for_review','ready-for-review'].includes(item.status)).map(item=>item.id);
        return json(response, 200, { ...snapshot, overview:buildOverview(snapshot), contextSuggestions:{diagnostic:suggestContext(snapshot),feedback:suggestContext(snapshot,{itemIds:reviewIds,limit:8})}, runtime:await runtimeState(), csrfToken });
      }
      if (request.method === 'GET' && path === '/api/health') {
        const snapshot = store.snapshot();
        return json(response, 200, { ok: true, runtime:await runtimeState(), revision: snapshot.revision, contextRevision: snapshot.contextRevision, coverage: snapshot.coverage });
      }
      if (request.method === 'GET' && path === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write(`event: update\ndata: ${JSON.stringify({ revision: store.snapshot().revision })}\n\n`);
        streams.add(response);
        request.on('close', () => streams.delete(response));
        return;
      }
      if (request.method === 'POST' && ['/api/diagnostics','/api/reviews','/api/review-feedback','/api/content-reveal','/api/answers','/api/proposals'].includes(path)) {
        if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return json(response, 415, { error: 'Use application/json.' });
        if (!sameToken(request.headers['x-flux-csrf'] ?? request.headers['x-csrf-token'], csrfToken)) return json(response, 403, { error: 'Missing or invalid CSRF token.' });
        const input = await bodyJSON(request);
        if ((await runtimeState()).restartRequired) return json(response, 409, { error: 'Flux was updated. Restart the local service before changing work or sending a question.' });
        if (path === '/api/answers') return json(response, 200, await submitAnswers(store, input, {queueCommand}));
        if (path === '/api/proposals') return json(response, 200, chooseProposal(store, input));
        if (path === '/api/content-reveal') return json(response,200,await revealContentLink(store.snapshot(),input,contentOptions));
        if (path === '/api/reviews') return json(response, 200, { event:reviewWork(store,input) });
        if (path === '/api/review-feedback') return json(response, 200, await reviewFeedback(store,input,{queueCommand}));
        return json(response, 200, await runDiagnostic(store, input, { queueCommand, projectDir: store.snapshot().project.directory ?? store.snapshot().project.repoDir }));
      }
      if (request.method === 'GET' && staticFiles.has(path)) {
        const [file, contentType] = staticFiles.get(path);
        let body;
        try { body = await readFile(join(publicDir, file)); }
        catch (error) {
          // Keep direct CLI development usable before the first frontend build.
          if (file !== 'build/index.html' || error.code !== 'ENOENT') throw error;
          body = await readFile(join(publicDir, 'index.html'));
        }
        response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
        response.end(body);
        return;
      }
      if (request.method === 'GET' && path.startsWith('/build/assets/')) {
        let assetPath;
        try { assetPath = resolve(publicDir, 'build', decodeURIComponent(path.slice('/build/'.length))); }
        catch { return json(response, 400, { error: 'Invalid frontend asset path.' }); }
        const buildRoot = resolve(publicDir, 'build');
        const prefix = `${buildRoot}${process.platform === 'win32' ? '\\' : '/'}`;
        if (!assetPath.startsWith(prefix)) return json(response, 400, { error: 'Invalid frontend asset path.' });
        const extension = assetPath.slice(assetPath.lastIndexOf('.')).toLowerCase();
        const contentType = ({ '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' })[extension] || 'application/octet-stream';
        try {
          const body = await readFile(assetPath);
          response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
          response.end(body);
        } catch (error) {
          if (error.code === 'ENOENT') return json(response, 404, { error: 'Frontend asset not found.' });
          throw error;
        }
        return;
      }
      if (request.method === 'GET' && path.startsWith('/build/assets/')) {
        const relativeAsset = path.slice('/build/'.length);
        let assetPath;
        try { assetPath = resolve(publicDir, 'build', decodeURIComponent(relativeAsset)); }
        catch { return json(response, 400, { error: 'Invalid frontend asset path.' }); }
        const buildRoot = resolve(publicDir, 'build');
        if (!assetPath.startsWith(`${buildRoot}${process.platform === 'win32' ? '\\' : '/'}`)) return json(response, 400, { error: 'Invalid frontend asset path.' });
        const contentType = ({ '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' })[assetPath.slice(assetPath.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream';
        const body = await readFile(assetPath);
        response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
        response.end(body);
        return;
      }
      return json(response, 404, { error: 'Not found.' });
    } catch (error) {
      return json(response, error.statusCode ?? 500, { error: error.statusCode ? error.message : 'Local server error.', ...(error.revision !== undefined ? { revision: error.revision } : {}), ...(error.contextRevision !== undefined ? { contextRevision: error.contextRevision } : {}) });
    }
  });
  const unsubscribe = store.subscribe(revision => {
    for (const stream of streams) stream.write(`event: update\ndata: ${JSON.stringify({ revision })}\n\n`);
  });
  await new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { localPort = server.address().port; server.off('error', reject); resolveStart(); });
  });
  const heartbeat = setInterval(() => { for (const stream of streams) stream.write(': keepalive\n\n'); }, 20_000);
  heartbeat.unref();
  const refreshTimer = watch ? setInterval(() => { try { store.refresh(); } catch (error) { console.error(`Flux journal refresh failed: ${error.message}`); } }, 500) : null;
  refreshTimer?.unref();
  return {
    server, store, address: `http://127.0.0.1:${localPort}`,
    async close() {
      unsubscribe(); clearInterval(heartbeat); clearInterval(refreshTimer);
      for (const stream of streams) stream.end();
      streams.clear();
      await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    },
  };
}
