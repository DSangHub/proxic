import { strict as assert } from 'node:assert';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { HttpRequest, InvocationContext } from '@azure/functions';
import { PrismaClient, type PlaidConnectionState } from '@prisma/client';
import type { DecodedIdToken } from 'firebase-admin/auth';
import type { Plaid } from 'plaid';
import { createPlaidHandlers } from '../src/functions/plaid.js';
import { decryptPlaidToken, encryptPlaidToken } from '../src/services/plaid-crypto.js';
import { PlaidConflictError, PlaidService, PrismaConnectionStore, SandboxPlaidGateway, type BankMetadata, type ConnectionStore, type PlaidGateway } from '../src/services/plaid.js';

process.env.PLAID_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('hex');
const context = new InvocationContext();
const user = (uid: string): DecodedIdToken => ({
  uid, sub: uid, aud: 'project', iss: 'issuer', auth_time: 1, iat: 1, exp: 9999999999,
  firebase: { identities: {}, sign_in_provider: 'test' },
});
const verify = async (token: string) => user(token);
const request = (method: string, token?: string, body?: unknown) => new HttpRequest({
  method, url: 'http://localhost/api/plaid', headers: token ? { authorization: `Bearer ${token}` } : {},
  ...(body === undefined ? {} : { body: { string: JSON.stringify(body) } }),
});

class MemoryStore implements ConnectionStore {
  rows = new Map<string, { status: PlaidConnectionState; encryptedToken: string }>();
  metadata = new Map<string, BankMetadata>();
  audits: { ownerUid: string; action: string; stage?: 'link' | 'exchange' }[] = [];
  async get(ownerUid: string) { return this.rows.get(ownerUid) ?? null; }
  async getMetadata(ownerUid: string) {
    const row = this.rows.get(ownerUid);
    if (!row) return null;
    const metadata = this.metadata.get(ownerUid);
    return {
      status: row.status, institutionName: metadata?.institutionName ?? null,
      accounts: (metadata?.accounts ?? []).map(({ accountId, mask, type, subtype }) => ({ accountId, mask, type, subtype })),
    };
  }
  async create(ownerUid: string, encryptedToken: string) {
    if (this.rows.has(ownerUid)) throw new PlaidConflictError('Already connected');
    this.rows.set(ownerUid, { status: 'LINKING', encryptedToken });
  }
  async transition(ownerUid: string, from: PlaidConnectionState, to: PlaidConnectionState, expected: string, encryptedToken?: string) {
    const row = this.rows.get(ownerUid);
    if (!row || row.status !== from || row.encryptedToken !== expected) return false;
    this.rows.set(ownerUid, { status: to, encryptedToken: encryptedToken ?? row.encryptedToken });
    if (from === 'EXCHANGING' && to === 'ACTIVE') this.audits.push({ ownerUid, action: 'bank.connected' });
    return true;
  }
  async delete(ownerUid: string, status: PlaidConnectionState, expected: string) {
    const row = this.rows.get(ownerUid);
    if (!row || row.status !== status || row.encryptedToken !== expected) return false;
    this.metadata.delete(ownerUid);
    if (status === 'DISCONNECTING') this.audits.push({ ownerUid, action: 'bank.disconnected' });
    return this.rows.delete(ownerUid);
  }
  async connectionFailed(ownerUid: string, stage: 'link' | 'exchange') {
    this.audits.push({ ownerUid, action: 'bank.connection_failed', stage });
  }
  async syncMetadata(ownerUid: string, expected: string, metadata: BankMetadata) {
    const row = this.rows.get(ownerUid);
    if (!row || row.status !== 'ACTIVE' || row.encryptedToken !== expected) return false;
    this.metadata.set(ownerUid, metadata);
    return true;
  }
}

