import type { ProposedAction } from '@proxic/types';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:7071/api';

export async function submitProxyRequest(message: string, token: string): Promise<ProposedAction> {
  const response = await fetch(`${API}/proxy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ message }),
  });
  if (response.status === 401) throw new Error('Your session is invalid or expired. Please sign in again.');
  if (!response.ok) throw new Error('Proxy API request failed. Please try again.');
  return response.json();
}
