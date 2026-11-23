import { createHash, randomBytes } from 'node:crypto';
import { Prisma, PrismaClient, type PaymentPolicy } from '@prisma/client';

export type PaymentMode = 'NOTIFY_ONLY' | 'ALWAYS_ASK' | 'AUTO_APPROVE_ELIGIBLE' | 'BLOCKED';
export type PaymentDecisionName = 'NOTIFY_ONLY' | 'APPROVAL_REQUIRED' | 'ELIGIBLE_FOR_FUTURE_AUTOPAY' | 'BLOCKED' | 'MANUAL_REVIEW';
export type PolicyReason =
  | 'POLICY_NOT_FOUND' | 'POLICY_INACTIVE' | 'POLICY_BLOCKED' | 'BILL_DUPLICATE' | 'BILL_CHANGED'
  | 'MERCHANT_MISMATCH' | 'ACCOUNT_REFERENCE_MISMATCH' | 'AMOUNT_ABOVE_LIMIT' | 'AMOUNT_BELOW_LIMIT'
  | 'AMOUNT_VARIANCE_EXCEEDED' | 'UNSUPPORTED_CURRENCY' | 'BANK_CONNECTION_INACTIVE'
  | 'FIRST_PAYMENT_REQUIRES_APPROVAL' | 'USER_APPROVAL_REQUIRED' | 'MANUAL_REVIEW_REQUIRED'
  | 'BILL_REJECTED' | 'INVALID_BILL' | 'DUE_DATE_CHANGED';
export type PolicyBill = {
  id: string; userId: string; merchantName: string; amountCents: number; currency: string;
  dueDate: Date; accountLast4: string | null; status: string; duplicate: boolean;
};
export type PaymentPolicyInput = {
  name: string; merchantName: string; accountLast4: string | null; mode: PaymentMode; active: boolean;
  maximumAmountCents: number | null; minimumAmountCents: number | null; currency: string;
  allowedBankConnectionId: string | null; typicalAmountCents: number | null; variancePercent: number | null;
  requireApprovalAboveCents: number | null; requireApprovalForFirstPayment: boolean;
  requireApprovalForAmountChange: boolean; requireApprovalForDueDateChange: boolean;
};
export type EvaluationResult = {
  decision: PaymentDecisionName; riskLevel: 0 | 1 | 2 | 3 | 4; reasons: PolicyReason[];
};
type PriorBill = { amountCents: number | null; currency: string | null; merchantName: string | null;
  accountLast4: string | null; billSnapshot: Prisma.JsonValue; billSnapshotHash: string; reasons: Prisma.JsonValue };
type EngineInput = {
  userId: string; bill: PolicyBill; policy: PaymentPolicyInput | null; bankConnection: { id: string; status: string } | null;
  previousBill?: PriorBill | null; firstPayment?: boolean;
};

