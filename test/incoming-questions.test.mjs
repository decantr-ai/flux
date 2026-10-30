import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { importTranscript } from '../src/transcript.mjs';
import { validateQuestionInput } from '../src/incoming-questions.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flux-questions-')); t.after(() => rmSync(dir, { recursive:true, force:true }));
  const store = createStore(join(dir,'data'));
  store.setProject({ id:'project', sessionId:'s1', sessions:[{id:'s1'}], items:[], plans:[], decisions:[] });
  const file=join(dir,'chat.jsonl');
  const line = record => JSON.stringify(record)+'\n';
  writeFileSync(file,line({type:'session_meta',payload:{id:'s1'}}));
  const add=record=>appendFileSync(file,line(record));
  const read=()=>importTranscript(store,file,{sessionId:'s1'});
  return {dir,store,file,add,read};
}
const call=(id,titles,session='s1')=>({type:'response_item',payload:{type:'function_call',session_id:session,name:'functions.request_user_input_async',call_id:id,arguments:JSON.stringify({questions:titles.map(title=>({title,options:['Yes','No']}))})}});
const reply=(items,session='s1')=>({type:'response_item',payload:{type:'message',role:'user',session_id:session,content:[{type:'input_text',text:`<send_user_message_question_reply>${JSON.stringify(items)}</send_user_message_question_reply>`}]}});
const tuple=(id,index)=>JSON.stringify(['request_user_input_async',id,index]);

test('allowlisted questions, partial replies and identity/session validation survive replay', t=>{
  const f=fixture(t);f.add(call('a',['Same','Second']));f.add(call('b',['Same','Fourth']));
  f.add({type:'response_item',payload:{type:'function_call_output',call_id:'a',output:JSON.stringify({accepted:true})}});
  f.read();let s=f.store.snapshot();assert.equal(s.incomingQuestions.pending.length,4);assert.equal(s.incomingQuestions.history.length,0);
  const ids=s.incomingQuestions.pending.map(q=>q.id);assert.equal(new Set(ids).size,4);assert.equal(s.coverage.adapterVersion,4);
  const before=s.contextRevision;f.store.append({kind:'tool.returned',sessionId:'s1'});assert.equal(f.store.snapshot().contextRevision,before);
  f.add(reply([{questionItemId:tuple('a',0),question:'Same',answer:'Yes'},{questionItemId:tuple('a',1),question:'Wrong',answer:'Yes'},{questionItemId:tuple('missing',0),answer:'Yes'},{questionItemId:tuple('b',9),answer:'Yes'},{questionItemId:tuple('b',0),answer:''}]));
  f.add(reply([{questionItemId:tuple('b',1),answer:'Yes'}],'foreign'));f.read();s=f.store.snapshot();
  assert.equal(s.incomingQuestions.pending.length,3);assert.equal(s.incomingQuestions.history.length,1);assert.equal(s.incomingQuestions.history[0].status,'replied');assert.equal(s.incomingQuestions.history[0].answer,'Yes');assert.notEqual(s.contextRevision,before);
  const rev=s.revision;f.read();assert.equal(f.store.snapshot().revision,rev);
  const reopened=createStore(join(f.dir,'data'));importTranscript(reopened,f.file,{sessionId:'s1'});assert.deepEqual(reopened.snapshot().incomingQuestions,s.incomingQuestions);
});

test('malformed wrappers, other tools and nested ordinary text do not resolve questions or expose arguments', t=>{
  const f=fixture(t);f.add(call('a',['Question']));f.add({type:'response_item',payload:{type:'function_call',name:'other',call_id:'x',arguments:'{"secret":"SECRET"}'}});
  f.add({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<send_user_message_question_reply>bad</send_user_message_question_reply>'}]}});
  f.add({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:`Quote: <send_user_message_question_reply>${JSON.stringify([{questionItemId:tuple('a',0),answer:'Yes'}])}</send_user_message_question_reply>`}]}});
  f.read();const s=f.store.snapshot();assert.equal(s.incomingQuestions.pending.length,1);assert.equal(s.incomingQuestions.history.length,0);assert.ok(!JSON.stringify(s.events).includes('SECRET'));
});

