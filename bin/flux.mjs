#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectPath, workspace, connect, requireEnrollment, readEnrollment } from '../src/workspaces.mjs';
import { start, stop, disconnect, status, serve } from '../src/lifecycle.mjs';
import { createStore } from '../src/store.mjs';
import { importTranscript } from '../src/transcript.mjs';
import { validateDiagnosticResult } from '../src/diagnostics.mjs';
import { validateQuestionInput } from '../src/incoming-questions.mjs';
const args = process.argv.slice(2), command = args.shift() || 'help';
function option(name, fallback) { const i = args.indexOf(name); if (i < 0) return fallback; const value = args[i + 1]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`); return value; }
const output = value => console.log(JSON.stringify(value, null, 2));
const json = () => { const file = option('--json'); if (!file) throw new Error('Requires --json <file|->'); return JSON.parse(fs.readFileSync(file === '-' ? 0 : path.resolve(file), 'utf8')); };
async function main() {
  if (command === 'version' || command === '--version') { console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url),'utf8')).version); return; }
  if (command === 'help' || command === '--help') { console.log('Flux local companion\n  connect --project <dir> --session <id> --transcript <file> [--title <title>]\n  start|open --project <dir> --session <id> [--port <port>]\n  status --project <dir> [--session <id>]\n  stop|disconnect|import|snapshot|requests|questions --project <dir> --session <id>\n  record|checkpoint|question|resolve-question --project <dir> --session <id> --json <file|->\n  result <request-id> --project <dir> --session <id> --text <answer>|--file <file>\n  install-skill|uninstall-skill --project <dir>\n  version'); return; }
  if (command === '_serve') return serve(option('--data-dir'), option('--port'), option('--instance'), option('--marker'), option('--deadline'));
  const project = projectPath(option('--project'));
  if (command === 'install-skill' || command === 'uninstall-skill') { const mod = await import('../src/skill-install.mjs'); return output(await mod[command === 'install-skill' ? 'installSkill' : 'uninstallSkill']({ project, runtimePath: fileURLToPath(import.meta.url) })); }
  const session = option('--session');
  if (command === 'status' && !session) {
    const root = path.join(project, '.flux', 'chats');
    if (!fs.existsSync(root)) return output([]);
    const found = [];
    for (const name of fs.readdirSync(root)) { try { const dir = path.join(root, name), e = readEnrollment(dir); if (e.project === project && workspace(project, e.sessionId, {validate:true}) === dir) found.push(await status(dir, e)); } catch {} }
    return output(found);
  }
  if (command === 'connect') return output(connect(project, session, option('--transcript'), option('--title')));
  const { dir, enrollment } = requireEnrollment(project, session, { enabled: !['status', 'stop', 'disconnect'].includes(command) });
  if (command === 'status') return output(await status(dir, enrollment));
  if (command === 'start') return output(await start(dir, enrollment, option('--port')));
  if (command === 'stop') return output(await stop(dir, enrollment));
  if (command === 'disconnect') return output(await disconnect(dir, enrollment));
  if (command === 'open') {
    const state = await start(dir, enrollment, option('--port'));
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    await new Promise((resolve, reject) => { const child = spawn(opener, [state.url], { stdio: 'ignore', shell: false }); child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`Browser opener exited with code ${code}`))); }); return output(state);
  }
  const store = createStore(dir), snapshot = store.snapshot();
  if (snapshot.project.id !== enrollment.projectId || snapshot.project.sessionId !== session || snapshot.project.directory !== project || snapshot.project.transcriptPath !== enrollment.transcript) throw new Error('Project identity mismatch');
  const checkScope = value => { if (!value || typeof value !== 'object') return; if (Array.isArray(value)) { for (const item of value) checkScope(item); return; } if (value.projectId !== undefined && value.projectId !== enrollment.projectId || value.sessionId !== undefined && value.sessionId !== session) throw new Error('Event cannot cross enrollment identity'); for (const nested of Object.values(value)) checkScope(nested); };
  const append = event => { checkScope(event); return store.append({ ...event, projectId: enrollment.projectId, sessionId: session }); };
  if (command === 'record') {
    const event = json(); if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Event must be an object');
    if (event.kind === 'project_patch') { const patch = event.data?.patch; const allowed = new Set(['title','goal','latestIntent','latestIntentSourceId','latestIntentSourceIds','focus','items','plans','decisions','constraints']); if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !allowed.has(key))) throw new Error('Project patch contains forbidden enrollment fields'); }
    return output(append(event));
  }
  if (command === 'checkpoint') { const plan = json(); plan.at ??= new Date().toISOString(); return output(append({ kind:'plan_saved', actor:'Codex', summary:plan.title || 'Plan saved', provenance:'agent_report', source:{type:'agent_checkpoint',ref:plan.id}, data:{plan} })); }
  if (command === 'import') { const transcript = option('--transcript', enrollment.transcript); if (fs.realpathSync(path.resolve(transcript)) !== enrollment.transcript) throw new Error('Transcript differs from enrollment'); return output(importTranscript({ ...store, append: event => append(event) }, transcript, { sessionId:session })); }
  if (command === 'snapshot') return output(args.includes('--full') ? snapshot : {revision:snapshot.revision,project:{id:snapshot.project.id,title:snapshot.project.title,goal:snapshot.project.goal,latestIntent:snapshot.project.latestIntent},items:snapshot.project.items,coverage:snapshot.coverage,pendingRequests:snapshot.requests?.filter(r=>r.status==='queued')});
  if (command === 'requests') return output(args.includes('--pending') ? snapshot.requests.filter(r=>!['completed','failed'].includes(r.status)) : snapshot.requests);
  if (command === 'questions') return output(args.includes('--pending') ? snapshot.incomingQuestions.pending : snapshot.incomingQuestions);
  if (command === 'result') {
    const id = args[0]; if (!id || id.startsWith('--')) throw new Error('result requires a request ID');
    const file = option('--file'), result = validateDiagnosticResult(file ? fs.readFileSync(path.resolve(file),'utf8') : option('--text'));
    if (!result?.trim()) throw new Error('result requires --text or --file');
    const request = snapshot.requests?.find(r=>r.id===id); if (!request) throw new Error('Unknown diagnostic request');
    if (request.status === 'completed') return output({requestId:id,status:'completed',result:request.result,alreadyRecorded:true});
    return output(append({kind:'diagnostic_result',actor:'Codex',summary:'Diagnostic answered',text:result.slice(0,12000),provenance:'agent_report',source:{type:'diagnostic',ref:id},data:{requestId:id,result:result.slice(0,12000)}}));
  }
  if (command === 'question' || command === 'resolve-question') {
    const resolving=command==='resolve-question', value=validateQuestionInput(json(),snapshot,resolving);
    if (value.existing) return output({question:value.existing,alreadyRecorded:true});
    return output(append({kind:resolving?'question_resolved':'question_recorded',actor:'Codex',summary:resolving?(value.status==='replied'?'Question reply recorded':'Question closed'):'Question recorded',text:resolving?(value.resolutionNote||value.reason||value.answer):value.text,provenance:'agent_report',source:{type:'agent_checkpoint',ref:resolving?value.questionId:value.id},data:resolving?{resolution:value}:{question:value}}));
  }
  throw new Error(`Unknown command: ${command}`);
}
main().catch(error => { console.error(`Flux: ${error.message}`); process.exitCode = 1; });
