import React, { useState } from 'react';
import { Printer, X } from 'lucide-react';
import { formatMoney, formatQty } from '../lib/api';
import type { PharmacySettings, SaleRecord } from '../types';

interface Props {
  sale: SaleRecord;
  settings: PharmacySettings;
  onClose: () => void;
}

export const ReceiptPrintModal: React.FC<Props> = ({ sale, settings, onClose }) => {
  const [format, setFormat] = useState<'A5' | 'THERMAL_80MM' | 'A4'>(settings.printer_type || 'A5');
  const currencySym = settings.currency_symbol || '৳';
  const totalDiscount = Number(sale.line_discount_total) + Number(sale.invoice_discount);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="bg-white border border-slate-200 rounded-lg w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 border-b border-slate-200 bg-slate-50">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-base font-semibold text-slate-900">
              Official Invoice Preview · {sale.invoice_number}
            </h3>
            <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-md">
              <button
                type="button"
                onClick={() => setFormat('A5')}
                className={`px-3 py-1 text-xs font-medium rounded whitespace-nowrap shrink-0 ${
                  format === 'A5' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                A5 Standard (148×210mm)
              </button>
              <button
                type="button"
                onClick={() => setFormat('THERMAL_80MM')}
                className={`px-3 py-1 text-xs font-medium rounded whitespace-nowrap shrink-0 ${
                  format === 'THERMAL_80MM' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                80mm Thermal
              </button>
              <button
                type="button"
                onClick={() => setFormat('A4')}
                className={`px-3 py-1 text-xs font-medium rounded whitespace-nowrap shrink-0 ${
                  format === 'A4' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                A4 Invoice
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap shrink-0"
            >
              <Printer className="w-4 h-4" />
              Print Receipt
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close invoice preview"
              className="p-2 text-slate-500 hover:text-slate-800 rounded-md"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto p-6 bg-slate-100 flex justify-center">
          <div
            id="printable-receipt-area"
            className={`bg-white text-slate-950 border border-slate-300 ${
              format === 'THERMAL_80MM'
                ? 'w-[320px] p-4 text-[11px] leading-snug'
                : format === 'A5'
                ? 'w-[559px] min-h-[794px] p-6 text-[12px] leading-relaxed flex flex-col justify-between'
                : 'w-[740px] p-8 text-sm flex flex-col justify-between'
            }`}
          >
            <div>
              {/* Header */}
              <div
                className={
                  format === 'THERMAL_80MM'
                    ? 'text-center border-b border-dashed border-slate-400 pb-3 mb-3'
                    : 'flex justify-between items-start gap-4 border-b-2 border-slate-800 pb-4 mb-4'
                }
              >
                <div className={format === 'THERMAL_80MM' ? '' : 'flex items-start gap-3'}>
                  {settings.logo_data_url && (
                    <img
                      src={settings.logo_data_url}
                      alt={settings.pharmacy_name}
                      className={
                        format === 'THERMAL_80MM'
                          ? 'w-10 h-10 object-contain mx-auto mb-1'
                          : 'w-12 h-12 object-contain shrink-0'
                      }
                    />
                  )}
                  <div>
                    <div className={format === 'THERMAL_80MM' ? 'text-sm font-bold' : 'text-lg font-bold tracking-tight'}>
                      {settings.pharmacy_name}
                    </div>
                    {settings.address && <div className="text-slate-600 text-[11px]">{settings.address}</div>}
                    <div className="text-slate-600 text-[11px]">
                      {settings.phone ? `Tel: ${settings.phone}` : ''}
                      {settings.phone && settings.email ? ' · ' : ''}
                      {settings.email || ''}
                    </div>
                    {(settings.website || settings.drug_license_no) && (
                      <div className="text-slate-600 text-[11px] font-mono-num">
                        {settings.drug_license_no ? `Reg/Lic: ${settings.drug_license_no}` : ''}
                        {settings.drug_license_no && settings.website ? ' · ' : ''}
                        {settings.website || ''}
                      </div>
                    )}
                  </div>
                </div>

                <div className={format === 'THERMAL_80MM' ? 'mt-2 text-left text-[11px]' : 'text-right text-[11px] shrink-0'}>
                  <div className="uppercase tracking-wider text-[10px] font-semibold text-slate-500">
                    Pharmacy Tax & Sales Receipt
                  </div>
                  <div className="font-mono-num font-bold text-sm text-slate-900">{sale.invoice_number}</div>
                  <div className="text-slate-600 font-mono-num">
                    Date: {sale.sale_date} · {sale.created_at.slice(11, 16)}
                  </div>
                  <div className="text-slate-700">Customer: {sale.customer_name}</div>
                  {sale.customer_phone && <div className="text-slate-600 font-mono-num">{sale.customer_phone}</div>}
                  <div className="text-slate-600">Cashier: {sale.cashier_name}</div>
                  {sale.status === 'REVERSED' && (
                    <div className="font-bold text-red-700 mt-1">REVERSED INVOICE</div>
                  )}
                </div>
              </div>

              {/* Line items */}
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-slate-400 text-left text-[11px] text-slate-700">
                    <th className="py-1.5 pr-2 font-semibold">Medicine & Batch</th>
                    <th className="py-1.5 px-1.5 font-semibold text-right">Qty</th>
                    <th className="py-1.5 px-1.5 font-semibold text-right">Unit Price</th>
                    <th className="py-1.5 pl-1.5 font-semibold text-right">Line Total</th>
                  </tr>
                </thead>
                <tbody>
                  {sale.lines.map((line) => (
                    <tr key={line.id} className="border-b border-dashed border-slate-200 align-top">
                      <td className="py-1.5 pr-2">
                        <div className="font-semibold text-slate-900">
                          {line.brand_name} {line.strength}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          {line.generic_name}
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono-num">
                          Batch: {line.allocations.map((a) => `${a.batch_number} (Exp ${a.expiry_date})`).join(', ')}
                        </div>
                      </td>
                      <td className="py-1.5 px-1.5 text-right font-mono-num whitespace-nowrap">
                        {formatQty(line.qty_input)} {line.unit_name_snapshot}
                        <div className="text-[10px] text-slate-500">
                          ({formatQty(line.qty_base)} {line.base_unit_name})
                        </div>
                      </td>
                      <td className="py-1.5 px-1.5 text-right font-mono-num whitespace-nowrap">
                        {formatMoney(line.unit_price, currencySym)}
                      </td>
                      <td className="py-1.5 pl-1.5 text-right font-mono-num font-semibold whitespace-nowrap">
                        {formatMoney(line.line_total, currencySym)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Totals */}
              <div className="mt-4 pt-2 border-t border-slate-400 space-y-1 font-mono-num text-xs">
                <div className="flex justify-between">
                  <span className="font-sans text-slate-600">Gross Subtotal</span>
                  <span>{formatMoney(sale.gross_subtotal, currencySym)}</span>
                </div>
                {totalDiscount > 0 && (
                  <div className="flex justify-between text-slate-700">
                    <span className="font-sans">Total Discounts</span>
                    <span>-{formatMoney(totalDiscount, currencySym)}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-sm border-t border-slate-300 pt-1.5">
                  <span className="font-sans">Net Total</span>
                  <span>{formatMoney(sale.net_total, currencySym)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-sans text-slate-600">Amount Paid</span>
                  <span>{formatMoney(sale.paid_amount, currencySym)}</span>
                </div>
                {Number(sale.due_amount) > 0 && (
                  <div className="flex justify-between font-semibold text-red-700">
                    <span className="font-sans">Balance Due</span>
                    <span>{formatMoney(sale.due_amount, currencySym)}</span>
                  </div>
                )}
              </div>

              {sale.payments.length > 0 && (
                <div className="mt-2 pt-2 border-t border-dashed border-slate-300 text-[10px] text-slate-600">
                  Payment Breakdown: {sale.payments.map((p) => `${p.method} ${formatMoney(p.amount, currencySym)}${p.reference_no ? ` (${p.reference_no})` : ''}`).join(' · ')}
                </div>
              )}

              {sale.notes && (
                <div className="mt-2 text-[11px] text-slate-600">
                  Notes: {sale.notes}
                </div>
              )}
            </div>

            <div className="mt-5 pt-3 border-t border-dashed border-slate-400 text-center text-slate-700 text-[11px]">
              <div>{settings.receipt_footer}</div>
              <div className="text-[10px] text-slate-500 mt-1 font-mono-num">
                Printed {new Date().toLocaleString()} · Format: {format === 'A5' ? 'A5 Standard (148×210mm)' : format === 'THERMAL_80MM' ? '80mm Thermal' : 'A4'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
