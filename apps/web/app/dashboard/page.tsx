'use client';

import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import type { Bill } from '@proxic/types';
import { useAuth } from '../auth-provider';
import { listBills } from '../../lib/api';
import { BankConnection } from './bank-connection';

const items = [['Bill Proxy', 'Organize bill-related tasks and prepare actions for approval.'], ['Appointment Proxy', 'Turn scheduling requests into proposed calendar actions.'], ['Task Proxy', 'Capture reminders, deadlines and everyday admin tasks.']];

function Bills({ user }: { user: User }) {
  const [bills, setBills] = useState<Bill[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const token = await user.getIdToken();
        const data = await listBills(token, controller.signal);
        if (!controller.signal.aborted) setBills(data);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load bills.');
      }
    }
    void load();
    return () => controller.abort();
  }, [user]);

  if (error) return <p role="alert">{error}</p>;
  if (!bills) return <p>Loading bills...</p>;
  if (!bills.length) return <p>No bills yet.</p>;
  return <div className="grid">{bills.map(bill => {
    const formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: bill.currency });
    const digits = formatter.resolvedOptions().maximumFractionDigits!;
    return <article className="card" key={bill.id}>
      <h3>{bill.merchant}</h3>
      <p>Amount: {formatter.format(bill.amountMinor / 10 ** digits)}</p>
      <p>Due: {bill.dueDate.slice(0, 10)}</p>
      <p>Last 4: {bill.accountLastFour ?? 'Not provided'}</p>
      <p>Status: {bill.status.replaceAll('_', ' ').toLowerCase()}</p>
      <p>Approval required: {bill.approvalRequired ? 'Yes' : 'No'}</p>
    </article>;
  })}</div>;
}

export default function Dashboard() {
  const { user, loading } = useAuth();
  return <main><h1>Your Proxies</h1><p className="muted">Start with three narrow agents and one shared approval layer.</p>
    <div className="grid">{items.map(([name, description]) => <div className="card" key={name}><h2>{name}</h2><p>{description}</p></div>)}</div>
    <section><h2>Bills</h2>{loading ? <p>Loading sign-in...</p> : user ? <Bills key={user.uid} user={user}/> : <p>Sign in to see your bills.</p>}</section>
    {user ? <BankConnection key={user.uid} user={user}/> : <section><h2>Bank Connections</h2><p>{loading ? 'Loading sign-in...' : 'Sign in to connect a Sandbox bank.'}</p></section>}
  </main>;
}
