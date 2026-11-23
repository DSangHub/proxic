import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { authenticate, type VerifyToken } from '../services/auth.js';
import {
  getPaymentPolicyStore, InvalidPaymentPolicyError, PaymentConflictError, PaymentResourceNotFoundError,
  PaymentPolicyConflictError, type PaymentPolicyStore,
} from '../services/payment-policy.js';

type Options = { verify?: VerifyToken; store?: PaymentPolicyStore };
const headers = { 'Cache-Control': 'no-store' };
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;

export function createPaymentPolicyHandlers(options: Options = {}) {
  const store = () => options.store ?? getPaymentPolicyStore();
  async function body(request: HttpRequest): Promise<{ value: unknown } | { response: HttpResponseInit }> {
    const text = await request.text();
    if (text.length > 8192) return { response: { status: 413, headers, jsonBody: { error: 'Request too large' } } };
    try { return { value: JSON.parse(text) }; }
    catch { return { response: { status: 400, headers, jsonBody: { error: 'Invalid JSON' } } }; }
  }
  async function authorized(request: HttpRequest, context: InvocationContext): Promise<{ response: HttpResponseInit } | { userId: string }> {
    const result = await authenticate(request, context, options.verify);
    return result.response ? { response: { ...result.response, headers } as HttpResponseInit } : { userId: result.user.uid };
  }
  async function policies(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const auth = await authorized(request, context);
    if ('response' in auth) return auth.response;
    try {
      if (request.method === 'GET') return { headers, jsonBody: await store().listPolicies(auth.userId) };
      const parsed = await body(request);
      if ('response' in parsed) return parsed.response;
      return { status: 201, headers, jsonBody: await store().createPolicy(auth.userId, parsed.value) };
    } catch (error) { return failed(context, error); }
  }
  async function policyDetail(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const auth = await authorized(request, context);
    if ('response' in auth) return auth.response;
    const id = request.params.id;
    if (!id || !idPattern.test(id)) return { status: 404, headers, jsonBody: { error: 'Policy not found' } };
    try {
      if (request.method === 'GET') {
        const policy = await store().getPolicy(auth.userId, id);
        return policy ? { headers, jsonBody: policy } : { status: 404, headers, jsonBody: { error: 'Policy not found' } };
      }
      if (request.method === 'DELETE') {
        return await store().deletePolicy(auth.userId, id)
          ? { status: 204, headers }
          : { status: 404, headers, jsonBody: { error: 'Policy not found' } };
      }
      const parsed = await body(request);
      if ('response' in parsed) return parsed.response;
      const policy = await store().updatePolicy(auth.userId, id, parsed.value);
      return policy ? { headers, jsonBody: policy } : { status: 404, headers, jsonBody: { error: 'Policy not found' } };
    } catch (error) { return failed(context, error); }
  }
  async function evaluate(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const auth = await authorized(request, context);
    if ('response' in auth) return auth.response;
    const billId = request.params.id;
    if (!billId || !idPattern.test(billId)) return { status: 404, headers, jsonBody: { error: 'Bill not found' } };
    try {
      const parsed = await body(request);
      if ('response' in parsed) return parsed.response;
      const raw = parsed.value;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
          Object.keys(raw).some(key => key !== 'policyId') ||
          ('policyId' in raw && raw.policyId !== null && (typeof raw.policyId !== 'string' || !idPattern.test(raw.policyId)))) {
        return { status: 400, headers, jsonBody: { error: 'Invalid evaluation request' } };
      }
      const result = await store().evaluate(auth.userId, billId, (raw as { policyId?: string | null }).policyId ?? null);
      return result ? { status: 201, headers, jsonBody: result } : { status: 404, headers, jsonBody: { error: 'Bill not found' } };
    } catch (error) { return failed(context, error); }
  }
  async function approvals(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const auth = await authorized(request, context);
    if ('response' in auth) return auth.response;
    try { return { headers, jsonBody: await store().listApprovals(auth.userId) }; }
    catch (error) { return failed(context, error); }
  }
  async function approvalDetail(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const auth = await authorized(request, context);
    if ('response' in auth) return auth.response;
    const id = request.params.id;
    if (!id || !idPattern.test(id)) return { status: 404, headers, jsonBody: { error: 'Approval not found' } };
    try {
      const approval = await store().getApproval(auth.userId, id);
      return approval ? { headers, jsonBody: approval } : { status: 404, headers, jsonBody: { error: 'Approval not found' } };
    } catch (error) { return failed(context, error); }
  }
  function act(action: 'approve' | 'reject' | 'cancel') {
    return async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
      const auth = await authorized(request, context);
      if ('response' in auth) return auth.response;
      const id = request.params.id;
      if (!id || !idPattern.test(id)) return { status: 404, headers, jsonBody: { error: 'Approval not found' } };
      try {
        const result = await store().actOnApproval(auth.userId, id, action);
        if (result.kind === 'not_found') return { status: 404, headers, jsonBody: { error: 'Approval not found' } };
        if (result.kind === 'expired') return { status: 409, headers, jsonBody: { error: 'Approval expired' } };
        if (result.kind === 'changed') return { status: 409, headers, jsonBody: { error: 'Bill changed; approval cancelled' } };
        if (result.kind === 'conflict') return { status: 409, headers, jsonBody: { error: 'Approval is no longer available' } };
        return { headers, jsonBody: result.approval };
      } catch (error) { return failed(context, error); }
    };
  }
  return {
    policies, policyDetail, evaluate, approvals, approvalDetail,
    approve: act('approve'), reject: act('reject'), cancel: act('cancel'),
  };
}
function failed(context: InvocationContext, error: unknown): HttpResponseInit {
  if (error instanceof InvalidPaymentPolicyError) return { status: 400, headers, jsonBody: { error: error.message } };
  if (error instanceof PaymentResourceNotFoundError) return { status: 404, headers, jsonBody: { error: 'Resource not found' } };
  if (error instanceof PaymentPolicyConflictError) return { status: 409, headers, jsonBody: { error: error.message } };
  if (error instanceof PaymentConflictError) return { status: 409, headers, jsonBody: { error: error.message } };
  const code = typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string' ? error.code : 'unknown';
  context.error('Payment policy request failed', { name: error instanceof Error ? error.name : 'unknown', code });
  return { status: 500, headers, jsonBody: { error: 'Payment policy service unavailable' } };
}

const handlers = createPaymentPolicyHandlers();
app.http('paymentPolicies', { methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'payment-policies', handler: handlers.policies });
app.http('paymentPolicyDetail', { methods: ['GET', 'PATCH', 'DELETE'], authLevel: 'anonymous', route: 'payment-policies/{id}', handler: handlers.policyDetail });
app.http('billPolicyEvaluation', { methods: ['POST'], authLevel: 'anonymous', route: 'bills/{id}/evaluate-policy', handler: handlers.evaluate });
app.http('paymentApprovals', { methods: ['GET'], authLevel: 'anonymous', route: 'approvals', handler: handlers.approvals });
app.http('paymentApprovalDetail', { methods: ['GET'], authLevel: 'anonymous', route: 'approvals/{id}', handler: handlers.approvalDetail });
app.http('paymentApprovalApprove', { methods: ['POST'], authLevel: 'anonymous', route: 'approvals/{id}/approve', handler: handlers.approve });
app.http('paymentApprovalReject', { methods: ['POST'], authLevel: 'anonymous', route: 'approvals/{id}/reject', handler: handlers.reject });
app.http('paymentApprovalCancel', { methods: ['POST'], authLevel: 'anonymous', route: 'approvals/{id}/cancel', handler: handlers.cancel });
