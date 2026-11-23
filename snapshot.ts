import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BillView } from './types.js';
export function billSnapshotHash(b:BillView){return createHash('sha256').update(JSON.stringify({id:b.id,merchantName:b.merchantName,amountCents:b.amountCents,currency:b.currency,dueDate:b.dueDate?.toISOString()??null,accountLast4:b.accountLast4,updatedAt:b.updatedAt.toISOString()})).digest('hex');}
export function newApprovalToken(){return randomBytes(32).toString('base64url');}
export function hashToken(token:string){return createHash('sha256').update(token).digest('hex');}
export function newIdempotencyKey(){return randomUUID();}