class FakeGateway implements PlaidGateway {
  removed: string[] = [];
  used: { token: string; live: boolean }[] = [];
  shouldFailRemove = false;
  async createLink(ownerUid: string) { return { linkToken: `link-sandbox-${ownerUid}`, expiration: '2027-01-01T00:00:00Z' }; }
  async linkInstitution(linkToken: string, publicToken: string) {
    return publicToken === linkToken.replace('link-', 'public-')
      ? { institutionId: 'ins_1', institutionName: 'Example Bank' } : null;
  }
  async exchange(publicToken: string) { return { accessToken: publicToken.replace('public-', 'access-'), itemId: 'item' }; }
  async accounts(accessToken: string, liveBalance: boolean): Promise<{ itemId: string; institutionId: string | null; institutionName: string | null; accounts: Plaid.AccountBase[] }> {
    this.used.push({ token: accessToken, live: liveBalance });
    return { itemId: 'item', institutionId: 'ins_1', institutionName: 'Example Bank', accounts: [{
      account_id: 'account', name: 'Checking', mask: '1234', official_name: null, type: 'depository', subtype: 'checking',
      balances: { available: 2, current: 3, limit: null, iso_currency_code: 'USD', unofficial_currency_code: null },
    }] };
  }
  async remove(accessToken: string) {
    if (this.shouldFailRemove) throw new Error('upstream failure');
    this.removed.push(accessToken);
  }
}

test('encryption authenticates token and owner and rejects invalid key configuration', () => {
  const ciphertext = encryptPlaidToken('access-sandbox-secret', 'alice');
  assert.ok(!ciphertext.includes('access-sandbox-secret'));
  assert.equal(decryptPlaidToken(ciphertext, 'alice'), 'access-sandbox-secret');
  assert.throws(() => decryptPlaidToken(ciphertext, 'bob'));
  const parts = ciphertext.split('.');
  parts[2] = Buffer.alloc(16).toString('base64url');
  assert.throws(() => decryptPlaidToken(parts.join('.'), 'alice'));
  const key = process.env.PLAID_TOKEN_ENCRYPTION_KEY;
  process.env.PLAID_TOKEN_ENCRYPTION_KEY = 'short';
  assert.throws(() => encryptPlaidToken('secret', 'alice'));
  process.env.PLAID_TOKEN_ENCRYPTION_KEY = key;
});

test('all endpoints authenticate before using Plaid or a store', async () => {
  const handlers = createPlaidHandlers();
  for (const handler of Object.values(handlers)) {
    const response = await handler(request('GET'), context);
    assert.equal(response.status, 401);
    assert.equal(new Headers(response.headers).get('Cache-Control'), 'no-store');
  }
});

test('link, exchange, account access and disconnect are scoped to the verified user', async () => {
  const store = new MemoryStore();
  const gateway = new FakeGateway();
  const handlers = createPlaidHandlers({ verify, service: new PlaidService(store, gateway) });
  const link = await handlers.link(request('POST', 'alice'), context);
  assert.deepEqual(link.jsonBody, { linkToken: 'link-sandbox-alice', expiration: '2027-01-01T00:00:00Z' });
  assert.equal((await handlers.link(request('POST', 'alice'), context)).status, 409);
  assert.equal((await handlers.accounts(request('GET', 'bob'), context)).status, 404);
  assert.equal((await handlers.disconnect(request('DELETE', 'bob'), context)).status, 404);
  assert.equal((await handlers.connection(request('GET', 'bob'), context)).status, 404);
  assert.deepEqual((await handlers.connection(request('GET', 'alice'), context)).jsonBody, {
    status: 'LINKING', institutionName: null, accounts: [],
  });
  assert.equal((await handlers.exchange(request('POST', 'bob', { publicToken: 'public-sandbox-alice' }), context)).status, 404);
  assert.equal((await handlers.exchange(request('POST', 'alice', { publicToken: 'public-sandbox-bob' }), context)).status, 400);
  assert.equal((await handlers.exchange(request('POST', 'alice', { publicToken: 'public-production-alice' }), context)).status, 400);
  assert.equal((await handlers.exchange(request('POST', 'alice', { publicToken: 'public-sandbox-alice', ownerUid: 'bob' }), context)).status, 400);
  assert.equal((await handlers.exchange(request('POST', 'alice', { publicToken: 'public-sandbox-alice' }), context)).status, 204);
  assert.equal(store.rows.get('alice')?.status, 'ACTIVE');
  assert.deepEqual((await handlers.connection(request('GET', 'alice'), context)).jsonBody, {
    status: 'ACTIVE', institutionName: 'Example Bank',
    accounts: [{ accountId: 'account', mask: '1234', type: 'depository', subtype: 'checking' }],
  });
  assert.ok(!store.rows.get('alice')?.encryptedToken.includes('access-sandbox-alice'));
  assert.equal((await handlers.accounts(request('GET', 'bob'), context)).status, 404);
  assert.equal((await handlers.balance(request('GET', 'bob'), context)).status, 404);
  assert.equal((await handlers.disconnect(request('DELETE', 'bob'), context)).status, 404);
  const accounts = await handlers.accounts(request('GET', 'alice'), context);
  assert.deepEqual(accounts.jsonBody, { accounts: [{
    accountId: 'account', name: 'Checking', mask: '1234', type: 'depository', subtype: 'checking',
    balances: { available: 2, current: 3, limit: null, isoCurrencyCode: 'USD', unofficialCurrencyCode: null },
  }] });
  await handlers.balance(request('GET', 'alice'), context);
  assert.deepEqual(gateway.used.map(entry => entry.live), [false, false, true]);
  assert.deepEqual(store.metadata.get('alice'), {
    itemId: 'item', institutionId: 'ins_1', institutionName: 'Example Bank',
    accounts: [{ accountId: 'account', displayName: 'Checking', mask: '1234', type: 'depository', subtype: 'checking' }],
  });
  gateway.shouldFailRemove = true;
  assert.equal((await handlers.disconnect(request('DELETE', 'alice'), context)).status, 502);
  assert.equal(store.rows.get('alice')?.status, 'DISCONNECTING');
  assert.equal((await handlers.accounts(request('GET', 'alice'), context)).status, 409);
  gateway.shouldFailRemove = false;
  assert.equal((await handlers.disconnect(request('DELETE', 'alice'), context)).status, 204);
  assert.deepEqual(gateway.removed, ['access-sandbox-alice']);
  assert.equal(store.rows.has('alice'), false);
});

