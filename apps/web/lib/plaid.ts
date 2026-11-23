const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:7071/api';

class PlaidApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function plaidRequest(path: string, token: string, options: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${API}/plaid/${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    cache: 'no-store',
  });
  if (!response.ok) {
    const message = response.status === 401
      ? 'Your session is invalid or expired. Please sign in again.'
      : 'The bank connection request failed. Please try again.';
    throw new PlaidApiError(response.status, message);
  }
  return response;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type BankConnection = {
  status: 'LINKING' | 'EXCHANGING' | 'ACTIVE' | 'DISCONNECTING';
  institutionName: string | null;
  accounts: { accountId: string; mask: string | null; type: string; subtype: string | null }[];
};

export type BankBalance = {
  accountId: string;
  available: number | null;
  current: number | null;
  currency: string | null;
};

export async function getPlaidConnection(token: string, signal?: AbortSignal): Promise<BankConnection | null> {
  try {
    const response = await plaidRequest('connection', token, { signal });
    const body: unknown = await response.json();
    if (!record(body) ||
        (body.status !== 'LINKING' && body.status !== 'EXCHANGING' && body.status !== 'ACTIVE' && body.status !== 'DISCONNECTING') ||
        !(typeof body.institutionName === 'string' || body.institutionName === null) || !Array.isArray(body.accounts)) {
      throw new Error('Invalid bank connection response.');
    }
    const status = body.status;
    const accounts = body.accounts.map((account: unknown) => {
      if (!record(account) || typeof account.accountId !== 'string' || typeof account.type !== 'string' ||
          !(typeof account.mask === 'string' || account.mask === null) ||
          !(typeof account.subtype === 'string' || account.subtype === null)) {
        throw new Error('Invalid bank account response.');
      }
      return {
        accountId: account.accountId,
        mask: typeof account.mask === 'string' && /^[A-Za-z0-9]{2,4}$/.test(account.mask) ? account.mask : null,
        type: account.type,
        subtype: account.subtype,
      };
    });
    return { status, institutionName: body.institutionName, accounts };
  } catch (error) {
    if (error instanceof PlaidApiError && error.status === 404) return null;
    throw error;
  }
}

export async function getPlaidBalances(token: string, live: boolean, signal?: AbortSignal): Promise<BankBalance[]> {
  const response = await plaidRequest(live ? 'balance' : 'accounts', token, { signal });
  const body: unknown = await response.json();
  if (!record(body) || !Array.isArray(body.accounts)) throw new Error('Invalid bank balance response.');
  return body.accounts.map((account: unknown) => {
    if (!record(account) || typeof account.accountId !== 'string' || !record(account.balances)) {
      throw new Error('Invalid bank balance response.');
    }
    const balance = account.balances;
    const value = (amount: unknown) => typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
    return {
      accountId: account.accountId,
      available: value(balance.available),
      current: value(balance.current),
      currency: typeof balance.isoCurrencyCode === 'string' && /^[A-Z]{3}$/.test(balance.isoCurrencyCode)
        ? balance.isoCurrencyCode : null,
    };
  });
}

export async function createPlaidLinkToken(token: string, signal?: AbortSignal): Promise<string> {
  const response = await plaidRequest('link-token', token, { method: 'POST', signal });
  const result: unknown = await response.json();
  if (typeof result !== 'object' || result === null || !('linkToken' in result) ||
      typeof result.linkToken !== 'string' || !result.linkToken.startsWith('link-sandbox-')) {
    throw new Error('The server returned an invalid Sandbox Link token.');
  }
  return result.linkToken;
}

export async function exchangePlaidPublicToken(token: string, publicToken: string, signal?: AbortSignal): Promise<void> {
  await plaidRequest('exchange-token', token, {
    method: 'POST', body: JSON.stringify({ publicToken }), signal,
  });
}

export async function disconnectPlaid(token: string, signal?: AbortSignal): Promise<void> {
  await plaidRequest('connection', token, { method: 'DELETE', signal });
}
