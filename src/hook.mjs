import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.mjs';

const EVENTS = new Set(['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Stop', 'Interrupt']);
const LABELS = {
  SessionStart: 'Codex session started', SessionEnd: 'Codex session ended',
  PreToolUse: 'Tool started', PostToolUse: 'Tool returned',
  PermissionRequest: 'Codex requested permission', UserPromptSubmit: 'User instruction submitted',
  SubagentStart: 'Agent started', SubagentStop: 'Agent stopped',
  PreCompact: 'Conversation compaction started', PostCompact: 'Conversation compacted',
  Stop: 'Codex turn stopped', Interrupt: 'Codex interrupted',
};
const string = value => typeof value === 'string' ? value.slice(0, 240) : undefined;

/** Pure recording adapter: no approvals, continuation instructions, or transcript reads. */
export function recordHook(store, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { recorded: false, reason: 'invalid_payload' };
  const enrolled = store.snapshot().project?.sessionId;
  if (!enrolled || input.session_id !== enrolled) return { recorded: false, reason: 'session_not_enrolled' };
  const eventName = string(input.hook_event_name);
  if (!EVENTS.has(eventName)) return { recorded: false, reason: 'unknown_event' };
  const callId = string(input.tool_use_id);
  const turnId = string(input.turn_id);
  const agentId = string(input.agent_id);
  const toolName = string(input.tool_name);
  const identity = callId || (agentId ? `${agentId}:${turnId || randomUUID()}` : undefined) || string(input.event_id) || randomUUID();
  const data = { eventName };
  for (const [key, value] of Object.entries({ callId, turnId, agentId, toolName, agentType: string(input.agent_type), trigger: string(input.trigger), reason: string(input.reason) })) {
    if (value !== undefined) data[key] = value;
  }
  const event = store.append({
    id: `hook:${enrolled}:${eventName}:${identity}`,
    at: new Date().toISOString(), kind: `hook.${eventName}`, sessionId: enrolled,
    actor: agentId ? `Agent ${agentId}` : 'Codex',
    summary: `${LABELS[eventName]}${toolName ? ` · ${toolName}` : ''}`,
    provenance: 'observed', source: { type: 'hook', ref: callId || agentId || turnId || eventName }, data,
  });
  return { recorded: true, eventId: event.id };
}

export function runHook({ dataDir, input } = {}) {
  try {
    if (!dataDir || !fs.existsSync(path.join(dataDir, 'project.json'))) return { recorded: false, reason: 'not_configured' };
    return recordHook(createStore(dataDir), input);
  } catch { return { recorded: false, reason: 'recording_unavailable' }; }
}

export async function readHookInput(stream = process.stdin, timeoutMs = 750) {
  return new Promise(resolve => {
    let size = 0;
    const parts = [];
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.pause?.();
      resolve(value);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) return finish(null);
      parts.push(Buffer.from(chunk));
    };
    const onEnd = () => {
      try { finish(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
      catch { finish(null); }
    };
    const onError = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

export async function hookMain({ dataDir } = {}) {
  const input = await readHookInput();
  runHook({ dataDir, input });
  // Empty output contract: this observer never controls Codex or injects context.
  process.stdout.write('{}\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--data-dir');
  const dataDir = flag >= 0 ? args[flag + 1] : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.flux');
  await hookMain({ dataDir });
}
