export type ContentLink = { kind:'blocked';href:string;reason:string } | {kind:'anchor'|'email';href:string} | {kind:'web';href:string;host:string} | {kind:'local';href:string;path:string;name:string;line?:number};
export function classifyLink(value:unknown):ContentLink;
export function linkKey(value:unknown):string;
export function markdownText(value:unknown):string;
export function markdownLinks(value:unknown):Array<{href:string;image:boolean}>;
