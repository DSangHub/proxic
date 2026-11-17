'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { usePlaidLink, type PlaidLinkOnExit, type PlaidLinkOnSuccess } from 'react-plaid-link';
import { createPlaidLinkToken, disconnectPlaid, exchangePlaidPublicToken, plaidConnectionStatus } from '../../lib/plaid';

type State = 'loading' | 'disconnected' | 'pending' | 'ready' | 'connected' | 'busy' | 'error';

function LinkButton({ token, onSuccess, onExit }: {
  token: string;
  onSuccess: PlaidLinkOnSuccess;
  onExit: PlaidLinkOnExit;
}) {
  const { open, ready, error } = usePlaidLink({ token, onSuccess, onExit });
  return <>
    <button disabled={!ready || !!error} onClick={() => open()}>Open Plaid Link</button>
    {error && <p role="alert">Could not load Plaid Link. Cancel the session and try again.</p>}
  </>;
}

export function BankConnection({ user }: { user: Pick<User, 'getIdToken'> }) {
  const [state, setState] = useState<State>('loading');
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(async (signal: AbortSignal) => {
    const token = await user.getIdToken();
    if (signal.aborted) return;
    const status = await plaidConnectionStatus(token, signal);
    if (!signal.aborted) setState(status);
  }, [user]);

  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    void refresh(active.signal).catch(() => {
      if (!active.signal.aborted) {
        setState('error');
        setMessage('Could not check the bank connection. Please try again.');
      }
    });
    return () => {
      active.abort();
      controller.current = null;
    };
  }, [refresh]);

  async function recover(error: unknown, signal: AbortSignal) {
    if (signal.aborted) return;
    setMessage(error instanceof Error ? error.message : 'The bank connection request failed.');
    try {
      await refresh(signal);
    } catch {
      if (!signal.aborted) setState('error');
    }
  }

  async function start() {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    setMessage('');
    setState('busy');
    try {
      const token = await user.getIdToken();
      if (signal.aborted) return;
      const link = await createPlaidLinkToken(token, signal);
      if (!signal.aborted) {
        setLinkToken(link);
        setState('ready');
      }
    } catch (error) {
      await recover(error, signal);
    }
  }

  const onSuccess = useCallback<PlaidLinkOnSuccess>((publicToken) => {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    setLinkToken(null);
    if (!publicToken) {
      setState('pending');
      setMessage('Plaid did not return a public token. Cancel the session and try again.');
      return;
    }
    setState('busy');
    setMessage('');
    void (async () => {
      try {
        const token = await user.getIdToken();
        if (signal.aborted) return;
        await exchangePlaidPublicToken(token, publicToken, signal);
        if (!signal.aborted) setState('connected');
      } catch (error) {
        await recover(error, signal);
      }
    })();
  }, [user, refresh]);

  const onExit = useCallback<PlaidLinkOnExit>((error) => {
    if (controller.current?.signal.aborted !== false) return;
    if (error?.error_code === 'INVALID_LINK_TOKEN') {
      setLinkToken(null);
      setState('pending');
      setMessage('The Link session expired. Cancel it and start again.');
    } else if (error) {
      setMessage('Plaid Link could not complete. Try again or cancel the session.');
    } else {
      setMessage('Plaid Link was closed. Reopen it or cancel the session.');
    }
  }, []);

  async function disconnect() {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || !window.confirm(
      state === 'connected' ? 'Disconnect your Sandbox bank account?' : 'Cancel this Sandbox bank connection session?',
    )) return;
    setMessage('');
    setState('busy');
    try {
      const token = await user.getIdToken();
      if (signal.aborted) return;
      await disconnectPlaid(token, signal);
      if (!signal.aborted) {
        setLinkToken(null);
        setState('disconnected');
      }
    } catch (error) {
      await recover(error, signal);
    }
  }

  return <section><h2>Sandbox bank connection</h2><div className="card">
    <p>Connect a test account with Plaid Sandbox. No payments are made.</p>
    {state === 'loading' && <p>Checking connection...</p>}
    {state === 'busy' && <p>Processing connection...</p>}
    {state === 'connected' && <p>Sandbox bank connected.</p>}
    {state === 'pending' && <p>A connection is incomplete or needs attention. Cancel it to retry; an exchange in progress may require support.</p>}
    {state === 'disconnected' && <button onClick={start}>Connect Sandbox bank</button>}
    {state === 'ready' && linkToken && <LinkButton token={linkToken} onSuccess={onSuccess} onExit={onExit}/>}
    {(state === 'ready' || state === 'pending' || state === 'connected') &&
      <p><button onClick={disconnect}>{state === 'connected' ? 'Disconnect bank' : 'Cancel session'}</button></p>}
    {state === 'error' && <button onClick={() => {
      const signal = controller.current?.signal;
      if (!signal) return;
      setState('loading');
      setMessage('');
      void refresh(signal).catch(() => {
        if (!signal.aborted) {
          setState('error');
          setMessage('Could not check the bank connection. Please try again.');
        }
      });
    }}>Retry</button>}
    {message && <p role="alert">{message}</p>}
  </div></section>;
}
