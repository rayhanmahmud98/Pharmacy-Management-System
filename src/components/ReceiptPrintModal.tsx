import React, { useState } from 'react';
import { Printer, X } from 'lucide-react';
import { formatBDT, formatQty } from '../lib/api';
import type { PharmacySettings, SaleRecord } from '../types';

interface Props {
  sale: SaleRecord;
  settings: PharmacySettings;
  onClose: () => void;
}

export const ReceiptPrintModal: React.FC<Props> = ({ sale, settings, onClose }) => {
  const [format, setFormat] = useState<'THERMAL_80MM' | 'A4'>(settings.printer_type || 'THERMAL_80MM');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="bg-white border border-slate-200 rounded-lg w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center gap-3">
            <h3 className="text-base font-semibold text-slate-900">
              Invoice Preview · {sale.invoice_number}
            </h3>
            <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-md">
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
              format === 'THERMAL_80MM' ? 'w-[320px] p-4 text-[11px] leading-snug' : 'w-[740px] p-8 text-sm'
            }`}
          >
            {/* Header */}
            <div className={format === 'THERMAL_80MM' ? 'text-center border-b border-dashed border-slate-400 pb-3 mb-3' : 'flex justify-between items-start border-b border-slate-300 pb-5 mb-5'}>
              <div className="flex items-center gap-3">
                {settings.logo_data_url && (
                  <img
                    src={settings.logo_data_url}
                    alt={settings.pharmacy_name}
                    className={format === 'THERMAL_80MM' ? 'w-10 h-10 object-contain mx-auto mb-1' : 'w-14 h-14 object-contain'}
                  />
                )}
                <div>
                  <div className={format === 'THERMAL_80MM' ? 'text-sm font-bold' : 'text-xl font-bold'}>
                    {settings.pharmacy_name}
                  </div>
                  {settings.pharmacy_name_bn && (
                    <div className="font-medium text-slate-700">{settings.pharmacy_name_bn}</div>
                  )}
                  <div className="text-slate-600">{settings.address}</div>
                  <div className="text-slate-600">
                    Tel: {settings.phone} · Drug Lic: {settings.drug_license_no}
                  </div>
                </div>
              </div>
              <div className={format === 'THERMAL_80MM' ? 'mt-2 text-left' : 'text-right'}>
                <div className="font-mono-num font-bold">{sale.invoice_number}</div>
                <div className="text-slate-600">Date: {sale.sale_date}</div>
                <div className="text-slate-600">Customer: {sale.customer_name}</div>
                <div className="text-slate-600">Cashier: {sale.cashier_name}</div>
                {sale.status === 'REVERSED' && (
                  <div className="font-bold text-red-700 mt-1">REVERSED INVOICE</div>
                )}
              </div>
            </div>

            {/* Line items */}
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-slate-400 text-left">
                  <th className="py-1.5 pr-2 font-semibold">Medicine</th>
                  <th className="py-1.5 px-1.5 font-semibold text-right">Qty</th>
                  <th className="py-1.5 px-1.5 font-semibold text-right">Rate</th>
                  <th className="py-1.5 pl-1.5 font-semibold text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {sale.lines.map((line) => (
                  <tr key={line.id} className="border-b border-dashed border-slate-200 align-top">
                    <td className="py-1.5 pr-2">
                      <div className="font-medium">
                        {line.brand_name} {line.strength}
                      </div>
                      {line.bangla_name && <div className="text-slate-600">{line.bangla_name}</div>}
                      <div className="text-[10px] text-slate-500 font-mono-num">
                        {line.allocations.map((a) => `${a.batch_number} (Exp ${a.expiry_date})`).join(', ')}
                      </div>
                    </td>
                    <td className="py-1.5 px-1.5 text-right font-mono-num whitespace-nowrap">
                      {formatQty(line.qty_input)} {line.unit_name_snapshot}
                      <div className="text-[10px] text-slate-500">
                        ({formatQty(line.qty_base)} {line.base_unit_name})
                      </div>
                    </td>
                    <td className="py-1.5 px-1.5 text-right font-mono-num whitespace-nowrap">
                      {formatBDT(line.unit_price)}
                    </td>
                    <td className="py-1.5 pl-1.5 text-right font-mono-num font-medium whitespace-nowrap">
                      {formatBDT(line.line_total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Totals */}
            <div className="mt-3 pt-2 border-t border-slate-400 space-y-1 font-mono-num">
              <div className="flex justify-between">
                <span>Gross Subtotal</span>
                <span>{formatBDT(sale.gross_subtotal)}</span>
              </div>
              {(Number(sale.line_discount_total) > 0 || Number(sale.invoice_discount) > 0) && (
                <div className="flex justify-between text-slate-700">
                  <span>Discount</span>
                  <span>
                    -{formatBDT(Number(sale.line_discount_total) + Number(sale.invoice_discount))}
                  </span>
                </div>
              )}
              <div className="flex justify-between font-bold text-sm border-t border-slate-300 pt-1">
                <span>Net Payable</span>
                <span>{formatBDT(sale.net_total)}</span>
              </div>
              <div className="flex justify-between">
                <span>Paid</span>
                <span>{formatBDT(sale.paid_amount)}</span>
              </div>
              {Number(sale.due_amount) > 0 && (
                <div className="flex justify-between font-semibold text-red-700">
                  <span>Balance Due</span>
                  <span>{formatBDT(sale.due_amount)}</span>
                </div>
              )}
            </div>

            {sale.payments.length > 0 && (
              <div className="mt-2 pt-2 border-t border-dashed border-slate-300 text-[10px] text-slate-600">
                Payments: {sale.payments.map((p) => `${p.method} ${formatBDT(p.amount)}`).join(' · ')}
              </div>
            )}

            <div className="mt-4 pt-3 border-t border-dashed border-slate-400 text-center text-slate-700">
              <div>{settings.receipt_footer}</div>
              <div className="text-[10px] text-slate-500 mt-1">
                Printed {new Date().toLocaleString()}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
