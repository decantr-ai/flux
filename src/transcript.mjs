import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { exactAnswerMessage, reconcileAnswerSubmissions } from './answer-submissions.mjs';

// The rollout format is a local, version-dependent adapter, not a supported
// event transport. Read only the explicitly enrolled file and public surfaces.
const cursors = new WeakMap();
const ADAPTER_VERSION = 4;
const PUBLIC_PHASES = new Set(['commentary', 'final', 'final_answer']);
const TOOL_CALLS = new Set(['function_call', 'custom_tool_call']);
const TOOL_RETURNS = new Set(['function_call_output', 'custom_tool_call_output']);
const CONTEXT_TAGS = /<(?:environment_context|external_codex_apps_open_page|codex_apps_open_page_instructions|send_user_message_question_reply|INSTRUCTIONS|permissions\b|skills_instructions\b|app-context\b|collaboration_mode\b|multi_agent_role\b)/i;
const AMBIENT_BROWSER_PREFIX = /^\s*<in-app-browser-context\s+source=(["'])ambient-ui-state\1\s*>[\s\S]*?<\/in-app-browser-context>\s*/i;
const TOKEN_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];

function newCursor(store, sessionId, file, projectId) {
  const previous = store.events();
  const captured = previous.filter(event => event.sessionId === sessionId && event.source?.type === 'transcript');
  const coverageEvents = captured.filter(event => event.kind === 'coverage_updated' && event.data?.source === file);
  const latestCoverage = coverageEvents.at(-1);
  return {
    projectId, foreignQuestions: new Set(previous.filter(event => event.sessionId === sessionId && event.projectId && event.projectId !== projectId).flatMap(event => {
      const q = event.kind === 'question_recorded' ? event.data?.question : event.kind === 'question_resolved' ? event.data?.resolution : null;
      return q?.origin === 'codex_tool' && typeof q.id === 'string' ? [q.id] : [];
    })), offset: 0, line: 0, tail: Buffer.alloc(0), inode: null,
    validated: false, rejected: false, toolNames: new Map(), toolContexts: new Map(), turnModels: new Map(), turnId: undefined,
    known: new Set(previous.map(event => event.id)),
    counts: {
      publicMessages: captured.filter(event => event.kind.startsWith('message.')).length,
      toolEvents: captured.filter(event => event.kind.startsWith('tool.')).length,
      turnEvents: captured.filter(event => event.kind.startsWith('turn.')).length,
      modelEvents: captured.filter(event => event.kind === 'model.configured').length,
      usageEvents: captured.filter(event => event.kind === 'usage.tokens').length,
      ignoredLines: 0, invalidLines: 0,
    },
    lastImportedAt: latestCoverage?.data?.lastImportedAt || null,
    coverageVersion: coverageEvents.length,
    published: latestCoverage ? `${latestCoverage.data.adapterVersion}:${latestCoverage.data.bytesRead}:${latestCoverage.data.linesRead}:${latestCoverage.data.status}` : null,
    status: 'waiting_for_session_metadata', changed: false,
  };
}

function cursorFor(store, file, sessionId, projectId) {
  let entries = cursors.get(store);
  if (!entries) cursors.set(store, entries = new Map());
  const key = `${file}\0${sessionId}\0${projectId}`;
  if (!entries.has(key)) entries.set(key, newCursor(store, sessionId, file, projectId));
  return entries.get(key);
}

function humanText(text) {
  // Only remove the known automatically supplied prefix. Ordinary HTML and
  // references to this tag in a user's prose must remain part of their request.
  const stripped = text.replace(AMBIENT_BROWSER_PREFIX, '');
  if (stripped === text) return text.trim();
  return stripped.replace(/^## My request:\s*/i, '').trim();
}

function publicText(content, role) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part && ['input_text', 'output_text', 'text'].includes(part.type) && typeof part.text === 'string')
    .map(part => role === 'user' ? humanText(part.text) : part.text.trim())
    .filter(text => text && !/^#\s*AGENTS\.md\s+instructions\b/i.test(text) && !CONTEXT_TAGS.test(text))
    .join('\n\n');
}

function label(text, maximum = 180) {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > maximum ? `${singleLine.slice(0, maximum - 1)}…` : singleLine;
}

function safeString(value, maximum = 200) {
  return typeof value === 'string' ? value.slice(0, maximum) : undefined;
}

function safeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const usage = Object.fromEntries(TOKEN_FIELDS.filter(key => Number.isSafeInteger(value[key]) && value[key] >= 0).map(key => [key, value[key]]));
  return Object.keys(usage).length ? usage : undefined;
}

