import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {classifyLink,markdownLinks,markdownText} from '../src/markdown.mjs';
import {inspectContentLink,readContentImage,revealContentLink} from '../src/content-links.mjs';
import {createStore} from '../src/store.mjs';
import {buildDiagnostic} from '../src/diagnostics.mjs';
import {startServer} from '../src/server.mjs';

let Reader,renderDirectory;
before(async()=>{
  fs.mkdirSync(new URL('../.flux/qa/',import.meta.url),{recursive:true});
  renderDirectory=fs.mkdtempSync(new URL('../.flux/qa/markdown-render-',import.meta.url).pathname);
  const output=join(renderDirectory,'reader.mjs');
  await build({entryPoints:[new URL('../ui/src/components/ReadableMessage.tsx',import.meta.url).pathname],outfile:output,bundle:true,format:'esm',platform:'node',packages:'external',jsx:'automatic',logLevel:'silent'});
  Reader=(await import(pathToFileURL(output).href)).default;
});
after(()=>{if(renderDirectory)fs.rmSync(renderDirectory,{recursive:true,force:true});});
const render=text=>renderToStaticMarkup(React.createElement(Reader,{text,sourceId:'message',csrfToken:'test-token'}));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=','base64');
function fixture(t){
  const directory=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'flux-markdown-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const project=join(directory,'project');fs.mkdirSync(project);const image=join(project,'preview.png');fs.writeFileSync(image,png);
  const note=join(project,'notes.md');fs.writeFileSync(note,'# Notes');
  const store=createStore(join(directory,'store'));store.setProject({id:'p',directory:project,goal:'Keep original evidence',sessionId:'chat',sessions:[{id:'chat'}],items:[],plans:[],decisions:[]});
  const body='## Update\n\n- **Explicit boundaries:** Read only.\n\n![Preview]('+image+')\n\n[Notes](<'+note+':12>)';
  store.append({id:'message',kind:'message.assistant',provenance:'agent_report',sessionId:'chat',text:body});
  return {directory,project,image,note,body,store};
}

test('common Markdown renders headings, emphasis, nested lists, quotes and code',()=>{
  const html=render('# Heading\n\n**Bold** and *emphasis* and ~~removed~~.\n\n- One\n  - Nested\n\n1. First\n2. Second\n\n> A quotation\n\nInline `literal()`\n\n~~~js\nconst n = 1;\n~~~\n\n---');
  for(const pattern of [/<h3>Heading<\/h3>/,/<strong>Bold<\/strong>/,/<em>emphasis<\/em>/,/<del>removed<\/del>/,/<ul>/,/<ol>/,/<blockquote>/,/<code>literal\(\)<\/code>/,/language-js/,/Copy code/,/<hr/])assert.match(html,pattern);
  assert.match(html,/Copy original/);assert.match(html,/Source/);
});

test('GFM tables and read-only task lists render as structured content',()=>{
  const html=render('| State | Evidence |\n| --- | --- |\n| Ready | Recorded |\n\n- [x] Built\n- [ ] Reviewed');
  assert.match(html,/role="region" aria-label="Message table"/);assert.match(html,/<table>/);assert.match(html,/<th>State<\/th>/);assert.match(html,/type="checkbox"[^>]*disabled/);assert.match(html,/checked/);
});

test('footnotes are linked with unique scoped IDs across messages',()=>{
  const text='A note[^one].\n\n[^one]: The footnote.';
  const html=renderToStaticMarkup(React.createElement(React.Fragment,null,React.createElement(Reader,{text,sourceId:'one',csrfToken:''}),React.createElement(Reader,{text,sourceId:'two',csrfToken:''})));
  const ids=[...html.matchAll(/ id="([^"]+)"/g)].map(m=>m[1]);assert.equal(ids.length,new Set(ids).size);assert.ok(ids.length>=6);
  for(const [,href]of html.matchAll(/href="#([^"]+)"/g))assert.ok(ids.includes(href));
});

