import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
export const MARKER = '.flux-harness-lab';
export function assertLab(path) {
  const dir=realpathSync(resolve(path)), tmp=realpathSync('/private/tmp');
  if (!relative(tmp,dir) || relative(tmp,dir).startsWith('..') || !existsSync(join(dir,MARKER))) throw new Error('Workspace must be a marked harness directory beneath the system temporary directory.');
  return dir;
}
export function initializeLab(dir) {
  dir=resolve(dir); const tmp=realpathSync('/private/tmp');
  const parent=realpathSync(resolve(dir,'..'));
  if (!relative(tmp,parent) && parent!==tmp || relative(tmp,parent).startsWith('..')) throw new Error('Output must be beneath the system temporary directory.');
  if (existsSync(dir)) throw new Error('Output directory already exists; choose a new path.');
  mkdirSync(dir,{recursive:false}); writeFileSync(join(dir,MARKER),'Flux synthetic lab v1\n',{flag:'wx'}); return dir;
}
export function seed(store, dir) {
  store.setProject({id:'synthetic',title:'Synthetic Flux lab',goal:'Build and review a small interface',directory:dir,sessionId:'synthetic-chat',sessions:[{id:'synthetic-chat',title:'Synthetic chat'}],items:[],plans:[],decisions:[],constraints:[]});
  const append=(id,kind,provenance,data={})=>store.append({id,kind,provenance,sessionId:'synthetic-chat',at:'2026-01-01T00:00:00.000Z',...data});
  append('instruction','message.user','user',{text:'Build the interface; keep both themes.'});
  append('focus','project_patch','agent_report',{data:{patch:{focus:{title:'Review the interface',status:'in_progress',sessionId:'synthetic-chat',intentSourceId:'instruction',sourceIds:['instruction'],why:{text:'Make progress inspectable'},next:{text:'Check queue behavior',status:'planned'}}}}});
  append('plan','plan_saved','agent_report',{data:{plan:{id:'plan-a',title:'Interface plan',steps:[{id:'render',title:'Render interface',status:'completed'},{id:'queue',title:'Check queue behavior',status:'in_progress'}]}}});
  append('check','verification','observed',{data:{details:'Rendering passed at 390px. Queue dispatch was NOT exercised.'}});
  for(const [id,title,purpose] of [['a','Review workflow','Improve review controls'],['b','Theme controls','Keep both themes']]) append('item-'+id,'item_updated','agent_report',{data:{item:{id,title,purpose,status:'ready_for_review',sessionId:'synthetic-chat',parentId:'pilot',returnCondition:'A user reviews the result',sourceIds:['check']}}});
  return append;
}
