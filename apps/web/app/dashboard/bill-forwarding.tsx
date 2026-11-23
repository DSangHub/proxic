'use client';

import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import { forwardingRequest, type ForwardingInfo } from '../../lib/api';

export function BillForwarding({ user }: { user: Pick<User, 'getIdToken'> }) {
  const [info, setInfo] = useState<ForwardingInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const token = await user.getIdToken();
        const data = await forwardingRequest(token, 'get', controller.signal);
        if (!controller.signal.aborted) setInfo(data);
      } catch {
        if (!controller.signal.aborted) setError('Could not load bill forwarding.');
      }
    })();
    return () => controller.abort();
  }, [user]);
  async function change(operation: 'create' | 'rotate') {
    if (operation === 'rotate' && !window.confirm('Rotate your address? The old address will stop working immediately.')) return;
    setBusy(true); setError(''); setCopied(false);
    try {
      const result = await forwardingRequest(await user.getIdToken(), operation);
      setInfo(previous => previous ? { ...previous, address: result.address } : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update bill forwarding.');
    } finally { setBusy(false); }
  }
  async function copy() {
    if (!info?.address) return;
    try { await navigator.clipboard.writeText(info.address); setCopied(true); }
    catch { setError('Could not copy the address.'); }
  }
  return <section><h2>Bill Forwarding</h2>
    <p>Forward bills here and your Bill Proxy will organize them.</p>
    {error && <p role="alert">{error}</p>}
    {!info ? <p>{error ? 'Bill forwarding is unavailable.' : 'Loading bill forwarding...'}</p> : <>
      <h3>Your Bill Proxy Address</h3>
      {info.address ? <><p>{info.address}</p><button onClick={copy}>Copy Address</button>{' '}
        <button disabled={busy} onClick={() => void change('rotate')}>Rotate Address</button>
        {copied && <p>Address copied.</p>}</> :
        <button disabled={busy} onClick={() => void change('create')}>Create Address</button>}
      <h3>Recent forwarded bills</h3>
      {!info.recent.length ? <p>No forwarded bills yet.</p> : <div className="grid">{info.recent.map(item =>
        <article className="card" key={item.id}>
          <h4>{item.bill?.merchant ?? 'Needs review'}</h4>
          <p>Amount: {item.bill ? new Intl.NumberFormat(undefined, { style: 'currency', currency: item.bill.currency }).format(item.bill.amountMinor / 100) : 'Not available'}</p>
          <p>Due date: {item.bill?.dueDate.slice(0, 10) ?? 'Not available'}</p>
          <p>Status: {item.processingStatus.replaceAll('_', ' ')}</p>
        </article>)}</div>}
    </>}
  </section>;
}
