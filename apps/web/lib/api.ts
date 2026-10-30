import type {ProposedAction} from '@proxic/types';
const API=process.env.NEXT_PUBLIC_API_URL || 'http://localhost:7071/api';
export async function submitProxyRequest(message:string):Promise<ProposedAction>{const r=await fetch(`${API}/proxy`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message})}); if(!r.ok) throw new Error('Proxy API request failed'); return r.json();}
