import {realpath,stat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,resolve,relative,sep,basename} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {markdownLinks,classifyLink,linkKey} from './markdown.mjs';

const execute=promisify(execFile);
const MAX_IMAGE=12*1024*1024;
export class ContentLinkError extends Error {constructor(message,statusCode=400){super(message);this.statusCode=statusCode;}}
const inScope=(value,sessionId)=>!value?.sessionId||value.sessionId===sessionId;
const within=(file,root)=>{const part=relative(root,file);return part===''||part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);};
const strings=value=>Object.values(value??{}).filter(v=>typeof v==='string');
function sourceContent(snapshot,sourceId){
  if(typeof sourceId!=='string'||sourceId.length>512)throw new ContentLinkError('Choose a recorded source.',400);
  const event=snapshot.events.find(e=>e.id===sourceId&&inScope(e,snapshot.project.sessionId));
  if(event){
    const parts=[event.text,event.summary];
    if(event.kind==='verification')parts.push(event.data?.details);
    if(event.kind==='item_updated')parts.push(...strings(event.data?.item));
    if(event.kind==='decision_recorded')parts.push(...strings(event.data?.decision));
    return {parts:parts.filter(p=>typeof p==='string'),direct:[event.source?.ref,...(event.source?.type==='local_artifact'?[event.data?.path]:[])].filter(p=>typeof p==='string')};
  }
  const item=snapshot.project.items?.find(i=>i.id===sourceId&&inScope(i,snapshot.project.sessionId));
  if(item)return {parts:[item.title,item.purpose,item.returnCondition].filter(p=>typeof p==='string'),direct:[]};
  throw new ContentLinkError('The source is not in the enrolled chat.',404);
}
function declaredLink(snapshot,sourceId,href){
  const source=sourceContent(snapshot,sourceId),key=linkKey(href);
  const links=source.parts.flatMap(body=>markdownLinks(body));
  const direct=source.direct.some(value=>linkKey(value)===key);
  if(!direct&&!links.some(link=>linkKey(link.href)===key))throw new ContentLinkError('This file is not referenced by the selected source.',403);
  const parsed=classifyLink(href);
  if(parsed.kind!=='local')throw new ContentLinkError('Only recorded local files use this endpoint.');
  return parsed;
}
async function resolveFile(snapshot,sourceId,href){
  const link=declaredLink(snapshot,sourceId,href);
  const projectRoot=resolve(snapshot.project.directory??snapshot.project.repoDir??process.cwd());
  const candidate=link.path.startsWith('~/')?resolve(homedir(),link.path.slice(2)):resolve(projectRoot,link.path);
  // Known artifacts outside the project are exact-file grants, not folder grants.
  const registered=snapshot.events.some(e=>inScope(e,snapshot.project.sessionId)&&e.source?.type==='local_artifact'&&e.data?.path===candidate&&e.source?.ref===candidate);
  if(!within(candidate,projectRoot)&&!registered)throw new ContentLinkError('This file is outside the project and registered artifacts.',403);
  let file,root;
  try{[file,root]=await Promise.all([realpath(candidate),realpath(projectRoot)]);}catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))throw new ContentLinkError('The linked file is no longer available.',404);throw error;}
  // An external registered artifact cannot grant access through a symlink.
  if(!within(file,root)&&(!registered||file!==candidate))throw new ContentLinkError('The file resolves outside its allowed location.',403);
  const info=await stat(file);
  if(!info.isFile()&&!info.isDirectory())throw new ContentLinkError('This file type cannot be opened here.',415);
  return {link,file,info};
}
function imageType(bytes){
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii')))return 'image/gif';
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
  if(bytes.subarray(4,8).toString()==='ftyp'&&['avif','avis'].includes(bytes.subarray(8,12).toString()))return 'image/avif';
  return null;
}
async function raster(file,metadataOnly=false){
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const info=await handle.stat();
    if(!info.isFile()||info.size>MAX_IMAGE)throw new ContentLinkError('Image previews are limited to 12 MB.',413);
    const signature=Buffer.alloc(16);await handle.read(signature,0,16,0);
    const type=imageType(signature);if(!type)throw new ContentLinkError('This format is available as a file link, not an inline image.',415);
    if(metadataOnly)return {type,size:info.size};
    const bytes=Buffer.alloc(info.size);let read=0;
    while(read<bytes.length){const result=await handle.read(bytes,read,bytes.length-read,read);if(!result.bytesRead)break;read+=result.bytesRead;}
    return {bytes:bytes.subarray(0,read),type};
  }finally{await handle.close();}
}
export async function inspectContentLink(snapshot,{sourceId,href},{platform=process.platform}={}){
  const parsed=classifyLink(href);
  // Validation happens even for unavailable files; metadata is source-scoped.
  declaredLink(snapshot,sourceId,href);
  try{
    const {file,info}=await resolveFile(snapshot,sourceId,href);
    let preview=false,previewReason;
    if(info.isFile())try{await raster(file,true);preview=true;}catch(error){if(error instanceof ContentLinkError)previewReason=error.message;else throw error;}
    const query=new URLSearchParams({sourceId,href});
    return {kind:'local',name:basename(file),path:file,exists:true,directory:info.isDirectory(),size:info.size,canReveal:platform==='darwin',previewUrl:preview?'/api/content-image?'+query.toString():null,previewReason};
  }catch(error){
    if(error instanceof ContentLinkError)return {kind:'local',name:parsed.kind==='local'?parsed.name:'File',path:parsed.kind==='local'?parsed.path:href,exists:false,canReveal:false,previewUrl:null,reason:error.message};
    throw error;
  }
}
export async function readContentImage(snapshot,{sourceId,href}){const {file}=await resolveFile(snapshot,sourceId,href);return raster(file);}
export async function revealContentLink(snapshot,{sourceId,href},{platform=process.platform,reveal=path=>execute('/usr/bin/open',['-R',path],{timeout:10000})}={}){
  if(platform!=='darwin')throw new ContentLinkError('Reveal in Finder is available on macOS. Copy the path on this device.',501);
  const {file}=await resolveFile(snapshot,sourceId,href);await reveal(file);return {revealed:true};
}
