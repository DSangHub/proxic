import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BillForwarding } from './bill-forwarding';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('loads the private address and rotates it only after confirmation', async () => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ address: 'b.old@in.proxic.app', recent: [{
      id: 'one', processingStatus: 'processed', receivedAt: '2027-01-01T00:00:00Z',
      bill: { merchant: 'Utility', amountMinor: 12345, currency: 'USD', dueDate: '2027-01-31' },
    }] }))
    .mockResolvedValueOnce(Response.json({ address: 'b.new@in.proxic.app' }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('confirm', vi.fn(() => true));
  render(<BillForwarding user={{ getIdToken: async () => 'firebase-token' }}/>);
  expect(await screen.findByText('b.old@in.proxic.app')).toBeTruthy();
  expect(screen.getByText('Utility')).toBeTruthy();
  expect(screen.getByText('Amount: $123.45')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Rotate Address' }));
  await waitFor(() => expect(screen.getByText('b.new@in.proxic.app')).toBeTruthy());
  expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer firebase-token' }, cache: 'no-store' });
});
