import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { initializeLab, seed } from './fixtures.mjs';
const arg=flag=>{const i=process.argv.indexOf(flag);return i<0?undefined:process.argv[i+1]};
if(!arg('--baseline')||!arg('--out'))throw Error('Usage: node scripts/harness/repair-check.mjs --baseline /path/to/frozen/baseline --out /private/tmp/new-lab');
const out=initializeLab(arg('--out')),baseline=resolve(arg('--baseline')),current=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
async function lane(root,name){const imp=p=>import(pathToFileURL(join(root,'src',p)));const {createStore}=await imp('store.mjs'),{runDiagnostic}=await imp('diagnostics.mjs'),{reviewFeedback,reviewGroupId}=await imp('review-feedback.mjs');const dir=join(out,name);mkdirSync(dir);const store=createStore(join(dir,'.flux'));seed(store,dir);return {store,runDiagnostic,reviewFeedback,reviewGroupId};}
const before=await lane(baseline,'baseline'),after=await lane(current,'current');
async function direct(l){let calls=0,code=null;try{await l.runDiagnostic(l.store,{question:'What remains?',recordIds:[],expectedRevision:l.store.snapshot().contextRevision,dispatch:true},{queueCommand:async()=>{calls++}})}catch(e){code=e.statusCode??null}return {calls,code};}
async function feedback(l,isCurrent){const itemIds=['a','b'],input={groupId:l.reviewGroupId(itemIds),itemIds,note:'Improve the review workflow.',recordIds:[],expectedRevision:l.store.snapshot().contextRevision,...(isCurrent?{intent:'request_changes',affectedItemIds:['a']}:{})};const draft=await l.reviewFeedback(l.store,input);await l.reviewFeedback(l.store,{...input,requestId:draft.id,dispatch:true},{queueCommand:async()=>{}});return Object.fromEntries(l.store.snapshot().project.items.map(i=>[i.id,i.status]));}
const results=[];async function run(id,fn){try{results.push({id,...await fn()})}catch(e){results.push({id,status:'failed',error:e.stack||String(e)})}}
await run('preview-gate',async()=>{const old=await direct(before),now=await direct(after);return {status:old.calls===1&&now.calls===0&&now.code===400?'passed':'failed',baseline:old,current:now}});
await run('affected-subset',async()=>{const old=await feedback(before,false),now=await feedback(after,true);return {status:old.a==='in_progress'&&old.b==='in_progress'&&now.a==='in_progress'&&now.b==='ready_for_review'?'passed':'failed',baseline:old,current:now}});
writeFileSync(join(out,'repair-check.json'),JSON.stringify({version:1,baseline,current,results,limitations:['Isolated queue spies only; no model calls or native delivery.']},null,2));console.log(JSON.stringify({out,results},null,2));if(results.some(r=>r.status==='failed'))process.exitCode=1;
