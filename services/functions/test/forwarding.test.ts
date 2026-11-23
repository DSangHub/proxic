import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { HttpRequest, InvocationContext } from '@azure/functions';
import { PrismaClient } from '@prisma/client';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { createForwardingHandlers } from '../src/functions/forwarding.js';
import { aliasHash, ForwardingStore, MockBillParser, newAliasToken, parseAlias, validateIngestion, type BillParser } from '../src/services/forwarding.js';
import type { VerifyToken } from '../src/services/auth.js';

const text = 'Merchant: Electric Utility\nAmount: 123.45\nCurrency: USD\nDue Date: 2027-01-31\nAccount Last 4: 1234';
const payload = (recipientAlias: string) => ({ recipientAlias, sender: 'utility@example.com', subject: 'Bill',
  receivedAt: '2027-01-01T00:00:00Z', textContent: text, attachments: [] });
const attachment = { fileName: 'bill.pdf', contentType: 'application/pdf', storageReference: 'quarantine/object-1', scanStatus: 'clean' };
const context = new InvocationContext();
const request = (method: string, token?: string, body?: unknown) => new HttpRequest({
  method, url: 'http://localhost/api/test', headers: token ? { authorization: `Bearer ${token}` } : {},
  ...(body === undefined ? {} : { body: { string: JSON.stringify(body) } }),
});

test('tokens are random, opaque, and alias validation is strict', () => {
  const tokens = Array.from({ length: 100 }, newAliasToken);
  assert.equal(new Set(tokens).size, tokens.length);
  for (const token of tokens) {
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(parseAlias(`b.${token}@in.proxic.app`), token);
    assert.notEqual(aliasHash(token), token);
  }
  assert.equal(parseAlias('b.alice@in.proxic.app'), null);
});

test('customer endpoints reject unauthenticated requests', async () => {
  const handlers = createForwardingHandlers();
  for (const handler of [handlers.get, handlers.create, handlers.rotate, handlers.revoke]) {
    assert.equal((await handler(request('GET'), context)).status, 401);
  }
});

test('validation rejects malformed payloads, binary data and unsafe references', () => {
  const good = payload(`b.${newAliasToken()}@in.proxic.app`);
  assert.equal(validateIngestion(good).sender, good.sender);
  for (const bad of [
    { ...good, ownerUid: 'bob' },
    { ...good, recipientAlias: 'b.alice@in.proxic.app' },
    { ...good, receivedAt: '2027-02-30T00:00:00Z' },
    { ...good, attachments: [{ ...attachment, storageReference: 'quarantine/../private' }] },
    { ...good, attachments: [{ ...attachment, storageReference: 'https://storage.example/bill?sas=secret' }] },
    { ...good, attachments: [{ ...attachment, data: 'binary' }] },
    { ...good, attachments: [{ ...attachment, scanStatus: 'unknown' }] },
  ]) assert.throws(() => validateIngestion(bad));
});

test('mock parser does not fill missing or ambiguous fields', async () => {
  const parser = new MockBillParser();
  const parsed = await parser.parse(text);
  assert.equal(parsed.amountCents, 12345);
  assert.equal(parsed.accountLast4, '1234');
  assert.equal((await parser.parse('Merchant: Utility')).amountCents, null);
  assert.equal((await parser.parse(`${text}\nAmount: 1.00`)).amountCents, null);
});

