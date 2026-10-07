import { createWorld, advanceWorld, previewIntervention, applyIntervention, askWorld, validateWorld, populationTotal } from './simulation';
import type { CreateWorldInput, InterventionProposal, World } from './simulation';

interface WorldRow { id: string; world: World; revision: string; updatedAt: string }
export interface BrowserSnapshot { id: string; worldId: string; name: string; label: string; reason: string; year: number; population: number; createdAt: string }
interface SnapshotRow extends BrowserSnapshot { world: World; order: number }
interface Preview { proposal: InterventionProposal; revision: string; digest: string; createdAt: number }
const previews = new Map<string, Preview>();
let connection: Promise<IDBDatabase> | undefined;

function uid() { return globalThis.crypto?.randomUUID?.() || `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`; }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A JSON object is required.');
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 2_000): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  if (value.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  return value.trim();
}
function storageError(error: unknown): Error {
  if (error instanceof Error && error.name === 'QuotaExceededError') return new Error('Browser storage is full. Export a backup and remove a world to free space. Your previous save remains intact.');
  if (error instanceof Error && error.name === 'SecurityError') return new Error('This browser is blocking local world storage. Enable storage for this site or use another browser.');
  return error instanceof Error ? error : new Error('Local storage failed. Your previous save remains intact.');
}
function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(storageError(operation.error)); });
}
function database(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('This browser does not support local world storage. Use a browser with IndexedDB enabled.'));
  if (!connection) connection = new Promise<IDBDatabase>((resolve, reject) => {
    const operation = indexedDB.open('genesis-worlds', 1);
    operation.onupgradeneeded = () => {
      const db = operation.result;
      db.createObjectStore('worlds', { keyPath: 'id' });
      db.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('worldId', 'worldId');
    };
    operation.onsuccess = () => {
      const db = operation.result;
      db.onversionchange = () => { db.close(); connection = undefined; };
      resolve(db);
    };
    operation.onerror = () => { connection = undefined; reject(storageError(operation.error)); };
    operation.onblocked = () => { connection = undefined; reject(new Error('Close other GENESIS tabs and refresh to update local storage.')); };
  });
  return connection;
}
async function transaction<T>(stores: string[], mode: IDBTransactionMode, action: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const tx = (await database()).transaction(stores, mode);
  const completed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(storageError(tx.error)); tx.onerror = () => {};
  });
  // Attach a handler immediately: a failed request and an aborted transaction reject together.
  void completed.catch(() => {});
  try { const result = await action(tx); await completed; return result; }
  catch (error) { try { tx.abort(); } catch {} await completed.catch(() => {}); throw storageError(error); }
}
async function readWorld(id: string): Promise<WorldRow> {
  const row = await transaction(['worlds'], 'readonly', tx => request<WorldRow | undefined>(tx.objectStore('worlds').get(id)));
  if (!row) throw new Error('World not found.');
  try { return { ...row, world: validateWorld(row.world) }; }
  catch { throw new Error('This save is damaged or uses an unsupported version. Import a valid backup to recover it.'); }
}
function rowFor(world: World): WorldRow { return { id: world.id, world, revision: uid(), updatedAt: new Date().toISOString() }; }
async function assertCurrent(tx: IDBTransaction, before: WorldRow) {
  const current = await request<WorldRow | undefined>(tx.objectStore('worlds').get(before.id));
  if (!current) throw new Error('This world was removed in another tab. Open your world library again.');
  if (current.revision !== before.revision) throw new Error('This world changed in another tab. Reload it before continuing; your previous save remains intact.');
}
function snapshotMetadata(row: SnapshotRow): BrowserSnapshot {
  const { world: _world, order: _order, ...metadata } = row; return metadata;
}
async function checkpoint(tx: IDBTransaction, world: World, label: string): Promise<BrowserSnapshot> {
  const store = tx.objectStore('snapshots');
  const previous = await request<SnapshotRow[]>(store.index('worldId').getAll(world.id));
  const row: SnapshotRow = { id: uid(), worldId: world.id, name: world.name, label, reason: label,
    year: world.year, population: populationTotal(world), createdAt: new Date().toISOString(), world,
    order: previous.reduce((highest, item) => Math.max(highest, item.order), 0) + 1 };
  await request(store.add(row));
  const expired = [...previous, row].sort((a, b) => b.order - a.order).slice(30);
  await Promise.all(expired.map(item => request(store.delete(item.id))));
  return snapshotMetadata(row);
}
async function insert(world: World, parent?: WorldRow): Promise<World> {
  validateWorld(world);
  await transaction(['worlds'], 'readwrite', async tx => {
    if (parent) await assertCurrent(tx, parent);
    await request(tx.objectStore('worlds').add(rowFor(world)));
  });
  return world;
}
async function update(before: WorldRow, world: World, label?: string): Promise<World> {
  validateWorld(world);
  await transaction(['worlds', 'snapshots'], 'readwrite', async tx => {
    await assertCurrent(tx, before);
    if (label) await checkpoint(tx, before.world, label);
    await request(tx.objectStore('worlds').put(rowFor(world)));
  });
  return world;
}
function suffix(name: string, ending: string) { return name.slice(0, Math.max(0, 120 - ending.length)) + ending; }
function branch(world: World, name: string): World {
  const result = structuredClone(world); result.id = uid(); result.name = name.slice(0, 120);
  result.createdAt = result.updatedAt = new Date().toISOString(); return result;
}
function creation(value: unknown): CreateWorldInput {
  const body = object(value); const input: CreateWorldInput = {};
  for (const field of ['name', 'origin', 'unusual', 'scenario'] as const) {
    if (field !== 'name' && body[field] === '') continue;
    if (body[field] !== undefined) input[field] = text(body[field], field, field === 'name' ? 120 : 4_000);
  }
  if (body.seed !== undefined) {
    if (typeof body.seed === 'number') { if (!Number.isSafeInteger(body.seed)) throw new Error('seed must be a finite safe integer or string.'); input.seed = body.seed; }
    else input.seed = text(body.seed, 'seed', 200);
  }
  return input;
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
async function digest(world: World): Promise<string> {
  const serialized = JSON.stringify(world);
  if (!globalThis.crypto?.subtle) return serialized;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Matches the server API while keeping every world's state private to this browser origin. */
export async function browserRequest(path: string, body?: unknown, method?: string): Promise<unknown> {
  const verb = method || (body !== undefined ? 'POST' : 'GET');
  const pieces = path.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  if (verb === 'GET' && pieces[0] === 'config') return { mode: 'browser', persistence: 'IndexedDB', ai: { available: false, provider: 'Local deterministic engine', model: null }, snapshots: { retention: 30 } };
  if (verb === 'GET' && pieces[0] === 'health') { await database(); return { status: 'ok', persistence: 'IndexedDB' }; }
  if (pieces[0] !== 'worlds') throw new Error('API endpoint not found.');
  if (pieces.length === 1) {
    if (verb === 'GET') {
      const rows = await transaction(['worlds'], 'readonly', tx => request<WorldRow[]>(tx.objectStore('worlds').getAll()));
      return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ world, updatedAt }) => ({ id: world.id, name: world.name, year: world.year, population: populationTotal(world), seed: world.seed, updatedAt }));
    }
    if (verb === 'POST') return insert(createWorld(creation(body)));
  }
  if (pieces.length === 2 && pieces[1] === 'import' && verb === 'POST') {
    const world = validateWorld(object(body).world); return insert(branch(world, suffix(world.name, ' (imported)')));
  }
  const id = pieces[1]; if (!id) throw new Error('World not found.');
  const before = await readWorld(id); const world = before.world;
  if (pieces.length === 2) {
    if (verb === 'GET') return world;
    if (verb === 'PATCH' || verb === 'PUT') {
      const renamed = structuredClone(world); renamed.name = text(object(body).name, 'name', 120); renamed.updatedAt = new Date().toISOString();
      return update(before, renamed);
    }
    if (verb === 'DELETE') {
      await transaction(['worlds', 'snapshots'], 'readwrite', async tx => {
        await assertCurrent(tx, before);
        const snapshots = await request<SnapshotRow[]>(tx.objectStore('snapshots').index('worldId').getAll(id));
        await Promise.all(snapshots.map(item => request(tx.objectStore('snapshots').delete(item.id))));
        await request(tx.objectStore('worlds').delete(id));
      });
      for (const [key, value] of previews) if (value.proposal.worldId === id) previews.delete(key);
      return null;
    }
  }
  if (pieces.length === 3) {
    const route = pieces[2];
    if (verb === 'GET' && route === 'export') return world;
    if (verb === 'POST' && route === 'save') { const saved = structuredClone(world); saved.updatedAt = new Date().toISOString(); return update(before, saved); }
    if (verb === 'POST' && route === 'duplicate') return insert(branch(world, body && object(body).name !== undefined ? text(object(body).name, 'name', 120) : suffix(world.name, ' (copy)')), before);
    if (verb === 'POST' && route === 'ask') return askWorld(world, text(object(body).question, 'Question', 2_000));
    if (verb === 'POST' && route === 'advance') {
      const command = text(object(body).command, 'command', 300);
      const result = advanceWorld(structuredClone(world), command);
      const major = result.summary.events.find(event => event.severity === 5);
      const label = result.summary.toYear - result.summary.fromYear > 10 ? `Before ${command}` : major ? `Before major event: ${major.title}` : undefined;
      await update(before, result.world, label); return result;
    }
    if (route === 'snapshots') {
      if (verb === 'GET') {
        const rows = await transaction(['snapshots'], 'readonly', tx => request<SnapshotRow[]>(tx.objectStore('snapshots').index('worldId').getAll(id)));
        return rows.sort((a, b) => b.order - a.order).map(snapshotMetadata);
      }
      if (verb === 'POST') {
        const supplied = body ? object(body).label ?? object(body).name : undefined;
        const label = supplied === undefined ? `Year ${world.year} — manual checkpoint` : text(supplied, 'label', 160);
        return transaction(['worlds', 'snapshots'], 'readwrite', async tx => { await assertCurrent(tx, before); return checkpoint(tx, world, label); });
      }
    }
  }
  if (pieces.length === 4 && pieces[2] === 'intervention' && verb === 'POST') {
    if (pieces[3] === 'preview') {
      const input = object(body);
      const target = input.targetId === undefined ? undefined : text(input.targetId, 'targetId', 200);
      const proposal = JSON.parse(JSON.stringify(previewIntervention(world, text(input.text, 'Intervention', 4_000), target))) as InterventionProposal;
      for (const [key, item] of previews) if (Date.now() - item.createdAt > 3_600_000) previews.delete(key);
      if (previews.size >= 32) previews.delete(previews.keys().next().value!);
      previews.set(proposal.id, { proposal: structuredClone(proposal), revision: before.revision, digest: await digest(world), createdAt: Date.now() });
      return proposal;
    }
    if (pieces[3] === 'apply') {
      const proposed = object(object(body).proposal); const preview = previews.get(String(proposed.id));
      if (!preview || preview.proposal.worldId !== id) throw new Error('Preview this intervention before applying it.');
      if (Date.now() - preview.createdAt > 3_600_000 || preview.revision !== before.revision || preview.digest !== await digest(world)) throw new Error('The world changed after the preview. Preview the intervention again.');
      if (canonical(proposed) !== canonical(preview.proposal)) throw new Error('The intervention does not match its preview.');
      const updated = applyIntervention(structuredClone(world), structuredClone(preview.proposal));
      await update(before, updated, `Before intervention: ${preview.proposal.action}`); previews.delete(preview.proposal.id); return updated;
    }
  }
  if (pieces.length === 5 && pieces[2] === 'snapshots' && pieces[4] === 'restore' && verb === 'POST') {
    const snapshot = await transaction(['snapshots'], 'readonly', tx => request<SnapshotRow | undefined>(tx.objectStore('snapshots').get(pieces[3])));
    if (!snapshot || snapshot.worldId !== id) throw new Error('Snapshot not found.');
    const restored = validateWorld(snapshot.world);
    return insert(branch(restored, suffix(restored.name, ` — year ${restored.year} branch`)), before);
  }
  throw new Error('API endpoint not found.');
}

export async function exportBrowserWorld(id: string): Promise<World> {
  return (await readWorld(id)).world;
}
export async function downloadBrowserWorld(id: string): Promise<void> {
  const world = await exportBrowserWorld(id);
  const blob = new Blob([JSON.stringify(world, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `${world.name.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80) || 'world'}.genesis.json`;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
