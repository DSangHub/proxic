import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { HttpRequest, InvocationContext } from '@azure/functions';
import { PrismaClient } from '@prisma/client';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { createPaymentPolicyHandlers } from '../src/functions/payment-policy.js';
import { billSnapshotHash, merchantFingerprint, PaymentPolicyEngine, PaymentPolicyStore, type PaymentPolicyInput, type PolicyBill } from '../src/services/payment-policy.js';
import type { VerifyToken } from '../src/services/auth.js';

const policy: PaymentPolicyInput = {
  name: 'Monthly utility', merchantName: 'Electric Utility', accountLast4: '1234', mode: 'AUTO_APPROVE_ELIGIBLE',
  active: true, maximumAmountCents: 50000, minimumAmountCents: 1000, currency: 'USD',
  allowedBankConnectionId: 'bank-1', typicalAmountCents: 12000, variancePercent: 50,
  requireApprovalAboveCents: 30000, requireApprovalForFirstPayment: true,
  requireApprovalForAmountChange: true, requireApprovalForDueDateChange: true,
};
const bill: PolicyBill = {
  id: 'bill-1', userId: 'alice', merchantName: 'Electric Utility', amountCents: 12345,
  currency: 'USD', dueDate: new Date('2027-01-31T00:00:00Z'), accountLast4: '1234',
  status: 'AWAITING_APPROVAL', duplicate: false,
};
const context = new InvocationContext();
const request = (method: string, token?: string, id = '', body?: unknown) => new HttpRequest({
  method, url: 'http://localhost/api/test', headers: token ? { authorization: `Bearer ${token}` } : {},
  params: { id }, ...(body === undefined ? {} : { body: { string: JSON.stringify(body) } }),
});

test('policy engine decisions and risk are deterministic and never authorize on last four alone', () => {
  const engine = new PaymentPolicyEngine();
  const evaluate = (input: Partial<Parameters<typeof engine.evaluate>[0]> = {}) => engine.evaluate({
    userId: 'alice', bill, policy, bankConnection: { id: 'bank-1', status: 'ACTIVE' },
    firstPayment: false, ...input,
  });
  assert.equal(evaluate().decision, 'ELIGIBLE_FOR_FUTURE_AUTOPAY');
  assert.deepEqual(evaluate({ firstPayment: true }).reasons, ['FIRST_PAYMENT_REQUIRES_APPROVAL']);
  assert.equal(evaluate({ bill: { ...bill, amountCents: 50001 } }).riskLevel, 4);
  assert.equal(evaluate({ bill: { ...bill, merchantName: 'Other Utility' } }).decision, 'BLOCKED');
  assert.equal(evaluate({ bill: { ...bill, duplicate: true } }).decision, 'BLOCKED');
  assert.equal(evaluate({ bill: { ...bill, accountLast4: '9999' } }).reasons[0], 'ACCOUNT_REFERENCE_MISMATCH');
  assert.equal(evaluate({ bill: { ...bill, accountLast4: null }, policy: { ...policy, accountLast4: null } }).decision, 'ELIGIBLE_FOR_FUTURE_AUTOPAY');
  assert.equal(evaluate({ bankConnection: { id: 'bank-1', status: 'LINKING' } }).decision, 'MANUAL_REVIEW');
  assert.equal(evaluate({ policy: { ...policy, typicalAmountCents: null, variancePercent: null } }).decision, 'MANUAL_REVIEW');
  assert.equal(evaluate({ bill: { ...bill, userId: 'bob' } }).riskLevel, 4);
  assert.notEqual(merchantFingerprint(' Electric   Utility '), merchantFingerprint('Other Utility'));
});

