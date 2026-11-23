import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HttpRequest, InvocationContext } from '@azure/functions';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { createMeHandler } from '../src/functions/me.js';
import { createProxyHandler } from '../src/functions/proxy.js';
import type { VerifyToken } from '../src/services/auth.js';

const user: DecodedIdToken = {
  uid: 'user-123', sub: 'user-123', aud: 'project', iss: 'issuer',
  auth_time: 1, iat: 1, exp: 9999999999, firebase: { identities: {}, sign_in_provider: 'google.com' },
  email: 'user@example.com', name: 'User',
};
const context = new InvocationContext();
const verify: VerifyToken = async token => {
  assert.equal(token, 'valid-token');
  return user;
};
const request = (authorization?: string, body?: string) => new HttpRequest({
  method: body === undefined ? 'GET' : 'POST',
  url: 'http://localhost/api/test',
  headers: authorization ? { authorization } : {},
  ...(body === undefined ? {} : { body: { string: body } }),
});

test('both endpoints reject missing or malformed authorization before verifying', async () => {
  const neverVerify: VerifyToken = async () => { throw new Error('must not verify'); };
  for (const header of [undefined, 'Basic abc', 'Bearer', 'Bearer token extra', 'Bearer ']) {
    assert.equal((await createMeHandler(neverVerify)(request(header), context)).status, 401);
    assert.equal((await createProxyHandler(neverVerify)(request(header, '{'), context)).status, 401);
  }
});

test('both endpoints reject invalid, expired and revoked tokens', async () => {
  for (const code of ['auth/argument-error', 'auth/invalid-id-token', 'auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled']) {
    const reject: VerifyToken = async () => { throw Object.assign(new Error('invalid'), { code }); };
    assert.equal((await createMeHandler(reject)(request('Bearer bad'), context)).status, 401);
    assert.equal((await createProxyHandler(reject)(request('Bearer bad', '{}'), context)).status, 401);
  }
});

test('verification service errors are not reported as invalid tokens', async () => {
  const fail: VerifyToken = async () => { throw new Error('credentials unavailable'); };
  const response = await createMeHandler(fail)(request('Bearer token'), context);
  assert.equal(response.status, 500);
  assert.deepEqual(response.jsonBody, { error: 'Authentication service unavailable' });
});

test('auth/me returns the verified user profile', async () => {
  const response = await createMeHandler(verify)(request('Bearer valid-token'), context);
  assert.deepEqual(response.jsonBody, { uid: 'user-123', email: 'user@example.com', name: 'User', picture: null });
});

test('real Firebase Admin verification rejects a malformed token', async () => {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  try {
    process.env.FIREBASE_PROJECT_ID = 'proxic-test';
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
    const response = await createMeHandler()(request('Bearer not-a-jwt'), context);
    assert.equal(response.status, 401);
  } finally {
    for (const [key, value] of Object.entries({
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_CLIENT_EMAIL: clientEmail,
      FIREBASE_PRIVATE_KEY: privateKey,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('proxy validates body after authentication and preserves successful behavior', async () => {
  const handler = createProxyHandler(verify);
  assert.equal((await handler(request('Bearer valid-token', '{'), context)).status, 400);
  for (const body of ['null', '{}', '{"message":42}', '{"message":"  "}']) {
    assert.equal((await handler(request('Bearer valid-token', body), context)).status, 400);
  }
  const result = await handler(request('Bearer valid-token', '{"message":"Remind me tomorrow"}'), context);
  assert.equal(result.status, 201);
  assert.equal((result.jsonBody as { description: string }).description, 'Remind me tomorrow');
});
