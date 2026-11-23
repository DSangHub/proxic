import type { BankView,BillView,Decision,PolicyView,ReasonCode } from './types.js';
export interface Evaluation {decision:Decision;riskLevel:0|1|2|3|4;reasons:ReasonCode[];}
export function evaluatePolicy(input:{bill:BillView;policy:PolicyView|null;bank:BankView|null;isFirstPayment:boolean}):Evaluation{
 const {bill,policy,bank,isFirstPayment}=input; const reasons:ReasonCode[]=[];
 if(!bill.merchantName||!bill.amountCents||bill.amountCents<=0||!bill.currency){return {decision:'MANUAL_REVIEW',riskLevel:4,reasons:['BILL_INVALID','MANUAL_REVIEW_REQUIRED']};}
 if(bill.duplicateOfId||bill.status==='DUPLICATE') return {decision:'BLOCKED',riskLevel:4,reasons:['BILL_DUPLICATE']};
 if(!policy) return {decision:'MANUAL_REVIEW',riskLevel:3,reasons:['POLICY_NOT_FOUND','MANUAL_REVIEW_REQUIRED']};
 if(!policy.active) return {decision:'BLOCKED',riskLevel:4,reasons:['POLICY_INACTIVE']};
 if(policy.mode==='BLOCKED') return {decision:'BLOCKED',riskLevel:4,reasons:['POLICY_BLOCKED']};
 if(policy.currency!==bill.currency) reasons.push('UNSUPPORTED_CURRENCY');
 if(policy.merchantFingerprint&&policy.merchantFingerprint!==bill.merchantFingerprint) reasons.push('MERCHANT_MISMATCH');
 else if(policy.merchantName&&policy.merchantName.toLowerCase()!==bill.merchantName.toLowerCase()) reasons.push('MERCHANT_MISMATCH');
 if(policy.accountLast4&&policy.accountLast4!==bill.accountLast4) reasons.push('ACCOUNT_REFERENCE_MISMATCH');
 if(policy.maximumAmountCents!=null&&bill.amountCents>policy.maximumAmountCents) reasons.push('AMOUNT_ABOVE_LIMIT');
 if(policy.minimumAmountCents!=null&&bill.amountCents<policy.minimumAmountCents) reasons.push('AMOUNT_BELOW_LIMIT');
 if(policy.typicalAmountCents&&policy.variancePercent!=null){const delta=Math.abs(bill.amountCents-policy.typicalAmountCents); if(delta>policy.typicalAmountCents*(policy.variancePercent/100)) reasons.push('AMOUNT_VARIANCE_EXCEEDED');}
 if(policy.allowedBankConnectionId&&(!bank||bank.id!==policy.allowedBankConnectionId||bank.status!=='ACTIVE')) reasons.push('BANK_CONNECTION_INACTIVE');
 const blockers:ReasonCode[]=['UNSUPPORTED_CURRENCY','MERCHANT_MISMATCH','ACCOUNT_REFERENCE_MISMATCH','AMOUNT_ABOVE_LIMIT','AMOUNT_BELOW_LIMIT','BANK_CONNECTION_INACTIVE'];
 if(reasons.some(r=>blockers.includes(r))) return {decision:'BLOCKED',riskLevel:4,reasons};
 if(policy.mode==='NOTIFY_ONLY') return {decision:'NOTIFY_ONLY',riskLevel:1,reasons};
 if(policy.requireApprovalForFirstPayment&&isFirstPayment) reasons.push('FIRST_PAYMENT_REQUIRES_APPROVAL');
 if(policy.mode==='ALWAYS_ASK'||reasons.length|| (policy.requireApprovalAboveCents!=null&&bill.amountCents>policy.requireApprovalAboveCents)){reasons.push('USER_APPROVAL_REQUIRED'); return {decision:'APPROVAL_REQUIRED',riskLevel:3,reasons:[...new Set(reasons)]};}
 return {decision:'ELIGIBLE_FOR_FUTURE_AUTOPAY',riskLevel:2,reasons};
}