test('HTML is escaped, active schemes are inert, web links are explicit and remote images do not auto-load',()=>{
  const html=render('<script>alert(1)</script>\n\n[Unsafe](javascript:alert(1))\n\n[Docs](https://example.com/docs)\n\n![Remote](https://example.com/track.png)');
  assert.doesNotMatch(html,/<script|href="javascript:|<img[^>]+src="https:/);assert.match(html,/&lt;script&gt;/);assert.match(html,/target="_blank"/);assert.match(html,/rel="noopener noreferrer"/);assert.match(html,/Open image/);
});

test('Markdown reference links resolve, code examples do not grant file access, and previews flatten syntax',()=>{
  const input='[Notes][doc]\n\n![Preview][image]\n\n[doc]: /tmp/a.md\n[image]: /tmp/a.png\n\n~~~md\n[Hidden](/tmp/secret.png)\n~~~';
  assert.deepEqual(markdownLinks(input),[{href:'/tmp/a.md',image:false},{href:'/tmp/a.png',image:true}]);
  assert.equal(markdownText('**Read this** [document](/tmp/a.md) ![preview](/tmp/p.png)'),'Read this document preview');
});

test('link classification supports local line anchors and encoded filenames while rejecting active schemes',()=>{
  assert.equal(classifyLink('/tmp/a%20b%23c.png:12').path,'/tmp/a b#c.png');assert.equal(classifyLink('/tmp/a.md#L9').line,9);
  assert.equal(classifyLink('file:///tmp/a%20b.md').path,'/tmp/a b.md');assert.equal(classifyLink('../docs/readme.md').kind,'local');
  for(const url of ['javascript:alert(1)','data:text/html,<script>','vbscript:x','file://remote/share','javascript%3Aalert(1)','/tmp/a%00.png'])assert.equal(classifyLink(url).kind,'blocked');
  assert.equal(classifyLink('https://example.com').kind,'web');assert.equal(classifyLink('#note').kind,'anchor');
});

test('recorded local images preview and file links resolve line suffixes',async t=>{
  const {store,image,note}=fixture(t);const info=await inspectContentLink(store.snapshot(),{sourceId:'message',href:image});assert.equal(info.exists,true);assert.ok(info.previewUrl.includes('/api/content-image?'));
  const read=await readContentImage(store.snapshot(),{sourceId:'message',href:image});assert.equal(read.type,'image/png');assert.deepEqual(read.bytes,png);
  const doc=await inspectContentLink(store.snapshot(),{sourceId:'message',href:note+':12'},{platform:'darwin'});assert.equal(doc.path,note);assert.equal(doc.canReveal,true);assert.equal(doc.previewUrl,null);
});

test('unreferenced paths and foreign sources cannot be inspected or revealed',async t=>{
  const {store,image,project}=fixture(t);store.append({id:'foreign',kind:'message.assistant',sessionId:'other',text:'![Image]('+image+')'});
  await assert.rejects(inspectContentLink(store.snapshot(),{sourceId:'foreign',href:image}),e=>e.statusCode===404);
  await assert.rejects(readContentImage(store.snapshot(),{sourceId:'message',href:join(project,'unlinked.png')}),e=>e.statusCode===403);
  await assert.rejects(revealContentLink(store.snapshot(),{sourceId:'message',href:join(project,'unlinked.png')},{platform:'darwin',reveal:async()=>assert.fail('No native action')}),e=>e.statusCode===403);
});

test('path traversal and symlinks cannot escape the project',async t=>{
  const {directory,project,store}=fixture(t);const outside=join(directory,'outside.png');fs.writeFileSync(outside,png);const symlink=join(project,'escape.png');fs.symlinkSync(outside,symlink);
  store.append({id:'escape',kind:'message.assistant',sessionId:'chat',text:'![Outside](../outside.png)\n\n![Symlink]('+symlink+')'});
  for(const href of ['../outside.png',symlink])await assert.rejects(readContentImage(store.snapshot(),{sourceId:'escape',href}),e=>e.statusCode===403);
});

