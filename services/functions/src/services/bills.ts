import { Prisma, PrismaClient, type Bill } from '@prisma/client';
import { parseBillInput, type BillInput } from './bill-input.js';
import { propose } from './propose.js';

export type BillView = Pick<Bill, 'id' | 'merchant' | 'amountMinor' | 'currency' | 'dueDate' |
  'accountLastFour' | 'source' | 'status' | 'approvalRequired' | 'createdAt' | 'updatedAt' | 'reviewedAt' | 'decidedAt'>;
export type DecisionResult = { kind: 'ok'; bill: BillView } | { kind: 'not_found' } | { kind: 'conflict' };

export interface BillStore {
  list(ownerUid: string): Promise<BillView[]>;
  review(ownerUid: string, id: string): Promise<BillView | null>;
  create(ownerUid: string, input: BillInput): Promise<BillView>;
  decide(ownerUid: string, id: string, decision: 'approve' | 'reject'): Promise<DecisionResult>;
}

export class DuplicateBillError extends Error {}

const billSelect = {
  id: true, merchant: true, amountMinor: true, currency: true, dueDate: true, accountLastFour: true,
  source: true, status: true, approvalRequired: true, createdAt: true, updatedAt: true, reviewedAt: true, decidedAt: true,
} satisfies Prisma.BillSelect;

type AuditAction = 'bill.created' | 'bill.reviewed' | 'bill.approved' | 'bill.rejected' |
  'bill.payment_state_changed';

async function audit(tx: Prisma.TransactionClient, ownerUid: string, billId: string, action: AuditAction) {
  await tx.auditEvent.create({ data: { actor: ownerUid, ownerUid, billId, action, resource: `bill:${billId}` } });
}

export class PrismaBillStore implements BillStore {
  constructor(private readonly db: PrismaClient) {}

  list(ownerUid: string) {
    return this.db.bill.findMany({ where: { ownerUid }, select: billSelect, orderBy: { createdAt: 'desc' } });
  }

  review(ownerUid: string, id: string) {
    return this.db.$transaction(async tx => {
      const bill = await tx.bill.findFirst({ where: { id, ownerUid }, select: billSelect });
      if (!bill) return null;
      const updated = await tx.bill.update({
        where: { id_ownerUid: { id, ownerUid } },
        data: { reviewedAt: new Date() },
        select: billSelect,
      });
      await audit(tx, ownerUid, id, 'bill.reviewed');
      return updated;
    });
  }

  async create(ownerUid: string, input: BillInput) {
    const action = propose('bill', 'pay bill');
    if (!action.requiresApproval || action.riskLevel < 3 || action.status !== 'awaiting_approval') {
      throw new Error('Payment proposal did not pass the approval policy');
    }
    try {
      return await this.db.$transaction(async tx => {
        const bill = await tx.bill.create({
          data: {
            ownerUid, ...input, source: 'MANUAL', riskLevel: action.riskLevel,
            approvalRequired: true,
          },
          select: billSelect,
        });
        await tx.billSubmission.create({ data: { billId: bill.id, ownerUid, source: 'MANUAL' } });
        await tx.approval.create({
          data: {
            billId: bill.id, ownerUid, status: 'pending',
            proposedAction: {
              id: action.id, proxy: action.proxy, action: action.action, description: action.description,
              riskLevel: action.riskLevel, requiresApproval: action.requiresApproval,
              status: action.status, payload: {}, createdAt: action.createdAt,
            },
          },
        });
        await audit(tx, ownerUid, bill.id, 'bill.created');
        return bill;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' &&
          Array.isArray(error.meta?.target) && error.meta.target.includes('fingerprint')) {
        throw new DuplicateBillError('A possible duplicate bill already exists');
      }
      throw error;
    }
  }

  decide(ownerUid: string, id: string, decision: 'approve' | 'reject') {
    return this.db.$transaction<DecisionResult>(async tx => {
      const now = new Date();
      const updated = await tx.bill.updateMany({
        where: { id, ownerUid, status: 'AWAITING_APPROVAL', approvalRequired: true },
        data: { status: decision === 'approve' ? 'APPROVED' : 'REJECTED', decidedAt: now },
      });
      if (updated.count === 0) {
        const bill = await tx.bill.findFirst({ where: { id, ownerUid }, select: { id: true } });
        return bill ? { kind: 'conflict' } : { kind: 'not_found' };
      }
      const approval = await tx.approval.updateMany({
        where: { billId: id, ownerUid, status: 'pending' },
        data: { status: decision === 'approve' ? 'approved' : 'rejected', decidedAt: now },
      });
      if (approval.count !== 1) throw new Error('Bill approval invariant violated');
      await audit(tx, ownerUid, id, decision === 'approve' ? 'bill.approved' : 'bill.rejected');
      const bill = await tx.bill.findUniqueOrThrow({ where: { id_ownerUid: { id, ownerUid } }, select: billSelect });
      return { kind: 'ok', bill };
    });
  }
}

// Only verified server-side identities may be passed here; never accept an owner from submission data.
export async function ingestManualBill(store: BillStore, ownerUid: string, raw: unknown): Promise<BillView> {
  if (!ownerUid) throw new Error('Verified owner is required');
  return store.create(ownerUid, parseBillInput(raw));
}

let store: BillStore | undefined;
export function getBillStore(): BillStore {
  if (!store) store = new PrismaBillStore(new PrismaClient());
  return store;
}
