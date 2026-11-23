import React, { useEffect, useState } from 'react';
import { CheckCircle2, DatabaseBackup, KeyRound, ShieldCheck, Wand2, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { ConfirmActionModal } from '../components/ActionModals';
import type { AuthUser, LicenseStatus, PharmacySettings } from '../types';

interface AdminPayload {
  roles: Array<{ id: string; name: string; description: string }>;
  permissions: Array<{ code: string; module: string; label: string }>;
  rolePermissions: Array<{ role_id: string; permission_code: string }>;
  users: Array<{
    id: string;
    username: string;
    full_name: string;
    phone: string;
    email: string;
    role_id: string;
    role_name: string;
    is_super_admin: number;
    is_active: number;
  }>;
  overrides: Array<{ user_id: string; permission_code: string; effect: 'ALLOW' | 'DENY'; reason: string }>;
  auditLogs: Array<{
    id: string;
    seq: number;
    username: string;
    action: string;
    module: string;
    target_type: string;
    transaction_ref: string;
    reason: string;
    entry_hash: string;
    created_at: string;
  }>;
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
}

interface Props {
  user: AuthUser;
  onRefreshBootstrap: () => void;
}

export const AdminPage: React.FC<Props> = ({ user, onRefreshBootstrap }) => {
  const [data, setData] = useState<AdminPayload | null>(null);
  const [tab, setTab] = useState<'users' | 'audit' | 'backups' | 'license' | 'settings'>('users');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [newUser, setNewUser] = useState({ username: '', fullName: '', password: '', roleId: '', phone: '' });
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
    if (!selectedUserId && res.users.length > 0) {
      setSelectedUserId(res.users.find((u) => !u.is_super_admin)?.id || res.users[0].id);
    }
    if (!newUser.roleId && res.roles.length > 0) {
      setNewUser((p) => ({ ...p, roleId: res.roles[res.roles.length - 1].id }));
    }
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
      setNewUser((p) => ({ ...p, username: '', fullName: '', password: '', phone: '' }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'User creation failed');
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
      const res = await apiFetch<{ restoredFrom: string }>(`/api/admin/backups/${restoreTarget.id}/restore`, { method: 'POST' });
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

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!settingsForm) return;
    setError('');
    try {
      await apiFetch('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          pharmacyName: settingsForm.pharmacy_name,
          pharmacyNameBn: settingsForm.pharmacy_name_bn,
          drugLicenseNo: settingsForm.drug_license_no,
          address: settingsForm.address,
          phone: settingsForm.phone,
          email: settingsForm.email,
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
          { id: 'license', label: 'Offline License' },
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
                    className={`p-3 flex items-center justify-between text-xs ${
                      selectedUserId === u.id ? 'bg-teal-50/50' : ''
                    }`}
                  >
                    <div>
                      <div className="font-semibold text-slate-900">
                        {u.full_name} ({u.username})
                      </div>
                      <div className="text-slate-500">
                        {u.role_name} · {u.is_active ? 'Active' : 'Deactivated'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedUserId(u.id)}
                        className="text-teal-700 hover:underline font-medium"
                      >
                        Overrides
                      </button>
                      {u.id !== user.id && user.permissions['admin.users'] && (
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
              className={`p-3 border rounded-md text-xs flex items-center gap-2 ${
                data.auditChain.valid
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-red-50 border-red-200 text-red-800'
              }`}
            >
              <CheckCircle2 className="w-4 h-4" />
              SHA-256 Hash Chain Integrity: {data.auditChain.valid ? 'VERIFIED' : `BROKEN AT #${data.auditChain.brokenAtSeq}`} ·{' '}
              {data.auditChain.totalEntries} immutable audit records
            </div>
          )}
          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">#</th>
                  <th className="text-left px-3 py-2">Timestamp</th>
                  <th className="text-left px-3 py-2">User</th>
                  <th className="text-left px-3 py-2">Action / Module</th>
                  <th className="text-left px-3 py-2">Ref / Reason</th>
                  <th className="text-left px-3 py-2">Hash Prefix</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.auditLogs.map((a) => (
                  <tr key={a.id}>
                    <td className="px-3 py-2 font-mono-num">{a.seq}</td>
                    <td className="px-3 py-2 font-mono-num text-slate-500">{a.created_at.slice(0, 19).replace('T', ' ')}</td>
                    <td className="px-3 py-2 font-medium">{a.username}</td>
                    <td className="px-3 py-2 font-mono-num">
                      {a.action} <span className="text-slate-400">({a.module})</span>
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {a.transaction_ref} {a.reason ? `· ${a.reason}` : ''}
                    </td>
                    <td className="px-3 py-2 font-mono-num text-slate-400">{a.entry_hash.slice(0, 12)}...</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'backups' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white border border-slate-200 rounded-lg p-4">
            <div className="text-xs">
              <div className="font-semibold text-slate-900 text-sm">SQLite Online Backup API (WAL-Safe)</div>
              <div className="text-slate-500 mt-0.5">
                Every backup is written outside app code using native sqlite3 backup and verified with PRAGMA integrity_check.
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
                      No manual backups created yet. Click Create Verified Backup Now to test WAL backup & verification.
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
              Only the Ed25519 public verification key is stored inside the application. Private signing keys stay strictly with the developer License Manager utility.
            </p>
          </div>

          <form onSubmit={handleInstallLicense} className="bg-white border border-slate-200 rounded-lg p-5 space-y-3 text-xs">
            <div className="font-bold text-sm text-slate-900">Install Signed License JSON</div>
            <textarea
              rows={8}
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
        <form onSubmit={handleSaveSettings} className="bg-white border border-slate-200 rounded-lg p-5 max-w-2xl space-y-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <ShieldCheck className="w-4 h-4 text-teal-700" />
              Pharmacy Profile, Printer & Retention Configuration
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-600 mb-1">Pharmacy Name (English) *</label>
              <input
                type="text"
                required
                value={settingsForm.pharmacy_name}
                onChange={(e) => setSettingsForm({ ...settingsForm, pharmacy_name: e.target.value })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Pharmacy Name (Bangla)</label>
              <input
                type="text"
                value={settingsForm.pharmacy_name_bn}
                onChange={(e) => setSettingsForm({ ...settingsForm, pharmacy_name_bn: e.target.value })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Drug License No</label>
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
              <label className="block text-slate-600 mb-1">Expiry Warning Days</label>
              <input
                type="number"
                min={7}
                value={settingsForm.expiry_warning_days}
                onChange={(e) => setSettingsForm({ ...settingsForm, expiry_warning_days: Number(e.target.value) })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Default Receipt Printer</label>
              <select
                value={settingsForm.printer_type}
                onChange={(e) => setSettingsForm({ ...settingsForm, printer_type: e.target.value as 'THERMAL_80MM' | 'A4' })}
                className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
              >
                <option value="THERMAL_80MM">80mm Thermal POS Printer</option>
                <option value="A4">Standard A4 Laser/Inkjet</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-slate-600 mb-1">Receipt Footer (Bangla / English)</label>
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
                  Pharmacy Setup Wizard · Step {wizardStep} of 3
                </h2>
                <p className="text-[11px] text-slate-500">Configure pharmacy identity, printer mode, and safety retention</p>
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
                  <label className="block text-slate-600 mb-1">Pharmacy Name (English) *</label>
                  <input
                    type="text"
                    required
                    value={settingsForm.pharmacy_name}
                    onChange={(e) => setSettingsForm({ ...settingsForm, pharmacy_name: e.target.value })}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Pharmacy Name (Bangla)</label>
                  <input
                    type="text"
                    value={settingsForm.pharmacy_name_bn}
                    onChange={(e) => setSettingsForm({ ...settingsForm, pharmacy_name_bn: e.target.value })}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">DGDA Drug License No</label>
                  <input
                    type="text"
                    value={settingsForm.drug_license_no}
                    onChange={(e) => setSettingsForm({ ...settingsForm, drug_license_no: e.target.value })}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded font-mono-num"
                  />
                </div>
              </div>
            )}

            {wizardStep === 2 && (
              <div className="space-y-3">
                <div>
                  <label className="block text-slate-600 mb-1">Default Receipt Printer</label>
                  <select
                    value={settingsForm.printer_type}
                    onChange={(e) => setSettingsForm({ ...settingsForm, printer_type: e.target.value as 'THERMAL_80MM' | 'A4' })}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
                  >
                    <option value="THERMAL_80MM">80mm Thermal POS Printer</option>
                    <option value="A4">Standard A4 Laser/Inkjet</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Receipt Footer (Bangla / English)</label>
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
