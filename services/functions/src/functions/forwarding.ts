import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { authenticate, type VerifyToken } from '../services/auth.js';
import { getForwardingStore, InvalidIngestionError, validateIngestion, type ForwardingStore } from '../services/forwarding.js';

type Options = { verify?: VerifyToken; store?: ForwardingStore };
const headers = { 'Cache-Control': 'no-store' };
export function createForwardingHandlers(options: Options = {}) {
  const store = () => options.store ?? getForwardingStore();
  async function manage(request: HttpRequest, context: InvocationContext, operation: 'get' | 'create' | 'rotate' | 'revoke'): Promise<HttpResponseInit> {
    const auth = await authenticate(request, context, options.verify);
    if (auth.response) return { ...auth.response, headers };
    try {
      if (operation === 'get') {
        const [address, recent] = await Promise.all([store().current(auth.user.uid), store().recent(auth.user.uid)]);
        return { headers, jsonBody: { address, recent } };
      }
      const address = await store().change(auth.user.uid, operation);
      if (operation === 'rotate' && !address) return { status: 404, headers, jsonBody: { error: 'Forwarding address not found' } };
      return { status: operation === 'create' ? 201 : 200, headers, jsonBody: { address } };
    } catch {
      context.error('Forwarding address operation failed');
      return { status: 500, headers, jsonBody: { error: 'Forwarding service unavailable' } };
    }
  }
  async function ingest(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    try {
      const body = await request.text();
      if (body.length > 150000) return { status: 413, headers, jsonBody: { error: 'Payload too large' } };
      let raw: unknown;
      try { raw = JSON.parse(body); } catch { return { status: 400, headers, jsonBody: { error: 'Invalid JSON' } }; }
      const result = await store().ingest(validateIngestion(raw));
      if (result.kind === 'unknown') return { status: 404, headers, jsonBody: { error: 'Unknown or revoked address' } };
      if (result.kind === 'quarantined' || result.kind === 'rejected') return { status: 422, headers, jsonBody: result };
      return { status: 201, headers, jsonBody: result };
    } catch (error) {
      if (error instanceof InvalidIngestionError) return { status: 400, headers, jsonBody: { error: error.message } };
      context.error('Forwarded bill ingestion failed');
      return { status: 500, headers, jsonBody: { error: 'Ingestion service unavailable' } };
    }
  }
  return {
    get: (r: HttpRequest, c: InvocationContext) => manage(r, c, 'get'),
    create: (r: HttpRequest, c: InvocationContext) => manage(r, c, 'create'),
    rotate: (r: HttpRequest, c: InvocationContext) => manage(r, c, 'rotate'),
    revoke: (r: HttpRequest, c: InvocationContext) => manage(r, c, 'revoke'),
    ingest,
  };
}
const handlers = createForwardingHandlers();
app.http('forwardingGet', { methods: ['GET'], authLevel: 'anonymous', route: 'bill-forwarding', handler: handlers.get });
app.http('forwardingCreate', { methods: ['POST'], authLevel: 'anonymous', route: 'bill-forwarding/create', handler: handlers.create });
app.http('forwardingRotate', { methods: ['POST'], authLevel: 'anonymous', route: 'bill-forwarding/rotate', handler: handlers.rotate });
app.http('forwardingRevoke', { methods: ['DELETE'], authLevel: 'anonymous', route: 'bill-forwarding', handler: handlers.revoke });
app.http('forwardedBillIngest', { methods: ['POST'], authLevel: 'function', route: 'internal/bills/ingest', handler: handlers.ingest });