const dbUrl = process.env.TEST_DATABASE_URL;
test('PostgreSQL forwarding lifecycle isolates owners, scans, duplicates and audit events', { skip: !dbUrl }, async () => {
  if (!dbUrl) throw new Error('TEST_DATABASE_URL is required');
  const previousKey = process.env.FORWARDING_ALIAS_ENCRYPTION_KEY;
  process.env.FORWARDING_ALIAS_ENCRYPTION_KEY = 'ab'.repeat(32);
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  const alice = `alice-${randomUUID()}`, bob = `bob-${randomUUID()}`;
  let parseCalls = 0;
  const parser: BillParser = { async parse(value) { parseCalls++; return new MockBillParser().parse(value); } };
  const store = new ForwardingStore(db, parser);
  const verify: VerifyToken = async token => {
    if (token !== alice && token !== bob) throw Object.assign(new Error('invalid'), { code: 'auth/argument-error' });
    return { uid: token, sub: token, aud: 'project', iss: 'issuer', auth_time: 1, iat: 1, exp: 9999999999,
      firebase: { identities: {}, sign_in_provider: 'test' } } as DecodedIdToken;
  };
  const handlers = createForwardingHandlers({ store, verify });
  try {
    const created = await handlers.create(request('POST', alice), context);
    assert.equal(created.status, 201);
    const first = (created.jsonBody as { address: string }).address;
    assert.equal((await handlers.get(request('GET', alice), context)).jsonBody && (await store.current(alice)), first);
    assert.equal(await store.current(bob), null);
    const row = await db.forwardingAlias.findFirstOrThrow({ where: { ownerUid: alice } });
    assert.equal(row.aliasHash, aliasHash(parseAlias(first)!));
    assert.ok(!JSON.stringify(row).includes(first));
    const createdBob = await handlers.create(request('POST', bob), context);
    assert.notEqual((createdBob.jsonBody as { address: string }).address, first);
    const rotated = await handlers.rotate(request('POST', alice), context);
    const current = (rotated.jsonBody as { address: string }).address;
    assert.notEqual(current, first);
    assert.equal((await handlers.ingest(request('POST', undefined, payload(first)), context)).status, 404);
    assert.equal((await handlers.ingest(request('POST', undefined, payload(`b.${newAliasToken()}@in.proxic.app`)), context)).status, 404);
    assert.equal((await handlers.ingest(request('POST', undefined, { ...payload(current), sender: null }), context)).status, 400);
    for (const status of ['pending', 'failed', 'malicious']) {
      const result = await handlers.ingest(request('POST', undefined, { ...payload(current), attachments: [{ ...attachment, scanStatus: status }] }), context);
      assert.equal(result.status, 422);
      assert.equal((result.jsonBody as { kind: string }).kind, status === 'malicious' ? 'rejected' : 'quarantined');
    }
    assert.equal(parseCalls, 0);
    const success = await handlers.ingest(request('POST', undefined, { ...payload(current), attachments: [attachment] }), context);
    assert.equal(success.status, 201);
    assert.equal((success.jsonBody as { kind: string }).kind, 'processed');
    assert.equal(parseCalls, 1);
    const duplicate = await handlers.ingest(request('POST', undefined, payload(current)), context);
    assert.equal((duplicate.jsonBody as { kind: string }).kind, 'duplicate');
    const otherAmount = await handlers.ingest(request('POST', undefined, { ...payload(current), textContent: text.replace('123.45', '99.00') }), context);
    assert.equal((otherAmount.jsonBody as { kind: string }).kind, 'processed');
    const missing = await handlers.ingest(request('POST', undefined, { ...payload(current), textContent: 'Merchant: Electric Utility' }), context);
    assert.equal((missing.jsonBody as { kind: string }).kind, 'needs_review');
    assert.equal((await store.recent(bob)).length, 0);
    const bills = await db.bill.findMany({ where: { ownerUid: alice } });
    assert.equal(bills.length, 2);
    assert.ok(bills.every(bill => bill.status === 'AWAITING_APPROVAL' && bill.approvalRequired));
    assert.equal(await db.approval.count({ where: { ownerUid: alice, status: 'pending' } }), 2);
    const actions = (await db.auditEvent.findMany({ where: { ownerUid: alice } })).map(event => event.action);
    for (const action of ['forwarding_alias.created', 'forwarding_alias.rotated', 'email.received', 'attachment.quarantined',
      'malware_scan.result_received', 'bill.parsed', 'bill.matched', 'bill.possible_duplicate', 'bill.rejected', 'bill.created']) {
      assert.ok(actions.includes(action), action);
    }
    assert.equal((await handlers.revoke(request('DELETE', alice), context)).status, 200);
    assert.equal((await handlers.ingest(request('POST', undefined, payload(current)), context)).status, 404);
  } finally {
    const owners = [alice, bob];
    await db.auditEvent.deleteMany({ where: { ownerUid: { in: owners } } });
    await db.approval.deleteMany({ where: { ownerUid: { in: owners } } });
    await db.billSubmission.deleteMany({ where: { ownerUid: { in: owners } } });
    await db.bill.deleteMany({ where: { ownerUid: { in: owners } } });
    await db.forwardingAlias.deleteMany({ where: { ownerUid: { in: owners } } });
    await db.$disconnect();
    if (previousKey === undefined) delete process.env.FORWARDING_ALIAS_ENCRYPTION_KEY;
    else process.env.FORWARDING_ALIAS_ENCRYPTION_KEY = previousKey;
  }
});
