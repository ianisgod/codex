import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import type { World, InterventionProposal, AdvanceResult } from '../src/simulation';
import type { BrowserSnapshot } from '../src/browser-store';

const chromiumPath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath());
const options = { skip: !existsSync(chromiumPath) ? 'Install Chromium or set CHROMIUM_PATH to run real browser storage checks.' : false };

async function fixture() {
  const vite = await createServer({ configFile: false, root: resolve('.'), appType: 'custom',
    define: { 'import.meta.env.VITE_STORAGE_MODE': JSON.stringify('browser') },
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'browser-store-test-page', configureServer(server) {
      server.middlewares.use('/__store-test', (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>GENESIS storage test</title>'); });
    } }],
  });
  await vite.listen();
  const address = vite.httpServer?.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ executablePath: chromiumPath, args: ['--no-sandbox'] });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage(); await page.goto(`${origin}/__store-test`);
  async function request<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
    return await page.evaluate(async input => {
      const path = '/src/api.ts'; const module = await import(path);
      if (!module.isBrowserStorage) throw new Error('The test must run the actual browser-mode API.');
      return module.api(input.path, input.body, input.method);
    }, { path, body, method }) as T;
  }
  return { request, page, origin, context,
    create(name = 'Browser Erya', seed = 'browser-world') { return request<World>('/worlds', { name, seed }); },
    async close() { await browser.close(); await vite.close(); },
  };
}

test('real IndexedDB keeps worlds independent across advances, reloads and snapshot branches', options, async () => {
  const store = await fixture();
  try {
    const first = await store.create('First world', 'first'); const second = await store.create('Second world', 'second');
    const advanced = await store.request<AdvanceResult>(`/worlds/${first.id}/advance`, { command: '20 years' });
    assert.equal(advanced.world.year, first.year + 20);
    assert.deepEqual(await store.request(`/worlds/${second.id}`), second);
    const snapshots = await store.request<BrowserSnapshot[]>(`/worlds/${first.id}/snapshots`);
    assert.equal(snapshots.length, 1); assert.equal(snapshots[0].year, first.year);
    const branch = await store.request<World>(`/worlds/${first.id}/snapshots/${snapshots[0].id}/restore`, {});
    assert.notEqual(branch.id, first.id); assert.deepEqual(branch.events, first.events); assert.equal(branch.rngState, first.rngState);
    assert.deepEqual(await store.request(`/worlds/${first.id}`), advanced.world);
    await store.page.reload();
    assert.deepEqual(await store.request(`/worlds/${first.id}`), advanced.world);
    const saved = await store.request<World>(`/worlds/${first.id}/save`, {});
    assert.deepEqual(saved.civilizations, advanced.world.civilizations);
    const renamed = await store.request<World>(`/worlds/${second.id}`, { name: 'Renamed world' }, 'PATCH');
    assert.equal(renamed.name, 'Renamed world');
    const duplicate = await store.request<World>(`/worlds/${second.id}/duplicate`, {});
    assert.notEqual(duplicate.id, second.id); assert.deepEqual(duplicate.events, second.events);
    await store.request(`/worlds/${first.id}`, undefined, 'DELETE');
    await assert.rejects(store.request(`/worlds/${first.id}`), /World not found/);
    const orphanCount = await store.page.evaluate(async id => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const op = indexedDB.open('genesis-worlds', 1); op.onsuccess = () => resolve(op.result); op.onerror = () => reject(op.error); });
      try { return await new Promise<number>((resolve, reject) => { const op = db.transaction('snapshots').objectStore('snapshots').index('worldId').count(id); op.onsuccess = () => resolve(op.result); op.onerror = () => reject(op.error); }); }
      finally { db.close(); }
    }, first.id);
    assert.equal(orphanCount, 0);
    assert.equal((await store.request<any[]>('/worlds')).length, 3);
    assert.equal((await store.request('/config')).persistence, 'IndexedDB');
  } finally { await store.close(); }
});

