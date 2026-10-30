#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.mjs';
import { validateDiagnosticResult } from './diagnostics.mjs';
import { validateQuestionInput } from './incoming-questions.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const command = args.shift() || 'help';
function option(name, fallback) { const i=args.indexOf(name); if(i<0)return fallback;const v=args[i+1];if(!v||v.startsWith('--'))throw new Error(`Missing value for ${name}`);return v; }
const dataDir = path.resolve(option('--data-dir', process.env.FLUX_DATA_DIR || path.join(repo,'.flux')));
const store = createStore(dataDir);
function readJson(value) { return JSON.parse(value==='-'?fs.readFileSync(0,'utf8'):fs.readFileSync(path.resolve(value),'utf8')); }
function output(value) { console.log(JSON.stringify(value,null,2)); }
if(command==='record') {
  const file=option('--json');if(!file)throw new Error('record requires --json <file|->');
  const event=readJson(file);output(store.append(event));
} else if(command==='checkpoint') {
  const file=option('--json');if(!file)throw new Error('checkpoint requires --json <file|->');
  const plan=readJson(file);plan.at ??= new Date().toISOString();output(store.append({kind:'plan_saved',sessionId:store.snapshot().project?.sessionId,actor:'Codex',summary:plan.title||'Plan saved',provenance:'agent_report',source:{type:'agent_checkpoint',ref:plan.id},data:{plan}}));
} else if(command==='result') {
  const requestId=args[0];if(!requestId||requestId.startsWith('--'))throw new Error('result requires a request ID');
  const text=option('--text');const file=option('--file');
  const result=validateDiagnosticResult(file?fs.readFileSync(path.resolve(file),'utf8'):text);
  if(!result?.trim())throw new Error('result requires --text or --file');
  const request=store.snapshot().requests?.find(r=>r.id===requestId);if(!request)throw new Error('Unknown diagnostic request');
  if(request.status==='completed')output({requestId,status:'completed',result:request.result,alreadyRecorded:true});
  else output(store.append({kind:'diagnostic_result',sessionId:store.snapshot().project?.sessionId,actor:'Codex',summary:'Diagnostic answered',text:result.slice(0,12000),provenance:'agent_report',source:{type:'diagnostic',ref:requestId},data:{requestId,result:result.slice(0,12000)}}));
} else if(command==='requests') {
  const requests=store.snapshot().requests||[];output(args.includes('--pending')?requests.filter(r=>!['completed','failed'].includes(r.status)):requests);
} else if(command==='questions') {
  const questions=store.snapshot().incomingQuestions;output(args.includes('--pending')?questions.pending:questions);
} else if(command==='question' || command==='resolve-question') {
  const file=option('--json');if(!file)throw new Error(`${command} requires --json <file|->`);
  const snapshot=store.snapshot();const resolving=command==='resolve-question';const value=validateQuestionInput(readJson(file),snapshot,resolving);
  if(value.existing) output({question:value.existing,alreadyRecorded:true});
  else output(store.append({kind:resolving?'question_resolved':'question_recorded',projectId:snapshot.project.id,sessionId:snapshot.project.sessionId,actor:'Codex',summary:resolving?(value.status==='replied'?'Question reply recorded':'Question closed'):'Question recorded',text:resolving?(value.resolutionNote||value.reason||value.answer):value.text,provenance:'agent_report',source:{type:'agent_checkpoint',ref:resolving?value.questionId:value.id},data:resolving?{resolution:value}:{question:value}}));
} else if(command==='snapshot') {
  const s=store.snapshot();output(args.includes('--full')?s:{revision:s.revision,project:{id:s.project?.id,title:s.project?.title,goal:s.project?.goal,latestIntent:s.project?.latestIntent},items:s.project?.items,coverage:s.coverage,pendingRequests:s.requests?.filter(r=>r.status==='queued')});
} else if(command==='import') {
  const {importTranscript}=await import('./transcript.mjs');
  const project=store.snapshot().project;const transcript=option('--transcript',project?.transcriptPath);const sessionId=option('--session',project?.sessionId);
  if(!transcript||!sessionId)throw new Error('import requires --transcript and --session or an enrolled project');
  output(importTranscript(store,transcript,{sessionId}));
} else if(command==='serve') {
  const {startServer}=await import('./server.mjs');
  const {watchTranscript}=await import('./transcript.mjs');
  const project=store.snapshot().project;const port=Number(option('--port','7391'));
  const app=await startServer({dataDir,port,store,publicDir:path.join(repo,'public')});
  let stop=()=>{};
  if(project?.transcriptPath&&project?.sessionId)stop=watchTranscript(store,project.transcriptPath,{sessionId:project.sessionId,intervalMs:1000});
  const connection={url:app.address,pid:process.pid,startedAt:new Date().toISOString(),sessionId:project?.sessionId};
  fs.writeFileSync(path.join(dataDir,'connection.json'),JSON.stringify(connection,null,2));
  output(connection);
  const close=async()=>{stop();await app.close();process.exit(0);};
  process.on('SIGINT',close);process.on('SIGTERM',close);
} else if(command==='help') {
  console.log('Flux local companion\n  serve [--port 7391]\n  import [--transcript <path> --session <id>]\n  snapshot [--full]\n  record --json <file|->\n  checkpoint --json <file|->\n  requests [--pending]\n  questions [--pending]\n  question --json <file|->\n  resolve-question --json <file|->\n  result <request-id> --text <answer>\nRun npm start to build and serve the local React UI.\nAll commands accept --data-dir <path>.');
} else throw new Error(`Unknown command: ${command}`);
