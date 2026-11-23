import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { authenticate, type VerifyToken } from '../services/auth.js';

export function createMeHandler(verify?: VerifyToken) {
  return async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const result = await authenticate(request, context, verify);
    if (result.response) return result.response;
    const { uid, email, name, picture } = result.user;
    return { jsonBody: { uid, email: email ?? null, name: name ?? null, picture: picture ?? null } };
  };
}

app.http('authMe', { methods: ['GET'], authLevel: 'anonymous', route: 'auth/me', handler: createMeHandler() });
