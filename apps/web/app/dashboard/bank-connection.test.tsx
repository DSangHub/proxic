import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BankConnection } from './bank-connection';

const link = vi.hoisted(() => ({
  options: null as null | { token: string; onSuccess: (publicToken: string | null) => void; onExit: (error: { error_code: string } | null) => void },
  open: vi.fn(),
  ready: true,
  error: null as Error | null,
}));

vi.mock('react-plaid-link', () => ({
  usePlaidLink: (options: typeof link.options) => {
    link.options = options;
    return { open: link.open, ready: link.ready, error: link.error };
  },
}));

const user = { getIdToken: vi.fn(async () => 'firebase-id-token') };
const fetchMock = vi.fn<typeof fetch>();
const api = 'http://localhost:7071/api/plaid';

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('confirm', vi.fn(() => true));
  user.getIdToken.mockReset().mockResolvedValue('firebase-id-token');
  fetchMock.mockReset();
  link.options = null;
  link.open.mockReset();
  link.ready = true;
  link.error = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Sandbox bank connection', () => {
  it('creates a Link token on Azure and sends only the public token back for exchange', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ linkToken: 'link-sandbox-session', expiration: '2027-01-01' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(<BankConnection user={user}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Sandbox bank' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open Plaid Link' }));
    expect(link.open).toHaveBeenCalledOnce();
    expect(link.options?.token).toBe('link-sandbox-session');
    act(() => link.options?.onSuccess('public-sandbox-example'));
    expect(await screen.findByText('Sandbox bank connected.')).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe(`${api}/accounts`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${api}/link-token`);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'POST', headers: { authorization: 'Bearer firebase-id-token' }, cache: 'no-store',
    });
    expect(fetchMock.mock.calls[2][0]).toBe(`${api}/exchange-token`);
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer firebase-id-token', 'content-type': 'application/json' },
      body: JSON.stringify({ publicToken: 'public-sandbox-example' }),
      cache: 'no-store',
    });
    expect(screen.queryByText('public-sandbox-example')).toBeNull();
  });

  it('does not open Link or exchange when token creation fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    render(<BankConnection user={user}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Sandbox bank' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Please sign in again.');
    expect(link.open).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === `${api}/exchange-token`)).toBe(false);
  });

  it('refuses a non-Sandbox Link token', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ linkToken: 'link-production-session' }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }));
    render(<BankConnection user={user}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Sandbox bank' }));
    expect((await screen.findByRole('alert')).textContent).toContain('invalid Sandbox Link token');
    expect(link.options).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url === `${api}/exchange-token`)).toBe(false);
  });

  it('reports a Plaid Link script loading failure', async () => {
    link.error = new Error('script unavailable');
    link.ready = false;
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ linkToken: 'link-sandbox-session' }));
    render(<BankConnection user={user}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Sandbox bank' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load Plaid Link');
    expect(screen.getByRole('button', { name: 'Cancel session' })).toBeTruthy();
  });

  it('handles a missing public token without exchanging and allows cancellation', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ linkToken: 'link-sandbox-session' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(<BankConnection user={user}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Sandbox bank' }));
    await screen.findByRole('button', { name: 'Open Plaid Link' });
    act(() => link.options?.onSuccess(null));
    expect((await screen.findByRole('alert')).textContent).toContain('did not return a public token');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    await screen.findByRole('button', { name: 'Connect Sandbox bank' });
    expect(fetchMock.mock.calls[2][0]).toBe(`${api}/connection`);
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'DELETE', headers: { authorization: 'Bearer firebase-id-token' } });
  });

  it('recovers an existing pending or expired session without exposing it', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ linkToken: 'link-sandbox-session' }));
    render(<BankConnection user={user}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel session' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Sandbox bank' }));
    await screen.findByRole('button', { name: 'Open Plaid Link' });
    act(() => link.options?.onExit({ error_code: 'INVALID_LINK_TOKEN' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Link session expired');
    expect(screen.getByRole('button', { name: 'Cancel session' })).toBeTruthy();
  });

  it('reports exchange failure and does not claim a connection was made', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ linkToken: 'link-sandbox-session' }))
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }));
    render(<BankConnection user={user}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Sandbox bank' }));
    await screen.findByRole('button', { name: 'Open Plaid Link' });
    act(() => link.options?.onSuccess('public-sandbox-example'));
    expect((await screen.findByRole('alert')).textContent).toContain('bank connection request failed');
    expect(await screen.findByText(/connection is incomplete/)).toBeTruthy();
    expect(screen.queryByText('Sandbox bank connected.')).toBeNull();
  });

  it('does not exchange after the authenticated user leaves the page', async () => {
    let resolveToken: (token: string) => void = () => {};
    const delayedToken = new Promise<string>(resolve => { resolveToken = resolve; });
    user.getIdToken.mockResolvedValueOnce('firebase-id-token')
      .mockResolvedValueOnce('firebase-id-token')
      .mockImplementationOnce(() => delayedToken);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ linkToken: 'link-sandbox-session' }));
    const view = render(<BankConnection user={user}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Sandbox bank' }));
    await screen.findByRole('button', { name: 'Open Plaid Link' });
    act(() => link.options?.onSuccess('public-sandbox-example'));
    view.unmount();
    await act(async () => resolveToken('firebase-id-token'));
    await waitFor(() => expect(user.getIdToken).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
