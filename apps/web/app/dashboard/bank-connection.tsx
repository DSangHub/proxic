'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { usePlaidLink, type PlaidLinkOnExit, type PlaidLinkOnSuccess } from 'react-plaid-link';
import {
  createPlaidLinkToken, disconnectPlaid, exchangePlaidPublicToken, getPlaidBalances, getPlaidConnection,
  type BankBalance, type BankConnection as Connection,
} from '../../lib/plaid';

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

function label(value: string | null): string {
  if (!value || !/^[a-z0-9_]{1,40}$/i.test(value) || /\d{4}/.test(value)) return 'Unavailable';
  return value.replaceAll('_', ' ');
}

function formatBalance(value: number | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined) return 'Unavailable';
  if (currency) return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
  return `${new Intl.NumberFormat(undefined).format(value)} (currency unavailable)`;
}

export function BankConnection({ user }: { user: Pick<User, 'getIdToken'> }) {
  const [state, setState] = useState<State>('loading');
  const [connection, setConnection] = useState<Connection | null>(null);
  const [balances, setBalances] = useState<BankBalance[]>([]);
  const [balanceSource, setBalanceSource] = useState<'cached' | 'live'>('cached');
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState('');
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null);
  const balanceController = useRef<AbortController | null>(null);

  const loadBalances = useCallback(async (signal: AbortSignal, live: boolean, existingToken?: string) => {
    balanceController.current?.abort();
    const active = new AbortController();
    balanceController.current = active;
    const abort = () => active.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) active.abort();
    setBalanceLoading(true);
    setBalanceError('');
    try {
      const token = existingToken ?? await user.getIdToken();
      if (active.signal.aborted) return;
      const result = await getPlaidBalances(token, live, active.signal);
      if (active.signal.aborted) return;
      const updated = await getPlaidConnection(token, active.signal);
      if (!active.signal.aborted) {
        setConnection(updated);
        if (updated?.status === 'ACTIVE') {
          setBalances(result);
          setBalanceSource(live ? 'live' : 'cached');
        } else {
          setBalances([]);
          setState(updated ? 'pending' : 'disconnected');
        }
      }
    } catch {
      if (!active.signal.aborted) setBalanceError(live ? 'Live balances unavailable; previously loaded balances may be cached.' : 'Balances unavailable.');
    } finally {
      signal.removeEventListener('abort', abort);
      if (balanceController.current === active) {
        balanceController.current = null;
        if (!active.signal.aborted) setBalanceLoading(false);
      }
    }
  }, [user]);

  const refresh = useCallback(async (signal: AbortSignal) => {
    const token = await user.getIdToken();
    if (signal.aborted) return;
    const result = await getPlaidConnection(token, signal);
    if (signal.aborted) return;
    setConnection(result);
    setBalances([]);
    setBalanceError('');
    if (!result) {
      setState('disconnected');
    } else if (result.status === 'ACTIVE') {
      setState('connected');
      void loadBalances(signal, false, token);
    } else {
      setState('pending');
    }
  }, [user, loadBalances]);

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
      balanceController.current?.abort();
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
        await refresh(signal);
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
      state === 'connected' || connection?.status === 'DISCONNECTING'
        ? 'Disconnect your Sandbox bank account?' : 'Cancel this Sandbox bank connection session?',
    )) return;
    balanceController.current?.abort();
    setBalanceLoading(false);
    setBalances([]);
    setMessage('');
    setState('busy');
    try {
      const token = await user.getIdToken();
      if (signal.aborted) return;
      await disconnectPlaid(token, signal);
      if (!signal.aborted) {
        setLinkToken(null);
        setConnection(null);
        setState('disconnected');
      }
    } catch (error) {
      await recover(error, signal);
    }
  }

  return <section><h2>Bank Connections</h2><div className="card">
    <p>Connect a test account with Plaid Sandbox. No payments are made.</p>
    {state === 'loading' && <p>Checking connection...</p>}
    {state === 'busy' && <p>Processing connection...</p>}
    {state === 'disconnected' && <><p>Connection status: Not connected</p><button onClick={start}>Connect Bank</button></>}
    {state === 'connected' && connection && <>
      <p>Connection status: Connected</p>
      <p>Institution: {connection.institutionName || 'Unavailable'}</p>
      {connection.accounts.length === 0 && <p>No accounts available.</p>}
      {connection.accounts.map(account => {
        const balance = balances.find(item => item.accountId === account.accountId);
        return <div key={account.accountId} className="bank-account">
          <p>Account type: {label(account.type)}{account.subtype ? ` / ${label(account.subtype)}` : ''}</p>
          <p>Last digits: {account.mask ? `**** ${account.mask}` : 'Unavailable'}</p>
          <p>Available balance: {formatBalance(balance?.available, balance?.currency)}</p>
          <p>Current balance: {formatBalance(balance?.current, balance?.currency)}</p>
        </div>;
      })}
      {balanceLoading ? <p>Loading balances...</p> : balances.length > 0 && <p className="muted">{balanceSource === 'cached' ? 'Cached balances' : 'Live balances'}</p>}
      {balanceError && <p role="alert">{balanceError}</p>}
      <p><button disabled={balanceLoading} onClick={() => {
        const signal = controller.current?.signal;
        if (signal && !signal.aborted) void loadBalances(signal, true);
      }}>Refresh Balance</button></p>
    </>}
    {state === 'pending' && <p>Connection status: {connection?.status === 'DISCONNECTING' ? 'Disconnecting' : connection?.status === 'EXCHANGING' ? 'Exchange requires attention' : 'Incomplete'}. {connection?.status === 'EXCHANGING' ? 'Contact support before retrying.' : 'Cancel or retry the connection.'}</p>}
    {state === 'ready' && linkToken && <LinkButton token={linkToken} onSuccess={onSuccess} onExit={onExit}/>}
    {(state === 'ready' || (state === 'pending' && connection?.status !== 'EXCHANGING') || state === 'connected') &&
      <p><button onClick={disconnect}>{state === 'connected' || connection?.status === 'DISCONNECTING' ? 'Disconnect Bank' : 'Cancel session'}</button></p>}
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
