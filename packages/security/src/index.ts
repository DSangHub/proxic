import type {ProxyType} from '@proxic/types';
export function riskFor(proxy:ProxyType,message:string):0|1|2|3|4 { const text=message.toLowerCase(); if(/pay|purchase|transfer|bank|card/.test(text)) return 4; if(proxy==='appointment' && /cancel|book|schedule|reschedule/.test(text)) return 3; if(proxy==='task') return 1; return 2; }
export function approvalRequired(risk:number){return risk>=3;}
