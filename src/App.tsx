import React, { useEffect, useState } from 'react';
import {
  BarChart3,
  Boxes,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Menu,
  Pill,
  Settings,
  ShoppingCart,
  Truck,
  User as UserIcon,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { apiFetch } from './lib/api';
import type { AuthUser, LicenseStatus, PharmacySettings } from './types';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { PosPage } from './pages/PosPage';
import { MedicinesPage } from './pages/MedicinesPage';
import { InventoryPage } from './pages/InventoryPage';
import { PurchasesPage } from './pages/PurchasesPage';
import { SalesHistoryPage } from './pages/SalesHistoryPage';
import { PartiesPage } from './pages/PartiesPage';
import { FinancePage } from './pages/FinancePage';
import { ReportsPage } from './pages/ReportsPage';
import { AdminPage } from './pages/AdminPage';

interface BootstrapState {
  authenticated: boolean;
  user: AuthUser | null;
  settings: PharmacySettings;
  license: LicenseStatus;
}

export default function App() {
  const [boot, setBoot] = useState<BootstrapState | null>(null);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileForm, setProfileForm] = useState({ fullName: '', phone: '', email: '', newPassword: '' });
  const [profileMsg, setProfileMsg] = useState('');
  const [profileErr, setProfileErr] = useState('');

  async function refreshBootstrap() {
    const res = await apiFetch<BootstrapState>('/api/auth/me');
    setBoot(res);
  }

  useEffect(() => {
    refreshBootstrap();
  }, []);

  if (!boot) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">
        Initializing offline pharmacy database...
      </div>
    );
  }

  if (!boot.authenticated || !boot.user) {
    return (
      <LoginPage
        settings={boot.settings}
        onLoggedIn={() => {
          refreshBootstrap();
        }}
      />
    );
  }

  const user = boot.user;
  const writable = boot.license.writable;

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, perm: null },
    { id: 'pos', label: 'POS Billing', icon: ShoppingCart, perm: 'pos.sell' },
    { id: 'medicines', label: 'Medicines & Units', icon: Pill, perm: 'medicines.view' },
    { id: 'inventory', label: 'Batches & Expiry', icon: Boxes, perm: 'inventory.view' },
    { id: 'purchases', label: 'Purchases', icon: Truck, perm: 'purchases.view' },
    { id: 'sales', label: 'Sales & Returns', icon: ClipboardList, perm: 'sales.view' },
    { id: 'parties', label: 'Customers & Suppliers', icon: Users, perm: 'parties.view' },
    { id: 'finance', label: 'Cash & Expenses', icon: Wallet, perm: 'cash.open' },
    { id: 'reports', label: 'Reports & Profit', icon: BarChart3, perm: 'reports.view' },
    { id: 'admin', label: 'Admin & Backups', icon: Settings, perm: 'admin.users' },
  ].filter((item) => {
    if (!item.perm) return true;
    if (item.id === 'finance') return user.permissions['cash.open'] || user.permissions['cash.close'] || user.permissions['expenses.manage'];
    if (item.id === 'admin') return user.permissions['admin.users'] || user.permissions['admin.backup'] || user.permissions['admin.audit'] || user.permissions['admin.settings'];
    return Boolean(user.permissions[item.perm]);
  });

  const currentNav = navItems.find((n) => n.id === activeTab) || navItems[0];

  async function handleLogout() {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    await refreshBootstrap();
  }

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-white border-r border-slate-200 flex flex-col transition-transform lg:static lg:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-base font-bold text-slate-900 truncate">
              {boot.settings.pharmacy_name}
            </div>
            <div className="text-[11px] text-slate-500 truncate">
              {boot.settings.pharmacy_name_bn}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close navigation menu"
            onClick={() => setMobileMenuOpen(false)}
            className="lg:hidden p-1 text-slate-500"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto" aria-label="Main navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = currentNav.id === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveTab(item.id);
                  setMobileMenuOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-teal-50 text-teal-800 font-semibold'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 text-xs space-y-2">
          <div>
            <div className="font-semibold text-slate-900 truncate">{user.fullName}</div>
            <div className="text-slate-500 truncate">
              {user.roleName} · {user.username}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setProfileForm({
                  fullName: user.fullName,
                  phone: user.phone || '',
                  email: user.email || '',
                  newPassword: '',
                });
                setProfileMsg('');
                setProfileErr('');
                setProfileOpen(true);
              }}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md whitespace-nowrap"
            >
              <UserIcon className="w-3.5 h-3.5" />
              Profile
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md whitespace-nowrap"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign Out
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white border-b border-slate-200 px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              aria-label="Open navigation menu"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 text-slate-600 border border-slate-200 rounded shrink-0"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="text-xs text-slate-500 truncate min-w-0">
              <span className="hidden sm:inline">{boot.settings.pharmacy_name}</span>
              <span className="hidden sm:inline mx-2">/</span>
              <span className="font-semibold text-slate-900">{currentNav.label}</span>
            </div>
          </div>

          <div className="flex items-center gap-4 text-xs">
            <span className="text-slate-500 hidden sm:inline">
              Drug Lic: {boot.settings.drug_license_no}
            </span>
            {user.permissions['pos.sell'] && currentNav.id !== 'pos' && (
              <button
                type="button"
                onClick={() => setActiveTab('pos')}
                className="px-3 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap shrink-0"
              >
                POS Counter
              </button>
            )}
          </div>
        </header>

        {!writable && (
          <div className="px-6 py-2.5 bg-amber-50 border-b border-amber-200 text-xs text-amber-900 font-medium">
            {boot.license.message}
          </div>
        )}

        <main className="flex-1 p-6 max-w-[1440px] w-full mx-auto">
          {currentNav.id === 'dashboard' && (
            <DashboardPage
              onNavigate={setActiveTab}
              canViewProfit={Boolean(user.permissions['reports.profit'])}
            />
          )}
          {currentNav.id === 'pos' && (
            <PosPage user={user} settings={boot.settings} writable={writable} />
          )}
          {currentNav.id === 'medicines' && <MedicinesPage user={user} writable={writable} />}
          {currentNav.id === 'inventory' && <InventoryPage user={user} writable={writable} />}
          {currentNav.id === 'purchases' && <PurchasesPage user={user} writable={writable} />}
          {currentNav.id === 'sales' && (
            <SalesHistoryPage user={user} settings={boot.settings} writable={writable} />
          )}
          {currentNav.id === 'parties' && <PartiesPage user={user} writable={writable} />}
          {currentNav.id === 'finance' && <FinancePage user={user} writable={writable} />}
          {currentNav.id === 'reports' && <ReportsPage />}
          {currentNav.id === 'admin' && (
            <AdminPage user={user} onRefreshBootstrap={refreshBootstrap} />
          )}
        </main>
      </div>

      {profileOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-modal-title"
            onSubmit={async (e) => {
              e.preventDefault();
              setProfileErr('');
              setProfileMsg('');
              try {
                await apiFetch('/api/auth/profile', {
                  method: 'PUT',
                  body: JSON.stringify(profileForm),
                });
                setProfileMsg('Profile updated successfully.');
                await refreshBootstrap();
                setProfileOpen(false);
              } catch (err) {
                setProfileErr(err instanceof Error ? err.message : 'Failed to update profile');
              }
            }}
            className="bg-white rounded-lg border border-slate-200 shadow-xl w-full max-w-md p-5 space-y-4 text-xs"
          >
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h2 id="profile-modal-title" className="text-sm font-bold text-slate-900">
                  My Profile · {user.username}
                </h2>
                <p className="text-[11px] text-slate-500">Role: {user.roleName}</p>
              </div>
              <button
                type="button"
                aria-label="Close profile dialog"
                onClick={() => setProfileOpen(false)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {profileErr && <div className="p-2 bg-red-50 border border-red-200 text-red-800 rounded">{profileErr}</div>}
            {profileMsg && <div className="p-2 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded">{profileMsg}</div>}
            <div className="space-y-3">
              <div>
                <label htmlFor="profile-fullname" className="block text-slate-600 mb-1">Full Name *</label>
                <input
                  id="profile-fullname"
                  type="text"
                  required
                  value={profileForm.fullName}
                  onChange={(e) => setProfileForm({ ...profileForm, fullName: e.target.value })}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label htmlFor="profile-phone" className="block text-slate-600 mb-1">Phone</label>
                <input
                  id="profile-phone"
                  type="text"
                  value={profileForm.phone}
                  onChange={(e) => setProfileForm({ ...profileForm, phone: e.target.value })}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label htmlFor="profile-email" className="block text-slate-600 mb-1">Email</label>
                <input
                  id="profile-email"
                  type="email"
                  value={profileForm.email}
                  onChange={(e) => setProfileForm({ ...profileForm, email: e.target.value })}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label htmlFor="profile-password" className="block text-slate-600 mb-1">
                  New Password (leave blank to keep current)
                </label>
                <input
                  id="profile-password"
                  type="password"
                  minLength={6}
                  placeholder="Min 6 characters"
                  value={profileForm.newPassword}
                  onChange={(e) => setProfileForm({ ...profileForm, newPassword: e.target.value })}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setProfileOpen(false)}
                className="px-4 py-1.5 text-xs bg-slate-100 rounded-md"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md"
              >
                Save My Profile
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
