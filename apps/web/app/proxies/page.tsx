'use client';
import { useState } from 'react';
import { useAuth } from '../auth-provider';
import { submitProxyRequest } from '../../lib/api';

export default function Proxies() {
  const { user, loading } = useAuth();
  const [message, setMessage] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function go() {
    if (!user) return;
    setError('');
    setResult('');
    setSubmitting(true);
    try {
      const token = await user.getIdToken();
      setResult(JSON.stringify(await submitProxyRequest(message, token), null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return <main><h1>Assign a Proxy</h1><div className="card">
    {!loading && !user && <p>Sign in to assign a proxy.</p>}
    <textarea value={message} onChange={e => setMessage(e.target.value)} placeholder="Example: Remind me to renew my vehicle registration"/>
    <p><button onClick={go} disabled={!user || !message.trim() || submitting}>{submitting ? 'Assigning...' : 'Assign'}</button></p>
    {error && <p role="alert">{error}</p>}
    {result && <pre>{result}</pre>}
  </div></main>;
}