test('browser interventions reject tampering and stale previews while queries cannot mutate worlds', options, async () => {
  const store = await fixture();
  try {
    const world = await store.create(); const path = `/worlds/${world.id}`;
    const proposal = await store.request<InterventionProposal>(`${path}/intervention/preview`, { text: 'Increase the food harvest by 20 percent' });
    const tampered = structuredClone(proposal); tampered.operations.push({ type: 'delete-all' });
    await assert.rejects(store.request(`${path}/intervention/apply`, { proposal: tampered }), /does not match/);
    assert.deepEqual(await store.request(path), world);
    const applied = await store.request<World>(`${path}/intervention/apply`, { proposal });
    assert(applied.events.length > world.events.length);
    await assert.rejects(store.request(`${path}/intervention/apply`, { proposal }), /Preview this intervention/);
    const stale = await store.request(`${path}/intervention/preview`, { text: 'Create a black monolith in the capital' });
    await store.request(`${path}/advance`, { command: '1 day' });
    await assert.rejects(store.request(`${path}/intervention/apply`, { proposal: stale }), /world changed/);
    const beforeAsk = await store.request<World>(path);
    const answer = await store.request(`${path}/ask`, { question: 'What civilizations exist?' });
    assert(answer.answer.length > 50); assert.equal(answer.mode, 'local');
    assert.deepEqual(await store.request(path), beforeAsk);
    assert.equal((await store.request('/config')).ai.available, false);
  } finally { await store.close(); }
});

test('browser JSON downloads round trip, invalid imports fail, and snapshots retain the newest 30', options, async () => {
  const store = await fixture();
  try {
    const world = await store.create();
    const downloaded = store.page.waitForEvent('download');
    await store.page.evaluate(async id => { const path = '/src/api.ts'; const module = await import(path); await module.downloadBrowserWorld(id); }, world.id);
    const download = await downloaded; assert.match(download.suggestedFilename(), /\.genesis\.json$/);
    const localPath = await download.path(); assert(localPath);
    const exported = JSON.parse(await readFile(localPath, 'utf8'));
    assert.deepEqual(exported, JSON.parse(JSON.stringify(world)));
    const imported = await store.request<World>('/worlds/import', { world: exported });
    assert.notEqual(imported.id, world.id); assert.deepEqual(imported.civilizations, world.civilizations);
    const invalid = structuredClone(exported); invalid.year = 'yesterday';
    await assert.rejects(store.request('/worlds/import', { world: invalid }), /Invalid world/);
    for (let index = 0; index < 32; index++) await store.request(`/worlds/${world.id}/snapshots`, { label: `Checkpoint ${index}` });
    const snapshots = await store.request<BrowserSnapshot[]>(`/worlds/${world.id}/snapshots`);
    assert.equal(snapshots.length, 30); assert.equal(snapshots[0].label, 'Checkpoint 31'); assert.equal(snapshots.at(-1)?.label, 'Checkpoint 2');
    const discoveries = structuredClone(world);
    discoveries.civilizations[0].technologies = ['Agriculture', 'Pottery', 'Ironworking', 'Writing', 'Sailing', 'Mathematics', 'Irrigation', 'Medicine', 'Steel', 'Navigation', 'Printing', 'Gunpowder', 'Steam Power', 'Germ Theory'];
    discoveries.civilizations[0].research = 1_000;
    const prepared = await store.request<World>('/worlds/import', { world: discoveries });
    const advanced = await store.request<AdvanceResult>(`/worlds/${prepared.id}/advance`, { command: '1 day' });
    assert(advanced.summary.events.some(event => event.severity === 5));
    assert.equal((await store.request<BrowserSnapshot[]>(`/worlds/${prepared.id}/snapshots`)).length, 1);
  } finally { await store.close(); }
});

test('IndexedDB concurrent writes never lose an advance and failed writes roll back checkpoints', options, async () => {
  const store = await fixture();
  try {
    const world = await store.create('Atomic world', 'atomic'); const path = `/worlds/${world.id}`;
    const results = await Promise.allSettled([store.request(`${path}/advance`, { command: '1 year' }), store.request(`${path}/advance`, { command: '1 year' })]);
    const successful = results.filter(result => result.status === 'fulfilled').length;
    assert(successful >= 1);
    const current = await store.request<World>(path);
    assert.equal(current.year, world.year + successful);
    const checkpoints = await store.request(`${path}/snapshots`);
    // Force a real IndexedDB uniqueness error after the checkpoint request succeeds.
    // The database remains real; only this write is deliberately changed to an insert.
    await store.page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      Reflect.set(globalThis, '__genesisOriginalPut', original);
      IDBObjectStore.prototype.put = function(value, key) {
        if (this.name === 'worlds') return this.add(value);
        return key === undefined ? original.call(this, value) : original.call(this, value, key);
      };
    });
    try {
      await assert.rejects(store.request(`${path}/advance`, { command: '20 years' }), /already exists|ConstraintError/i);
      assert.deepEqual(await store.request(path), current);
      assert.deepEqual(await store.request(`${path}/snapshots`), checkpoints);
    } finally { await store.page.evaluate(() => { IDBObjectStore.prototype.put = Reflect.get(globalThis, '__genesisOriginalPut'); Reflect.deleteProperty(globalThis, '__genesisOriginalPut'); }); }
  } finally { await store.close(); }
});
