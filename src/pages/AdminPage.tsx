import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  DatabaseBackup,
  Download,
  Edit3,
  Eye,
  KeyRound,
  Network,
  RotateCcw,
  ShieldCheck,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import { apiFetch, checkStrictDecimalInput } from '../lib/api';
import { ConfirmActionModal } from '../components/ActionModals';
import type { AuthUser, LicenseStatus, PharmacySettings } from '../types';

interface AuditRow {
  id: string;
  seq: number;
  username: string;
  session_id: string;
  ip_address: string;
  action: string;
  module: string;
  target_type: string;
  target_id: string;
  transaction_ref: string;
  status: string;
  reason: string;
  before_state: string | null;
  after_state: string | null;
  metadata_json: string | null;
  prev_hash: string;
  entry_hash: string;
  created_at: string;
}

interface AdminUserRow {
  id: string;
  username: string;
  full_name: string;
  phone: string;
  email: string;
  role_id: string;
  role_name: string;
  is_super_admin: number;
  is_active: number;
  must_change_password: number;
  last_login_at: string | null;
}

interface AdminPayload {
  roles: Array<{ id: string; name: string; description: string }>;
  permissions: Array<{ code: string; module: string; label: string }>;
  rolePermissions: Array<{ role_id: string; permission_code: string }>;
  users: AdminUserRow[];
  overrides: Array<{ user_id: string; permission_code: string; effect: 'ALLOW' | 'DENY'; reason: string }>;
  auditLogs: AuditRow[];
  auditChain: { valid: boolean; totalEntries: number; brokenAtSeq: number | null } | null;
  backups: Array<{
    id: string;
    filename: string;
    size_bytes: number;
    sha256: string;
    integrity_check_result: string;
    backup_type: string;
    status: string;
    created_at: string;
  }>;
  settings: PharmacySettings;
  license: LicenseStatus;
  networkInfo?: {
    port: number;
    hostname: string;
    urls: string[];
  };
}

interface Props {
  user: AuthUser;
  onRefreshBootstrap: () => void;
}

