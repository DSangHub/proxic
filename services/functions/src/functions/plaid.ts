import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { authenticate, type VerifyToken } from '../services/auth.js';
import { getPlaidService, PlaidConflictError, PlaidInvalidTokenError, PlaidNotFoundError, type PlaidService } from '../services/plaid.js';

type Options = { verify?: VerifyToken; service?: PlaidService };
const headers = { 'Cache-Control': 'no-store' };

export function createPlaidHandlers(options: Options = {}) {
  const service = () => options.service ?? getPlaidService();
  function handler(operation: 'link' | 'exchange' | 'accounts' | 'balance' | 'connection' | 'disconnect') {
    return async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
      const auth = await authenticate(request, context, options.verify);
      if (auth.response) return { ...auth.response, headers };
      try {
        if (operation === 'link') return { headers, jsonBody: await service().link(auth.user.uid) };
        if (operation === 'exchange') {
          const body = await request.text();
          if (body.length > 2048) return { status: 413, headers, jsonBody: { error: 'Request too large' } };
          let data: unknown;
          try { data = JSON.parse(body); } catch { return { status: 400, headers, jsonBody: { error: 'Invalid JSON' } }; }
          if (typeof data !== 'object' || data === null || Array.isArray(data) ||
              Object.keys(data).length !== 1 || !('publicToken' in data) || typeof data.publicToken !== 'string') {
            return { status: 400, headers, jsonBody: { error: 'publicToken is required' } };
          }
          await service().exchange(auth.user.uid, data.publicToken);
          return { status: 204, headers };
        }
        if (operation === 'disconnect') {
          await service().disconnect(auth.user.uid);
          return { status: 204, headers };
        }
        if (operation === 'connection') return { headers, jsonBody: await service().connection(auth.user.uid) };
        return { headers, jsonBody: { accounts: await service().accounts(auth.user.uid, operation === 'balance') } };
      } catch (error) {
        if (error instanceof PlaidInvalidTokenError) return { status: 400, headers, jsonBody: { error: error.message } };
        if (error instanceof PlaidNotFoundError) return { status: 404, headers, jsonBody: { error: error.message } };
        if (error instanceof PlaidConflictError) return { status: 409, headers, jsonBody: { error: error.message } };
        // SDK errors can include requests and credentials; never log or return them.
        context.error(`Plaid ${operation} failed`);
        return { status: 502, headers, jsonBody: { error: 'Plaid Sandbox service unavailable' } };
      }
    };
  }
  return {
    link: handler('link'), exchange: handler('exchange'), accounts: handler('accounts'),
    balance: handler('balance'), connection: handler('connection'), disconnect: handler('disconnect'),
  };
}

const handlers = createPlaidHandlers();
app.http('plaidLinkToken', { methods: ['POST'], authLevel: 'anonymous', route: 'plaid/link-token', handler: handlers.link });
app.http('plaidExchangeToken', { methods: ['POST'], authLevel: 'anonymous', route: 'plaid/exchange-token', handler: handlers.exchange });
app.http('plaidAccounts', { methods: ['GET'], authLevel: 'anonymous', route: 'plaid/accounts', handler: handlers.accounts });
app.http('plaidBalance', { methods: ['GET'], authLevel: 'anonymous', route: 'plaid/balance', handler: handlers.balance });
app.http('plaidConnection', {
  methods: ['GET', 'DELETE'], authLevel: 'anonymous', route: 'plaid/connection',
  handler: (request, context) => request.method === 'GET'
    ? handlers.connection(request, context) : handlers.disconnect(request, context),
});
