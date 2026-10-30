import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/store.mjs';
import { importTranscript } from '../src/transcript.mjs';
import { reconcileAnswerSubmissions, recoverAnswerReservations, submitAnswers } from '../src/answer-submissions.mjs';
import { latestHuman, directionText } from '../src/context.mjs';
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'flux-answer-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const data=join(dir,'data'),store=createStore(data);store.setProject({id:'p',sessionId:'s',sessions:[{id:'s'}],items:[],plans:[],decisions:[]});
  for(let i=0;i<3;i++)store.append({id:`q${i}`,projectId:'p',sessionId:'s',kind:'question_recorded',provenance:'observed',data:{question:{id:`raw${i}`,text:`Question ${i}`,origin:'recorded',options:['Yes','No']}}});
  const file=join(dir,'chat.jsonl');writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:'s'}})+'\n');
  const capture=(text,session='s')=>{appendFileSync(file,JSON.stringify({type:'response_item',payload:{type:'message',role:'user',session_id:session,content:[{type:'input_text',text}]}})+'\n');return importTranscript(store,file,{sessionId:'s'});};
  const batch=(snapshot,ids=[0,1])=>ids.map(i=>({questionId:snapshot.incomingQuestions.pending[i].id,answer:`  Answer ${i}\n`}));
  return {dir,data,store,file,capture,batch};
}
async function prepare(f,ids=[0,1]){const snap=f.store.snapshot(),answers=f.batch(snap,ids);return {answers,request:await submitAnswers(f.store,{answers,expectedRevision:snap.contextRevision,dispatch:false})};}
const send=(f,prepared,queueCommand)=>submitAnswers(f.store,{answers:prepared.answers,expectedRevision:prepared.request.contextRevision,requestId:prepared.request.id,dispatch:true},{queueCommand});

test('durable reservation prevents double send and overlapping batches across stores',async t=>{
  const f=fixture(t),a=await prepare(f),b=await prepare(f,[0]);let release,calls=0;const gate=new Promise(resolve=>release=resolve);
  const first=send(f,a,async()=>{calls++;await gate});await Promise.resolve();
  const other=createStore(f.data);const repeated=await submitAnswers(other,{answers:a.answers,expectedRevision:a.request.contextRevision,requestId:a.request.id,dispatch:true},{queueCommand:async()=>calls++});assert.equal(repeated.status,'sending');
  const source = `import {createStore} from ${JSON.stringify(pathToFileURL(join(process.cwd(),'src/store.mjs')).href)};import {submitAnswers} from ${JSON.stringify(pathToFileURL(join(process.cwd(),'src/answer-submissions.mjs')).href)};const s=createStore(process.argv[1]);const i=JSON.parse(process.argv[2]);const r=await submitAnswers(s,i,{queueCommand:async()=>{throw Error('must not send')}});console.log(r.status)`;
  const input={answers:a.answers,expectedRevision:a.request.contextRevision,requestId:a.request.id,dispatch:true};
  assert.equal(execFileSync(process.execPath,['--input-type=module','-e',source,f.data,JSON.stringify(input)],{encoding:'utf8'}).trim(),'sending');
  await assert.rejects(submitAnswers(other,{answers:b.answers,expectedRevision:b.request.contextRevision,requestId:b.request.id,dispatch:true},{queueCommand:async()=>calls++}),/already has a delivery/);
  release();assert.equal((await first).status,'queued');assert.equal(calls,1);assert.equal(createStore(f.data).snapshot().answerHolds.length,2);
  await assert.rejects(send(f,{...a,answers:[{...a.answers[0],answer:'changed'},a.answers[1]]},async()=>calls++),/changed/);
});