test('simultaneous exchange consumes a session only once', async () => {
  const gateway = new FakeGateway();
  const service = new PlaidService(new MemoryStore(), gateway);
  await service.link('alice');
  const results = await Promise.allSettled([
    service.exchange('alice', 'public-sandbox-alice'),
    service.exchange('alice', 'public-sandbox-alice'),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
});

test('exchange persistence failure removes the newly created Plaid Item', async () => {
  const store = new MemoryStore();
  const gateway = new FakeGateway();
  const service = new PlaidService(store, gateway);
  await service.link('alice');
  const originalTransition = store.transition.bind(store);
  store.transition = async (...args) => {
    if (args[2] === 'ACTIVE') throw new Error('database unavailable');
    return originalTransition(...args);
  };
  await assert.rejects(service.exchange('alice', 'public-sandbox-alice'));
  assert.deepEqual(gateway.removed, ['access-sandbox-alice']);
  assert.equal(await store.get('alice'), null);
});

test('ambiguous exchange failures stay locked and do not expose upstream errors', async () => {
  const store = new MemoryStore();
  const gateway = new FakeGateway();
  gateway.exchange = async () => { throw new Error('sensitive upstream message'); };
  const handlers = createPlaidHandlers({ verify, service: new PlaidService(store, gateway) });
  await handlers.link(request('POST', 'alice'), context);
  const failed = await handlers.exchange(request('POST', 'alice', { publicToken: 'public-sandbox-alice' }), context);
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.jsonBody, { error: 'Plaid Sandbox service unavailable' });
  assert.equal((await store.get('alice'))?.status, 'EXCHANGING');
  assert.equal((await handlers.disconnect(request('DELETE', 'alice'), context)).status, 409);
  assert.equal((await handlers.exchange(request('POST', 'alice', { publicToken: 'public-sandbox-alice' }), context)).status, 409);
});

test('pending Link sessions can be canceled and replaced', async () => {
  const store = new MemoryStore();
  const service = new PlaidService(store, new FakeGateway());
  await service.link('alice');
  await service.disconnect('alice');
  assert.deepEqual(store.audits, []);
  assert.equal((await service.link('alice')).linkToken, 'link-sandbox-alice');
});

test('connection failures are audited without provider details and audit failures are surfaced', async () => {
  const store = new MemoryStore();
  const gateway = new FakeGateway();
  gateway.createLink = async () => { throw new Error('provider-secret'); };
  const handlers = createPlaidHandlers({ verify, service: new PlaidService(store, gateway) });
  assert.equal((await handlers.link(request('POST', 'alice'), context)).status, 502);
  assert.equal((await handlers.exchange(request('POST', 'bob', { publicToken: 'invalid-secret' }), context)).status, 400);
  assert.equal((await handlers.exchange(request('POST', 'bob', { unexpected: 'invalid-secret' }), context)).status, 400);
  assert.deepEqual(store.audits, [
    { ownerUid: 'alice', action: 'bank.connection_failed', stage: 'link' },
    { ownerUid: 'bob', action: 'bank.connection_failed', stage: 'exchange' },
    { ownerUid: 'bob', action: 'bank.connection_failed', stage: 'exchange' },
  ]);
  assert.doesNotMatch(JSON.stringify(store.audits), /provider-secret|invalid-secret/);
  store.connectionFailed = async () => { throw new Error('database unavailable'); };
  assert.equal((await handlers.link(request('POST', 'alice'), context)).status, 502);
});

test('metadata lookup failure preserves the encrypted connection for retry', async () => {
  const store = new MemoryStore();
  const gateway = new FakeGateway();
  const original = gateway.accounts.bind(gateway);
  gateway.accounts = async () => { throw new Error('upstream unavailable'); };
  const service = new PlaidService(store, gateway);
  await service.link('alice');
  await assert.rejects(service.exchange('alice', 'public-sandbox-alice'));
  assert.equal((await store.get('alice'))?.status, 'ACTIVE');
  assert.deepEqual(gateway.removed, []);
  gateway.accounts = original;
  assert.equal((await service.accounts('alice', false))[0].mask, '1234');
  assert.equal(store.metadata.get('alice')?.itemId, 'item');
});

test('Plaid SDK sends Sandbox requests and checks Link session tokens', async () => {
  const oldFetch = globalThis.fetch;
  const oldEnv = { ...process.env };
  const paths: string[] = [];
  try {
    process.env.PLAID_ENV = 'sandbox';
    process.env.PLAID_CLIENT_ID = 'test-client';
    process.env.PLAID_SECRET = 'test-secret';
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://sandbox.plaid.com');
      paths.push(url.pathname);
      if (url.pathname === '/link/token/create') return Response.json({ link_token: 'link-sandbox-one', expiration: '2027-01-01T00:00:00Z', request_id: 'r' });
      if (url.pathname === '/link/token/get') return Response.json({
        link_token: 'link-sandbox-one', created_at: null, expiration: null, metadata: {}, request_id: 'r',
        link_sessions: [{ link_session_id: 'x', results: { item_add_results: [{ public_token: 'public-sandbox-one', institution: { institution_id: 'ins_1', name: 'Example Bank' } }] },
          on_success: { public_token: 'public-sandbox-legacy', metadata: null } }],
      });
      if (url.pathname === '/item/public_token/exchange') return Response.json({ access_token: 'access-sandbox-one', item_id: 'item', request_id: 'r' });
      if (url.pathname === '/accounts/get' || url.pathname === '/accounts/balance/get') return Response.json({
        accounts: [{ account_id: 'a', name: 'Checking', mask: '1234', official_name: null, type: 'depository', subtype: 'checking',
          balances: { available: 2, current: 3, limit: null, iso_currency_code: 'USD', unofficial_currency_code: null } }],
        item: { item_id: 'item', institution_id: 'ins_1', institution_name: 'Example Bank' }, request_id: 'r',
      });
      if (url.pathname === '/item/remove') return Response.json({ request_id: 'r' });
      throw new Error(`Unexpected request ${url.pathname}`);
    };
    const gateway = new SandboxPlaidGateway();
    assert.equal((await gateway.createLink('alice')).linkToken, 'link-sandbox-one');
    assert.deepEqual(await gateway.linkInstitution('link-sandbox-one', 'public-sandbox-one'), { institutionId: 'ins_1', institutionName: 'Example Bank' });
    assert.equal(await gateway.linkInstitution('link-sandbox-one', 'public-sandbox-other'), null);
    assert.deepEqual(await gateway.linkInstitution('link-sandbox-one', 'public-sandbox-legacy'), { institutionId: null, institutionName: null });
    assert.equal((await gateway.exchange('public-sandbox-one')).accessToken, 'access-sandbox-one');
    const accountResult = await gateway.accounts('access-sandbox-one', false);
    assert.equal(accountResult.institutionName, 'Example Bank');
    assert.equal(accountResult.accounts[0].account_id, 'a');
    assert.equal((await gateway.accounts('access-sandbox-one', true)).accounts[0].balances.current, 3);
    await gateway.remove('access-sandbox-one');
    assert.deepEqual(paths, ['/link/token/create', '/link/token/get', '/link/token/get', '/link/token/get',
      '/item/public_token/exchange', '/accounts/get', '/accounts/balance/get', '/item/remove']);
    process.env.PLAID_ENV = 'production';
    assert.throws(() => new SandboxPlaidGateway());
  } finally {
    globalThis.fetch = oldFetch;
    for (const name of ['PLAID_ENV', 'PLAID_CLIENT_ID', 'PLAID_SECRET']) {
      if (oldEnv[name] === undefined) delete process.env[name];
      else process.env[name] = oldEnv[name];
    }
  }
});

