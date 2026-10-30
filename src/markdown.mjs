import {unified} from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import {toString} from 'mdast-util-to-string';

const parser=unified().use(remarkParse).use(remarkGfm);
const sourceText=value=>typeof value==='string'?value:'';
const previewCache=new Map();
export function markdownText(value){
  const input=sourceText(value);
  if(previewCache.has(input))return previewCache.get(input);
  const blocks=new Set(['root','list','listItem','blockquote','table','tableRow','footnoteDefinition']);
  const flatten=node=>blocks.has(node.type)?(node.children??[]).map(flatten).join(' '):toString(node,{includeHtml:false});
  const result=flatten(parser.parse(input)).replace(/\s+/g,' ').trim();
  if(previewCache.size>=128)previewCache.delete(previewCache.keys().next().value);
  previewCache.set(input,result);return result;
}
export function markdownLinks(value){
  const tree=parser.parse(sourceText(value)),definitions=new Map(),links=[];
  function walk(node,callback){callback(node);for(const child of node.children??[])walk(child,callback);}
  walk(tree,node=>{if(node.type==='definition')definitions.set(node.identifier,node.url);});
  walk(tree,node=>{
    if(node.type==='link'||node.type==='image')links.push({href:node.url,image:node.type==='image'});
    if(node.type==='linkReference'||node.type==='imageReference'){
      const href=definitions.get(node.identifier);if(href)links.push({href,image:node.type==='imageReference'});
    }
  });
  return links;
}

/** Shared browser/server URL policy. It never opens or fetches a target. */
export function classifyLink(value){
  const href=sourceText(value).trim();
  const blocked=reason=>({kind:'blocked',href,reason});
  if(!href||href.length>4096||/[\u0000-\u001f\u007f]/.test(href))return blocked('Unsupported link');
  if(href.startsWith('#'))return {kind:'anchor',href};
  if(/^https?:\/\//i.test(href)||href.startsWith('//')){
    try{const url=new URL(href.startsWith('//')?'https:'+href:href);if(url.username||url.password)return blocked('This link contains credentials');return {kind:'web',href:url.href,host:url.host};}catch{return blocked('Invalid web address');}
  }
  if(/^mailto:/i.test(href))return {kind:'email',href};
  let path=href,line;
  if(/^file:/i.test(href)){
    try{const url=new URL(href);if(url.hostname&&url.hostname!=='localhost')return blocked('Network file paths are not supported');path=url.pathname;const match=url.hash.match(/^#L?(\d+)/);if(match)line=Number(match[1]);}catch{return blocked('Invalid file path');}
  }else{
    if(/^[a-z][a-z\d+.-]*:/i.test(href))return blocked('Unsupported link type');
    const fragment=path.indexOf('#');
    if(fragment>=0){const match=path.slice(fragment).match(/^#L?(\d+)/);if(match)line=Number(match[1]);path=path.slice(0,fragment);}
  }
  const suffix=path.match(/:(\d+)(?::\d+)?$/);if(suffix){line=Number(suffix[1]);path=path.slice(0,-suffix[0].length);}
  try{path=decodeURIComponent(path);}catch{return blocked('Invalid file path');}
  if(/[\u0000-\u001f\u007f]/.test(path)||/^[a-z][a-z\d+.-]*:/i.test(path)||path.startsWith('//'))return blocked('Unsupported file path');
  if(!path)return blocked('Empty file path');
  return {kind:'local',href,path,...(line?{line}:{}),name:path.split('/').filter(Boolean).at(-1)||path};
}
export function linkKey(value){const link=classifyLink(value);return link.kind==='local'?link.path:link.href;}
