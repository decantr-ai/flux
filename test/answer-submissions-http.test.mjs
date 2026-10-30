import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';

test('answers endpoint enforces origin, CSRF, runtime freshness and reviewed exact payload',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'flux-answer-http-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=createStore(dir);store.setProject({id:'p',sessionId:'s',sessions:[{id:'s'}],items:[],plans:[],decisions:[]});store.append({id:'q',projectId:'p',sessionId:'s',kind:'question_recorded',data:{question:{id:'q',text:'Question?',origin:'recorded'}}});
  let version='v1',calls=0;const app=await startServer({store,dataDir:dir,watch:false,runtimeFingerprint:async()=>version,queueCommand:async()=>{calls++}});t.after(()=>app.close());
  const state=await fetch(app.address+'/api/state').then(r=>r.json());const payload={answers:[{questionId:state.incomingQuestions.pending[0].id,answer:' yes '}],expectedRevision:state.contextRevision,dispatch:false};
  const post=(body,headers={})=>fetch(app.address+'/api/answers',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post(payload)).status,403);assert.equal((await post(payload,{'x-flux-csrf':state.csrfToken,origin:'https://evil.invalid'})).status,403);
  const headers={'x-flux-csrf':state.csrfToken};assert.equal((await post({padding:'x'.repeat(66000)},headers)).status,413);
  version='v2';assert.equal((await post(payload,headers)).status,409);version='v1';
  const prepared=await (await post(payload,headers)).json();assert.equal(prepared.status,'prepared');
  const dispatch={requestId:prepared.id,answers:payload.answers,expectedRevision:prepared.contextRevision,dispatch:true};assert.equal((await post({...dispatch,answers:[{...payload.answers[0],answer:'other'}]},headers)).status,409);assert.equal(calls,0);
  const result=await (await post(dispatch,headers)).json();assert.equal(result.status,'queued');assert.equal(calls,1);
  assert.equal((await post(dispatch,headers)).status,200);assert.equal(calls,1);
  const missing=await post({},headers);assert.equal(missing.status,400);
});
