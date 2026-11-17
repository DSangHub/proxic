import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

type VerifyToken = (token: string) => Promise<DecodedIdToken>;

function verifyFirebaseToken(token: string): Promise<DecodedIdToken> {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!projectId || Boolean(clientEmail) !== Boolean(privateKey)) {
    throw new Error('Firebase Admin credentials are not configured correctly');
  }
  const firebaseApp = getApps().find(app => app.name === 'proxic') ?? initializeApp({
    projectId,
    credential: clientEmail && privateKey
      ? cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') })
      : applicationDefault(),
  }, 'proxic');
  return getAuth(firebaseApp).verifyIdToken(token, true);
}

const invalidTokenCodes = new Set([
  'auth/argument-error',
  'auth/invalid-id-token',
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/user-disabled',
  'auth/user-not-found',
]);

export async function authenticate(
  request: HttpRequest,
  context: InvocationContext,
  verify: VerifyToken = verifyFirebaseToken,
): Promise<{ user: DecodedIdToken; response?: never } | { user?: never; response: HttpResponseInit }> {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '');
  if (!match) return { response: { status: 401, jsonBody: { error: 'Bearer token required' } } };

  try {
    return { user: await verify(match[1]) };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error &&
        typeof error.code === 'string' && invalidTokenCodes.has(error.code)) {
      return { response: { status: 401, jsonBody: { error: 'Invalid or expired token' } } };
    }
    context.error('Firebase token verification failed', error);
    return { response: { status: 500, jsonBody: { error: 'Authentication service unavailable' } } };
  }
}

export type { VerifyToken };