test('changed bill after a previous approval requires elevated review', () => {
  const engine = new PaymentPolicyEngine();
  const result = engine.evaluate({
    userId: 'alice', bill, policy, bankConnection: { id: 'bank-1', status: 'ACTIVE' },
    firstPayment: false, previousBill: {
      amountCents: 12000, currency: 'USD', merchantName: 'Electric Utility', accountLast4: '1234',
      billSnapshot: { dueDate: '2027-01-30' }, billSnapshotHash: 'previous', reasons: [],
    },
  });
  assert.equal(result.decision, 'MANUAL_REVIEW');
  assert.equal(result.riskLevel, 4);
  assert.deepEqual(result.reasons, ['BILL_CHANGED', 'DUE_DATE_CHANGED']);
  const repeated = engine.evaluate({
    userId: 'alice', bill, policy, bankConnection: { id: 'bank-1', status: 'ACTIVE' },
    firstPayment: false, previousBill: {
      amountCents: bill.amountCents, currency: bill.currency, merchantName: bill.merchantName,
      accountLast4: bill.accountLast4, billSnapshot: { dueDate: '2027-01-31' },
      billSnapshotHash: billSnapshotHash(bill), reasons: ['BILL_CHANGED'],
    },
  });
  assert.equal(repeated.decision, 'MANUAL_REVIEW');
  assert.equal(repeated.riskLevel, 4);
});

test('all policy and approval endpoints authenticate before data access', async () => {
  const handlers = createPaymentPolicyHandlers();
  for (const handler of [
    handlers.policies, handlers.policyDetail, handlers.evaluate, handlers.approvals,
    handlers.approvalDetail, handlers.approve, handlers.reject, handlers.cancel,
  ]) assert.equal((await handler(request('GET'), context)).status, 401);
});

