import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PlaidLinkOptions } from 'react-plaid-link';
import { BankConnection } from './bank-connection';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.querySelectorAll('script[src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"]').forEach(script => script.remove());
});

it('initializes the real React Plaid hook and exchanges the Link callback token', async () => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ linkToken: 'link-sandbox-session' }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  let config: PlaidLinkOptions | undefined;
  const open = vi.fn();
  vi.stubGlobal('Plaid', {
    create: (options: PlaidLinkOptions) => {
      config = options;
      return { open, exit: vi.fn(), destroy: vi.fn(), submit: vi.fn() };
    },
  });
  render(<BankConnection user={{ getIdToken: async () => 'firebase-id-token' }}/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Sandbox bank' }));
  const button = await screen.findByRole('button', { name: 'Open Plaid Link' });
  const script = document.querySelector('script[src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"]');
  expect(script).not.toBeNull();
  act(() => script?.dispatchEvent(new Event('load')));
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  fireEvent.click(button);
  expect(open).toHaveBeenCalledOnce();
  expect(config?.token).toBe('link-sandbox-session');
  act(() => config?.onSuccess('public-sandbox-example', { institution: null, accounts: [], link_session_id: 'test' }));
  await screen.findByText('Sandbox bank connected.');
  expect(fetchMock.mock.calls[2][1]?.body).toBe(JSON.stringify({ publicToken: 'public-sandbox-example' }));
});