function turnMetadata(cursor) {
  return { turnId: cursor.turnId, configuredModel: cursor.turnModels.get(cursor.turnId) };
}

function append(store, cursor, event, counter) {
  if (cursor.known.has(event.id)) return false;
  store.append(event);
  cursor.known.add(event.id);
  if (counter) cursor.counts[counter]++;
  cursor.lastImportedAt = new Date().toISOString();
  cursor.changed = true;
  return true;
}

const nativeQuestionName = name => name === 'request_user_input_async' || name === 'functions.request_user_input_async' ? 'request_user_input_async' : null;
const questionEventId = (projectId, sessionId, kind, key) => `transcript:${sessionId}:question:${kind}:${createHash('sha256').update(JSON.stringify([projectId,key])).digest('hex')}`;
const MAX_QUESTION_BYTES = 65536, MAX_QUESTIONS = 20, MAX_OPTIONS = 20, MAX_REPLIES = 20;
function captureQuestionCall(store, cursor, base, payload) {
  const name = nativeQuestionName(payload.name);
  const callId = typeof payload.call_id === 'string' && payload.call_id.length <= 200 ? payload.call_id : null;
  if (!name || !callId) return;
  let args = payload.arguments;
  if (typeof args === 'string') { if (Buffer.byteLength(args) > MAX_QUESTION_BYTES) return; try { args = JSON.parse(args); } catch { return; } }
  else { try { if (Buffer.byteLength(JSON.stringify(args)) > MAX_QUESTION_BYTES) return; } catch { return; } }
  if (!args || typeof args !== 'object' || !Array.isArray(args.questions) || args.questions.length > MAX_QUESTIONS) return;
  args.questions.forEach((question, index) => {
    if (!question || typeof question.title !== 'string' || !question.title.trim() || question.title.length > 4000 || (question.options !== undefined && (!Array.isArray(question.options) || question.options.length > MAX_OPTIONS || question.options.some(option => typeof option !== 'string' || !option.trim() || option.length > 500)))) return;
    const tuple = JSON.stringify([name, callId, index]);
    if (cursor.foreignQuestions.has(tuple)) return;
    append(store, cursor, { ...base, projectId: cursor.projectId, id: questionEventId(cursor.projectId, base.sessionId, 'asked', tuple), kind: 'question_recorded', actor: 'Codex', summary: 'Codex asked a question', text: question.title, provenance: 'observed', data: { question: { id: tuple, text: question.title, ...(question.options !== undefined ? { options: question.options } : {}), origin: 'codex_tool' } } });
  });
}
function captureQuestionReplies(store, cursor, base, payload, lineNumber) {
  if (payload.role !== 'user' || !Array.isArray(payload.content) || payload.content.length !== 1) return false;
  const part = payload.content[0];
  if (!part || !['input_text','text'].includes(part.type) || typeof part.text !== 'string') return false;
  const match = part.text.match(/^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/);
  if (!match) return false;
  if (Buffer.byteLength(match[1]) > MAX_QUESTION_BYTES) return true;
  let replies; try { replies = JSON.parse(match[1]); } catch { return true; }
  if (!Array.isArray(replies) || replies.length > MAX_REPLIES) return true;
  replies.forEach((reply, index) => {
    if (!reply || typeof reply.questionItemId !== 'string' || typeof reply.answer !== 'string' || !reply.answer.trim() || reply.answer.length > 4000 || (reply.question !== undefined && typeof reply.question !== 'string')) return;
    let tuple; try { tuple = JSON.parse(reply.questionItemId); } catch { return; }
    if (!Array.isArray(tuple) || tuple.length !== 3 || !nativeQuestionName(tuple[0]) || typeof tuple[1] !== 'string' || !tuple[1] || tuple[1].length > 200 || !Number.isSafeInteger(tuple[2]) || tuple[2] < 0) return;
    const id = JSON.stringify([nativeQuestionName(tuple[0]), tuple[1], tuple[2]]);
    if (cursor.foreignQuestions.has(id)) return;
    append(store, cursor, { ...base, projectId: cursor.projectId, id: questionEventId(cursor.projectId, base.sessionId, 'reply', [lineNumber,index]), kind: 'question_resolved', actor: 'You', summary: 'Question reply recorded', text: reply.answer, provenance: 'user', data: { resolution: { origin: 'codex_tool', id, status: 'replied', answer: reply.answer, ...(reply.question !== undefined ? { questionText: reply.question } : {}) } } });
  });
  return true;
}

