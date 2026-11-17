'use client';

import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { firebaseAuth } from '../lib/firebase';

type AuthState = { user: User | null; loading: boolean };
const AuthContext = createContext<AuthState>({ user: null, loading: true });

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    try {
      return onAuthStateChanged(firebaseAuth(), nextUser => {
        setUser(nextUser);
        setLoading(false);
      }, () => {
        setError('Could not restore your sign-in. Please try again.');
        setLoading(false);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not initialize authentication.');
      setLoading(false);
    }
  }, []);

  async function changeSignIn() {
    setError('');
    try {
      if (user) await signOut(firebaseAuth());
      else await signInWithPopup(firebaseAuth(), new GoogleAuthProvider());
    } catch {
      setError('Sign-in or sign-out failed. Please try again.');
    }
  }

  return <AuthContext.Provider value={{ user, loading }}>
    <div className="auth-controls">
      {user && <span>Signed in as {user.displayName || user.email || 'user'}</span>}
      <button onClick={changeSignIn} disabled={loading}>{loading ? 'Loading...' : user ? 'Sign out' : 'Sign in with Google'}</button>
      {error && <span role="alert">{error}</span>}
    </div>
    {children}
  </AuthContext.Provider>;
}
