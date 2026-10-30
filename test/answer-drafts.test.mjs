import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const { outputFiles } = await build({ entryPoints:[fileURLToPath(new URL('../ui/src/lib/answer-drafts.ts',import.meta.url))],bundle:true,write:false,format:'esm',target:'es2022',platform:'node' })
const d = await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'))
const scope={projectId:'project',sessionId:'chat'}
const question=(id,text=`Question ${id}`,options=[])=>({id,text,options,status:'pending'})

test('four independent drafts preserve exact text across reload and project/chat scope',()=>{
  let state=d.emptyAnswers(scope);const questions=[1,2,3,4].map(i=>question(String(i)))
  questions.forEach((q,i)=>{state=d.editAnswer(state,q,`  Answer ${i}\n\n`)})
  assert.equal(d.partitionAnswers(state,questions).ready.length,4)
  assert.deepEqual(d.restoreAnswers(JSON.stringify(state),scope),state)
  assert.deepEqual(d.restoreAnswers(JSON.stringify(state),{...scope,sessionId:'other'}).drafts,[])
  const writes=[];const storage={setItem:(...args)=>writes.push(args)}
  assert.equal(d.saveAnswers(storage,state,{...scope,projectId:'other'}),false);assert.equal(writes.length,0)
  d.saveAnswers(storage,state,scope);assert.equal(writes[0][0],d.answerStorageKey(scope))
  assert.throws(()=>d.saveAnswers({setItem(){throw Error('denied')}},state,scope));assert.equal(state.drafts[0].answer,'  Answer 0\n\n')
})

test('changed, closed and missing questions recover without entering batch',()=>{
  let state=d.emptyAnswers(scope);const a=question('a','Original',['Yes']),b=question('b'),c=question('c'),empty=question('empty')
  for(const q of [a,b,c])state=d.editAnswer(state,q,'answer')
  state=d.editAnswer(state,empty,'  \n')
  const pending=[question('a','Changed',['Yes']),empty];let parts=d.partitionAnswers(state,pending)
  assert.equal(parts.ready.length,0);assert.deepEqual(parts.recovery.map(x=>x.questionId),['a','b','c'])
  state=d.editAnswer(state,pending[0],'new answer');parts=d.partitionAnswers(state,pending)
  assert.equal(parts.ready.length,1);assert.equal(parts.ready[0].answer,'new answer');assert.equal(parts.recovery.find(x=>x.questionId==='a').questionText,'Original')
  assert.equal(d.partitionAnswers(state,[question('a','Original',['No'])]).ready.length,0)
})

test('copy format includes exact authored text and selected questions only',()=>{
  let state=d.emptyAnswers(scope);const qs=[question('a'),question('b'),question('c')]
  state=d.editAnswer(state,qs[0],'  yes\n\n');state=d.editAnswer(state,qs[1],'\nno ');state=d.editAnswer(state,qs[2],' ')
  const ready=d.partitionAnswers(state,qs).ready;assert.equal(ready.length,2)
  assert.equal(d.formatAnswers(ready),'Question: Question a\nFlux question ID: a\nYour answer:\n  yes\n\n\n\n---\n\nQuestion: Question b\nFlux question ID: b\nYour answer:\n\nno ')
  assert.doesNotMatch(d.formatAnswers(ready),/send_user_message_question_reply|Question c/)
})

test('clipboard failures and delayed copies do not discard drafts or attribute results to another scope',async()=>{
  const state=d.editAnswer(d.emptyAnswers(scope),question('a'),'original')
  assert.equal(await d.copyAnswers({writeText:async()=>{throw Error('denied')}},state.drafts,()=> 'same'),'failed')
  assert.equal(state.drafts[0].answer,'original')
  let done;const clipboard={writeText:()=>new Promise(resolve=>{done=resolve})};let ownership='same'
  const pending=d.copyAnswers(clipboard,state.drafts,()=>ownership);ownership='changed';done();assert.equal(await pending,'changed')
  const pending2=d.copyAnswers(clipboard,state.drafts,()=>ownership);ownership='scope_changed';done();assert.equal(await pending2,'scope_changed')
})

test('discard removes only the explicitly selected snapshot without changing other drafts',()=>{
  let state=d.emptyAnswers(scope);const original=question('a','Original'),changed=question('a','Changed'),other=question('b')
  state=d.editAnswer(state,original,'old');state=d.editAnswer(state,changed,'new');state=d.editAnswer(state,other,'other')
  const next=d.discardAnswer(state,d.draftFingerprint(state.drafts[0]))
  assert.deepEqual(next.drafts.map(item=>item.answer),['new','other']);assert.equal(state.drafts.length,3)
  assert.deepEqual(d.restoreAnswers(JSON.stringify(next),scope),next)
})
