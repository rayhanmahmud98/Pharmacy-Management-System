import React, { useEffect, useState } from 'react';
import { Download, Pencil, Plus, Search, Settings2, Upload } from 'lucide-react';
import { apiFetch, checkStrictDecimalInput, formatQty } from '../lib/api';
import type { AuthUser, Medicine, MedicineUnit } from '../types';

interface Category {
  id: string;
  name: string;
}
interface Manufacturer {
  id: string;
  name: string;
}

interface ImportRowPreview {
  rowIndex: number;
  medicineCode: string;
  barcode: string;
  brandName: string;
  genericName: string;
  strength: string;
  baseUnit: string;
  secondaryUnit: string;
  secondaryConversion: string;
  boxUnit: string;
  boxConversion: string;
  openingBatchNumber: string;
  openingExpiryDate: string;
  openingQtyBase: string;
  duplicateMedicineId: string | null;
  duplicateAction?: 'SKIP' | 'USE_EXISTING' | 'CREATE_NEW';
  errors: string[];
}

interface Props {
  user: AuthUser;
}

export const MedicinesPage: React.FC<Props> = ({ user }) => {
  const [search, setSearch] = useState('');
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>([]);
  const [selectedMed, setSelectedMed] = useState<Medicine | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingMed, setEditingMed] = useState<Medicine | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importRows, setImportRows] = useState<ImportRowPreview[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [newMed, setNewMed] = useState({
    medicineCode: '',
    barcode: '',
    brandName: '',
    genericName: '',
    strength: '',
    dosageForm: 'Tablet',
    categoryId: '',
    manufacturerId: '',
    storageInfo: '',
    baseUnitName: 'Tablet',
    minStockLevel: '50',
    rxRequired: false,
    extraUnitName: 'Strip',
    extraUnitConv: '10',
  });

  const [editForm, setEditForm] = useState({
    medicineCode: '',
    barcode: '',
    brandName: '',
    genericName: '',
    strength: '',
    dosageForm: '',
    categoryId: '',
    manufacturerId: '',
    storageInfo: '',
    minStockLevel: '0',
    rxRequired: false,
    isActive: true,
  });

  const [newUnit, setNewUnit] = useState({
    unitName: '',
    conversionToBase: '',
    allowPurchase: true,
    allowSale: true,
  });

  async function load(q = search) {
    const res = await apiFetch<{
      medicines: Medicine[];
      categories: Category[];
      manufacturers: Manufacturer[];
    }>(`/api/medicines?search=${encodeURIComponent(q)}&includeInactive=1`);
    setMedicines(res.medicines);
    setCategories(res.categories);
    setManufacturers(res.manufacturers);
    if (selectedMed) {
      const updated = res.medicines.find((m) => m.id === selectedMed.id) || null;
      setSelectedMed(updated);
    }
  }

  useEffect(() => {
    load('').catch((e) => setError(e.message));
  }, []);

  async function handleCreateMedicine(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const minErr = checkStrictDecimalInput(newMed.minStockLevel || '0', 'qty', 'Minimum stock level', { allowZero: true });
    if (minErr) {
      setError(minErr);
      return;
    }
    if (newMed.extraUnitName.trim()) {
      const convErr = checkStrictDecimalInput(newMed.extraUnitConv, 'conversion', 'Conversion ratio');
      if (convErr) {
        setError(convErr);
        return;
      }
    }
    try {
      const units = newMed.extraUnitName.trim()
        ? [
            {
              unitName: newMed.extraUnitName.trim(),
              conversionToBase: newMed.extraUnitConv,
              allowPurchase: true,
              allowSale: true,
            },
          ]
        : [];
      await apiFetch('/api/medicines', {
        method: 'POST',
        body: JSON.stringify({
          ...newMed,
          categoryId: newMed.categoryId || null,
          manufacturerId: newMed.manufacturerId || null,
          units,
        }),
      });
      setShowCreateModal(false);
      setNotice(`Medicine '${newMed.brandName}' created with manual unit conversions.`);
      setNewMed({
        medicineCode: '',
        barcode: '',
        brandName: '',
        genericName: '',
        strength: '',
        dosageForm: 'Tablet',
        categoryId: '',
        manufacturerId: '',
        storageInfo: '',
        baseUnitName: 'Tablet',
        minStockLevel: '50',
        rxRequired: false,
        extraUnitName: 'Strip',
        extraUnitConv: '10',
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create medicine');
    }
  }

  async function handleSaveEditMedicine(e: React.FormEvent) {
    e.preventDefault();
    if (!editingMed) return;
    setError('');
    const minErr = checkStrictDecimalInput(editForm.minStockLevel || '0', 'qty', 'Minimum stock level', { allowZero: true });
    if (minErr) {
      setError(minErr);
      return;
    }
    try {
      await apiFetch(`/api/medicines/${editingMed.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...editForm,
          categoryId: editForm.categoryId || null,
          manufacturerId: editForm.manufacturerId || null,
        }),
      });
      setNotice(`Updated medicine '${editForm.brandName}'.`);
      setEditingMed(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update medicine');
    }
  }

  async function handleAddUnit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedMed) return;
    setError('');
    const convErr = checkStrictDecimalInput(newUnit.conversionToBase, 'conversion', 'Conversion ratio');
    if (convErr) {
      setError(convErr);
      return;
    }
    try {
      await apiFetch(`/api/medicines/${selectedMed.id}/units`, {
        method: 'POST',
        body: JSON.stringify({
          unitName: newUnit.unitName,
          conversionToBase: newUnit.conversionToBase,
          allowPurchase: newUnit.allowPurchase,
          allowSale: newUnit.allowSale,
          isActive: true,
        }),
      });
      setNewUnit({ unitName: '', conversionToBase: '', allowPurchase: true, allowSale: true });
      setNotice(`Manual unit added for ${selectedMed.brand_name}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add unit');
    }
  }

  async function handleUpdateUnit(u: MedicineUnit, patch: Partial<MedicineUnit>) {
    if (!selectedMed) return;
    setError('');
    const convStr = String(patch.conversion_to_base ?? u.conversion_to_base);
    if (!u.is_base) {
      const convErr = checkStrictDecimalInput(convStr, 'conversion', `Conversion ratio for ${u.unit_name}`);
      if (convErr) {
        setError(convErr);
        return;
      }
    }
    try {
      await apiFetch(`/api/medicines/${selectedMed.id}/units`, {
        method: 'POST',
        body: JSON.stringify({
          unitId: u.id,
          unitName: patch.unit_name ?? u.unit_name,
          conversionToBase: convStr,
          allowPurchase: Boolean(patch.allow_purchase ?? u.allow_purchase),
          allowSale: Boolean(patch.allow_sale ?? u.allow_sale),
          isActive: Boolean(patch.is_active ?? u.is_active),
        }),
      });
      setNotice(`Updated unit '${u.unit_name}' (historical transactions retain prior snapshots).`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update unit');
    }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setError('Only .xlsx Excel workbooks are supported. Please save your spreadsheet as .xlsx.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Excel file exceeds the 5 MB upload limit.');
      return;
    }
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    try {
      const res = await apiFetch<{ rows: ImportRowPreview[] }>('/api/medicines/import/preview', {
        method: 'POST',
        body: JSON.stringify({ fileBase64: base64 }),
      });
      setImportRows(res.rows.map((r) => ({ ...r, duplicateAction: 'SKIP' })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Excel parse failed');
    }
  }

  async function handleExecuteImport() {
    setError('');
    try {
      const res = await apiFetch<{ createdMeds: number; addedBatches: number; skipped: number }>(
        '/api/medicines/import/execute',
        {
          method: 'POST',
          body: JSON.stringify({ rows: importRows }),
        }
      );
      setShowImportModal(false);
      setImportRows([]);
      setNotice(
        `Excel import complete: ${res.createdMeds} medicines created, ${res.addedBatches} batches added, ${res.skipped} skipped.`
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Medicines, Codes &amp; Manual Unit Conversions</h1>
          <p className="text-xs text-slate-500">
            Configure medicine codes, barcodes, storage shelves, and explicit base-unit conversion ratios. No packaging assumptions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {user.permissions['medicines.manage'] && (
            <>
              <button
                type="button"
                onClick={() => setShowImportModal(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md"
              >
                <Upload className="w-3.5 h-3.5" />
                Excel Import
              </button>
              <button
                type="button"
                onClick={() => setShowCreateModal(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md"
              >
                <Plus className="w-3.5 h-3.5" />
                New Medicine
              </button>
            </>
          )}
        </div>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-md text-xs">{error}</div>}
      {notice && <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-md text-xs">{notice}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left: Medicine Table */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-3 border-b border-slate-200 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Search code, barcode, brand, generic, storage, manufacturer..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  load(e.target.value);
                }}
                className="w-full pl-9 pr-3 py-1.5 text-sm border border-slate-300 rounded-md"
              />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium">Medicine &amp; Code</th>
                  <th className="text-left px-4 py-2.5 font-medium">Base Unit &amp; Configs</th>
                  <th className="text-right px-4 py-2.5 font-medium">Sellable Stock</th>
                  <th className="text-right px-4 py-2.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {medicines.map((m) => (
                  <tr
                    key={m.id}
                    className={`${selectedMed?.id === m.id ? 'bg-teal-50/50' : 'hover:bg-slate-50'} ${!m.is_active ? 'opacity-60' : ''}`}
                  >
                    <td className="px-4 py-2.5">
                      <div className="font-semibold text-slate-900">
                        {m.brand_name} {m.strength}
                        {!m.is_active && <span className="ml-2 text-[10px] text-red-700 font-semibold">(Inactive)</span>}
                      </div>
                      <div className="text-slate-600">{m.generic_name}</div>
                      <div className="text-[11px] text-slate-500 font-mono-num">
                        {m.medicine_code || '—'} {m.barcode ? `· BC: ${m.barcode}` : ''}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {m.manufacturer_name || '—'} · {m.category_name || '—'}
                        {m.storage_info ? ` · ${m.storage_info}` : ''}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-slate-700 font-mono-num">
                      <div>Base: {m.base_unit_name}</div>
                      <div className="text-[11px] text-slate-500">
                        {m.units
                          .filter((u) => !u.is_base && u.is_active)
                          .map((u) => `1 ${u.unit_name}=${formatQty(u.conversion_to_base)}`)
                          .join(' · ') || 'Base only'}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono-num font-semibold text-slate-900 whitespace-nowrap">
                      {formatQty(m.sellable_stock_base)} {m.base_unit_name}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap space-x-1.5">
                      {user.permissions['medicines.manage'] && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingMed(m);
                            setEditForm({
                              medicineCode: m.medicine_code || '',
                              barcode: m.barcode || '',
                              brandName: m.brand_name,
                              genericName: m.generic_name,
                              strength: m.strength,
                              dosageForm: m.dosage_form,
                              categoryId: m.category_id || '',
                              manufacturerId: m.manufacturer_id || '',
                              storageInfo: m.storage_info || '',
                              minStockLevel: formatQty(m.min_stock_level),
                              rxRequired: Boolean(m.rx_required),
                              isActive: Boolean(m.is_active),
                            });
                          }}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 border border-slate-200 rounded disabled:opacity-40"
                        >
                          <Pencil className="w-3 h-3" />
                          Edit
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setSelectedMed(m)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-700 hover:bg-teal-50 border border-teal-200 rounded"
                      >
                        <Settings2 className="w-3.5 h-3.5" />
                        Units
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right: Manual Unit Configurator */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-4 space-y-4">
          {!selectedMed ? (
            <div className="py-10 text-center text-xs text-slate-500">
              Select any medicine and click <strong>Units</strong> to view or manually configure its direct conversion ratios to the base unit.
            </div>
          ) : (
            <>
              <div className="pb-3 border-b border-slate-200">
                <h2 className="text-base font-bold text-slate-900">
                  {selectedMed.brand_name} {selectedMed.strength}
                </h2>
                <p className="text-xs text-slate-500">
                  Code: <span className="font-mono-num">{selectedMed.medicine_code || '—'}</span> · Base Stock Unit:{' '}
                  <strong>{selectedMed.base_unit_name}</strong> · Up to 6 decimal places supported. Historical invoices retain original snapshots.
                </p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="text-left px-2 py-2 font-medium">Unit Name</th>
                      <th className="text-right px-2 py-2 font-medium">Base Ratio</th>
                      <th className="text-center px-2 py-2 font-medium">Buy</th>
                      <th className="text-center px-2 py-2 font-medium">Sale</th>
                      <th className="text-center px-2 py-2 font-medium">Active</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selectedMed.units.map((u) => (
                      <tr key={u.id}>
                        <td className="px-2 py-2 font-medium text-slate-900">
                          {u.unit_name} {u.is_base ? '(Base)' : ''}
                        </td>
                        <td className="px-2 py-2 text-right font-mono-num">
                          {u.is_base ? (
                            '1'
                          ) : (
                            <input
                              type="text"
                              inputMode="decimal"
                              disabled={!user.permissions['medicines.units']}
                              defaultValue={formatQty(u.conversion_to_base)}
                              onBlur={(e) => {
                                const val = e.target.value.trim();
                                if (val && val !== formatQty(u.conversion_to_base)) {
                                  handleUpdateUnit(u, { conversion_to_base: val });
                                }
                              }}
                              className="w-24 px-1.5 py-1 text-right border border-slate-300 rounded font-mono-num"
                            />
                          )}
                        </td>
                        <td className="px-2 py-2 text-center">
                          <input
                            type="checkbox"
                            disabled={!user.permissions['medicines.units']}
                            checked={Boolean(u.allow_purchase)}
                            onChange={(e) => handleUpdateUnit(u, { allow_purchase: e.target.checked ? 1 : 0 })}
                          />
                        </td>
                        <td className="px-2 py-2 text-center">
                          <input
                            type="checkbox"
                            disabled={!user.permissions['medicines.units']}
                            checked={Boolean(u.allow_sale)}
                            onChange={(e) => handleUpdateUnit(u, { allow_sale: e.target.checked ? 1 : 0 })}
                          />
                        </td>
                        <td className="px-2 py-2 text-center">
                          <input
                            type="checkbox"
                            disabled={Boolean(u.is_base) || !user.permissions['medicines.units']}
                            checked={Boolean(u.is_active)}
                            onChange={(e) => handleUpdateUnit(u, { is_active: e.target.checked ? 1 : 0 })}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {user.permissions['medicines.units'] && (
                <form onSubmit={handleAddUnit} className="pt-3 border-t border-slate-200 space-y-2.5">
                  <div className="text-xs font-semibold text-slate-800">Add Manual Unit</div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      placeholder="Unit name (e.g. Strip, Box, Carton)"
                      value={newUnit.unitName}
                      onChange={(e) => setNewUnit({ ...newUnit, unitName: e.target.value })}
                      required
                      className="px-2.5 py-1.5 text-xs border border-slate-300 rounded"
                    />
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder={`Qty in ${selectedMed.base_unit_name} (up to 6 dec)`}
                      value={newUnit.conversionToBase}
                      onChange={(e) => setNewUnit({ ...newUnit, conversionToBase: e.target.value })}
                      required
                      className="px-2.5 py-1.5 text-xs border border-slate-300 rounded font-mono-num"
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-4">
                      <label className="inline-flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={newUnit.allowPurchase}
                          onChange={(e) => setNewUnit({ ...newUnit, allowPurchase: e.target.checked })}
                        />
                        Purchase Unit
                      </label>
                      <label className="inline-flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={newUnit.allowSale}
                          onChange={(e) => setNewUnit({ ...newUnit, allowSale: e.target.checked })}
                        />
                        Sale Unit
                      </label>
                    </div>
                    <button
                      type="submit"
                      className="px-3 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded"
                    >
                      Save Unit
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      </div>

      {/* Create Medicine Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleCreateMedicine}
            className="bg-white border border-slate-200 rounded-lg w-full max-w-xl p-6 space-y-3"
          >
            <h3 className="text-base font-bold text-slate-900">Add New Medicine &amp; Base Unit</h3>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-slate-600 mb-1">Medicine Code (auto if blank)</label>
                <input
                  type="text"
                  placeholder="e.g. MED-0101"
                  value={newMed.medicineCode}
                  onChange={(e) => setNewMed({ ...newMed, medicineCode: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded font-mono-num"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Barcode / EAN-13</label>
                <input
                  type="text"
                  placeholder="Scan or type barcode"
                  value={newMed.barcode}
                  onChange={(e) => setNewMed({ ...newMed, barcode: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded font-mono-num"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Brand Name *</label>
                <input
                  type="text"
                  required
                  value={newMed.brandName}
                  onChange={(e) => setNewMed({ ...newMed, brandName: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Generic Name *</label>
                <input
                  type="text"
                  required
                  value={newMed.genericName}
                  onChange={(e) => setNewMed({ ...newMed, genericName: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Strength (e.g. 500 mg)</label>
                <input
                  type="text"
                  value={newMed.strength}
                  onChange={(e) => setNewMed({ ...newMed, strength: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Storage / Shelf Location</label>
                <input
                  type="text"
                  placeholder="e.g. Shelf A1 · Room Temp"
                  value={newMed.storageInfo}
                  onChange={(e) => setNewMed({ ...newMed, storageInfo: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Category</label>
                <select
                  value={newMed.categoryId}
                  onChange={(e) => setNewMed({ ...newMed, categoryId: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                >
                  <option value="">Select category</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Manufacturer</label>
                <select
                  value={newMed.manufacturerId}
                  onChange={(e) => setNewMed({ ...newMed, manufacturerId: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                >
                  <option value="">Select manufacturer</option>
                  {manufacturers.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Base Stock Unit *</label>
                <input
                  type="text"
                  required
                  value={newMed.baseUnitName}
                  onChange={(e) => setNewMed({ ...newMed, baseUnitName: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Min Stock Level (Base)</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={newMed.minStockLevel}
                  onChange={(e) => setNewMed({ ...newMed, minStockLevel: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded font-mono-num"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Optional Secondary Unit</label>
                <input
                  type="text"
                  placeholder="e.g. Strip / Box"
                  value={newMed.extraUnitName}
                  onChange={(e) => setNewMed({ ...newMed, extraUnitName: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Conversion to Base</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={newMed.extraUnitConv}
                  onChange={(e) => setNewMed({ ...newMed, extraUnitConv: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded font-mono-num"
                />
              </div>
            </div>
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 pt-1">
              <input
                type="checkbox"
                checked={newMed.rxRequired}
                onChange={(e) => setNewMed({ ...newMed, rxRequired: e.target.checked })}
              />
              Prescription Required (Rx)
            </label>
            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-md"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md"
              >
                Create Medicine
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Edit Medicine Modal */}
      {editingMed && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleSaveEditMedicine}
            className="bg-white border border-slate-200 rounded-lg w-full max-w-xl p-6 space-y-3"
          >
            <h3 className="text-base font-bold text-slate-900">
              Edit Medicine · {editingMed.brand_name}
            </h3>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-slate-600 mb-1">Medicine Code</label>
                <input
                  type="text"
                  value={editForm.medicineCode}
                  onChange={(e) => setEditForm({ ...editForm, medicineCode: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded font-mono-num"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Barcode</label>
                <input
                  type="text"
                  value={editForm.barcode}
                  onChange={(e) => setEditForm({ ...editForm, barcode: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded font-mono-num"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Brand Name *</label>
                <input
                  type="text"
                  required
                  value={editForm.brandName}
                  onChange={(e) => setEditForm({ ...editForm, brandName: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Generic Name *</label>
                <input
                  type="text"
                  required
                  value={editForm.genericName}
                  onChange={(e) => setEditForm({ ...editForm, genericName: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Strength</label>
                <input
                  type="text"
                  value={editForm.strength}
                  onChange={(e) => setEditForm({ ...editForm, strength: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Storage / Shelf Location</label>
                <input
                  type="text"
                  value={editForm.storageInfo}
                  onChange={(e) => setEditForm({ ...editForm, storageInfo: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Category</label>
                <select
                  value={editForm.categoryId}
                  onChange={(e) => setEditForm({ ...editForm, categoryId: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                >
                  <option value="">Select category</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Manufacturer</label>
                <select
                  value={editForm.manufacturerId}
                  onChange={(e) => setEditForm({ ...editForm, manufacturerId: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                >
                  <option value="">Select manufacturer</option>
                  {manufacturers.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-600 mb-1">Min Stock Level ({editingMed.base_unit_name})</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={editForm.minStockLevel}
                  onChange={(e) => setEditForm({ ...editForm, minStockLevel: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded font-mono-num"
                />
              </div>
              <div className="flex items-center gap-4 pt-5">
                <label className="inline-flex items-center gap-1.5 text-slate-700">
                  <input
                    type="checkbox"
                    checked={editForm.rxRequired}
                    onChange={(e) => setEditForm({ ...editForm, rxRequired: e.target.checked })}
                  />
                  Rx Required
                </label>
                <label className="inline-flex items-center gap-1.5 text-slate-700">
                  <input
                    type="checkbox"
                    checked={editForm.isActive}
                    onChange={(e) => setEditForm({ ...editForm, isActive: e.target.checked })}
                  />
                  Active
                </label>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setEditingMed(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-md"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md"
              >
                Save Medicine
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Excel Import Modal */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-4xl max-h-[88vh] flex flex-col p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900">Excel Medicine &amp; Opening Stock Import</h3>
                <p className="text-xs text-slate-500">
                  Validate rows with strict numeric checks, resolve duplicates explicitly, and import atomically.
                </p>
              </div>
              <a
                href="/api/medicines/import/template"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-teal-700 bg-teal-50 border border-teal-200 rounded-md"
              >
                <Download className="w-3.5 h-3.5" />
                Download Sample Template (.xlsx)
              </a>
            </div>

            <input
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={handleFileSelect}
              className="text-xs text-slate-700"
            />

            {importRows.length > 0 && (
              <div className="overflow-auto flex-1 border border-slate-200 rounded">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-3 py-2 text-left">Row</th>
                      <th className="px-3 py-2 text-left">Medicine &amp; Code</th>
                      <th className="px-3 py-2 text-left">Units</th>
                      <th className="px-3 py-2 text-left">Opening Batch</th>
                      <th className="px-3 py-2 text-left">Duplicate / Validation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {importRows.map((r) => (
                      <tr key={r.rowIndex}>
                        <td className="px-3 py-2 font-mono-num">{r.rowIndex}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium">{r.brandName} {r.strength}</div>
                          <div className="text-slate-500">{r.genericName}</div>
                          {(r.medicineCode || r.barcode) && (
                            <div className="text-[11px] font-mono-num text-slate-400">
                              {r.medicineCode} {r.barcode ? `· ${r.barcode}` : ''}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono-num">
                          Base: {r.baseUnit} {r.secondaryUnit ? `· 1 ${r.secondaryUnit}=${formatQty(r.secondaryConversion)}` : ''}
                        </td>
                        <td className="px-3 py-2 font-mono-num">
                          {r.openingBatchNumber ? `${r.openingBatchNumber} (${formatQty(r.openingQtyBase)}, Exp ${r.openingExpiryDate})` : '—'}
                        </td>
                        <td className="px-3 py-2">
                          {r.errors.length > 0 ? (
                            <span className="text-red-700 font-medium">{r.errors.join('; ')}</span>
                          ) : r.duplicateMedicineId ? (
                            <select
                              value={r.duplicateAction || 'SKIP'}
                              onChange={(e) =>
                                setImportRows((prev) =>
                                  prev.map((x) =>
                                    x.rowIndex === r.rowIndex
                                      ? { ...x, duplicateAction: e.target.value as 'SKIP' | 'USE_EXISTING' | 'CREATE_NEW' }
                                      : x
                                  )
                                )
                              }
                              className="px-2 py-1 border border-amber-300 bg-amber-50 rounded text-xs"
                            >
                              <option value="SKIP">Duplicate: Skip</option>
                              <option value="USE_EXISTING">Duplicate: Use Existing</option>
                              <option value="CREATE_NEW">Duplicate: Create New</option>
                            </select>
                          ) : (
                            <span className="text-emerald-700 font-medium">Valid New Medicine</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => {
                  setShowImportModal(false);
                  setImportRows([]);
                }}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-md"
              >
                Close
              </button>
              <button
                type="button"
                disabled={importRows.length === 0 || importRows.some((r) => r.errors.length > 0)}
                onClick={handleExecuteImport}
                className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-md"
              >
                Confirm &amp; Execute Atomic Import
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
