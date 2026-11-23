import { Prisma } from '@prisma/client'; import { prisma } from '../db/prisma.js'; import { evaluatePolicy } from '../domain/policy-engine.js'; import { billSnapshotHash,hashToken,newApprovalToken,newIdempotencyKey } from '../domain/snapshot.js'; import { HttpError } from '../http/response.js'; import { audit } from './audit.js';
export async function evaluateBill(userId:string,billId:string){
 const bill=await prisma.bill.findFirst({where:{id:billId,userId}}) as any; if(!bill) throw new HttpError(404,'Bill not found');
 const policy=await prisma.paymentPolicy.findFirst({where:{userId,active:true,OR:[{merchantFingerprint:bill.merchantFingerprint},{merchantName:{equals:bill.merchantName,mode:'insensitive'}}]},orderBy:{updatedAt:'desc'}}) as any;
 const bank=policy?.allowedBankConnectionId?await prisma.bankConnection.findFirst({where:{id:policy.allowedBankConnectionId,userId}}):null;
 const prior=await prisma.approval.count({where:{userId,merchantName:bill.merchantName,status:'CONSUMED'}});
 const result=evaluatePolicy({bill,policy,bank,isFirstPayment:prior===0}); const hash=billSnapshotHash(bill);
 return prisma.$transaction(async tx=>{
  const decision=await tx.paymentDecision.create({data:{userId,billId,policyId:policy?.id,decision:result.decision,riskLevel:result.riskLevel,reasons:result.reasons,amountCents:bill.amountCents,currency:bill.currency,merchantName:bill.merchantName,accountLast4:bill.accountLast4,bankConnectionId:bank?.id,policySnapshot:policy?{id:policy.id,name:policy.name,mode:policy.mode,version:policy.version,maximumAmountCents:policy.maximumAmountCents,currency:policy.currency}:undefined,billSnapshotHash:hash}});
  let approval=null; let approvalToken:string|undefined;
  if(result.decision==='APPROVAL_REQUIRED'){
   approvalToken=newApprovalToken(); const ttl=Number(process.env.APPROVAL_TTL_MINUTES??30);
   approval=await tx.approval.create({data:{userId,billId,paymentDecisionId:decision.id,approvalTokenHash:hashToken(approvalToken),billSnapshotHash:hash,amountCents:bill.amountCents,currency:bill.currency,merchantName:bill.merchantName,accountLast4:bill.accountLast4,bankConnectionId:bank?.id,idempotencyKey:newIdempotencyKey(),expiresAt:new Date(Date.now()+ttl*60000)}});
   await audit(tx,{userId,action:'APPROVAL_CREATED',resource:approval.id,metadata:{billId,decisionId:decision.id}});
  }
  await audit(tx,{userId,action:'PAYMENT_POLICY_EVALUATED',resource:billId,metadata:{decision:result.decision,riskLevel:result.riskLevel}});
  return {decision,approval:approval?{...approval,approvalTokenHash:undefined,idempotencyKey:undefined}:null,approvalToken};
 },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}
export async function approve(userId:string,id:string){
 return prisma.$transaction(async tx=>{
  const a=await tx.approval.findFirst({where:{id,userId},include:{decision:true}}) as any; if(!a) throw new HttpError(404,'Approval not found');
  if(a.status==='APPROVED') return sanitize(a); if(a.status!=='PENDING') throw new HttpError(409,'Unsupported approval state','INVALID_STATE');
  if(a.expiresAt<=new Date()){await tx.approval.update({where:{id},data:{status:'EXPIRED'}}); throw new HttpError(409,'Approval expired','APPROVAL_EXPIRED');}
  const bill=await tx.bill.findFirst({where:{id:a.billId,userId}}) as any; if(!bill) throw new HttpError(404,'Bill not found');
  if(billSnapshotHash(bill)!==a.billSnapshotHash){await tx.approval.update({where:{id},data:{status:'CANCELLED',cancelledAt:new Date()}}); await audit(tx,{userId,action:'APPROVAL_INVALIDATED_BILL_CHANGED',resource:id}); throw new HttpError(409,'Bill changed; evaluate again','BILL_CHANGED');}
  if(a.bankConnectionId){const bank=await tx.bankConnection.findFirst({where:{id:a.bankConnectionId,userId,status:'ACTIVE'}}); if(!bank) throw new HttpError(409,'Bank connection inactive','BANK_CONNECTION_INACTIVE');}
  const changed=await tx.approval.updateMany({where:{id,userId,status:'PENDING'},data:{status:'APPROVED',approvedAt:new Date()}}); if(changed.count!==1) throw new HttpError(409,'Approval state changed');
  await audit(tx,{userId,action:'APPROVAL_APPROVED',resource:id,metadata:{billId:a.billId,decisionId:a.paymentDecisionId}});
  return sanitize(await tx.approval.findUniqueOrThrow({where:{id}}));
 },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}
export async function setApprovalState(userId:string,id:string,target:'REJECTED'|'CANCELLED'){
 return prisma.$transaction(async tx=>{const data=target==='REJECTED'?{status:target as any,rejectedAt:new Date()}:{status:target as any,cancelledAt:new Date()}; const r=await tx.approval.updateMany({where:{id,userId,status:'PENDING'},data}); if(r.count!==1) throw new HttpError(404,'Pending approval not found'); await audit(tx,{userId,action:`APPROVAL_${target}`,resource:id}); return sanitize(await tx.approval.findUniqueOrThrow({where:{id}}));});
}
function sanitize(a:any){const {approvalTokenHash,idempotencyKey,...safe}=a; return safe;}