test('registered artifacts outside the project grant exactly that file',async t=>{
  const {directory,store}=fixture(t);const artifact=join(directory,'registered.png'),other=join(directory,'other.png');fs.writeFileSync(artifact,png);fs.writeFileSync(other,png);
  store.append({id:'artifact',kind:'artifact_created',sessionId:'chat',source:{type:'local_artifact',ref:artifact},data:{path:artifact}});
  store.append({id:'links',kind:'message.assistant',sessionId:'chat',text:'![Artifact]('+artifact+')\n\n![Other]('+other+')'});
  assert.equal((await readContentImage(store.snapshot(),{sourceId:'links',href:artifact})).type,'image/png');await assert.rejects(readContentImage(store.snapshot(),{sourceId:'links',href:other}),e=>e.statusCode===403);
});

test('missing, oversized and non-raster content falls back without active HTML or SVG delivery',async t=>{
  const {project,store}=fixture(t);const fake=join(project,'disguised.png'),large=join(project,'large.png');fs.writeFileSync(fake,'<svg onload="alert(1)"></svg>');fs.writeFileSync(large,Buffer.concat([png,Buffer.alloc(12*1024*1024)]));
  store.append({id:'files',kind:'message.assistant',sessionId:'chat',text:'![Fake]('+fake+')\n\n![Large]('+large+')\n\n![Gone](gone.png)'});
  await assert.rejects(readContentImage(store.snapshot(),{sourceId:'files',href:fake}),e=>e.statusCode===415);await assert.rejects(readContentImage(store.snapshot(),{sourceId:'files',href:large}),e=>e.statusCode===413);
  const gone=await inspectContentLink(store.snapshot(),{sourceId:'files',href:'gone.png'});assert.equal(gone.exists,false);assert.equal(gone.canReveal,false);
});

test('Finder reveal is explicit and receives only the validated canonical path',async t=>{
  const {store,note}=fixture(t);let revealed;
  await revealContentLink(store.snapshot(),{sourceId:'message',href:note+':12'},{platform:'darwin',reveal:async path=>{revealed=path}});assert.equal(revealed,note);
  await assert.rejects(revealContentLink(store.snapshot(),{sourceId:'message',href:note+':12'},{platform:'linux'}),e=>e.statusCode===501);
});

test('rendering and attachment inspection do not rewrite stored evidence or model prompts',async t=>{
  const {store,body,image}=fixture(t),before=store.snapshot();const input={question:'What does this selected message report?',recordIds:['message'],expectedRevision:before.contextRevision};
  const promptBefore=buildDiagnostic(before,input,{id:'immutable'}).prompt;render(body);await inspectContentLink(before,{sourceId:'message',href:image});
  const after=store.snapshot();assert.equal(after.events.find(e=>e.id==='message').text,body);assert.equal(after.contextRevision,before.contextRevision);assert.equal(buildDiagnostic(after,input,{id:'immutable'}).prompt,promptBefore);assert.match(promptBefore,/\*\*Explicit boundaries:\*\*/);
});

test('image HTTP is same-origin scoped and native reveal requires CSRF',async t=>{
  const {store,directory,image,note}=fixture(t);let reveals=0;
  const app=await startServer({dataDir:join(directory,'store'),store,contentOptions:{platform:'darwin',reveal:async()=>{reveals++}}});t.after(()=>app.close());
  const query=new URLSearchParams({sourceId:'message',href:image});const url=app.address+'/api/content-image?'+query;
  const response=await fetch(url);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');
  assert.equal((await fetch(url,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  const state=await fetch(app.address+'/api/state').then(r=>r.json());const body=JSON.stringify({sourceId:'message',href:note+':12'});
  assert.equal((await fetch(app.address+'/api/content-reveal',{method:'POST',headers:{'Content-Type':'application/json'},body})).status,403);assert.equal(reveals,0);
  assert.equal((await fetch(app.address+'/api/content-reveal',{method:'POST',headers:{'Content-Type':'application/json','X-Flux-CSRF':state.csrfToken},body})).status,200);assert.equal(reveals,1);
});

test('plain Timeline previews preserve word boundaries between blocks and nested list items',()=>{
  assert.equal(markdownText('# Heading\n\nParagraph.\n\n- First\n  - Nested\n- Second'),'Heading Paragraph. First Nested Second');
});
