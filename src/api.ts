export const isBrowserStorage = import.meta.env.VITE_STORAGE_MODE === 'browser';

export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  if (isBrowserStorage) return await (await import('./browser-store')).browserRequest(path, body, method) as T;
  const response = await fetch(`/api${path}`, { method: method || (body ? 'POST' : 'GET'), headers: body ? {'Content-Type':'application/json'} : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({error:'The engine returned an unreadable response.'}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
export async function downloadBrowserWorld(id: string): Promise<void> {
  return (await import('./browser-store')).downloadBrowserWorld(id);
}
export async function exportBrowserWorld(id: string) {
  return (await import('./browser-store')).exportBrowserWorld(id);
}
export const number = (n:number) => new Intl.NumberFormat('en', {notation:Math.abs(n)>=100000?'compact':'standard', maximumFractionDigits:1}).format(n);
export const integer = (n:number) => new Intl.NumberFormat('en', {maximumFractionDigits:0}).format(n);