const currencies = new Set(['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'NZD']);
export function merchantFingerprint(merchant: string) {
  return createHash('sha256').update(merchant.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')).digest('hex');
}
export function billSnapshot(bill: PolicyBill) {
  return {
    id: bill.id, userId: bill.userId, merchantName: bill.merchantName, amountCents: bill.amountCents,
    currency: bill.currency, dueDate: bill.dueDate.toISOString().slice(0, 10), accountLast4: bill.accountLast4,
    status: bill.status, duplicate: bill.duplicate,
  };
}
export function billSnapshotHash(bill: PolicyBill) {
  return createHash('sha256').update(JSON.stringify(billSnapshot(bill))).digest('hex');
}

export class PaymentPolicyEngine {
  evaluate(input: EngineInput): EvaluationResult {
    const reasons: PolicyReason[] = [];
    const { userId, bill, policy, bankConnection } = input;
    if (!userId || bill.userId !== userId) return { decision: 'MANUAL_REVIEW', riskLevel: 4, reasons: ['MANUAL_REVIEW_REQUIRED'] };
    if (bill.status === 'REJECTED') return { decision: 'BLOCKED', riskLevel: 4, reasons: ['BILL_REJECTED'] };
    if (bill.duplicate) return { decision: 'BLOCKED', riskLevel: 4, reasons: ['BILL_DUPLICATE'] };
    if (!bill.merchantName?.trim() || !Number.isSafeInteger(bill.amountCents) || bill.amountCents <= 0 ||
        !currencies.has(bill.currency) || Number.isNaN(bill.dueDate.getTime())) {
      return { decision: 'MANUAL_REVIEW', riskLevel: 3, reasons: ['INVALID_BILL'] };
    }
    if (!policy) return { decision: 'MANUAL_REVIEW', riskLevel: 3, reasons: ['POLICY_NOT_FOUND'] };
    if (!policy.active) return { decision: 'MANUAL_REVIEW', riskLevel: 3, reasons: ['POLICY_INACTIVE'] };
    if (policy.mode === 'BLOCKED') return { decision: 'BLOCKED', riskLevel: 4, reasons: ['POLICY_BLOCKED'] };
    if (policy.allowedBankConnectionId &&
        (!bankConnection || bankConnection.id !== policy.allowedBankConnectionId || bankConnection.status !== 'ACTIVE')) {
      return { decision: 'MANUAL_REVIEW', riskLevel: 3, reasons: ['BANK_CONNECTION_INACTIVE'] };
    }
    if (merchantFingerprint(bill.merchantName) !== merchantFingerprint(policy.merchantName)) {
      return { decision: 'BLOCKED', riskLevel: 4, reasons: ['MERCHANT_MISMATCH'] };
    }
    if (policy.accountLast4 && policy.accountLast4 !== bill.accountLast4) {
      return { decision: 'MANUAL_REVIEW', riskLevel: 4, reasons: ['ACCOUNT_REFERENCE_MISMATCH'] };
    }
    if (policy.currency !== bill.currency) return { decision: 'MANUAL_REVIEW', riskLevel: 3, reasons: ['UNSUPPORTED_CURRENCY'] };
    if (policy.maximumAmountCents !== null && bill.amountCents > policy.maximumAmountCents) {
      return { decision: 'BLOCKED', riskLevel: 4, reasons: ['AMOUNT_ABOVE_LIMIT'] };
    }
    if (policy.minimumAmountCents !== null && bill.amountCents < policy.minimumAmountCents) {
      return { decision: 'MANUAL_REVIEW', riskLevel: 3, reasons: ['AMOUNT_BELOW_LIMIT'] };
    }
    if (input.previousBill?.billSnapshotHash === billSnapshotHash(bill) &&
        Array.isArray(input.previousBill.reasons) &&
        input.previousBill.reasons.some(reason => reason === 'BILL_CHANGED' || reason === 'DUE_DATE_CHANGED')) {
      return { decision: 'MANUAL_REVIEW', riskLevel: 4, reasons: input.previousBill.reasons as PolicyReason[] };
    }
    if (policy.mode === 'AUTO_APPROVE_ELIGIBLE' &&
        (policy.typicalAmountCents === null || policy.variancePercent === null)) {
      return { decision: 'MANUAL_REVIEW', riskLevel: 2, reasons: ['MANUAL_REVIEW_REQUIRED'] };
    }
    if (policy.typicalAmountCents !== null && policy.variancePercent !== null) {
      const variance = Math.abs(bill.amountCents - policy.typicalAmountCents) / Math.max(1, policy.typicalAmountCents) * 100;
      if (variance > policy.variancePercent) {
        reasons.push('AMOUNT_VARIANCE_EXCEEDED');
        if (policy.requireApprovalForAmountChange) return { decision: 'APPROVAL_REQUIRED', riskLevel: 3, reasons };
        return { decision: 'MANUAL_REVIEW', riskLevel: 3, reasons };
      }
    }
    if (input.previousBill && input.previousBill.amountCents !== bill.amountCents && policy.requireApprovalForAmountChange) {
      reasons.push('BILL_CHANGED');
    }
    if (input.previousBill) {
      const previous = input.previousBill.billSnapshot as { dueDate?: unknown } | null;
      if (previous && typeof previous === 'object' && previous.dueDate !== billSnapshot(bill).dueDate &&
          policy.requireApprovalForDueDateChange) reasons.push('DUE_DATE_CHANGED');
    }
    if (reasons.includes('BILL_CHANGED') || reasons.includes('DUE_DATE_CHANGED')) {
      return { decision: 'MANUAL_REVIEW', riskLevel: 4, reasons };
    }
    if (policy.mode === 'NOTIFY_ONLY') return { decision: 'NOTIFY_ONLY', riskLevel: 1, reasons };
    if (policy.mode === 'ALWAYS_ASK') return { decision: 'APPROVAL_REQUIRED', riskLevel: 3, reasons: ['USER_APPROVAL_REQUIRED'] };
    if (policy.requireApprovalAboveCents !== null && bill.amountCents > policy.requireApprovalAboveCents) {
      return { decision: 'APPROVAL_REQUIRED', riskLevel: 3, reasons: ['USER_APPROVAL_REQUIRED'] };
    }
    if (input.firstPayment && policy.requireApprovalForFirstPayment) {
      return { decision: 'APPROVAL_REQUIRED', riskLevel: 3, reasons: ['FIRST_PAYMENT_REQUIRES_APPROVAL'] };
    }
    if (!policy.allowedBankConnectionId) {
      return { decision: 'MANUAL_REVIEW', riskLevel: 2, reasons: ['MANUAL_REVIEW_REQUIRED'] };
    }
    // Eligibility is a policy assessment only. It never authorizes or initiates a payment.
    return { decision: 'ELIGIBLE_FOR_FUTURE_AUTOPAY', riskLevel: 2, reasons: [] };
  }
}

export class InvalidPaymentPolicyError extends Error {}
export class PaymentResourceNotFoundError extends Error {}
export class PaymentPolicyConflictError extends Error {}
export class PaymentConflictError extends Error {
  constructor(readonly kind: 'expired' | 'changed' | 'not_pending' | 'invalid_policy') { super(kind); }
}

const policyFields = new Set([
  'name', 'merchantName', 'accountLast4', 'mode', 'maximumAmountCents', 'minimumAmountCents', 'currency',
  'allowedBankConnectionId', 'typicalAmountCents', 'variancePercent', 'requireApprovalAboveCents',
  'requireApprovalForFirstPayment', 'requireApprovalForAmountChange', 'requireApprovalForDueDateChange', 'active',
]);
function parsePolicy(value: unknown, existing?: PaymentPolicy): PaymentPolicyInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidPaymentPolicyError('Invalid policy');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !policyFields.has(key))) throw new InvalidPaymentPolicyError('Unexpected policy field');
  const get = <T>(key: string, current: T): T => (key in raw ? raw[key] : current) as T;
  const name = get('name', existing?.name ?? '');
  const merchantName = get('merchantName', existing?.merchantName ?? '');
  const accountLast4 = get('accountLast4', existing?.accountLast4 ?? null);
  const mode = get('mode', existing?.mode ?? '');
  const currency = get('currency', existing?.currency ?? '');
  const maximumAmountCents = get('maximumAmountCents', existing?.maximumAmountCents ?? null);
  const minimumAmountCents = get('minimumAmountCents', existing?.minimumAmountCents ?? null);
  const allowedBankConnectionId = get('allowedBankConnectionId', existing?.allowedBankConnectionId ?? null);
  const typicalAmountCents = get('typicalAmountCents', existing?.typicalAmountCents ?? null);
  const variancePercent = get('variancePercent', existing?.variancePercent ?? null);
  const requireApprovalAboveCents = get('requireApprovalAboveCents', existing?.requireApprovalAboveCents ?? null);
  const bool = (key: string, current: boolean) => get(key, current);
  const sensitiveText = (value: string) =>
    /\b(?:password|passcode|cvv|cvc|pin|routing|iban|account number|card number|credential|token)\b|\d(?:[ -]?\d){7,}/i.test(value);
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 80 ||
      typeof merchantName !== 'string' || merchantName.trim().length < 1 || merchantName.trim().length > 80 ||
      !/^[\p{L}\p{M}0-9 &'.,-]+$/u.test(name.trim()) ||
      !/^[\p{L}\p{M}0-9 &'.,-]+$/u.test(merchantName.trim()) ||
      sensitiveText(name) || sensitiveText(merchantName) ||
      (name.match(/[0-9]/g)?.length ?? 0) > 3 ||
      (merchantName.match(/[0-9]/g)?.length ?? 0) > 3 ||
      (accountLast4 !== null && (typeof accountLast4 !== 'string' || !/^\d{4}$/.test(accountLast4))) ||
      !['NOTIFY_ONLY', 'ALWAYS_ASK', 'AUTO_APPROVE_ELIGIBLE', 'BLOCKED'].includes(String(mode)) ||
      typeof currency !== 'string' || !currencies.has(currency) ||
      (allowedBankConnectionId !== null && (typeof allowedBankConnectionId !== 'string' || allowedBankConnectionId.length > 100)) ||
      [maximumAmountCents, minimumAmountCents, typicalAmountCents, requireApprovalAboveCents]
        .some(value => value !== null && (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 2147483647)) ||
      (variancePercent !== null && (typeof variancePercent !== 'number' || !Number.isFinite(variancePercent) || variancePercent < 0 || variancePercent > 1000)) ||
      ['requireApprovalForFirstPayment', 'requireApprovalForAmountChange', 'requireApprovalForDueDateChange']
        .some(key => typeof bool(key, true) !== 'boolean') ||
      typeof bool('active', existing?.active ?? true) !== 'boolean' ||
      (minimumAmountCents !== null && maximumAmountCents !== null && Number(minimumAmountCents) > Number(maximumAmountCents))) {
    throw new InvalidPaymentPolicyError('Invalid policy fields');
  }
  return {
    name: name.trim(), merchantName: merchantName.trim().normalize('NFKC').replace(/\s+/g, ' '),
    accountLast4: accountLast4 as string | null, mode: mode as PaymentMode,
    active: bool('active', existing?.active ?? true),
    maximumAmountCents: maximumAmountCents as number | null, minimumAmountCents: minimumAmountCents as number | null,
    currency, allowedBankConnectionId: allowedBankConnectionId as string | null,
    typicalAmountCents: typicalAmountCents as number | null, variancePercent: variancePercent as number | null,
    requireApprovalAboveCents: requireApprovalAboveCents as number | null,
    requireApprovalForFirstPayment: bool('requireApprovalForFirstPayment', existing?.requireApprovalForFirstPayment ?? true),
    requireApprovalForAmountChange: bool('requireApprovalForAmountChange', existing?.requireApprovalForAmountChange ?? true),
    requireApprovalForDueDateChange: bool('requireApprovalForDueDateChange', existing?.requireApprovalForDueDateChange ?? true),
  };
}

function snapshotPolicy(policy: PaymentPolicy | null) {
  if (!policy) return { policyId: null, active: false };
  return {
    id: policy.id, userId: policy.userId, name: policy.name, merchantName: policy.merchantName,
    merchantFingerprint: policy.merchantFingerprint, accountLast4: policy.accountLast4, mode: policy.mode,
    maximumAmountCents: policy.maximumAmountCents, minimumAmountCents: policy.minimumAmountCents,
    currency: policy.currency, allowedBankConnectionId: policy.allowedBankConnectionId,
    typicalAmountCents: policy.typicalAmountCents, variancePercent: policy.variancePercent,
    requireApprovalAboveCents: policy.requireApprovalAboveCents,
    requireApprovalForFirstPayment: policy.requireApprovalForFirstPayment,
    requireApprovalForAmountChange: policy.requireApprovalForAmountChange,
    requireApprovalForDueDateChange: policy.requireApprovalForDueDateChange, active: policy.active,
  };
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
function approvalTtl() {
  const value = Number(process.env.PAYMENT_APPROVAL_TTL_HOURS ?? 24);
  if (!Number.isInteger(value) || value < 1 || value > 720) throw new Error('PAYMENT_APPROVAL_TTL_HOURS must be 1..720');
  return value;
}
function newApprovalToken() { return randomBytes(32).toString('base64url'); }
function approvalTokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }

const policySelect = {
  id: true, userId: true, name: true, merchantName: true, merchantFingerprint: true, accountLast4: true,
  mode: true, maximumAmountCents: true, minimumAmountCents: true, currency: true, allowedBankConnectionId: true,
  typicalAmountCents: true, variancePercent: true, requireApprovalAboveCents: true,
  requireApprovalForFirstPayment: true, requireApprovalForAmountChange: true, requireApprovalForDueDateChange: true,
  active: true, createdAt: true, updatedAt: true,
} satisfies Prisma.PaymentPolicySelect;
const approvalSelect = {
  id: true, billId: true, paymentDecisionId: true, status: true, billSnapshotHash: true,
  amountCents: true, currency: true, merchantName: true, accountLast4: true, bankConnectionId: true,
  expiresAt: true, approvedAt: true, rejectedAt: true, cancelledAt: true, createdAt: true, updatedAt: true,
} satisfies Prisma.ApprovalSelect;

export class PaymentPolicyStore {
  constructor(private readonly db: PrismaClient, private readonly engine = new PaymentPolicyEngine()) {}

  listPolicies(userId: string) {
    return this.db.paymentPolicy.findMany({ where: { userId }, select: policySelect, orderBy: { createdAt: 'desc' } });
  }
  getPolicy(userId: string, id: string) {
    return this.db.paymentPolicy.findFirst({ where: { id, userId }, select: policySelect });
  }
  async createPolicy(userId: string, raw: unknown) {
    const input = parsePolicy(raw);
    if (input.allowedBankConnectionId) {
      const bank = await this.db.bankConnection.findFirst({ where: { id: input.allowedBankConnectionId, ownerUid: userId } });
      if (!bank) throw new PaymentResourceNotFoundError();
    }
    try {
      return await this.db.$transaction(async tx => {
        const policy = await tx.paymentPolicy.create({ data: {
          ...input, userId, merchantFingerprint: merchantFingerprint(input.merchantName),
        }, select: policySelect });
        await tx.auditEvent.create({ data: {
          actor: userId, ownerUid: userId, action: 'payment_policy.created', resource: `payment_policy:${policy.id}`,
        } });
        return policy;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new PaymentPolicyConflictError('A policy already exists for this merchant and account reference');
      }
      throw error;
    }
  }
  async updatePolicy(userId: string, id: string, raw: unknown) {
    const current = await this.db.paymentPolicy.findFirst({ where: { id, userId } });
    if (!current) return null;
    const input = parsePolicy(raw, current);
    if (input.allowedBankConnectionId) {
      const bank = await this.db.bankConnection.findFirst({ where: { id: input.allowedBankConnectionId, ownerUid: userId } });
      if (!bank) throw new PaymentResourceNotFoundError();
    }
    try {
      return await this.db.$transaction(async tx => {
        const policy = await tx.paymentPolicy.update({ where: { id, userId }, data: {
          ...input, merchantFingerprint: merchantFingerprint(input.merchantName),
        }, select: policySelect });
        await tx.auditEvent.create({ data: {
          actor: userId, ownerUid: userId, action: 'payment_policy.updated', resource: `payment_policy:${id}`,
        } });
        return policy;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new PaymentPolicyConflictError('A policy already exists for this merchant and account reference');
      }
      throw error;
    }
  }
  async deletePolicy(userId: string, id: string) {
    return this.db.$transaction(async tx => {
      const result = await tx.paymentPolicy.updateMany({ where: { id, userId, active: true }, data: { active: false } });
      if (result.count) await tx.auditEvent.create({ data: {
        actor: userId, ownerUid: userId, action: 'payment_policy.deactivated', resource: `payment_policy:${id}`,
      } });
      return result.count > 0;
    });
  }

  async evaluate(userId: string, billId: string, policyId: string | null) {
    return this.db.$transaction(async tx => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Bill" WHERE "id" = ${billId} AND "ownerUid" = ${userId} FOR UPDATE`;
      if (!locked.length) return null;
      const bill = await tx.bill.findFirst({ where: { id: billId, ownerUid: userId } });
      if (!bill) return null;
      let policy: PaymentPolicy | null;
      if (policyId) {
        policy = await tx.paymentPolicy.findFirst({ where: { id: policyId, userId } });
      } else {
        const candidates = await tx.paymentPolicy.findMany({
          where: { userId, merchantFingerprint: merchantFingerprint(bill.merchant), active: true },
        });
        const exact = candidates.filter(candidate => candidate.accountLast4 !== null && candidate.accountLast4 === bill.accountLastFour);
        const generic = candidates.filter(candidate => candidate.accountLast4 === null);
        const matches = exact.length ? exact : generic;
        policy = matches.length === 1 ? matches[0] : candidates.length === 1 ? candidates[0] : null;
      }
      if (policyId && !policy) return null;
      const [duplicates, originals] = await Promise.all([
        tx.billSubmission.count({ where: { billId, ownerUid: userId, processingStatus: 'duplicate' } }),
        tx.billSubmission.count({ where: { billId, ownerUid: userId, processingStatus: { not: 'duplicate' } } }),
      ]);
      const bankId = policy?.allowedBankConnectionId ?? null;
      const bank = bankId ? await tx.bankConnection.findFirst({ where: { id: bankId, ownerUid: userId }, select: { id: true, status: true } }) : null;
      const previous = policy ? await tx.paymentDecision.findFirst({
        where: { userId, billId, policyId: policy.id }, orderBy: { createdAt: 'desc' },
        select: {
          amountCents: true, currency: true, merchantName: true, accountLast4: true,
          billSnapshot: true, billSnapshotHash: true, reasons: true,
        },
      }) : null;
      const policyValue: PaymentPolicyInput | null = policy ? {
        name: policy.name, merchantName: policy.merchantName, accountLast4: policy.accountLast4,
        mode: policy.mode as PaymentMode, active: policy.active, maximumAmountCents: policy.maximumAmountCents,
        minimumAmountCents: policy.minimumAmountCents, currency: policy.currency,
        allowedBankConnectionId: policy.allowedBankConnectionId, typicalAmountCents: policy.typicalAmountCents,
        variancePercent: policy.variancePercent, requireApprovalAboveCents: policy.requireApprovalAboveCents,
        requireApprovalForFirstPayment: policy.requireApprovalForFirstPayment,
        requireApprovalForAmountChange: policy.requireApprovalForAmountChange,
        requireApprovalForDueDateChange: policy.requireApprovalForDueDateChange,
      } : null;
      const modelBill: PolicyBill = {
        id: bill.id, userId, merchantName: bill.merchant, amountCents: bill.amountMinor,
        currency: bill.currency, dueDate: bill.dueDate, accountLast4: bill.accountLastFour,
        status: bill.status, duplicate: duplicates > 0 && originals === 0,
      };
      const evaluated = this.engine.evaluate({
        userId, bill: modelBill, policy: policyValue, bankConnection: bank, previousBill: previous,
        firstPayment: !await tx.approval.findFirst({
          where: { ownerUid: userId, paymentDecision: { policyId: policy?.id }, status: 'CONSUMED' },
          select: { id: true },
        }),
      });
      const hash = billSnapshotHash(modelBill);
      const now = new Date();
      const currentPolicySnapshot = snapshotPolicy(policy);
      let activeApprovals = await tx.approval.findMany({
        where: { ownerUid: userId, billId, status: { in: ['PENDING', 'APPROVED'] }, paymentDecisionId: { not: null } },
        include: { paymentDecision: { select: { policyId: true, decision: true, policySnapshot: true } } },
      });
      const expiredApprovals = activeApprovals.filter(approval => approval.expiresAt && approval.expiresAt <= now);
      for (const expired of expiredApprovals) {
        const updated = await tx.approval.updateMany({
          where: { id: expired.id, ownerUid: userId, status: expired.status },
          data: { status: 'EXPIRED', updatedAt: now },
        });
        if (updated.count) await tx.auditEvent.create({ data: {
          actor: userId, ownerUid: userId, billId, action: 'payment_approval.expired',
          resource: `approval:${expired.id}`,
        } });
      }
      activeApprovals = activeApprovals.filter(approval => !expiredApprovals.includes(approval));
      if (evaluated.decision === 'APPROVAL_REQUIRED') {
        const reusable = activeApprovals.find(existing =>
          existing.billSnapshotHash === hash && existing.paymentDecision?.policyId === (policy?.id ?? null) &&
          existing.paymentDecision.decision === 'APPROVAL_REQUIRED' &&
          stableJson(existing.paymentDecision.policySnapshot) === stableJson(currentPolicySnapshot) &&
          Boolean(existing.expiresAt && existing.expiresAt > now));
        if (reusable) {
          const decision = await tx.paymentDecision.findFirst({
            where: { id: reusable.paymentDecisionId!, userId, billId },
          });
          if (decision) {
            const staleIds = activeApprovals.filter(candidate => candidate.id !== reusable.id).map(candidate => candidate.id);
            if (staleIds.length) await tx.approval.updateMany({
              where: { id: { in: staleIds }, ownerUid: userId, status: { in: ['PENDING', 'APPROVED'] } },
              data: { status: 'CANCELLED', cancelledAt: now, updatedAt: now },
            });
            for (const staleId of staleIds) await tx.auditEvent.create({ data: {
              actor: userId, ownerUid: userId, billId, action: 'payment_approval.cancelled',
              resource: `approval:${staleId}`, metadata: { reason: 'superseded_decision' },
            } });
            return { decision: { ...decision, reasons: evaluated.reasons }, approval: await tx.approval.findFirstOrThrow({
              where: { id: reusable.id, ownerUid: userId }, select: approvalSelect,
            }), reused: true };
          }
        }
      }
      await tx.approval.updateMany({
        where: { ownerUid: userId, billId, status: { in: ['PENDING', 'APPROVED'] }, paymentDecisionId: { not: null } },
        data: { status: 'CANCELLED', cancelledAt: now, updatedAt: now },
      });
      for (const stale of activeApprovals) await tx.auditEvent.create({ data: {
        actor: userId, ownerUid: userId, billId, action: 'payment_approval.cancelled',
        resource: `approval:${stale.id}`, metadata: { reason: 'superseded_decision' },
      } });
      const decision = await tx.paymentDecision.create({ data: {
        userId, billId, policyId: policy?.id ?? null, decision: evaluated.decision,
        riskLevel: evaluated.riskLevel, reasons: evaluated.reasons, amountCents: bill.amountMinor,
        currency: bill.currency, merchantName: bill.merchant, accountLast4: bill.accountLastFour,
        bankConnectionId: bankId, policySnapshot: currentPolicySnapshot, billSnapshot: billSnapshot(modelBill),
        billSnapshotHash: hash, expiresAt: evaluated.decision === 'APPROVAL_REQUIRED'
          ? new Date(now.getTime() + approvalTtl() * 60 * 60 * 1000) : null,
      } });
      let approval = null;
      if (evaluated.decision === 'APPROVAL_REQUIRED') {
        const token = newApprovalToken();
        approval = await tx.approval.create({ data: {
          ownerUid: userId, billId, paymentDecisionId: decision.id, status: 'PENDING',
          approvalTokenHash: approvalTokenHash(token), billSnapshotHash: hash, amountCents: bill.amountMinor,
          currency: bill.currency, merchantName: bill.merchant, accountLast4: bill.accountLastFour,
          bankConnectionId: bankId, expiresAt: decision.expiresAt,
        }, select: approvalSelect });
      }
      await tx.auditEvent.create({ data: {
        actor: userId, ownerUid: userId, billId, action: 'payment_policy.evaluated',
        resource: `payment_decision:${decision.id}`,
        metadata: { decision: evaluated.decision, riskLevel: evaluated.riskLevel, reasons: evaluated.reasons },
      } });
      if (approval) await tx.auditEvent.create({ data: {
        actor: userId, ownerUid: userId, billId, action: 'payment_approval.created',
        resource: `approval:${approval.id}`,
      } });
      return { decision, approval, reused: false };
    });
  }

  private async expireApprovals(userId: string, id?: string) {
    const now = new Date();
    const expired = await this.db.approval.findMany({
      where: {
        ownerUid: userId, paymentDecisionId: { not: null }, status: { in: ['PENDING', 'APPROVED'] },
        expiresAt: { lte: now }, ...(id ? { id } : {}),
      },
      select: { id: true, billId: true, status: true },
    });
    for (const approval of expired) {
      const updated = await this.db.approval.updateMany({
        where: { id: approval.id, ownerUid: userId, status: approval.status },
        data: { status: 'EXPIRED', updatedAt: now },
      });
      if (updated.count) await this.db.auditEvent.create({ data: {
        actor: userId, ownerUid: userId, billId: approval.billId, action: 'payment_approval.expired',
        resource: `approval:${approval.id}`,
      } });
    }
  }

  listApprovals(userId: string) {
    return this.expireApprovals(userId).then(() => this.db.approval.findMany({
      where: { ownerUid: userId, paymentDecisionId: { not: null } }, select: approvalSelect,
      orderBy: { createdAt: 'desc' },
    }));
  }
  getApproval(userId: string, id: string) {
    return this.expireApprovals(userId, id).then(() => this.db.approval.findFirst({
      where: { id, ownerUid: userId, paymentDecisionId: { not: null } }, select: approvalSelect,
    }));
  }
  async actOnApproval(userId: string, id: string, action: 'approve' | 'reject' | 'cancel') {
    return this.db.$transaction(async tx => {
      const approval = await tx.approval.findFirst({
        where: { id, ownerUid: userId, paymentDecisionId: { not: null } }, select: approvalSelect,
      });
      if (!approval) return { kind: 'not_found' as const };
      if (!['PENDING', 'APPROVED'].includes(approval.status) || (action !== 'cancel' && approval.status !== 'PENDING')) {
        return { kind: 'conflict' as const };
      }
      await tx.$queryRaw`SELECT "id" FROM "Bill" WHERE "id" = ${approval.billId!} AND "ownerUid" = ${userId} FOR UPDATE`;
      const [bill, decision] = await Promise.all([
        tx.bill.findFirst({ where: { id: approval.billId!, ownerUid: userId } }),
        tx.paymentDecision.findFirst({ where: { id: approval.paymentDecisionId!, userId, billId: approval.billId! } }),
      ]);
      if (!bill || !decision) return { kind: 'not_found' as const };
      if (approval.expiresAt && approval.expiresAt <= new Date()) {
        const expired = await tx.approval.updateMany({
          where: { id, ownerUid: userId, status: approval.status }, data: { status: 'EXPIRED', updatedAt: new Date() },
        });
        if (expired.count) await tx.auditEvent.create({ data: {
          actor: userId, ownerUid: userId, billId: bill.id, action: 'payment_approval.expired', resource: `approval:${id}`,
        } });
        return { kind: 'expired' as const };
      }
      const currentBill: PolicyBill = {
        id: bill.id, userId, merchantName: bill.merchant, amountCents: bill.amountMinor, currency: bill.currency,
        dueDate: bill.dueDate, accountLast4: bill.accountLastFour, status: bill.status, duplicate: false,
      };
      const currentPolicy = decision.policyId ? await tx.paymentPolicy.findFirst({
        where: { id: decision.policyId, userId },
      }) : null;
      if (billSnapshotHash(currentBill) !== approval.billSnapshotHash || decision.billSnapshotHash !== approval.billSnapshotHash ||
          stableJson(snapshotPolicy(currentPolicy)) !== stableJson(decision.policySnapshot)) {
        await tx.approval.updateMany({
          where: { id, ownerUid: userId, status: { in: ['PENDING', 'APPROVED'] } },
          data: { status: 'CANCELLED', cancelledAt: new Date(), updatedAt: new Date() },
        });
        await tx.auditEvent.create({ data: {
          actor: userId, ownerUid: userId, billId: bill.id, action: 'payment_approval.cancelled',
          resource: `approval:${id}`, metadata: { reason: 'bill_changed' },
        } });
        return { kind: 'changed' as const };
      }
      if (action === 'approve' && approval.status === 'PENDING') {
        const changed = await tx.approval.updateMany({
          where: { id, ownerUid: userId, status: 'PENDING', billSnapshotHash: approval.billSnapshotHash },
          data: { status: 'APPROVED', approvedAt: new Date(), updatedAt: new Date() },
        });
        if (!changed.count) return { kind: 'conflict' as const };
      } else if (action === 'reject') {
        const changed = await tx.approval.updateMany({
          where: { id, ownerUid: userId, status: 'PENDING' },
          data: { status: 'REJECTED', rejectedAt: new Date(), updatedAt: new Date() },
        });
        if (!changed.count) return { kind: 'conflict' as const };
      } else if (action === 'cancel') {
        const changed = await tx.approval.updateMany({
          where: { id, ownerUid: userId, status: { in: ['PENDING', 'APPROVED'] } },
          data: { status: 'CANCELLED', cancelledAt: new Date(), updatedAt: new Date() },
        });
        if (!changed.count) return { kind: 'conflict' as const };
      }
      await tx.auditEvent.create({ data: {
        actor: userId, ownerUid: userId, billId: bill.id, action: `payment_approval.${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled'}`,
        resource: `approval:${id}`,
      } });
      return { kind: 'ok' as const, approval: await tx.approval.findFirstOrThrow({
        where: { id, ownerUid: userId }, select: approvalSelect,
      }) };
    });
  }
}

let store: PaymentPolicyStore | undefined;
export function getPaymentPolicyStore() { return store ??= new PaymentPolicyStore(new PrismaClient()); }
