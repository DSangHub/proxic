import type { Bill, ProposedAction } from '@proxic/types';

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

export async function listBills(token: string, signal?: AbortSignal): Promise<Bill[]> {
  const response = await fetch(`${API}/bills`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal,
  });
  if (response.status === 401) throw new Error('Your session is invalid or expired. Please sign in again.');
  if (!response.ok) throw new Error('Could not load bills. Please try again.');
  return response.json();
}

export type ForwardedBill = {
  id: string;
  processingStatus: string;
  receivedAt: string;
  bill: { merchant: string; amountMinor: number; currency: string; dueDate: string } | null;
};
export type ForwardingInfo = { address: string | null; recent: ForwardedBill[] };

export function forwardingRequest(token: string, operation: 'get', signal?: AbortSignal): Promise<ForwardingInfo>;
export function forwardingRequest(token: string, operation: 'create' | 'rotate' | 'revoke', signal?: AbortSignal): Promise<{ address: string | null }>;
export async function forwardingRequest(token: string, operation: 'get' | 'create' | 'rotate' | 'revoke', signal?: AbortSignal): Promise<ForwardingInfo | { address: string | null }> {
  const suffix = operation === 'create' || operation === 'rotate' ? `/${operation}` : '';
  const response = await fetch(`${API}/bill-forwarding${suffix}`, {
    method: operation === 'get' ? 'GET' : operation === 'revoke' ? 'DELETE' : 'POST',
    headers: { authorization: `Bearer ${token}` }, cache: 'no-store', signal,
  });
  if (response.status === 401) throw new Error('Your session is invalid or expired. Please sign in again.');
  if (!response.ok) throw new Error('Could not update bill forwarding. Please try again.');
  return response.json();
}
