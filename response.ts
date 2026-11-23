import type { HttpResponseInit } from '@azure/functions';
export const json=(status:number,body:unknown):HttpResponseInit=>({status,jsonBody:body,headers:{'cache-control':'no-store'}});
export function errorResponse(e:unknown):HttpResponseInit {const status=typeof e==='object'&&e&&'status'in e?Number((e as {status:number}).status):500; return json(status,status===500?{error:'Internal server error'}:{error:(e as Error).message});}
export class HttpError extends Error {constructor(public status:number,message:string,public code?:string){super(message);}}