test('legacy work statuses, explicit records and source validation stay session scoped', t=>{
  const f=fixture(t);const statuses=['done','complete','completed','verified','verified_complete','superseded','cancelled','canceled','abandoned'];
  f.store.setProject({...f.store.snapshot().project,items:[...statuses.map((status,i)=>({id:`closed${i}`,title:'Closed',status,requiresUserDecision:true,sessionId:'s1'})),{id:'pending',title:'Pending',status:'waiting',requiresUserDecision:true},{id:'cleared',title:'Cleared',status:'waiting',requiresUserDecision:false},{id:'foreign',title:'Foreign',status:'waiting',requiresUserDecision:true,sessionId:'s2'}]});
  f.store.append({id:'source',sessionId:'s1',kind:'message.user',text:'Source'});f.store.append({id:'foreign-source',sessionId:'s2',kind:'message.user',text:'Foreign'});
  let s=f.store.snapshot();assert.equal(s.incomingQuestions.pending.length,1);assert.equal(s.incomingQuestions.history.length,statuses.length);
  assert.throws(()=>validateQuestionInput({id:'x',text:'Question',sourceIds:['foreign-source']},s));
  const q=validateQuestionInput({id:'x',text:'Question',sourceIds:['source']},s);f.store.append({id:'q',projectId:'project',sessionId:'s1',kind:'question_recorded',provenance:'agent_report',data:{question:q}});s=f.store.snapshot();
  const recorded=s.incomingQuestions.pending.find(value=>value.origin==='recorded');assert.ok(recorded);assert.ok(validateQuestionInput({id:'x',text:'Question',sourceIds:['source']},s).existing);assert.throws(()=>validateQuestionInput({id:'x',text:'Different',sourceIds:['source']},s));
  const resolution=validateQuestionInput({id:recorded.id,status:'resolved',reason:'Addressed',sourceIds:['source']},s,true);f.store.append({id:'resolution',projectId:'project',sessionId:'s1',kind:'question_resolved',provenance:'agent_report',data:{resolution}});
  s=f.store.snapshot();assert.equal(s.incomingQuestions.history.find(value=>value.id===recorded.id).status,'resolved');assert.equal(s.incomingQuestions.history.find(value=>value.id===recorded.id).resolutionProvenance,'agent_report');
});

test('foreign same-id updates and references cannot leak into current questions', t=>{
  const f=fixture(t);f.store.setProject({...f.store.snapshot().project,items:[{id:'shared',title:'Current',status:'waiting',sessionId:'s1',requiresUserDecision:true}]});
  f.store.append({id:'foreign-item',sessionId:'s2',kind:'item_updated',data:{item:{id:'shared',title:'FOREIGN',status:'completed',requiresUserDecision:true}}});
  f.store.append({id:'foreign-q',projectId:'other',sessionId:'s1',kind:'question_recorded',data:{question:{id:'x',text:'FOREIGN QUESTION',origin:'recorded'}}});
  const q=f.store.snapshot().incomingQuestions;assert.equal(q.pending.length,1);assert.equal(q.pending[0].text,'Current');assert.equal(q.history.length,0);assert.doesNotMatch(JSON.stringify(q),/FOREIGN/);
});

test('retains a validated reply before its exact call, never matches by title', t=>{
  const f=fixture(t);f.add(reply([{questionItemId:tuple('later',0),question:'Same',answer:'Yes'}]));f.add(call('other',['Same']));f.read();
  assert.equal(f.store.snapshot().incomingQuestions.pending.length,1);assert.equal(f.store.snapshot().incomingQuestions.history.length,0);
  f.add(call('later',['Same']));f.read();const q=f.store.snapshot().incomingQuestions;assert.equal(q.pending.length,1);assert.equal(q.history.length,1);assert.equal(q.history[0].status,'replied');
});

test('freeform questions are captured and oversized or malformed payloads fail closed', t=>{
  const f=fixture(t);
  const native=(id,questions)=>({type:'response_item',payload:{type:'function_call',name:'request_user_input_async',call_id:id,arguments:JSON.stringify({questions})}});
  f.add(native('free',[{title:'Free form'}]));f.add(native('many',Array.from({length:21},(_,i)=>({title:`Q${i}`}))));f.add(native('options',[{title:'Bad',options:Array(21).fill('x')}]));f.add(native('malformed',[{title:'Bad',options:'yes'}]));f.add(native('large',[{title:'Q',ignored:'x'.repeat(66000)}]));f.read();
  let q=f.store.snapshot().incomingQuestions;assert.equal(q.pending.length,1);assert.equal(q.pending[0].text,'Free form');assert.equal(q.pending[0].options,undefined);
  f.add(reply(Array.from({length:21},()=>({questionItemId:tuple('free',0),answer:'Yes'}))));f.read();q=f.store.snapshot().incomingQuestions;assert.equal(q.history.length,0);
  assert.ok(f.store.snapshot().coverage.limits.some(value=>value.includes('64 KiB')));
});

test('project switch never reattributes recorded questions in a shared session', t=>{
  const f=fixture(t);f.add(call('a',['Original']));f.read();
  f.store.setProject({...f.store.snapshot().project,id:'other'});assert.equal(f.store.snapshot().incomingQuestions.pending.length,0);
  f.add(call('b',['New']));f.read();const q=f.store.snapshot().incomingQuestions;assert.deepEqual(q.pending.map(item=>item.text),['New']);assert.equal(q.pending[0].projectId,'other');
  f.store.append({id:'unstamped',sessionId:'s1',kind:'question_recorded',data:{question:{id:'unsafe',text:'Unstamped',origin:'recorded'}}});assert.deepEqual(f.store.snapshot().incomingQuestions.pending.map(item=>item.text),['New']);
});

