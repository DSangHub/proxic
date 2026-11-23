import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { HttpRequest, InvocationContext } from '@azure/functions';
import { PrismaClient } from '@prisma/client';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { createBillHandlers } from '../src/functions/bills.js';
import { InvalidBillError, parseBillInput } from '../src/services/bill-input.js';
import { PrismaBillStore } from '../src/services/bills.js';
import type { VerifyToken } from '../src/services/auth.js';

const sample = { merchant: 'Electric Utility', amountMinor: 12345, currency: 'USD', dueDate: '2027-01-31', accountLastFour: '1234' };

test('bill ingestion only accepts bounded structured fields and rejects sensitive data', () => {
  const parsed = parseBillInput(sample);
  assert.equal(parsed.accountLastFour, '1234');
  assert.equal(parsed.fingerprint, parseBillInput({ ...sample, merchant: ' ELECTRIC   UTILITY ' }).fingerprint);
  for (const bad of [
    { ...sample, ownerUid: 'other' },
    { ...sample, body: 'email contents' },
    { ...sample, attachment: 'data' },
    { ...sample, cardNumber: '4111111111111111' },
    { ...sample, password: 'secret' },
    { ...sample, merchant: '4111-1111-1111-1111' },
    { ...sample, accountLastFour: '1234567890123456' },
    { ...sample, dueDate: '2027-02-30' },
    { ...sample, amountMinor: 1.5 },
  ]) assert.throws(() => parseBillInput(bad), InvalidBillError);
});

test('all bill endpoints require authentication before database access', async () => {
  const handlers = createBillHandlers();
  const context = new InvocationContext();
  const request = new HttpRequest({ method: 'GET', url: 'http://localhost/api/bills/abc', params: { id: 'abc' } });
  for (const handler of [handlers.collection, handlers.detail, handlers.approve, handlers.reject]) {
    assert.equal((await handler(request, context)).status, 401);
  }
});

const dbUrl = process.env.TEST_DATABASE_URL;
test('PostgreSQL bill lifecycle enforces owner isolation, policy, duplicate and audit invariants', { skip: !dbUrl }, async () => {
  if (!dbUrl) throw new Error('TEST_DATABASE_URL is required');
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  const alice = `test-alice-${randomUUID()}`;
  const bob = `test-bob-${randomUUID()}`;
  const owners = [alice, bob];
  const verify: VerifyToken = async token => {
    if (!owners.includes(token)) throw Object.assign(new Error('invalid'), { code: 'auth/argument-error' });
    const user: DecodedIdToken = {
      uid: token, sub: token, aud: 'project', iss: 'issuer', auth_time: 1, iat: 1, exp: 9999999999,
      firebase: { identities: {}, sign_in_provider: 'test' },
    };
    return user;
  };
  const handlers = createBillHandlers({ verify, store: new PrismaBillStore(db) });
  const context = new InvocationContext();
  const request = (method: string, token: string, id = '', body?: unknown) => new HttpRequest({
    method, url: 'http://localhost/api/bills', headers: { authorization: `Bearer ${token}` },
    params: { id }, ...(body === undefined ? {} : { body: { string: JSON.stringify(body) } }),
  });
  try {
    const created = await handlers.collection(request('POST', alice, '', sample), context);
    assert.equal(created.status, 201);
    const bill = created.jsonBody as { id: string; approvalRequired: boolean; status: string };
    assert.equal(bill.approvalRequired, true);
    assert.equal(bill.status, 'AWAITING_APPROVAL');
    assert.equal((await handlers.collection(request('POST', alice, '', sample), context)).status, 409);
    assert.equal((await handlers.collection(request('POST', bob, '', sample), context)).status, 201);
    assert.equal((await handlers.collection(request('POST', alice, '', { ...sample, ownerUid: bob }), context)).status, 400);

    const bobList = await handlers.collection(request('GET', bob), context);
    assert.equal((bobList.jsonBody as { id: string }[]).length, 1);
    assert.notEqual((bobList.jsonBody as { id: string }[])[0].id, bill.id);
    assert.equal((await handlers.detail(request('GET', bob, bill.id), context)).status, 404);
    assert.equal((await handlers.approve(request('POST', bob, bill.id), context)).status, 404);
    assert.equal((await handlers.reject(request('POST', bob, bill.id), context)).status, 404);
    assert.equal((await handlers.detail(request('GET', alice, bill.id), context)).status ?? 200, 200);

    const approval = await db.approval.findFirstOrThrow({ where: { ownerUid: alice, billId: bill.id } });
    assert.equal(approval.status, 'pending');
    assert.deepEqual(
      { proxy: (approval.proposedAction as { proxy: string }).proxy, status: (approval.proposedAction as { status: string }).status },
      { proxy: 'bill', status: 'awaiting_approval' },
    );
    const results = await Promise.all([
      handlers.approve(request('POST', alice, bill.id), context),
      handlers.approve(request('POST', alice, bill.id), context),
    ]);
    assert.deepEqual(results.map(result => result.status ?? 200).sort(), [200, 409]);
    assert.equal((await db.approval.findUniqueOrThrow({ where: { id: approval.id } })).status, 'approved');
    const events = await db.auditEvent.findMany({ where: { ownerUid: alice, billId: bill.id }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(events.map(event => event.action), ['bill.created', 'bill.reviewed', 'bill.approved']);
    assert.ok(events.every(event => event.actor === alice && event.metadata === null));

    const another = await handlers.collection(request('POST', alice, '', { ...sample, amountMinor: 456 }), context);
    const rejectedId = (another.jsonBody as { id: string }).id;
    assert.equal((await handlers.reject(request('POST', alice, rejectedId), context)).status ?? 200, 200);
    assert.equal((await db.bill.findUniqueOrThrow({ where: { id: rejectedId } })).status, 'REJECTED');
    assert.equal(await db.auditEvent.count({ where: { billId: rejectedId, action: 'bill.rejected', ownerUid: alice } }), 1);

    await assert.rejects(db.billSubmission.create({ data: { billId: bill.id, ownerUid: bob, source: 'MANUAL' } }));
  } finally {
    await db.auditEvent.deleteMany({ where: { ownerUid: { in: owners } } });
    await db.approval.deleteMany({ where: { ownerUid: { in: owners } } });
    await db.billSubmission.deleteMany({ where: { ownerUid: { in: owners } } });
    await db.bill.deleteMany({ where: { ownerUid: { in: owners } } });
    await db.$disconnect();
  }
});
