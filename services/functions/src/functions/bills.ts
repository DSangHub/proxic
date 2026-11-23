import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { authenticate, type VerifyToken } from '../services/auth.js';
import { InvalidBillError } from '../services/bill-input.js';
import { DuplicateBillError, getBillStore, ingestManualBill, type BillStore } from '../services/bills.js';

type Options = { verify?: VerifyToken; store?: BillStore };
const headers = { 'Cache-Control': 'no-store' };

export function createBillHandlers(options: Options = {}) {
  const store = () => options.store ?? getBillStore();

  async function collection(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const auth = await authenticate(request, context, options.verify);
    if (auth.response) return { ...auth.response, headers };
    try {
      if (request.method === 'GET') return { headers, jsonBody: await store().list(auth.user.uid) };
      const body = await request.text();
      if (body.length > 2048) return { status: 413, headers, jsonBody: { error: 'Bill submission too large' } };
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        return { status: 400, headers, jsonBody: { error: 'Invalid JSON' } };
      }
      const bill = await ingestManualBill(store(), auth.user.uid, raw);
      return { status: 201, headers, jsonBody: bill };
    } catch (error) {
      if (error instanceof InvalidBillError) return { status: 400, headers, jsonBody: { error: error.message } };
      if (error instanceof DuplicateBillError) return { status: 409, headers, jsonBody: { error: error.message } };
      context.error('Bill request failed', error);
      return { status: 500, headers, jsonBody: { error: 'Bill service unavailable' } };
    }
  }

  async function detail(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const auth = await authenticate(request, context, options.verify);
    if (auth.response) return { ...auth.response, headers };
    try {
      const bill = await store().review(auth.user.uid, request.params.id);
      return bill ? { headers, jsonBody: bill } : { status: 404, headers, jsonBody: { error: 'Bill not found' } };
    } catch (error) {
      context.error('Bill review failed', error);
      return { status: 500, headers, jsonBody: { error: 'Bill service unavailable' } };
    }
  }

  function decide(decision: 'approve' | 'reject') {
    return async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
      const auth = await authenticate(request, context, options.verify);
      if (auth.response) return { ...auth.response, headers };
      try {
        const result = await store().decide(auth.user.uid, request.params.id, decision);
        if (result.kind === 'not_found') return { status: 404, headers, jsonBody: { error: 'Bill not found' } };
        if (result.kind === 'conflict') return { status: 409, headers, jsonBody: { error: 'Bill is not awaiting approval' } };
        return { headers, jsonBody: result.bill };
      } catch (error) {
        context.error('Bill decision failed', error);
        return { status: 500, headers, jsonBody: { error: 'Bill service unavailable' } };
      }
    };
  }
  return { collection, detail, approve: decide('approve'), reject: decide('reject') };
}

const handlers = createBillHandlers();
app.http('bills', { methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'bills', handler: handlers.collection });
app.http('billDetail', { methods: ['GET'], authLevel: 'anonymous', route: 'bills/{id}', handler: handlers.detail });
app.http('billApprove', { methods: ['POST'], authLevel: 'anonymous', route: 'bills/{id}/approve', handler: handlers.approve });
app.http('billReject', { methods: ['POST'], authLevel: 'anonymous', route: 'bills/{id}/reject', handler: handlers.reject });