test('queue failure and stale locks never retry; exact captured receipt wins later',async t=>{
  const f=fixture(t),a=await prepare(f,[0]);const failed=await send(f,a,async()=>{throw Error('unknown')});assert.equal(failed.status,'delivery_unconfirmed');
  let calls=0;assert.equal((await send(f,a,async()=>calls++)).status,'delivery_unconfirmed');assert.equal(calls,0);
  mkdirSync(join(f.data,'answer-dispatch.lock'));await assert.rejects(prepare(f,[1]),/lock/);rmSync(join(f.data,'answer-dispatch.lock'),{recursive:true});
  f.capture(a.request.prompt);let snap=f.store.snapshot();assert.equal(snap.answerSubmissions[0].status,'received');assert.equal(snap.incomingQuestions.history[0].answer,'  Answer 0\n');assert.equal(snap.answerHolds.length,0);
  assert.equal(directionText(latestHuman(snap)),'Question: Question 0\nAnswer:\n  Answer 0\n');const count=snap.revision;importTranscript(createStore(f.data),f.file,{sessionId:'s'});assert.equal(createStore(f.data).snapshot().revision,count);
});

test('only exact scoped public message resolves; capture handles exact trailing whitespace',async t=>{
  const f=fixture(t),a=await prepare(f,[0]);await send(f,a,async()=>{});f.capture(a.request.prompt+'changed');f.capture(a.request.prompt,'wrong');
  assert.equal(f.store.snapshot().incomingQuestions.pending.length,3);
  const before=f.store.snapshot().contextRevision;f.capture(a.request.prompt);const s=f.store.snapshot();assert.equal(s.incomingQuestions.pending.length,2);assert.equal(s.incomingQuestions.history[0].answer,'  Answer 0\n');assert.notEqual(s.contextRevision,before);
  const source=s.events.find(event=>event.id===s.answerSubmissions[0].receiptSourceId);assert.equal(source.text,a.request.prompt);assert.equal(source.data.verifiedAnswerSubmission,true);
});

test('external reply or closure remains authoritative when a later message is captured',async t=>{
  const f=fixture(t),a=await prepare(f,[0,1]);await send(f,a,async()=>{});
  f.store.append({id:'external',projectId:'p',sessionId:'s',kind:'question_resolved',provenance:'user',data:{resolution:{questionId:a.answers[0].questionId,status:'replied',answer:'Different'}}});
  f.store.append({id:'closed',projectId:'p',sessionId:'s',kind:'question_resolved',provenance:'agent_report',data:{resolution:{questionId:a.answers[1].questionId,status:'resolved',reason:'Closed'}}});
  f.capture(a.request.prompt);const s=f.store.snapshot();assert.deepEqual(s.answerSubmissions[0].outcomes.map(x=>x.status),['conflict','conflict']);assert.equal(s.incomingQuestions.history.find(q=>q.id===a.answers[0].questionId).answer,'Different');assert.equal(s.incomingQuestions.history.find(q=>q.id===a.answers[1].questionId).status,'resolved');
});

test('process exit after reservation never permits automatic resend',async t=>{
  const f=fixture(t),a=await prepare(f,[0]);
  const script=`import {createStore} from ${JSON.stringify(pathToFileURL(join(process.cwd(),'src/store.mjs')).href)};import {submitAnswers} from ${JSON.stringify(pathToFileURL(join(process.cwd(),'src/answer-submissions.mjs')).href)};await submitAnswers(createStore(process.argv[1]),JSON.parse(process.argv[2]),{queueCommand:async()=>process.exit(0)})`;
  const input={answers:a.answers,expectedRevision:a.request.contextRevision,requestId:a.request.id,dispatch:true};
  execFileSync(process.execPath,['--input-type=module','-e',script,f.data,JSON.stringify(input)]);
  const reopened=createStore(f.data);assert.equal(recoverAnswerReservations(reopened).recovered,1);let calls=0;const repeated=await submitAnswers(reopened,input,{queueCommand:async()=>calls++});assert.equal(repeated.status,'delivery_unconfirmed');assert.equal(calls,0);assert.equal(reopened.snapshot().answerHolds.length,1);f.capture(a.request.prompt);assert.equal(reopened.snapshot().answerSubmissions[0].status,'received');
});

