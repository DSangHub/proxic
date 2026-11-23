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
const connected = {
  status: 'ACTIVE', institutionName: 'Example Bank',
  accounts: [{ accountId: 'account-id', mask: '1234', type: 'depository', subtype: 'checking' }],
};
const cached = {
  accounts: [{ accountId: 'account-id', balances: { available: 12.5, current: 20, isoCurrencyCode: 'USD' } }],
};

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
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json(connected))
      .mockResolvedValueOnce(Response.json(cached))
      .mockResolvedValueOnce(Response.json(connected));
    render(<BankConnection user={user}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Bank' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open Plaid Link' }));
    expect(link.open).toHaveBeenCalledOnce();
    expect(link.options?.token).toBe('link-sandbox-session');
    act(() => link.options?.onSuccess('public-sandbox-example'));
    expect(await screen.findByText('Connection status: Connected')).toBeTruthy();
    await screen.findByText('Cached balances');

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls[0][0]).toBe(`${api}/connection`);
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
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Bank' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Please sign in again.');
    expect(link.open).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === `${api}/exchange-token`)).toBe(false);
  });

  it('refuses a non-Sandbox Link token', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ linkToken: 'link-production-session' }))
      .mockResolvedValueOnce(Response.json({ status: 'LINKING', institutionName: null, accounts: [] }));
    render(<BankConnection user={user}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Bank' }));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Bank' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load Plaid Link');
    expect(screen.getByRole('button', { name: 'Cancel session' })).toBeTruthy();
  });

  it('handles a missing public token without exchanging and allows cancellation', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ linkToken: 'link-sandbox-session' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(<BankConnection user={user}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Bank' }));
    await screen.findByRole('button', { name: 'Open Plaid Link' });
    act(() => link.options?.onSuccess(null));
    expect((await screen.findByRole('alert')).textContent).toContain('did not return a public token');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    await screen.findByRole('button', { name: 'Connect Bank' });
    expect(fetchMock.mock.calls[2][0]).toBe(`${api}/connection`);
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'DELETE', headers: { authorization: 'Bearer firebase-id-token' } });
  });

  it('recovers an existing pending or expired session without exposing it', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ status: 'LINKING', institutionName: null, accounts: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ linkToken: 'link-sandbox-session' }));
    render(<BankConnection user={user}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel session' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Bank' }));
    await screen.findByRole('button', { name: 'Open Plaid Link' });
    act(() => link.options?.onExit({ error_code: 'INVALID_LINK_TOKEN' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Link session expired');
    expect(screen.getByRole('button', { name: 'Cancel session' })).toBeTruthy();
  });

  it('reports exchange failure and does not claim a connection was made', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ linkToken: 'link-sandbox-session' }))
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(Response.json({ status: 'EXCHANGING', institutionName: null, accounts: [] }));
    render(<BankConnection user={user}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Bank' }));
    await screen.findByRole('button', { name: 'Open Plaid Link' });
    act(() => link.options?.onSuccess('public-sandbox-example'));
    expect((await screen.findByRole('alert')).textContent).toContain('bank connection request failed');
    expect(await screen.findByText(/Exchange requires attention/)).toBeTruthy();
    expect(screen.queryByText('Connection status: Connected')).toBeNull();
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
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Bank' }));
    await screen.findByRole('button', { name: 'Open Plaid Link' });
    act(() => link.options?.onSuccess('public-sandbox-example'));
    view.unmount();
    await act(async () => resolveToken('firebase-id-token'));
    await waitFor(() => expect(user.getIdToken).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('displays safe account details and explicitly refreshes live balances', async () => {
    const data = {
      status: 'ACTIVE', institutionName: 'Example Bank',
      accounts: [
        { accountId: 'account-id', mask: '1234', type: 'depository', subtype: 'checking' },
        { accountId: '1234567890123456', mask: '9876543210', type: 'credit', subtype: null },
      ],
    };
    const live = { accounts: [
      { accountId: 'account-id', balances: { available: 0, current: 42, isoCurrencyCode: 'USD' } },
      { accountId: '1234567890123456', balances: { available: null, current: null, isoCurrencyCode: null } },
    ] };
    fetchMock.mockResolvedValueOnce(Response.json(data))
      .mockResolvedValueOnce(Response.json(cached))
      .mockResolvedValueOnce(Response.json(data))
      .mockResolvedValueOnce(Response.json(live))
      .mockResolvedValueOnce(Response.json(data));
    render(<BankConnection user={user}/>);
    expect(await screen.findByText('Institution: Example Bank')).toBeTruthy();
    expect(await screen.findByText('Cached balances')).toBeTruthy();
    expect(screen.getByText('Account type: depository / checking')).toBeTruthy();
    expect(screen.getByText('Last digits: **** 1234')).toBeTruthy();
    expect(screen.getByText('Last digits: Unavailable')).toBeTruthy();
    expect(screen.getByText('Available balance: $12.50')).toBeTruthy();
    expect(screen.getByText('Current balance: $20.00')).toBeTruthy();
    expect(document.body.textContent).not.toContain('1234567890123456');
    expect(document.body.textContent).not.toContain('9876543210');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Balance' }));
    expect(await screen.findByText('Live balances')).toBeTruthy();
    expect(screen.getByText('Available balance: $0.00')).toBeTruthy();
    expect(screen.getByText('Current balance: $42.00')).toBeTruthy();
    expect(screen.getByText('Available balance: Unavailable')).toBeTruthy();
    expect(fetchMock.mock.calls[3][0]).toBe(`${api}/balance`);
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ headers: { authorization: 'Bearer firebase-id-token' } });
  });

  it('keeps disconnect available when balances are unavailable', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(connected))
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(<BankConnection user={user}/>);
    expect(await screen.findByText('Institution: Example Bank')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('Balances unavailable');
    expect(screen.getByText('Current balance: Unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Bank' }));
    await screen.findByRole('button', { name: 'Connect Bank' });
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'DELETE' });
    expect(screen.queryByText('Institution: Example Bank')).toBeNull();
  });

  it('updates backfilled account details after accounts synchronize', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...connected, institutionName: null, accounts: [] }))
      .mockResolvedValueOnce(Response.json(cached))
      .mockResolvedValueOnce(Response.json(connected));
    render(<BankConnection user={user}/>);
    expect(await screen.findByText('Institution: Example Bank')).toBeTruthy();
    expect(screen.getByText('Last digits: **** 1234')).toBeTruthy();
    expect(screen.getByText('Available balance: $12.50')).toBeTruthy();
  });

  it('ignores a late balance response after disconnect', async () => {
    let resolveBalances: (response: Response) => void = () => {};
    const pending = new Promise<Response>(resolve => { resolveBalances = resolve; });
    fetchMock.mockResolvedValueOnce(Response.json(connected))
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(<BankConnection user={user}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Bank' }));
    await screen.findByRole('button', { name: 'Connect Bank' });
    await act(async () => resolveBalances(Response.json(cached)));
    expect(screen.queryByText('Institution: Example Bank')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