function prettyJson(raw: string | null): string {
  if (!raw) return '—';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export const AdminPage: React.FC<Props> = ({ user, onRefreshBootstrap }) => {
  const [data, setData] = useState<AdminPayload | null>(null);
  const [tab, setTab] = useState<'users' | 'audit' | 'backups' | 'license' | 'settings'>('users');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [newUser, setNewUser] = useState({ username: '', fullName: '', password: '', roleId: '', phone: '', email: '' });
  const [editUserTarget, setEditUserTarget] = useState<{
    id: string;
    username: string;
    fullName: string;
    phone: string;
    email: string;
    roleId: string;
    isSuperAdmin: boolean;
  } | null>(null);
  const [resetPwdTarget, setResetPwdTarget] = useState<AdminUserRow | null>(null);
  const [resetPwdValue, setResetPwdValue] = useState('');
  const [resetForceChange, setResetForceChange] = useState(true);

  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditFilter, setAuditFilter] = useState({
    search: '',
    module: '',
    status: '',
    fromDate: '',
    toDate: '',
  });
  const [inspectAudit, setInspectAudit] = useState<AuditRow | null>(null);

  const [licenseJson, setLicenseJson] = useState('');
  const [settingsForm, setSettingsForm] = useState<PharmacySettings | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<{ id: string; filename: string } | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    const res = await apiFetch<AdminPayload>('/api/admin/overview');
    setData(res);
    setSettingsForm(res.settings);
    setAuditRows(res.auditLogs || []);
    setAuditTotal(res.auditChain?.totalEntries ?? res.auditLogs?.length ?? 0);
    if (!selectedUserId && res.users.length > 0) {
      setSelectedUserId(res.users.find((u) => !u.is_super_admin)?.id || res.users[0].id);
    }
    if (!newUser.roleId && res.roles.length > 0) {
      setNewUser((p) => ({ ...p, roleId: res.roles[res.roles.length - 1].id }));
    }
  }

  async function loadFilteredAudit(offset = 0, filter = auditFilter) {
    setError('');
    const params = new URLSearchParams();
    if (filter.search.trim()) params.set('search', filter.search.trim());
    if (filter.module) params.set('module', filter.module);
    if (filter.status) params.set('status', filter.status);
    if (filter.fromDate) params.set('fromDate', filter.fromDate);
    if (filter.toDate) params.set('toDate', filter.toDate);
    params.set('limit', '50');
    params.set('offset', String(offset));
    const res = await apiFetch<{ rows: AuditRow[]; total: number }>(`/api/admin/audit?${params.toString()}`);
    setAuditRows(res.rows);
    setAuditTotal(res.total);
    setAuditOffset(offset);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await apiFetch('/api/admin/users', { method: 'POST', body: JSON.stringify(newUser) });
      setNotice(`User '${newUser.username}' created.`);
      setNewUser((p) => ({ ...p, username: '', fullName: '', password: '', phone: '', email: '' }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'User creation failed');
    }
  }

  async function handleEditUserSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editUserTarget) return;
    setError('');
    try {
      await apiFetch(`/api/admin/users/${editUserTarget.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          fullName: editUserTarget.fullName,
          phone: editUserTarget.phone,
          email: editUserTarget.email,
          roleId: editUserTarget.roleId,
          isSuperAdmin: editUserTarget.isSuperAdmin,
        }),
      });
      setNotice(`Updated account '${editUserTarget.username}'.`);
      setEditUserTarget(null);
      await load();
      onRefreshBootstrap();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user');
    }
  }

  async function handleResetPasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!resetPwdTarget) return;
    setError('');
    try {
      await apiFetch(`/api/admin/users/${resetPwdTarget.id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({
          newPassword: resetPwdValue,
          forceChange: resetForceChange,
        }),
      });
      setNotice(
        `Password reset for '${resetPwdTarget.username}'${resetForceChange ? ' (will prompt to change on next login)' : ''}.`
      );
      setResetPwdTarget(null);
      setResetPwdValue('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password reset failed');
    }
  }

  async function handleOverrideChange(permissionCode: string, effect: 'ALLOW' | 'DENY' | 'INHERIT') {
    if (!selectedUserId) return;
    setError('');
    try {
      await apiFetch(`/api/admin/users/${selectedUserId}/override`, {
        method: 'POST',
        body: JSON.stringify({ permissionCode, effect, reason: 'Admin individual permission rule' }),
      });
      setNotice(`Override updated (${permissionCode} = ${effect}). Effective immediately without restart.`);
      await load();
      onRefreshBootstrap();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update override');
    }
  }

  async function handleCreateBackup() {
    setError('');
    try {
      const res = await apiFetch<{ filename: string; integrityCheck: string }>('/api/admin/backups', {
        method: 'POST',
      });
      setNotice(`Verified SQLite backup '${res.filename}' created (PRAGMA integrity_check: ${res.integrityCheck}).`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backup failed');
    }
  }

  function handleRestoreBackup(id: string, filename: string) {
    setRestoreTarget({ id, filename });
  }

  async function confirmRestoreBackup() {
    if (!restoreTarget) return;
    setError('');
    try {
      const res = await apiFetch<{ restoredFrom: string }>(`/api/admin/backups/${restoreTarget.id}/restore`, {
        method: 'POST',
      });
      setNotice(`Database restored & verified from ${res.restoredFrom}.`);
      setRestoreTarget(null);
      await load();
      onRefreshBootstrap();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed');
    }
  }

  async function handleInstallLicense(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const parsed = JSON.parse(licenseJson);
      const res = await apiFetch<LicenseStatus>('/api/admin/license/install', {
        method: 'POST',
        body: JSON.stringify(parsed),
      });
      setNotice(`License installed: ${res.message}`);
      setLicenseJson('');
      await load();
      onRefreshBootstrap();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'License installation failed');
    }
  }

  function handleLogoUpload(file: File | undefined) {
    if (!file || !settingsForm) return;
    if (file.size > 512 * 1024) {
      setError('Logo image must be 512 KB or smaller.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setSettingsForm({ ...settingsForm, logo_data_url: reader.result });
      }
    };
    reader.readAsDataURL(file);
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!settingsForm) return;
    setError('');
    const threshErr = checkStrictDecimalInput(
      String(settingsForm.default_low_stock_threshold ?? '10'),
      'qty',
      'Default low-stock threshold',
      { allowZero: true }
    );
    if (threshErr) {
      setError(threshErr);
      return;
    }
    try {
      await apiFetch('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          pharmacyName: settingsForm.pharmacy_name,
          drugLicenseNo: settingsForm.drug_license_no,
          address: settingsForm.address,
          phone: settingsForm.phone,
          email: settingsForm.email,
          website: settingsForm.website,
          currency: settingsForm.currency,
          currencySymbol: settingsForm.currency_symbol,
          timezone: settingsForm.timezone,
          defaultLowStockThreshold: settingsForm.default_low_stock_threshold,
          sessionTimeoutMinutes: settingsForm.session_timeout_minutes,
          logoDataUrl: settingsForm.logo_data_url || '',
          receiptFooter: settingsForm.receipt_footer,
          expiryWarningDays: settingsForm.expiry_warning_days,
          backupRetentionCount: settingsForm.backup_retention_count,
          printerType: settingsForm.printer_type,
          setupCompleted: true,
        }),
      });
      setNotice('Pharmacy settings saved.');
      setWizardOpen(false);
      await load();
      onRefreshBootstrap();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Settings update failed');
    }
  }

  if (!data) return <div className="p-6 text-sm text-slate-500">Loading administration console...</div>;

  const selectedUser = data.users.find((u) => u.id === selectedUserId);
  const auditExportParams = new URLSearchParams();
  if (auditFilter.search.trim()) auditExportParams.set('search', auditFilter.search.trim());
  if (auditFilter.module) auditExportParams.set('module', auditFilter.module);
  if (auditFilter.status) auditExportParams.set('status', auditFilter.status);
  if (auditFilter.fromDate) auditExportParams.set('fromDate', auditFilter.fromDate);
  if (auditFilter.toDate) auditExportParams.set('toDate', auditFilter.toDate);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-slate-900">Administration, Security, Backups & Offline Licensing</h1>
        <p className="text-xs text-slate-500">
          Permission precedence: Inactive Account (Deny) &gt; Super Admin &gt; Individual Override &gt; Role Rule.
        </p>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-md text-xs">{error}</div>}
      {notice && <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-md text-xs">{notice}</div>}

      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg w-fit">
        {[
          { id: 'users', label: 'Users & Permission Overrides' },
          { id: 'audit', label: 'Audit Log & Hash Chain' },
          { id: 'backups', label: 'Verified SQLite Backups' },
          { id: 'license', label: 'Offline License & LAN' },
          { id: 'settings', label: 'Pharmacy Setup & Settings' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as typeof tab)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${
              tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'users' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <div className="lg:col-span-5 space-y-4">
            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 font-semibold text-sm">Staff Accounts</div>
              <div className="divide-y divide-slate-100">
                {data.users.map((u) => (
                  <div
                    key={u.id}
                    className={`p-3 flex items-center justify-between gap-2 text-xs ${
                      selectedUserId === u.id ? 'bg-teal-50/50' : ''
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900 truncate">
                        {u.full_name} ({u.username})
                        {Boolean(u.must_change_password) && (
                          <span className="ml-1.5 px-1.5 py-0.5 text-[10px] bg-amber-100 text-amber-800 rounded">
                            Reset Pending
                          </span>
                        )}
                      </div>
                      <div className="text-slate-500">
                        {u.role_name} · {u.is_active ? 'Active' : 'Deactivated'}
                        {u.last_login_at ? ` · Last login: ${u.last_login_at.slice(0, 16).replace('T', ' ')}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setSelectedUserId(u.id)}
                        className="text-teal-700 hover:underline font-medium"
                      >
                        Overrides
                      </button>
                      {user.permissions['admin.users'] && (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              setEditUserTarget({
                                id: u.id,
                                username: u.username,
                                fullName: u.full_name,
                                phone: u.phone || '',
                                email: u.email || '',
                                roleId: u.role_id,
                                isSuperAdmin: Boolean(u.is_super_admin),
                              })
                            }
                            className="inline-flex items-center gap-0.5 text-slate-700 hover:underline"
                          >
                            <Edit3 className="w-3 h-3" /> Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setResetPwdTarget(u);
                              setResetPwdValue('');
                              setResetForceChange(true);
                            }}
                            className="inline-flex items-center gap-0.5 text-amber-700 hover:underline"
                          >
                            <RotateCcw className="w-3 h-3" /> Reset Pwd
                          </button>
                          {u.id !== user.id && (
                            <button
                              type="button"
                              onClick={async () => {
                                await apiFetch(`/api/admin/users/${u.id}/toggle-active`, { method: 'POST' });
                                load();
                              }}
                              className="text-slate-600 hover:underline"
                            >
                              {u.is_active ? 'Deactivate' : 'Activate'}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {user.permissions['admin.users'] && (
              <form onSubmit={handleCreateUser} className="bg-white border border-slate-200 rounded-lg p-4 space-y-2.5 text-xs">
                <div className="font-semibold text-slate-900">Add Staff User</div>
                <input
                  type="text"
                  required
                  placeholder="Username"
                  value={newUser.username}
                  onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded"
                />
                <input
                  type="text"
                  required
                  placeholder="Full Name"
                  value={newUser.fullName}
                  onChange={(e) => setNewUser({ ...newUser, fullName: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="Phone"
                    value={newUser.phone}
                    onChange={(e) => setNewUser({ ...newUser, phone: e.target.value })}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded"
                  />
                  <input
                    type="email"
                    placeholder="Email"
                    value={newUser.email}
                    onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded"
                  />
                </div>
                <input
                  type="password"
                  required
                  minLength={6}
                  placeholder="Password (min 6 chars)"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded"
                />
                <select
                  value={newUser.roleId}
                  onChange={(e) => setNewUser({ ...newUser, roleId: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                >
                  {data.roles.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="w-full py-2 bg-teal-700 hover:bg-teal-800 text-white font-semibold rounded"
                >
                  Create Staff Account
                </button>
              </form>
            )}
          </div>

          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200">
              <div className="font-semibold text-sm text-slate-900">
                Individual Permission Overrides · {selectedUser?.full_name || 'Select User'}
              </div>
              <div className="text-[11px] text-slate-500">
                {selectedUser?.is_super_admin
                  ? 'Super Admin always has full administrative access.'
                  : 'Override any permission for this specific user without altering global role defaults.'}
              </div>
            </div>
            <div className="max-h-[500px] overflow-y-auto divide-y divide-slate-100">
              {data.permissions.map((p) => {
                const roleAllows = data.rolePermissions.some(
                  (rp) => rp.role_id === selectedUser?.role_id && rp.permission_code === p.code
                );
                const ov = data.overrides.find(
                  (o) => o.user_id === selectedUserId && o.permission_code === p.code
                );
                const currentEffect = ov?.effect || 'INHERIT';
                return (
                  <div key={p.code} className="px-4 py-2 flex items-center justify-between gap-2 text-xs">
                    <div>
                      <div className="font-medium text-slate-900">{p.label}</div>
                      <div className="text-[11px] text-slate-500 font-mono-num">
                        {p.code} · Role default: {roleAllows ? 'Allow' : 'Deny'}
                      </div>
                    </div>
                    <select
                      disabled={!user.permissions['admin.permissions'] || Boolean(selectedUser?.is_super_admin)}
                      value={currentEffect}
                      onChange={(e) =>
                        handleOverrideChange(p.code, e.target.value as 'ALLOW' | 'DENY' | 'INHERIT')
                      }
                      className="px-2 py-1 border border-slate-300 rounded bg-white text-xs"
                    >
                      <option value="INHERIT">Inherit ({roleAllows ? 'Allow' : 'Deny'})</option>
                      <option value="ALLOW">Force Allow</option>
                      <option value="DENY">Force Deny</option>
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {tab === 'audit' && (
        <div className="space-y-3">
          {data.auditChain && (
            <div
              className={`p-3 border rounded-md text-xs flex flex-wrap items-center justify-between gap-2 ${
                data.auditChain.valid
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-red-50 border-red-200 text-red-800'
              }`}
            >
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>
                  Local SHA-256 Hash Chain Integrity: {data.auditChain.valid ? 'VERIFIED' : `BROKEN AT #${data.auditChain.brokenAtSeq}`} ·{' '}
                  {data.auditChain.totalEntries} immutable audit records
                </span>
              </div>
              <span className="text-[11px] opacity-80">
                Detects post-write modifications inside the local SQLite audit ledger.
              </span>
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              loadFilteredAudit(0).catch((err) => setError(err.message));
            }}
            className="bg-white border border-slate-200 rounded-lg p-3 flex flex-wrap items-end gap-2 text-xs"
          >
            <div className="flex-1 min-w-[160px]">
              <label className="block text-[11px] text-slate-500 mb-1">Search User / Action / Ref / Reason</label>
              <input
                type="text"
                placeholder="Search logs..."
                value={auditFilter.search}
                onChange={(e) => setAuditFilter({ ...auditFilter, search: e.target.value })}
                className="w-full px-2.5 py-1.5 border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Module</label>
              <select
                value={auditFilter.module}
                onChange={(e) => setAuditFilter({ ...auditFilter, module: e.target.value })}
                className="px-2.5 py-1.5 border border-slate-300 rounded bg-white"
              >
                <option value="">All Modules</option>
                <option value="accounts">Accounts & Auth</option>
                <option value="sales">Sales & POS</option>
                <option value="purchases">Purchases</option>
                <option value="inventory">Inventory</option>
                <option value="medicines">Medicines</option>
                <option value="finance">Finance & Cash</option>
                <option value="settings">Settings</option>
                <option value="permissions">Permissions</option>
                <option value="backups">Backups</option>
                <option value="licensing">Licensing</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Status</label>
              <select
                value={auditFilter.status}
                onChange={(e) => setAuditFilter({ ...auditFilter, status: e.target.value })}
                className="px-2.5 py-1.5 border border-slate-300 rounded bg-white"
              >
                <option value="">All</option>
                <option value="SUCCESS">SUCCESS</option>
                <option value="FAILURE">FAILURE</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">From</label>
              <input
                type="date"
                value={auditFilter.fromDate}
                onChange={(e) => setAuditFilter({ ...auditFilter, fromDate: e.target.value })}
                className="px-2 py-1.5 border border-slate-300 rounded font-mono-num"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">To</label>
              <input
                type="date"
                value={auditFilter.toDate}
                onChange={(e) => setAuditFilter({ ...auditFilter, toDate: e.target.value })}
                className="px-2 py-1.5 border border-slate-300 rounded font-mono-num"
              />
            </div>
            <button type="submit" className="px-3 py-1.5 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded">
              Apply Filters
            </button>
            <button
              type="button"
              onClick={() => {
                const cleared = { search: '', module: '', status: '', fromDate: '', toDate: '' };
                setAuditFilter(cleared);
                loadFilteredAudit(0, cleared).catch((err) => setError(err.message));
              }}
              className="px-3 py-1.5 text-slate-700 bg-slate-100 hover:bg-slate-200 rounded"
            >
              Reset
            </button>
            <a
              href={`/api/admin/audit/export?${auditExportParams.toString()}`}
              className="inline-flex items-center gap-1 px-3 py-1.5 font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded"
            >
              <Download className="w-3.5 h-3.5" /> Export Excel
            </a>
          </form>

          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">#</th>
                  <th className="text-left px-3 py-2">Timestamp</th>
                  <th className="text-left px-3 py-2">User / IP</th>
                  <th className="text-left px-3 py-2">Action / Module</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-left px-3 py-2">Ref / Reason</th>
                  <th className="text-left px-3 py-2">Hash Prefix</th>
                  <th className="text-right px-3 py-2">Diff</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {auditRows.map((a) => (
                  <tr key={a.id}>
                    <td className="px-3 py-2 font-mono-num">{a.seq}</td>
                    <td className="px-3 py-2 font-mono-num text-slate-500">{a.created_at.slice(0, 19).replace('T', ' ')}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-900">{a.username}</div>
                      {a.ip_address && <div className="text-[10px] font-mono-num text-slate-400">{a.ip_address}</div>}
                    </td>
                    <td className="px-3 py-2 font-mono-num">
                      {a.action} <span className="text-slate-400">({a.module})</span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={a.status === 'FAILURE' ? 'text-red-700 font-semibold' : 'text-emerald-700 font-medium'}>
                        {a.status || 'SUCCESS'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {a.transaction_ref || a.target_id} {a.reason ? `· ${a.reason}` : ''}
                    </td>
                    <td className="px-3 py-2 font-mono-num text-slate-400">{a.entry_hash.slice(0, 12)}...</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setInspectAudit(a)}
                        className="inline-flex items-center gap-1 text-teal-700 hover:underline font-medium"
                      >
                        <Eye className="w-3.5 h-3.5" /> Inspect
                      </button>
                    </td>
                  </tr>
                ))}
                {auditRows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
                      No audit records match the active filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>
              Showing {auditRows.length} of {auditTotal} records (Offset {auditOffset})
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={auditOffset === 0}
                onClick={() => loadFilteredAudit(Math.max(0, auditOffset - 50)).catch((err) => setError(err.message))}
                className="px-3 py-1.5 bg-white border border-slate-300 rounded disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={auditOffset + 50 >= auditTotal}
                onClick={() => loadFilteredAudit(auditOffset + 50).catch((err) => setError(err.message))}
                className="px-3 py-1.5 bg-white border border-slate-300 rounded disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'backups' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white border border-slate-200 rounded-lg p-4">
            <div className="text-xs">
              <div className="font-semibold text-slate-900 text-sm">SQLite Online Backup API (WAL-Safe)</div>
              <div className="text-slate-500 mt-0.5">
                Every backup is written using native SQLite online backup and verified with PRAGMA integrity_check.
              </div>
            </div>
            <button
              type="button"
              onClick={handleCreateBackup}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap shrink-0"
            >
              <DatabaseBackup className="w-4 h-4" />
              Create Verified Backup Now
            </button>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="text-left px-4 py-2.5">Filename</th>
                  <th className="text-left px-4 py-2.5">Type</th>
                  <th className="text-right px-4 py-2.5">Size</th>
                  <th className="text-left px-4 py-2.5">Integrity Check</th>
                  <th className="text-left px-4 py-2.5">SHA-256</th>
                  <th className="text-right px-4 py-2.5">Restore</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.backups.map((b) => (
                  <tr key={b.id}>
                    <td className="px-4 py-2.5 font-mono-num font-medium">{b.filename}</td>
                    <td className="px-4 py-2.5">{b.backup_type}</td>
                    <td className="px-4 py-2.5 text-right font-mono-num">{(b.size_bytes / 1024).toFixed(1)} KB</td>
                    <td className="px-4 py-2.5 font-semibold text-emerald-700">
                      {b.status} ({b.integrity_check_result})
                    </td>
                    <td className="px-4 py-2.5 font-mono-num text-slate-400">{b.sha256.slice(0, 14)}...</td>
                    <td className="px-4 py-2.5 text-right">
                      {b.status === 'VERIFIED' && (
                        <button
                          type="button"
                          onClick={() => handleRestoreBackup(b.id, b.filename)}
                          className="text-amber-700 hover:underline font-medium"
                        >
                          Restore
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {data.backups.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                      No manual backups created yet. Click Create Verified Backup Now to verify WAL backup & restore.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'license' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-4">
            <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3 text-xs">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
                <KeyRound className="w-4 h-4 text-teal-700" />
                Offline Ed25519 License Status
              </div>
              <div className="p-3 bg-slate-50 border border-slate-200 rounded space-y-1.5 font-mono-num">
                <div>Status: <strong>{data.license.status}</strong></div>
                <div>Writable: <strong>{data.license.writable ? 'YES (Full Operation)' : 'READ-ONLY (Data Export & Reprints Unlocked)'}</strong></div>
                <div>Device Fingerprint: <strong>{data.license.deviceFingerprint}</strong></div>
                {data.license.payload && (
                  <>
                    <div>License ID: {data.license.payload.licenseId}</div>
                    <div>Licensed To: {data.license.payload.pharmacyName}</div>
                    <div>Type: {data.license.payload.licenseType}</div>
                    <div>Expiry: {data.license.payload.expiryDate || 'Lifetime'}</div>
                  </>
                )}
              </div>
              <p className="text-slate-500">
                Only the Ed25519 public verification key is stored inside the application. Clock-rollback protection compares UTC timestamps monotonically across restarts.
              </p>
            </div>

            {data.networkInfo && (
              <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-2.5 text-xs">
                <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
                  <Network className="w-4 h-4 text-teal-700" />
                  Multi-Device LAN Access URLs
                </div>
                <p className="text-slate-500">
                  Open any URL below from counter PCs or tablets connected to the same shop Wi-Fi/LAN ({data.networkInfo.hostname}, Port {data.networkInfo.port}):
                </p>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded space-y-1 font-mono-num text-slate-800">
                  {data.networkInfo.urls.map((u) => (
                    <div key={u}>{u}</div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <form onSubmit={handleInstallLicense} className="bg-white border border-slate-200 rounded-lg p-5 space-y-3 text-xs h-fit">
            <div className="font-bold text-sm text-slate-900">Install Signed License JSON</div>
            <textarea
              rows={9}
              required
              placeholder='Paste signed license JSON payload from License Manager...'
              value={licenseJson}
              onChange={(e) => setLicenseJson(e.target.value)}
              className="w-full p-2.5 border border-slate-300 rounded font-mono-num text-[11px]"
            />
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md"
            >
              Verify Signature & Activate License
            </button>
          </form>
        </div>
      )}

      {tab === 'settings' && settingsForm && (
        <form onSubmit={handleSaveSettings} className="bg-white border border-slate-200 rounded-lg p-5 max-w-3xl space-y-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <ShieldCheck className="w-4 h-4 text-teal-700" />
              Pharmacy Profile, Receipt Format & Security Configuration
            </div>
            <button
              type="button"
              onClick={() => {
                setWizardStep(1);
                setWizardOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded-md whitespace-nowrap"
            >
              <Wand2 className="w-3.5 h-3.5" />
              Launch Setup Wizard
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-4 p-3 bg-slate-50 border border-slate-200 rounded-md">
            <div className="w-14 h-14 bg-white border border-slate-200 rounded-md flex items-center justify-center overflow-hidden shrink-0">
              {settingsForm.logo_data_url ? (
                <img src={settingsForm.logo_data_url} alt="Pharmacy logo preview" className="w-full h-full object-contain" />
              ) : (
                <span className="text-[10px] text-slate-400">No Logo</span>
              )}
            </div>
            <div className="space-y-1.5">
              <div className="font-semibold text-slate-800">Pharmacy Brand Logo (Displayed on Sidebar & Official A5 Receipts)</div>
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 rounded cursor-pointer hover:bg-slate-100 font-medium">
                  <Upload className="w-3.5 h-3.5" /> Upload Logo (PNG/JPG/SVG)
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml,image/webp"
                    className="hidden"
                    onChange={(e) => handleLogoUpload(e.target.files?.[0])}
                  />
                </label>
                {settingsForm.logo_data_url && (
                  <button
                    type="button"
                    onClick={() => setSettingsForm({ ...settingsForm, logo_data_url: '' })}
                    className="px-2.5 py-1.5 text-red-700 hover:underline"
                  >
                    Remove Logo
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-600 mb-1">Pharmacy Name *</label>
              <input
                type="text"
                required
                value={settingsForm.pharmacy_name}
                onChange={(e) => setSettingsForm({ ...settingsForm, pharmacy_name: e.target.value })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Drug License / Registration No</label>
              <input
                type="text"
                value={settingsForm.drug_license_no}
                onChange={(e) => setSettingsForm({ ...settingsForm, drug_license_no: e.target.value })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Phone</label>
              <input
                type="text"
                value={settingsForm.phone}
                onChange={(e) => setSettingsForm({ ...settingsForm, phone: e.target.value })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Email</label>
              <input
                type="email"
                value={settingsForm.email}
                onChange={(e) => setSettingsForm({ ...settingsForm, email: e.target.value })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Website</label>
              <input
                type="text"
                placeholder="https://medinest.local"
                value={settingsForm.website || ''}
                onChange={(e) => setSettingsForm({ ...settingsForm, website: e.target.value })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Timezone</label>
              <input
                type="text"
                value={settingsForm.timezone || 'Asia/Dhaka'}
                onChange={(e) => setSettingsForm({ ...settingsForm, timezone: e.target.value })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-slate-600 mb-1">Address</label>
              <input
                type="text"
                value={settingsForm.address}
                onChange={(e) => setSettingsForm({ ...settingsForm, address: e.target.value })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Currency Code</label>
              <input
                type="text"
                maxLength={8}
                value={settingsForm.currency || 'BDT'}
                onChange={(e) => setSettingsForm({ ...settingsForm, currency: e.target.value.toUpperCase() })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Currency Symbol</label>
              <input
                type="text"
                maxLength={6}
                value={settingsForm.currency_symbol || '৳'}
                onChange={(e) => setSettingsForm({ ...settingsForm, currency_symbol: e.target.value })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Default Receipt Format</label>
              <select
                value={settingsForm.printer_type}
                onChange={(e) =>
                  setSettingsForm({
                    ...settingsForm,
                    printer_type: e.target.value as 'A5' | 'THERMAL_80MM' | 'A4',
                  })
                }
                className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
              >
                <option value="A5">A5 Standard (148 × 210 mm Official Default)</option>
                <option value="THERMAL_80MM">80mm Thermal POS Printer</option>
                <option value="A4">Standard A4 Laser/Inkjet</option>
              </select>
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Expiry Warning Window (Days)</label>
              <input
                type="number"
                min={7}
                value={settingsForm.expiry_warning_days}
                onChange={(e) => setSettingsForm({ ...settingsForm, expiry_warning_days: Number(e.target.value) })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Default Low Stock Threshold</label>
              <input
                type="text"
                inputMode="decimal"
                value={settingsForm.default_low_stock_threshold ?? '10'}
                onChange={(e) => setSettingsForm({ ...settingsForm, default_low_stock_threshold: e.target.value })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Session Timeout (Minutes)</label>
              <input
                type="number"
                min={15}
                max={1440}
                value={settingsForm.session_timeout_minutes ?? 960}
                onChange={(e) => setSettingsForm({ ...settingsForm, session_timeout_minutes: Number(e.target.value) })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Backup Retention Count</label>
              <input
                type="number"
                min={3}
                value={settingsForm.backup_retention_count}
                onChange={(e) => setSettingsForm({ ...settingsForm, backup_retention_count: Number(e.target.value) })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-slate-600 mb-1">Receipt Footer</label>
              <input
                type="text"
                value={settingsForm.receipt_footer}
                onChange={(e) => setSettingsForm({ ...settingsForm, receipt_footer: e.target.value })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded"
              />
            </div>
          </div>
          <button
            type="submit"
            className="px-5 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md"
          >
            Save Pharmacy Settings
          </button>
        </form>
      )}

      <ConfirmActionModal
        open={Boolean(restoreTarget)}
        title={`Restore Database Backup (${restoreTarget?.filename || ''})`}
        description="A pre-restore safety backup will be created automatically before restoring from this verified snapshot."
        confirmLabel="Restore Database"
        onCancel={() => setRestoreTarget(null)}
        onConfirm={confirmRestoreBackup}
      />

      {/* Edit Staff User Modal */}
      {editUserTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form onSubmit={handleEditUserSubmit} className="bg-white rounded-lg border border-slate-200 w-full max-w-md p-5 space-y-3 text-xs">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2">
              <h3 className="text-sm font-bold text-slate-900">Edit User · {editUserTarget.username}</h3>
              <button type="button" onClick={() => setEditUserTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Full Name *</label>
              <input
                type="text"
                required
                value={editUserTarget.fullName}
                onChange={(e) => setEditUserTarget({ ...editUserTarget, fullName: e.target.value })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-slate-600 mb-1">Phone</label>
                <input
                  type="text"
                  value={editUserTarget.phone}
                  onChange={(e) => setEditUserTarget({ ...editUserTarget, phone: e.target.value })}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Email</label>
                <input
                  type="email"
                  value={editUserTarget.email}
                  onChange={(e) => setEditUserTarget({ ...editUserTarget, email: e.target.value })}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded"
                />
              </div>
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Assigned Role</label>
              <select
                value={editUserTarget.roleId}
                onChange={(e) => setEditUserTarget({ ...editUserTarget, roleId: e.target.value })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
              >
                {data.roles.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
            <label className="inline-flex items-center gap-2 text-slate-700">
              <input
                type="checkbox"
                checked={editUserTarget.isSuperAdmin}
                onChange={(e) => setEditUserTarget({ ...editUserTarget, isSuperAdmin: e.target.checked })}
              />
              Super Admin Access
            </label>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button type="button" onClick={() => setEditUserTarget(null)} className="px-3 py-1.5 bg-slate-100 rounded">
                Cancel
              </button>
              <button type="submit" className="px-4 py-1.5 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded">
                Save User
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Admin Password Reset Modal */}
      {resetPwdTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form onSubmit={handleResetPasswordSubmit} className="bg-white rounded-lg border border-slate-200 w-full max-w-md p-5 space-y-3 text-xs">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2">
              <h3 className="text-sm font-bold text-slate-900">Reset Password · {resetPwdTarget.username}</h3>
              <button type="button" onClick={() => setResetPwdTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Temporary / New Password (min 6 chars) *</label>
              <input
                type="password"
                required
                minLength={6}
                value={resetPwdValue}
                onChange={(e) => setResetPwdValue(e.target.value)}
                className="w-full px-2.5 py-2 border border-slate-300 rounded"
              />
            </div>
            <label className="inline-flex items-center gap-2 text-slate-700">
              <input
                type="checkbox"
                checked={resetForceChange}
                onChange={(e) => setResetForceChange(e.target.checked)}
              />
              Force password change on next sign-in
            </label>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button type="button" onClick={() => setResetPwdTarget(null)} className="px-3 py-1.5 bg-slate-100 rounded">
                Cancel
              </button>
              <button type="submit" className="px-4 py-1.5 font-semibold text-white bg-amber-700 hover:bg-amber-800 rounded">
                Reset Password
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Inspect Audit Diff Modal */}
      {inspectAudit && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg border border-slate-200 shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-5 space-y-3 text-xs">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  Audit Record #{inspectAudit.seq} · {inspectAudit.action}
                </h3>
                <div className="text-[11px] text-slate-500 font-mono-num">
                  {inspectAudit.created_at} · User: {inspectAudit.username} · Module: {inspectAudit.module}
                </div>
              </div>
              <button type="button" onClick={() => setInspectAudit(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 p-2.5 bg-slate-50 border border-slate-200 rounded font-mono-num text-[11px]">
              <div>Status: <strong>{inspectAudit.status || 'SUCCESS'}</strong></div>
              <div>IP Address: {inspectAudit.ip_address || '—'}</div>
              <div>Session ID: {inspectAudit.session_id || '—'}</div>
              <div>Target: {inspectAudit.target_type} ({inspectAudit.target_id || '—'})</div>
              <div className="col-span-2 break-all">Prev Hash: {inspectAudit.prev_hash}</div>
              <div className="col-span-2 break-all">Entry Hash: {inspectAudit.entry_hash}</div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <div className="font-semibold text-slate-700 mb-1">Before State</div>
                <pre className="p-2.5 bg-slate-50 border border-slate-200 rounded font-mono-num text-[11px] overflow-x-auto max-h-48">
                  {prettyJson(inspectAudit.before_state)}
                </pre>
              </div>
              <div>
                <div className="font-semibold text-slate-700 mb-1">After State</div>
                <pre className="p-2.5 bg-slate-50 border border-slate-200 rounded font-mono-num text-[11px] overflow-x-auto max-h-48">
                  {prettyJson(inspectAudit.after_state)}
                </pre>
              </div>
            </div>
            {inspectAudit.metadata_json && (
              <div>
                <div className="font-semibold text-slate-700 mb-1">Metadata</div>
                <pre className="p-2.5 bg-slate-50 border border-slate-200 rounded font-mono-num text-[11px] overflow-x-auto">
                  {prettyJson(inspectAudit.metadata_json)}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Setup Wizard */}
      {wizardOpen && settingsForm && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="setup-wizard-title"
            className="bg-white rounded-lg border border-slate-200 shadow-xl w-full max-w-lg p-5 space-y-4 text-xs"
          >
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h2 id="setup-wizard-title" className="text-sm font-bold text-slate-900">
                  MediNest Setup Wizard · Step {wizardStep} of 3
                </h2>
                <p className="text-[11px] text-slate-500">Configure pharmacy identity, A5 receipt standard, and safety retention</p>
              </div>
              <button
                type="button"
                aria-label="Close setup wizard"
                onClick={() => setWizardOpen(false)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {wizardStep === 1 && (
              <div className="space-y-3">
                <div>
                  <label className="block text-slate-600 mb-1">Pharmacy Name *</label>
                  <input
                    type="text"
                    required
                    value={settingsForm.pharmacy_name}
                    onChange={(e) => setSettingsForm({ ...settingsForm, pharmacy_name: e.target.value })}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Drug License / Registration No</label>
                  <input
                    type="text"
                    value={settingsForm.drug_license_no}
                    onChange={(e) => setSettingsForm({ ...settingsForm, drug_license_no: e.target.value })}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-slate-600 mb-1">Phone</label>
                    <input
                      type="text"
                      value={settingsForm.phone}
                      onChange={(e) => setSettingsForm({ ...settingsForm, phone: e.target.value })}
                      className="w-full px-2.5 py-2 border border-slate-300 rounded"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-600 mb-1">Email</label>
                    <input
                      type="email"
                      value={settingsForm.email}
                      onChange={(e) => setSettingsForm({ ...settingsForm, email: e.target.value })}
                      className="w-full px-2.5 py-2 border border-slate-300 rounded"
                    />
                  </div>
                </div>
              </div>
            )}

            {wizardStep === 2 && (
              <div className="space-y-3">
                <div>
                  <label className="block text-slate-600 mb-1">Default Receipt Standard</label>
                  <select
                    value={settingsForm.printer_type}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        printer_type: e.target.value as 'A5' | 'THERMAL_80MM' | 'A4',
                      })
                    }
                    className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
                  >
                    <option value="A5">A5 Standard (148 × 210 mm Official Default)</option>
                    <option value="THERMAL_80MM">80mm Thermal POS Printer</option>
                    <option value="A4">Standard A4 Laser/Inkjet</option>
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-slate-600 mb-1">Currency Code</label>
                    <input
                      type="text"
                      value={settingsForm.currency || 'BDT'}
                      onChange={(e) => setSettingsForm({ ...settingsForm, currency: e.target.value.toUpperCase() })}
                      className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-600 mb-1">Currency Symbol</label>
                    <input
                      type="text"
                      value={settingsForm.currency_symbol || '৳'}
                      onChange={(e) => setSettingsForm({ ...settingsForm, currency_symbol: e.target.value })}
                      className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Receipt Footer</label>
                  <input
                    type="text"
                    value={settingsForm.receipt_footer}
                    onChange={(e) => setSettingsForm({ ...settingsForm, receipt_footer: e.target.value })}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded"
                  />
                </div>
              </div>
            )}

            {wizardStep === 3 && (
              <div className="space-y-3">
                <div>
                  <label className="block text-slate-600 mb-1">Expiry Warning Window (Days)</label>
                  <input
                    type="number"
                    min={7}
                    value={settingsForm.expiry_warning_days}
                    onChange={(e) => setSettingsForm({ ...settingsForm, expiry_warning_days: Number(e.target.value) })}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Verified Backup Retention Count</label>
                  <input
                    type="number"
                    min={3}
                    value={settingsForm.backup_retention_count}
                    onChange={(e) => setSettingsForm({ ...settingsForm, backup_retention_count: Number(e.target.value) })}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Session Timeout (Minutes)</label>
                  <input
                    type="number"
                    min={15}
                    max={1440}
                    value={settingsForm.session_timeout_minutes ?? 960}
                    onChange={(e) => setSettingsForm({ ...settingsForm, session_timeout_minutes: Number(e.target.value) })}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
                  />
                </div>
              </div>
            )}

            <div className="flex items-center justify-between pt-2 border-t border-slate-200">
              <button
                type="button"
                disabled={wizardStep === 1}
                onClick={() => setWizardStep((s) => Math.max(1, s - 1))}
                className="px-3 py-1.5 text-xs bg-slate-100 rounded-md disabled:opacity-40"
              >
                Back
              </button>
              <div className="flex items-center gap-2">
                {wizardStep < 3 ? (
                  <button
                    type="button"
                    onClick={() => setWizardStep((s) => Math.min(3, s + 1))}
                    className="px-4 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                  >
                    Next Step
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => handleSaveSettings(e as unknown as React.FormEvent)}
                    className="px-4 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                  >
                    Finish & Save Setup
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