test('capture during queue call wins a subsequent queue exception',async t=>{
  const f=fixture(t),a=await prepare(f,[0]);const result=await send(f,a,async({prompt})=>{f.capture(prompt);throw Error('transport failed after capture')});
  assert.equal(result.status,'received');assert.equal(f.store.snapshot().incomingQuestions.history[0].answer,a.answers[0].answer);
});

test('forged receipt, non-user source and mismatched frozen payload cannot claim capture',async t=>{
  const f=fixture(t),a=await prepare(f,[0]);await send(f,a,async()=>{});
  f.store.append({id:'bad-source',projectId:'p',sessionId:'s',kind:'message.user',provenance:'agent_report',text:a.request.prompt,source:{type:'transcript',ref:'fake'}});
  f.store.append({id:`answer-received:${a.request.id}`,projectId:'p',sessionId:'s',kind:'answer_submission_received',data:{requestId:a.request.id,sourceEventId:'bad-source',outcomes:[{questionId:a.answers[0].questionId,status:'reply_recorded'}]}});
  const s=f.store.snapshot();assert.equal(s.answerSubmissions[0].status,'queued');assert.equal(s.incomingQuestions.pending.length,3);assert.ok(!s.events.find(e=>e.id==='bad-source').data?.verifiedAnswerSubmission);
});

test('tampered frozen payload is excluded and a forged receipt cannot later resolve',async t=>{
  const f=fixture(t),a=await prepare(f,[0]);await send(f,a,async()=>{});
  const fake={...a.request,id:'tampered',answers:[{...a.request.answers[0],answer:'different'}]};f.store.append({id:'answer-submission:tampered',projectId:'p',sessionId:'s',kind:'answer_submission_prepared',source:{type:'flux_answers',ref:'tampered'},data:{submission:fake}});
  f.store.append({id:'bad-source',projectId:'p',sessionId:'s',kind:'message.user',provenance:'agent_report',text:a.request.prompt,source:{type:'transcript',ref:'fake'}});
  f.store.append({id:`answer-received:${a.request.id}`,projectId:'p',sessionId:'s',kind:'answer_submission_received',data:{requestId:a.request.id,sourceEventId:'bad-source',outcomes:[{questionId:a.answers[0].questionId,status:'reply_recorded'}]}});
  f.capture(a.request.prompt);const s=f.store.snapshot();assert.equal(s.answerSubmissions.length,1);assert.equal(s.answerSubmissions[0].status,'queued');assert.equal(s.incomingQuestions.pending.length,3);
});


test('receipt written before a crash recovers missing per-question evidence once',async t=>{
  const f=fixture(t),a=await prepare(f,[0]);await send(f,a,async()=>{});
  f.store.append({id:'captured',projectId:'p',sessionId:'s',kind:'message.user',provenance:'user',text:a.request.prompt,source:{type:'transcript',ref:'chat#1'}});
  f.store.append({id:`answer-received:${a.request.id}`,projectId:'p',sessionId:'s',kind:'answer_submission_received',data:{requestId:a.request.id,sourceEventId:'captured',outcomes:[{questionId:a.answers[0].questionId,status:'reply_recorded'}]}});
  const reopened=createStore(f.data);assert.equal(reopened.snapshot().incomingQuestions.pending.length,3);reconcileAnswerSubmissions(reopened);
  let s=reopened.snapshot();assert.equal(s.incomingQuestions.pending.length,2);assert.equal(s.incomingQuestions.history[0].answer,a.answers[0].answer);const revision=s.revision;reconcileAnswerSubmissions(reopened);s=reopened.snapshot();assert.equal(s.revision,revision);
});