test('terminal status normalization, explicit clearing and source-linked manual resolutions', t=>{
  const f=fixture(t);f.store.setProject({...f.store.snapshot().project,items:[{id:'closed',title:'Closed',status:' verified-complete ',requiresUserDecision:true},{id:'wrong-project',title:'Foreign',status:'waiting',requiresUserDecision:true,projectId:'other'}]});
  f.store.append({id:'flag',sessionId:'s1',kind:'item_updated',data:{item:{id:'clear',title:'Clear',status:'waiting',requiresUserDecision:true}}});
  f.store.append({id:'cleared',sessionId:'s1',kind:'item_updated',data:{item:{id:'clear',requiresUserDecision:false}}});
  f.store.append({id:'human',sessionId:'s1',kind:'message.user',provenance:'user',text:'The answer is yes.'});f.store.append({id:'assistant',sessionId:'s1',kind:'message.assistant',provenance:'agent_report',text:'The answer is yes.'});
  let s=f.store.snapshot();assert.equal(s.incomingQuestions.pending.length,0);assert.equal(s.incomingQuestions.history.length,2);
  assert.throws(()=>validateQuestionInput({id:'x',text:'Question',sourceIds:['human'],projectId:'other'},s));
  const question=validateQuestionInput({id:'x',text:'Question',sourceIds:['human']},s);f.store.append({id:'q2',projectId:'project',sessionId:'s1',kind:'question_recorded',data:{question}});s=f.store.snapshot();const id=s.incomingQuestions.pending[0].id;
  assert.throws(()=>validateQuestionInput({id,status:'resolved',sourceIds:['human']},s,true));
  assert.throws(()=>validateQuestionInput({id,status:'replied',answer:'yes',sourceIds:['assistant']},s,true));
  assert.throws(()=>validateQuestionInput({id,status:'replied',answer:'missing',sourceIds:['human']},s,true));
  const resolution=validateQuestionInput({id,status:'replied',answer:'yes',sourceIds:['human']},s,true);f.store.append({id:'r2',projectId:'project',sessionId:'s1',kind:'question_resolved',provenance:'agent_report',data:{resolution}});
  const result=f.store.snapshot().incomingQuestions.history.find(q=>q.id===id);assert.equal(result.status,'replied');assert.equal(result.resolutionProvenance,'agent_report');
});

test('clearing base and patch flags preserves scoped history; foreign flags do not', t=>{
  const f=fixture(t);f.store.setProject({...f.store.snapshot().project,items:[{id:'base',title:'Base',status:'waiting',requiresUserDecision:true},{id:'foreign',title:'Foreign',status:'waiting',requiresUserDecision:false}]});
  f.store.append({id:'patch',sessionId:'s1',kind:'project_patch',data:{patch:{items:[{id:'base',title:'Base',status:'waiting',requiresUserDecision:false},{id:'patch-item',title:'Patch',status:'waiting',requiresUserDecision:true},{id:'foreign',title:'Foreign',status:'waiting',requiresUserDecision:false}]}}});
  f.store.append({id:'foreign-flag',sessionId:'s2',kind:'item_updated',data:{item:{id:'foreign',requiresUserDecision:true}}});
  f.store.append({id:'clear-base',sessionId:'s1',kind:'item_updated',data:{item:{id:'base',requiresUserDecision:false}}});
  f.store.append({id:'clear-patch',sessionId:'s1',kind:'item_updated',data:{item:{id:'patch-item',requiresUserDecision:false}}});
  const q=f.store.snapshot().incomingQuestions;assert.equal(q.pending.length,0);assert.deepEqual(q.history.map(item=>item.text),['Base','Patch']);assert.ok(q.history.find(item=>item.text==='Patch').sourceIds.includes('patch'));
});

test('maximum declaration id can be resolved through its longer canonical id', t=>{
  const f=fixture(t);f.store.append({id:'source',sessionId:'s1',kind:'message.user',provenance:'user',text:'Yes'});
  const question=validateQuestionInput({id:'x'.repeat(500),text:'Question',sourceIds:['source']},f.store.snapshot());
  f.store.append({id:'long-q',projectId:'project',sessionId:'s1',kind:'question_recorded',data:{question}});const s=f.store.snapshot();const id=s.incomingQuestions.pending[0].id;assert.ok(id.length>500);
  assert.equal(validateQuestionInput({id,status:'resolved',reason:'Addressed',sourceIds:['source']},s,true).questionId,id);
});
