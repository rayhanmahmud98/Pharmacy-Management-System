import React, { useState } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { AuthUser, PharmacySettings } from '../types';

interface Props {
  settings: PharmacySettings | null;
  onLoggedIn: (user: AuthUser) => void;
}

export const LoginPage: React.FC<Props> = ({ settings, onLoggedIn }) => {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('Admin@123');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submitLogin(u: string, p: string) {
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: u, password: p }),
      });
      onLoggedIn(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-lg p-8">
        <div className="mb-6">
          <div className="flex items-center gap-2.5 text-teal-700 mb-2">
            <ShieldCheck className="w-6 h-6" />
            <span className="text-xl font-bold tracking-tight text-slate-900">
              {settings?.pharmacy_name || 'Dhaka Care Pharmacy'}
            </span>
          </div>
          {settings?.pharmacy_name_bn && (
            <p className="text-sm text-slate-600">{settings.pharmacy_name_bn}</p>
          )}
          <p className="text-xs text-slate-500 mt-1">
            Offline-First Pharmacy Management System · Localhost Workstation
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 text-xs text-red-800 bg-red-50 border border-red-200 rounded-md">
            {error}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitLogin(username, password);
          }}
          className="space-y-4"
        >
          <div>
            <label htmlFor="login-username" className="block text-xs font-medium text-slate-700 mb-1">
              Username
            </label>
            <input
              id="login-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600"
              required
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="login-password" className="block text-xs font-medium text-slate-700 mb-1">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-60 rounded-md transition-colors"
          >
            <Lock className="w-4 h-4" />
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className="mt-6 pt-5 border-t border-slate-200">
          <p className="text-xs font-medium text-slate-500 mb-2">Workstation Accounts (Role Testing)</p>
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'Admin', u: 'admin', p: 'Admin@123' },
              { label: 'Manager', u: 'manager', p: 'Manager@123' },
              { label: 'Cashier', u: 'cashier', p: 'Cashier@123' },
            ].map((acc) => (
              <button
                key={acc.u}
                type="button"
                onClick={() => {
                  setUsername(acc.u);
                  setPassword(acc.p);
                  submitLogin(acc.u, acc.p);
                }}
                className="px-2.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md border border-slate-200 whitespace-nowrap"
              >
                {acc.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
