import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertLab } from './fixtures.mjs';
const get=flag=>{const i=process.argv.indexOf(flag);return i<0?undefined:process.argv[i+1]};
const workspace=assertLab(get('--workspace')||''),op=get('--op');
if(!['passive','semantic','new-checkpoint','result','reopen','queue-fail','legacy-feedback','remove-check','confirm-receipt','queue-accept','confirm-feedback-receipt'].includes(op))throw Error('Unknown operation.');
const meta=JSON.parse(readFileSync(join(workspace,'lab.json')));if(meta.workspace!==workspace||meta.dataDir!==join(workspace,'lab-project','.flux')||meta.baseline!==join(workspace,'baseline'))throw Error('Invalid lab metadata.');
const {createStore}=await import(pathToFileURL(join(meta.baseline,'src/store.mjs'))),store=createStore(meta.dataDir),sessionId='synthetic-chat';
const append=(kind,data)=>store.append({kind,sessionId,at:new Date().toISOString(),...data});
let result;
if(op==='confirm-feedback-receipt'){const id=get('--request-id'),request=store.snapshot().reviewFeedback.find(r=>r.id===id);if(!request||request.sessionId!==sessionId||request.status!=='failed')throw Error('An existing failed synthetic feedback request ID is required.');result=append('review_feedback_status',{provenance:'observed',source:{type:'flux_review',ref:request.groupId},data:{id,status:'queued',userInstruction:request.note},summary:'Synthetic late queue receipt'});}
if(op==='confirm-receipt'){const id=get('--request-id'),request=store.snapshot().requests.find(r=>r.id===id);if(!request||request.sessionId!==sessionId||request.status!=='failed')throw Error('An existing failed synthetic diagnostic request ID is required.');result=append('diagnostic_status',{provenance:'observed',source:{type:'flux',ref:id},data:{requestId:id,status:'queued'},summary:'Synthetic late queue receipt'});}
if(op==='remove-check'){const file=join(meta.dataDir,'events.jsonl'),raw=readFileSync(file,'utf8');const rows=raw.split('\n').filter(Boolean).map(line=>JSON.parse(line));if(rows.filter(event=>event.id==='check').length!==1)throw Error('Synthetic check record not found uniquely.');writeFileSync(join(workspace,'events-before-remove-check.jsonl'),raw,{flag:'wx'});writeFileSync(file,rows.filter(event=>event.id!=='check').map(event=>JSON.stringify(event)).join('\n')+'\n');result={removed:'check',backup:join(workspace,'events-before-remove-check.jsonl')};}
if(op==='legacy-feedback'){const {reviewGroupId}=await import(pathToFileURL(join(meta.baseline,'src/review-feedback.mjs')));const itemIds=['a','b'],groupId=reviewGroupId(itemIds),feedback={id:'synthetic-legacy-feedback',sessionId,groupId,itemIds,note:'Legacy prepared request.',recordIds:[],contextRevision:store.snapshot().contextRevision,status:'prepared',prompt:'Synthetic legacy preview.'};result=append('review_feedback_request',{provenance:'user',source:{type:'flux_review',ref:groupId},data:{feedback}});}
if(op==='queue-accept'){writeFileSync(meta.queueState,JSON.stringify({mode:'accepted'}));result={mode:'accepted'};}
if(op==='queue-fail'){writeFileSync(meta.queueState,JSON.stringify({mode:'fail'}));result={mode:'fail'};}
if(op==='passive')result=append('verification',{provenance:'observed',text:'Synthetic passive check arrived.'});
if(op==='semantic')result=append('message.user',{provenance:'user',text:'Pause styling and inspect context quality first.'});
if(op==='new-checkpoint')result=append('plan_saved',{provenance:'agent_report',data:{plan:{id:'lab-checkpoint',title:'Synthetic checkpoint',steps:[{id:'inspect',title:'Inspect context quality',status:'in_progress'}]}}});
if(op==='reopen')result=append('item_updated',{provenance:'agent_report',data:{item:{id:'a',title:'Review workflow',status:'ready_for_review',sessionId,purpose:'Improve review controls',returnCondition:'A user reviews the result'}}});
if(op==='result'){const request=store.snapshot().requests.filter(r=>['queued','acknowledged'].includes(r.status)).at(-1);if(!request)throw Error('No queued diagnostic request in this lab.');result=append('diagnostic_result',{provenance:'agent_report',data:{requestId:request.id,result:'Now: the interface is under review. Evidence: the recorded rendering check did not exercise queue dispatch. Next: check the queue behavior.'}});}
console.log(JSON.stringify(result,null,2));