test('PostgreSQL connection persistence uses UID and conditional state transitions', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const db = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
  const owner = `plaid-test-${randomUUID()}`;
  const store = new PrismaConnectionStore(db);
  try {
    await store.create(owner, 'encrypted');
    assert.equal((await db.bankConnection.findUniqueOrThrow({ where: { ownerUid: owner } })).status, 'LINKING');
    assert.equal(await store.get(`${owner}-other`), null);
    await assert.rejects(store.create(owner, 'another'), PlaidConflictError);
    assert.equal(await store.transition(owner, 'LINKING', 'EXCHANGING', 'wrong'), false);
    assert.equal(await store.transition(owner, 'LINKING', 'EXCHANGING', 'encrypted'), true);
    assert.equal((await db.bankConnection.findUniqueOrThrow({ where: { ownerUid: owner } })).status, 'EXCHANGING');
    assert.equal(await store.transition(owner, 'LINKING', 'EXCHANGING', 'encrypted'), false);
    assert.equal(await store.delete(owner, 'EXCHANGING', 'wrong'), false);
    assert.equal(await store.delete(owner, 'EXCHANGING', 'encrypted'), true);
    assert.equal(await db.bankConnection.findUnique({ where: { ownerUid: owner } }), null);
  } finally {
    await db.plaidConnection.deleteMany({ where: { ownerUid: owner } });
    await db.$disconnect();
  }
});