function readRecord(store, cursor, record, lineNumber, file, sessionId) {
  const payload = record?.payload;
  if (!payload || typeof payload !== 'object') return;
  if (record.type === 'session_meta') {
    const actualId = payload.session_id || payload.id;
    if (actualId !== sessionId) {
      cursor.rejected = true;
      cursor.validated = false;
      cursor.status = 'out_of_scope';
    } else if (!cursor.rejected) {
      cursor.validated = true;
      cursor.status = 'caught_up';
    }
    return;
  }
  if (!cursor.validated || cursor.rejected) return;
  const explicitSession = payload.session_id || payload.thread_id;
  if (explicitSession && explicitSession !== sessionId) {
    cursor.counts.ignoredLines++;
    return;
  }
  const base = {
    at: safeString(record.timestamp, 50) || new Date().toISOString(),
    sessionId,
    source: { type: 'transcript', ref: `${file}#L${lineNumber}` },
  };
  if (record.type === 'turn_context') {
    const turnId = safeString(payload.turn_id);
    const model = safeString(payload.model);
    cursor.turnId = turnId;
    // Rebuild this map on replay even when the immutable model event exists.
    // A missing model stays unknown instead of inheriting the previous turn.
    if (turnId && model) cursor.turnModels.set(turnId, model);
    else if (turnId) cursor.turnModels.delete(turnId);
    if (!model) return;
    append(store, cursor, {
      ...base, id: `transcript:${sessionId}:${lineNumber}`, kind: 'model.configured',
      actor: 'Codex', summary: `Configured model · ${model}`, provenance: 'observed',
      data: { turnId, model, line: lineNumber },
    }, 'modelEvents');
    return;
  }
  if (record.type === 'token_usage_record') {
    const usage = safeUsage(payload.usage);
    if (!usage) return;
    const turnId = safeString(payload.turn_id);
    const responseId = safeString(payload.response_id);
    append(store, cursor, {
      ...base, id: responseId ? `transcript:${sessionId}:usage:${responseId}` : `transcript:${sessionId}:${lineNumber}`,
      kind: 'usage.tokens', actor: 'Codex', summary: 'Model response · token usage', provenance: 'observed',
      // Native usage is per response. Cached input and reasoning output are
      // subsets, and native cumulative scopes must never be summed together.
      data: { turnId, responseId, configuredModel: cursor.turnModels.get(turnId), usage,
        turnUsage: safeUsage(payload.turn_token_usage), threadUsage: safeUsage(payload.thread_token_usage), line: lineNumber },
    }, 'usageEvents');
    return;
  }
  if (record.type === 'response_item' && payload.type === 'message') {
    if (!['user', 'assistant'].includes(payload.role)) return;
    const phase = payload.channel || payload.phase;
    // Older public messages lack phase; explicit non-public channels are never imported.
    if (payload.role === 'assistant' && phase && !PUBLIC_PHASES.has(phase)) return;
    if (captureQuestionReplies(store, cursor, base, payload, lineNumber)) return;
    const raw = payload.role === 'user' && payload.content?.length === 1 && ['input_text','text'].includes(payload.content[0]?.type) ? payload.content[0]?.text : undefined;
    const exact = typeof raw === 'string' && exactAnswerMessage(store.snapshot(), raw);
    const text = exact ? raw : publicText(payload.content, payload.role);
    if (!text) return;
    append(store, cursor, {
      ...base, projectId: cursor.projectId, id: `transcript:${sessionId}:${lineNumber}`,
      kind: `message.${payload.role}`, actor: payload.role === 'user' ? 'You' : 'Codex',
      summary: label(text), text,
      provenance: payload.role === 'user' ? 'user' : 'agent_report',
      data: { channel: phase || (payload.role === 'user' ? 'user' : 'public'), line: lineNumber,
        ...(payload.role === 'assistant' ? turnMetadata(cursor) : {}) },
    }, 'publicMessages');
    return;
  }
  if (record.type === 'response_item' && TOOL_CALLS.has(payload.type)) {
    captureQuestionCall(store, cursor, base, payload);
    const callId = safeString(payload.call_id || payload.id);
    const name = safeString(payload.name) || 'Tool';
    if (callId) {
      cursor.toolNames.set(callId, name);
      cursor.toolContexts.set(callId, turnMetadata(cursor));
    }
    append(store, cursor, {
      ...base, id: callId ? `transcript:${sessionId}:tool:${callId}:started` : `transcript:${sessionId}:${lineNumber}`,
      kind: 'tool.started', actor: 'Codex', summary: `Tool started · ${name}`, provenance: 'observed',
      data: { toolName: name, callId, state: 'started', line: lineNumber, ...turnMetadata(cursor) },
    }, 'toolEvents');
    return;
  }
  if (record.type === 'response_item' && TOOL_RETURNS.has(payload.type)) {
    const callId = safeString(payload.call_id || payload.id);
    const name = cursor.toolNames.get(callId) || 'Tool';
    append(store, cursor, {
      ...base, id: callId ? `transcript:${sessionId}:tool:${callId}:returned` : `transcript:${sessionId}:${lineNumber}`,
      kind: 'tool.returned', actor: 'Codex', summary: `Tool returned · ${name}`, provenance: 'observed',
      // A return says nothing about success, test validity, or goal completion.
      data: { toolName: name, callId, state: 'returned', line: lineNumber, ...(cursor.toolContexts.get(callId) || {}) },
    }, 'toolEvents');
    return;
  }
  if (record.type === 'event_msg' && ['task_started', 'task_complete'].includes(payload.type)) {
    const finished = payload.type === 'task_complete';
    if (!finished) cursor.turnId = safeString(payload.turn_id);
    append(store, cursor, {
      ...base, id: `transcript:${sessionId}:${lineNumber}`,
      kind: finished ? 'turn.finished' : 'turn.started', actor: 'Codex',
      summary: finished ? 'Codex turn ended' : 'Codex turn started', provenance: 'observed',
      data: { turnId: safeString(payload.turn_id), state: finished ? 'finished' : 'started', line: lineNumber },
    }, 'turnEvents');
    return;
  }
  cursor.counts.ignoredLines++;
}