const dbUrl = process.env.TEST_DATABASE_URL;
test('PostgreSQL policy APIs enforce owner isolation and approval snapshot, expiry, reuse, and audit invariants', { skip: !dbUrl }, async () => {
  if (!dbUrl) throw new Error('TEST_DATABASE_URL is required');
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  const alice = `alice-${randomUUID()}`, bob = `bob-${randomUUID()}`;
  const bankId = randomUUID();
  const owners = [alice, bob];
  const verify: VerifyToken = async token => {
    if (!owners.includes(token)) throw Object.assign(new Error('invalid'), { code: 'auth/argument-error' });
    return {
      uid: token, sub: token, aud: 'project', iss: 'issuer', auth_time: 1, iat: 1, exp: 9999999999,
      firebase: { identities: {}, sign_in_provider: 'test' },
    } as DecodedIdToken;
  };
  const handlers = createPaymentPolicyHandlers({ verify, store: new PaymentPolicyStore(db) });
  const bodyFor = (owner: string, merchant = 'Electric Utility') => ({
    name: 'Monthly utility', merchantName: merchant, accountLast4: '1234', mode: 'ALWAYS_ASK',
    maximumAmountCents: 50000, minimumAmountCents: 1000, currency: 'USD',
    allowedBankConnectionId: null, typicalAmountCents: 12000, variancePercent: 50,
    requireApprovalAboveCents: 30000, requireApprovalForFirstPayment: true,
    requireApprovalForAmountChange: true, requireApprovalForDueDateChange: true,
  });
  try {
    const policyResponse = await handlers.policies(request('POST', alice, '', bodyFor(alice)), context);
    assert.equal(policyResponse.status, 201);
    const policyId = (policyResponse.jsonBody as { id: string }).id;
    assert.equal((await handlers.policies(request('POST', alice, '', bodyFor(alice)), context)).status, 409);
    assert.equal((await handlers.policyDetail(request('GET', bob, policyId), context)).status, 404);
    assert.equal((await handlers.policyDetail(request('PATCH', bob, policyId, { mode: 'BLOCKED' }), context)).status, 404);
    assert.equal((await handlers.policies(request('POST', alice, '', { ...bodyFor(alice), userId: bob }), context)).status, 400);
    assert.equal((await handlers.policies(request('POST', alice, '', { ...bodyFor(alice), userId: alice }), context)).status, 400);
    assert.equal((await handlers.policies(request('POST', alice, '', { ...bodyFor(alice), merchantName: '1234 5678 9012 3456' }), context)).status, 400);
    assert.equal((await handlers.policies(request('POST', alice, '', { ...bodyFor(alice), name: 'Acct 1234567890123456' }), context)).status, 400);

    await db.bill.create({ data: {
      id: randomUUID(), ownerUid: alice, merchant: 'Electric Utility', amountMinor: 12345, currency: 'USD',
      dueDate: new Date('2027-01-31T00:00:00Z'), accountLastFour: '1234', source: 'MANUAL',
      status: 'AWAITING_APPROVAL', riskLevel: 3, approvalRequired: true, fingerprint: randomUUID(),
    } });
    const bill = await db.bill.findFirstOrThrow({ where: { ownerUid: alice } });
    assert.equal((await handlers.evaluate(request('POST', bob, bill.id, { policyId }), context)).status, 404);
    const evaluated = await handlers.evaluate(request('POST', alice, bill.id, { policyId }), context);
    assert.equal(evaluated.status, 201);
    const result = evaluated.jsonBody as { decision: { id: string; decision: string }; approval: { id: string; status: string } };
    assert.equal(result.decision.decision, 'APPROVAL_REQUIRED');
    assert.equal(result.approval.status, 'PENDING');
    assert.equal(JSON.stringify(evaluated.jsonBody).includes('approvalTokenHash'), false);
    const tokenHash = await db.approval.findUniqueOrThrow({ where: { id: result.approval.id } }).then(row => row.approvalTokenHash);
    assert.match(tokenHash!, /^[a-f0-9]{64}$/);
    const reused = await handlers.evaluate(request('POST', alice, bill.id, { policyId }), context);
    assert.equal((reused.jsonBody as { reused: boolean }).reused, true);
    assert.equal(await db.approval.count({ where: { ownerUid: alice, billId: bill.id, paymentDecisionId: { not: null }, status: 'PENDING' } }), 1);
    assert.equal((await handlers.approvalDetail(request('GET', bob, result.approval.id), context)).status, 404);
    assert.equal((await handlers.approve(request('POST', alice, result.approval.id), context)).status ?? 200, 200);
    assert.equal((await handlers.approve(request('POST', alice, result.approval.id), context)).status, 409);
    assert.equal((await db.approval.findUniqueOrThrow({ where: { id: result.approval.id } })).status, 'APPROVED');
    assert.equal((await db.bill.findUniqueOrThrow({ where: { id_ownerUid: { id: bill.id, ownerUid: alice } } })).status, 'AWAITING_APPROVAL');
    const audit = await db.auditEvent.findMany({ where: { ownerUid: alice, billId: bill.id } });
    assert.ok(audit.some(event => event.action === 'payment_policy.evaluated'));
    assert.ok(audit.some(event => event.action === 'payment_approval.created'));
    assert.ok(audit.some(event => event.action === 'payment_approval.approved'));
    assert.ok((await db.auditEvent.findMany({ where: { ownerUid: alice } })).some(event => event.action === 'payment_policy.created'));
    assert.ok(audit.every(event => !JSON.stringify(event.metadata).includes(tokenHash!)));
    assert.equal(await db.approval.count({ where: { ownerUid: alice, status: 'CONSUMED' } }), 0);

    await db.bill.update({ where: { id_ownerUid: { id: bill.id, ownerUid: alice } }, data: { amountMinor: 20000 } });
    assert.equal((await handlers.cancel(request('POST', alice, result.approval.id), context)).status, 409);
    assert.equal((await db.approval.findUniqueOrThrow({ where: { id: result.approval.id } })).status, 'CANCELLED');

    const expiringBill = await db.bill.create({ data: {
      ownerUid: alice, merchant: 'Electric Utility', amountMinor: 9000, currency: 'USD',
      dueDate: new Date('2027-02-28T00:00:00Z'), accountLastFour: '1234', source: 'MANUAL',
      status: 'AWAITING_APPROVAL', riskLevel: 3, approvalRequired: true, fingerprint: randomUUID(),
    } });
    const expiringEvaluation = await handlers.evaluate(request('POST', alice, expiringBill.id, { policyId }), context);
    const expiringApproval = (expiringEvaluation.jsonBody as { approval: { id: string } }).approval;
    await db.approval.update({ where: { id: expiringApproval.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await handlers.approve(request('POST', alice, expiringApproval.id), context)).status, 409);
    assert.equal((await db.approval.findUniqueOrThrow({ where: { id: expiringApproval.id } })).status, 'EXPIRED');

    const rejectBill = await db.bill.create({ data: {
      ownerUid: alice, merchant: 'Electric Utility', amountMinor: 10000, currency: 'USD',
      dueDate: new Date('2027-04-30T00:00:00Z'), accountLastFour: '1234', source: 'MANUAL',
      status: 'AWAITING_APPROVAL', riskLevel: 3, approvalRequired: true, fingerprint: randomUUID(),
    } });
    const rejectEvaluation = await handlers.evaluate(request('POST', alice, rejectBill.id, { policyId }), context);
    const rejectApproval = (rejectEvaluation.jsonBody as { approval: { id: string } }).approval;
    assert.equal((await handlers.reject(request('POST', alice, rejectApproval.id), context)).status ?? 200, 200);
    assert.equal((await db.approval.findUniqueOrThrow({ where: { id: rejectApproval.id } })).status, 'REJECTED');

    const cancelBill = await db.bill.create({ data: {
      ownerUid: alice, merchant: 'Electric Utility', amountMinor: 10500, currency: 'USD',
      dueDate: new Date('2027-05-31T00:00:00Z'), accountLastFour: '1234', source: 'MANUAL',
      status: 'AWAITING_APPROVAL', riskLevel: 3, approvalRequired: true, fingerprint: randomUUID(),
    } });
    const cancelEvaluation = await handlers.evaluate(request('POST', alice, cancelBill.id, { policyId }), context);
    const cancelApproval = (cancelEvaluation.jsonBody as { approval: { id: string } }).approval;
    assert.equal((await handlers.cancel(request('POST', alice, cancelApproval.id), context)).status ?? 200, 200);
    assert.equal((await db.approval.findUniqueOrThrow({ where: { id: cancelApproval.id } })).status, 'CANCELLED');

    const changedPolicyBill = await db.bill.create({ data: {
      ownerUid: alice, merchant: 'Electric Utility', amountMinor: 11000, currency: 'USD',
      dueDate: new Date('2027-03-31T00:00:00Z'), accountLastFour: '1234', source: 'MANUAL',
      status: 'AWAITING_APPROVAL', riskLevel: 3, approvalRequired: true, fingerprint: randomUUID(),
    } });
    const changedPolicyEvaluation = await handlers.evaluate(request('POST', alice, changedPolicyBill.id, { policyId }), context);
    const changedPolicyApproval = (changedPolicyEvaluation.jsonBody as { approval: { id: string } }).approval;
    assert.equal((await handlers.policyDetail(request('PATCH', alice, policyId, { mode: 'BLOCKED' }), context)).status ?? 200, 200);
    assert.ok((await db.auditEvent.findMany({ where: { ownerUid: alice } })).some(event => event.action === 'payment_policy.updated'));
    assert.equal((await handlers.approve(request('POST', alice, changedPolicyApproval.id), context)).status, 409);
    assert.equal((await db.approval.findUniqueOrThrow({ where: { id: changedPolicyApproval.id } })).status, 'CANCELLED');
    const deleted = await handlers.policyDetail(request('DELETE', alice, policyId), context);
    assert.equal(deleted.status, 204);
  } finally {
    await db.auditEvent.deleteMany({ where: { ownerUid: { in: owners } } });
    await db.approval.deleteMany({ where: { ownerUid: { in: owners } } });
    await db.paymentDecision.deleteMany({ where: { userId: { in: owners } } });
    await db.paymentPolicy.deleteMany({ where: { userId: { in: owners } } });
    await db.billSubmission.deleteMany({ where: { ownerUid: { in: owners } } });
    await db.bill.deleteMany({ where: { ownerUid: { in: owners } } });
    await db.bankAccount.deleteMany({ where: { bankConnection: { ownerUid: { in: owners } } } });
    await db.bankConnection.deleteMany({ where: { ownerUid: { in: owners } } });
    await db.plaidConnection.deleteMany({ where: { ownerUid: { in: owners } } });
    await db.$disconnect();
  }
});