test('PostgreSQL stores owner-scoped bank metadata separately from encrypted tokens', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const db = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
  const owner = `plaid-test-${randomUUID()}`;
  const gateway = new FakeGateway();
  const originalAccounts = gateway.accounts.bind(gateway);
  gateway.accounts = async (token, live) => {
    const result = await originalAccounts(token, live);
    return {
      ...result,
      accounts: [
        Object.assign({}, result.accounts[0], {
          account_number: 'full-account-number', password: 'bank-password', username: 'bank-username',
        }),
        { ...result.accounts[0], account_id: 'other-account', name: 'Savings', mask: '123456789012' },
      ],
    };
  };
  const service = new PlaidService(new PrismaConnectionStore(db), gateway);
  const handlers = createPlaidHandlers({ verify, service });
  try {
    assert.equal((await handlers.link(request('POST', owner), context)).status ?? 200, 200);
    assert.equal((await handlers.exchange(request('POST', owner, { publicToken: `public-sandbox-${owner}` }), context)).status, 204);
    const secretRow = await db.plaidConnection.findUniqueOrThrow({ where: { ownerUid: owner } });
    assert.notEqual(secretRow.encryptedToken, `access-sandbox-${owner}`);
    assert.equal(decryptPlaidToken(secretRow.encryptedToken, owner), `access-sandbox-${owner}`);
    const saved = await db.bankConnection.findUniqueOrThrow({ where: { ownerUid: owner }, include: { accounts: true } });
    assert.equal(saved.ownerUid, owner);
    assert.equal(saved.provider, 'PLAID');
    assert.equal(saved.status, 'ACTIVE');
    assert.equal(saved.plaidItemId, 'item');
    assert.equal(saved.institutionId, 'ins_1');
    assert.equal(saved.institutionName, 'Example Bank');
    assert.equal(saved.accounts.length, 2);
    assert.equal(saved.accounts.find(account => account.accountId === 'other-account')?.mask, null);
    assert.equal(saved.accounts.find(account => account.accountId === 'account')?.mask, '1234');
    const persisted = JSON.stringify(saved);
    for (const forbidden of ['access-sandbox-', 'full-account-number', 'bank-password', 'bank-username', 'available', 'balances']) {
      assert.equal(persisted.includes(forbidden), false);
    }
    const otherOwner = `${owner}-other`;
    assert.equal((await handlers.accounts(request('GET', otherOwner), context)).status, 404);
    assert.equal((await handlers.connection(request('GET', otherOwner), context)).status, 404);
    const connection = await handlers.connection(request('GET', owner), context);
    assert.equal(JSON.stringify(connection.jsonBody).includes('access-sandbox-'), false);
    assert.equal(JSON.stringify(connection.jsonBody).includes('full-account-number'), false);
    assert.equal((connection.jsonBody as { institutionName: string }).institutionName, 'Example Bank');
    const response = await handlers.accounts(request('GET', owner), context);
    assert.equal(JSON.stringify(response.jsonBody).includes('access-sandbox-'), false);
    assert.equal(JSON.stringify(response.jsonBody).includes('full-account-number'), false);
    assert.equal((response.jsonBody as { accounts: { mask: string | null }[] }).accounts[1].mask, null);

    gateway.accounts = async (token, live) => {
      const result = await originalAccounts(token, live);
      return { ...result, institutionName: null, accounts: [{ ...result.accounts[0], name: 'Updated checking' }] };
    };
    await service.accounts(owner, false);
    const refreshed = await db.bankConnection.findUniqueOrThrow({ where: { ownerUid: owner }, include: { accounts: true } });
    assert.equal(refreshed.institutionName, 'Example Bank');
    assert.equal(refreshed.accounts.length, 1);
    assert.equal(refreshed.accounts[0].displayName, 'Updated checking');
    assert.equal(refreshed.accounts[0].id, saved.accounts.find(account => account.accountId === 'account')?.id);
    const store = new PrismaConnectionStore(db);
    const unexpected: BankMetadata = { itemId: 'other-item', institutionId: 'x', institutionName: 'Wrong', accounts: [] };
    assert.equal(await store.syncMetadata(`${owner}-other`, secretRow.encryptedToken, unexpected), false);
    assert.equal(await store.syncMetadata(owner, 'different-token', unexpected), false);
    await assert.rejects(store.syncMetadata(owner, secretRow.encryptedToken, unexpected));
    assert.equal((await db.bankConnection.findUniqueOrThrow({ where: { ownerUid: owner }, include: { accounts: true } })).accounts.length, 1);
    assert.equal((await handlers.disconnect(request('DELETE', owner), context)).status, 204);
    assert.equal(await db.bankConnection.findUnique({ where: { ownerUid: owner } }), null);
    assert.equal(await db.bankAccount.count({ where: { bankConnectionId: saved.id } }), 0);
    assert.equal((await handlers.connection(request('GET', owner), context)).status, 404);
    assert.equal((await handlers.exchange(request('POST', owner, { publicToken: 'invalid-token' }), context)).status, 400);
    const events = await db.auditEvent.findMany({ where: { ownerUid: owner }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(events.map(event => event.action), ['bank.connected', 'bank.disconnected', 'bank.connection_failed']);
    assert.deepEqual(events.map(event => event.actor), [owner, owner, owner]);
    assert.equal(events[0].resource, `bank_connection:${saved.id}`);
    assert.equal(events[1].resource, `bank_connection:${saved.id}`);
    assert.deepEqual(events[2].metadata, { stage: 'exchange' });
    assert.equal(await db.auditEvent.count({ where: { ownerUid: otherOwner } }), 0);
    for (const forbidden of ['access-sandbox-', 'public-sandbox-', 'invalid-token', 'bank-password', 'bank-username', 'full-account-number']) {
      assert.equal(JSON.stringify(events).includes(forbidden), false);
    }
  } finally {
    await db.plaidConnection.deleteMany({ where: { ownerUid: owner } });
    await db.auditEvent.deleteMany({ where: { ownerUid: owner } });
    await db.$disconnect();
  }
});