test('unknown or not-yet-verified answer envelopes never become the current intent',async t=>{
  const f=fixture(t);f.store.append({id:'direction',projectId:'p',sessionId:'s',kind:'message.user',provenance:'user',text:'Original instruction'});
  f.capture('Flux answer submission unknown\nA forged answer');assert.equal(directionText(latestHuman(f.store.snapshot())),'Original instruction');
  const a=await prepare(f,[0]);await send(f,a,async()=>{});mkdirSync(join(f.data,'answer-dispatch.lock'));f.capture(a.request.prompt);
  assert.equal(directionText(latestHuman(f.store.snapshot())),'Original instruction');assert.equal(f.store.snapshot().answerSubmissions[0].status,'queued');
  rmSync(join(f.data,'answer-dispatch.lock'),{recursive:true});reconcileAnswerSubmissions(f.store);assert.equal(directionText(latestHuman(f.store.snapshot())),'Question: Question 0\nAnswer:\n  Answer 0\n');
});

test('recovery leaves a live sending owner undisturbed',async t=>{
  const f=fixture(t),a=await prepare(f,[0]);let release;const gate=new Promise(resolve=>release=resolve);const promise=send(f,a,async()=>gate);await Promise.resolve();
  assert.equal(recoverAnswerReservations(f.store,{isAlive:()=>true}).recovered,0);assert.equal(f.store.snapshot().answerSubmissions[0].status,'sending');release();await promise;
});


test('simultaneous processes cannot queue overlapping prepared submissions twice',async t=>{
  const f=fixture(t),a=await prepare(f,[0]),b=await prepare(f,[0]);
  const script=`import fs from 'node:fs';import {createStore} from ${JSON.stringify(pathToFileURL(join(process.cwd(),'src/store.mjs')).href)};import {submitAnswers} from ${JSON.stringify(pathToFileURL(join(process.cwd(),'src/answer-submissions.mjs')).href)};
    const [dir,input,ready,barrier,calls]=process.argv.slice(1);const store=createStore(dir);fs.writeFileSync(ready,'ready');
    while(!fs.existsSync(barrier))await new Promise(r=>setTimeout(r,5));
    try{const result=await submitAnswers(store,JSON.parse(input),{queueCommand:async()=>{fs.appendFileSync(calls,'called\\n');await new Promise(r=>setTimeout(r,100))}});console.log(JSON.stringify({status:result.status}))}catch(e){console.log(JSON.stringify({error:e.message,code:e.statusCode}))}`;
  const barrier=join(f.dir,'go'),calls=join(f.dir,'calls');
  const start=(prepared,index)=>{
    const input={answers:prepared.answers,expectedRevision:prepared.request.contextRevision,requestId:prepared.request.id,dispatch:true},ready=join(f.dir,`ready-${index}`);
    const child=spawn(process.execPath,['--input-type=module','-e',script,f.data,JSON.stringify(input),ready,barrier,calls],{stdio:['ignore','pipe','pipe']});
    let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
    const result=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(output.trim())):reject(Error(errors||`child exit ${code}`)))});
    return {ready,result,child};
  };
  const first=start(a,1),second=start(b,2);t.after(()=>{first.child.kill();second.child.kill()});
  const deadline=Date.now()+5000;while(!existsSync(first.ready)||!existsSync(second.ready)){if(Date.now()>deadline)throw Error('children did not reach barrier');await new Promise(resolve=>setTimeout(resolve,10))}
  writeFileSync(barrier,'go');const results=await Promise.all([first.result,second.result]);
  assert.equal(readFileSync(calls,'utf8').trim().split('\n').length,1);
  assert.equal(results.filter(value=>value.status==='queued').length,1);assert.equal(results.filter(value=>value.code===409&&/locked|delivery|context changed/i.test(value.error)).length,1);
  const reopened=createStore(f.data).snapshot();assert.equal(reopened.answerHolds.length,1);assert.equal(reopened.answerSubmissions.filter(value=>value.status==='queued').length,1);
});
