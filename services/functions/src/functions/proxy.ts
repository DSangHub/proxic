import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { route } from '../agents/router.js';
import { authenticate, type VerifyToken } from '../services/auth.js';
import { propose } from '../services/propose.js';

export function createProxyHandler(verify?: VerifyToken) {
  return async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const auth = await authenticate(request, context, verify);
    if (auth.response) return auth.response;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return { status: 400, jsonBody: { error: 'invalid JSON' } };
    }
    if (typeof body !== 'object' || body === null || !('message' in body) ||
        typeof body.message !== 'string' || !body.message.trim()) {
      return { status: 400, jsonBody: { error: 'message is required' } };
    }
    try {
      const action = propose(route(body.message), body.message);
      context.log(`Created proposed action ${action.id}`);
      return { status: 201, jsonBody: action };
    } catch (error) {
      context.error('Failed to create proposed action', error);
      return { status: 500, jsonBody: { error: 'Failed to create proposed action' } };
    }
  };
}

app.http('proxy', { methods: ['POST'], authLevel: 'anonymous', route: 'proxy', handler: createProxyHandler() });