function parseLine(store, cursor, line, lineNumber, file, sessionId, complete) {
  if (!line.length) return;
  try {
    readRecord(store, cursor, JSON.parse(line.toString('utf8')), lineNumber, file, sessionId);
  } catch (error) {
    if (error instanceof SyntaxError) {
      if (complete) cursor.counts.invalidLines++;
      return;
    }
    throw error;
  }
}

function coverage(cursor, file, sessionId, imported = 0) {
  return {
    adapter: 'local transcript', adapterVersion: ADAPTER_VERSION,
    versionDependent: true, nativeHooksActive: false,
    status: cursor.status, sessionId, source: file,
    lastImportedAt: cursor.lastImportedAt,
    bytesRead: cursor.offset, linesRead: cursor.line,
    partialLine: cursor.tail.length > 0, imported,
    ...cursor.counts,
    limits: ['Public user and assistant messages only', 'Tool names and lifecycle; allowlisted question titles and options plus validated public replies', 'Native configured model and per-response token metadata when supplied', 'Question capture limits: 64 KiB per call or reply wrapper, 20 questions, 20 options per question and 20 replies', 'No private reasoning or other tool argument/output bodies'],
  };
}

function publishCoverage(store, cursor, stats) {
  const fingerprint = `${ADAPTER_VERSION}:${cursor.offset}:${cursor.line}:${cursor.status}`;
  if (cursor.published === fingerprint) return;
  cursor.published = fingerprint;
  cursor.coverageVersion++;
  append(store, cursor, {
    id: `coverage:transcript:${stats.sessionId}:${createHash('sha256').update(stats.source).digest('hex').slice(0, 12)}:${cursor.coverageVersion}`,
    at: new Date().toISOString(), kind: 'coverage_updated', sessionId: stats.sessionId,
    actor: 'Flux', summary: `Local transcript capture · ${cursor.status.replaceAll('_', ' ')}`,
    source: { type: 'transcript', ref: stats.source }, provenance: 'observed', data: stats,
  });
}

