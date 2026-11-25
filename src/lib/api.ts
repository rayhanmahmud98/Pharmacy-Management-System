import {
  validateConversionInput,
  validateCostInput,
  validateCurrencyInput,
  validateQuantityInput,
} from '../shared/decimalMath';

let activeCurrencySymbol = '৳';

export function setDisplayCurrencySymbol(symbol: string | undefined | null): void {
  activeCurrencySymbol = (symbol || '৳').trim() || '৳';
}

export function getDisplayCurrencySymbol(): string {
  return activeCurrencySymbol;
}

const COUNTER_STORAGE_KEY = 'medinest_counter_code';

export function normalizeCounterCode(raw?: string | null): string {
  const cleaned = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
  return cleaned.slice(0, 32) || 'COUNTER-1';
}

export function getCounterCode(): string {
  if (typeof window === 'undefined') return 'COUNTER-1';
  try {
    return normalizeCounterCode(window.localStorage.getItem(COUNTER_STORAGE_KEY));
  } catch {
    return 'COUNTER-1';
  }
}

export function setCounterCode(code: string): string {
  const normalized = normalizeCounterCode(code);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(COUNTER_STORAGE_KEY, normalized);
    } catch {
      // ignore storage errors
    }
  }
  return normalized;
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `idemp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'MediNest',
      'X-Counter-Id': getCounterCode(),
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    let errMsg = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) errMsg = body.error;
    } catch {
      // ignore non-json error
    }
    throw new Error(errMsg);
  }
  return (await res.json()) as T;
}

export function formatMoney(
  val: string | number | null | undefined,
  symbolOverride?: string
): string {
  const sym = symbolOverride ?? activeCurrencySymbol;
  const num = Number(val ?? 0);
  if (!Number.isFinite(num)) return `${sym}0.00`;
  const absFormatted = Math.abs(num).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return num < 0 ? `-${sym}${absFormatted}` : `${sym}${absFormatted}`;
}

export function formatBDT(val: string | number | null | undefined, symbolOverride?: string): string {
  return formatMoney(val, symbolOverride);
}

export function formatQty(val: string | number | null | undefined): string {
  if (val === null || val === undefined || val === '') return '0';
  const raw = String(val).trim();
  if (/^[+-]?\d+(\.\d+)?$/.test(raw)) {
    if (!raw.includes('.')) return raw.replace(/^0+(?=\d)/, '') || '0';
    const trimmed = raw.replace(/\.?0+$/, '');
    return trimmed === '-0' ? '0' : trimmed;
  }
  const num = Number(val);
  if (!Number.isFinite(num)) return '0';
  return Number.isInteger(num) ? String(num) : num.toFixed(6).replace(/\.?0+$/, '');
}

export function checkStrictDecimalInput(
  value: string,
  kind: 'currency' | 'qty' | 'conversion' | 'cost',
  label: string,
  options: { allowZero?: boolean } = {}
): string | null {
  try {
    if (kind === 'currency') {
      validateCurrencyInput(value, label, options);
    } else if (kind === 'qty') {
      validateQuantityInput(value, label, options);
    } else if (kind === 'conversion') {
      validateConversionInput(value, label);
    } else {
      validateCostInput(value, label, options);
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : `Invalid ${label}`;
  }
}
