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

export async function plaidConnectionStatus(token: string, signal?: AbortSignal): Promise<'connected' | 'disconnected' | 'pending'> {
  try {
    await plaidRequest('accounts', token, { signal });
    return 'connected';
  } catch (error) {
    if (error instanceof PlaidApiError && error.status === 404) return 'disconnected';
    if (error instanceof PlaidApiError && error.status === 409) return 'pending';
    throw error;
  }
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