/** Import only the enrolled transcript; repeated reads de-duplicate immutable events. */
export function importTranscript(store, transcriptPath, { sessionId } = {}) {
  if (!store || typeof store.append !== 'function' || typeof store.snapshot !== 'function') {
    throw new TypeError('A Flux store is required');
  }
  if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('An enrolled sessionId is required');
  const project = store.snapshot().project;
  const enrolled = project?.sessionId;
  const projectId = project?.id;
  if (typeof projectId !== 'string' || !projectId) throw new Error('An enrolled project id is required');
  if (!enrolled || enrolled !== sessionId) throw new Error('Transcript session is not enrolled in this project');
  if (typeof transcriptPath !== 'string' || !transcriptPath) throw new TypeError('An exact transcript path is required');
  const file = path.resolve(transcriptPath);
  let cursor = cursorFor(store, file, sessionId, projectId);
  const initialEvents = cursor.known.size;
  let stat;
  try { stat = fs.statSync(file); }
  catch (error) {
    cursor.status = error.code === 'ENOENT' ? 'unavailable' : 'read_error';
    const stats = coverage(cursor, file, sessionId);
    publishCoverage(store, cursor, stats);
    return stats;
  }
  if (!stat.isFile()) throw new Error('Transcript path must refer to one file');
  if (cursor.inode !== null && (stat.ino !== cursor.inode || stat.size < cursor.offset)) {
    const entries = cursors.get(store);
    cursor = newCursor(store, sessionId, file, projectId);
    cursor.status = 'replaying_after_file_change';
    entries.set(`${file}\0${sessionId}\0${projectId}`, cursor);
  }
  cursor.inode = stat.ino;
  cursor.changed = false;
  if (cursor.validated && !cursor.rejected) cursor.status = 'caught_up';
  if (stat.size > cursor.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const bytes = Buffer.alloc(stat.size - cursor.offset);
      const read = fs.readSync(fd, bytes, 0, bytes.length, cursor.offset);
      cursor.offset += read;
      let remaining = Buffer.concat([cursor.tail, bytes.subarray(0, read)]);
      let newline;
      while ((newline = remaining.indexOf(10)) !== -1) {
        cursor.line++;
        parseLine(store, cursor, remaining.subarray(0, newline), cursor.line, file, sessionId, true);
        remaining = remaining.subarray(newline + 1);
      }
      cursor.tail = Buffer.from(remaining);
      // A valid final record without a newline is safe to import. Keep its bytes
      // until its newline arrives so its line number and event identity stay stable.
      if (remaining.length) parseLine(store, cursor, remaining, cursor.line + 1, file, sessionId, false);
    } finally { fs.closeSync(fd); }
  }
  reconcileAnswerSubmissions(store);
  const stats = coverage(cursor, file, sessionId, cursor.known.size - initialEvents);
  publishCoverage(store, cursor, stats);
  return stats;
}

/** Poll exactly one file. The returned function stops capture without changing data. */
export function watchTranscript(store, transcriptPath, { sessionId, intervalMs = 1000 } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs < 50) throw new TypeError('intervalMs must be at least 50ms');
  let stopped = false;
  let lastCoverage = importTranscript(store, transcriptPath, { sessionId });
  const timer = setInterval(() => {
    if (stopped) return;
    try { lastCoverage = importTranscript(store, transcriptPath, { sessionId }); }
    catch (error) {
      lastCoverage = { ...lastCoverage, status: 'read_error', error: String(error.message).slice(0, 160) };
    }
  }, intervalMs);
  timer.unref?.();
  const stop = () => { stopped = true; clearInterval(timer); };
  Object.defineProperty(stop, 'coverage', { get: () => lastCoverage });
  return stop;
}
