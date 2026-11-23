export async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
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

export function formatBDT(val: string | number | null | undefined): string {
  const num = Number(val ?? 0);
  if (!Number.isFinite(num)) return '৳0.00';
  return `৳${num.toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatQty(val: string | number | null | undefined): string {
  const num = Number(val ?? 0);
  if (!Number.isFinite(num)) return '0';
  return Number.isInteger(num) ? String(num) : num.toFixed(2).replace(/\.?0+$/, '');
}
