import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createApp } from '../server/app.js';
import { askWorld } from '../src/simulation/index.js';
import type { World } from '../src/simulation/types.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'genesis-api-'));
  const databasePath = join(directory, 'worlds.sqlite');
  let app = createApp(databasePath);
  let server: Server;
  let origin = '';
  async function start() {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
  }
  async function stop() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    app.locals.database.close();
  }
  await start();
  async function request(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${origin}${path}`, {
      method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = response.status === 204 ? null : await response.json();
    return { status: response.status, body: result, headers: response.headers };
  }
  return {
    request,
    async create(seed = 'persistent-world'): Promise<World> {
      const response = await request('/api/worlds', 'POST', { name: 'Erya', seed });
      assert.equal(response.status, 201);
      return response.body as World;
    },
    async restart() { await stop(); app = createApp(databasePath); await start(); },
    async close() { await stop(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('SQLite worlds survive restart with complete history and deterministic random state', async () => {
  const api = await fixture();
  try {
    const world = await api.create();
    const advanced = await api.request(`/api/worlds/${world.id}/advance`, 'POST', { command: '20 years' });
    assert.equal(advanced.status, 200);
    assert.equal(advanced.body.summary.toYear - world.year, 20);
    assert(advanced.body.world.events.length > world.events.length);
    const saved = advanced.body.world;
    await api.restart();
    assert.deepEqual((await api.request(`/api/worlds/${world.id}`)).body, saved);
    const list = (await api.request('/api/worlds')).body;
    assert.equal(list.length, 1);
    assert.equal(list[0].year, saved.year);
    assert(list[0].population > 0);
    assert.equal(list[0].seed, saved.seed);
    assert.equal((await api.request('/api/health')).body.status, 'ok');
    const manual = await api.request(`/api/worlds/${world.id}/save`, 'POST', {});
    assert.equal(manual.status, 200);
    assert.deepEqual(manual.body.events, saved.events);
    assert.equal(manual.body.rngState, saved.rngState);
    assert.deepEqual(manual.body.civilizations, saved.civilizations);
    await api.restart();
    assert.deepEqual((await api.request(`/api/worlds/${world.id}`)).body, manual.body);
  } finally { await api.close(); }
});

test('large advances checkpoint before the jump and restoring creates a separate branch', async () => {
  const api = await fixture();
  try {
    const original = await api.create('branch-test');
    const advanced = (await api.request(`/api/worlds/${original.id}/advance`, 'POST', { command: '50 years' })).body.world;
    const checkpoints = (await api.request(`/api/worlds/${original.id}/snapshots`)).body;
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].year, original.year);
    const restored = await api.request(`/api/worlds/${original.id}/snapshots/${checkpoints[0].id}/restore`, 'POST', {});
    assert.equal(restored.status, 201);
    assert.notEqual(restored.body.id, original.id);
    assert.equal(restored.body.year, original.year);
    assert.deepEqual(restored.body.events, original.events);
    assert.deepEqual((await api.request(`/api/worlds/${original.id}`)).body, advanced);
    assert.equal((await api.request('/api/worlds')).body.length, 2);
  } finally { await api.close(); }
});

test('export and validated import preserve simulation data without overwriting the original', async () => {
  const api = await fixture();
  try {
    const original = await api.create('import-test');
    const exported = await api.request(`/api/worlds/${original.id}/export`);
    assert.match(exported.headers.get('content-disposition') || '', /attachment/);
    assert.deepEqual(exported.body, original);
    const imported = await api.request('/api/worlds/import', 'POST', { world: exported.body });
    assert.equal(imported.status, 201);
    assert.notEqual(imported.body.id, original.id);
    assert.deepEqual(imported.body.civilizations, original.civilizations);
    assert.equal(imported.body.rngState, original.rngState);
    const malformed = structuredClone(original);
    malformed.year = 'yesterday' as unknown as number;
    assert.equal((await api.request('/api/worlds/import', 'POST', { world: malformed })).status, 400);
    assert.equal((await api.request('/api/worlds')).body.length, 2);
    assert.deepEqual((await api.request(`/api/worlds/${original.id}`)).body, original);
  } finally { await api.close(); }
});

test('manual snapshots retain only the newest 30 and deleting a world removes its snapshots', async () => {
  const api = await fixture();
  try {
    const world = await api.create('snapshot-test');
    const ids: string[] = [];
    for (let i = 0; i < 32; i++) {
      const snapshot = await api.request(`/api/worlds/${world.id}/snapshots`, 'POST', { label: `Checkpoint ${i}` });
      assert.equal(snapshot.status, 201);
      ids.push(snapshot.body.id);
    }
    const snapshots = (await api.request(`/api/worlds/${world.id}/snapshots`)).body;
    assert.equal(snapshots.length, 30);
    assert.equal(snapshots[0].label, 'Checkpoint 31');
    assert(!snapshots.some((snapshot: { id: string }) => snapshot.id === ids[0]));
    assert.equal((await api.request(`/api/worlds/${world.id}`, 'DELETE')).status, 204);
    assert.equal((await api.request(`/api/worlds/${world.id}`)).status, 404);
    assert.equal((await api.request(`/api/worlds/${world.id}/snapshots/${ids[31]}/restore`, 'POST', {})).status, 404);
  } finally { await api.close(); }
});

test('full exports above the ordinary request limit can round trip without losing canon', async () => {
  const api = await fixture();
  try {
    const world = await api.create('large-export-test');
    // Canon and history grow independently of one bounded simulation jump.
    world.attributes.extendedArchive = 'A'.repeat(17 * 1024 * 1024);
    const imported = await api.request('/api/worlds/import', 'POST', { world });
    assert.equal(imported.status, 201);
    const exported = await api.request(`/api/worlds/${imported.body.id}/export`);
    const restored = await api.request('/api/worlds/import', 'POST', { world: exported.body });
    assert.equal(restored.status, 201);
    assert.equal(restored.body.attributes.extendedArchive, world.attributes.extendedArchive);
    assert.deepEqual(restored.body.events, world.events);
    assert.deepEqual(restored.body.civilizations, world.civilizations);
  } finally { await api.close(); }
});

test('a natural major discovery checkpoints before a short advance', async () => {
  const api = await fixture();
  try {
    const world = await api.create('major-discovery-test');
    const civ = world.civilizations[0];
    civ.technologies = ['Agriculture', 'Pottery', 'Ironworking', 'Writing', 'Sailing', 'Mathematics', 'Irrigation', 'Medicine', 'Steel', 'Navigation', 'Printing', 'Gunpowder', 'Steam Power', 'Germ Theory'];
    civ.research = 1_000;
    const imported = (await api.request('/api/worlds/import', 'POST', { world })).body;
    const advanced = await api.request(`/api/worlds/${imported.id}/advance`, 'POST', { command: '1 day' });
    assert.equal(advanced.status, 200);
    assert(advanced.body.world.civilizations[0].technologies.includes('Electricity'));
    assert(advanced.body.summary.events.some((event: { severity: number }) => event.severity === 5));
    const snapshots = (await api.request(`/api/worlds/${imported.id}/snapshots`)).body;
    assert.equal(snapshots.length, 1);
    const restored = (await api.request(`/api/worlds/${imported.id}/snapshots/${snapshots[0].id}/restore`, 'POST', {})).body;
    assert(!restored.civilizations[0].technologies.includes('Electricity'));
    assert.deepEqual(restored.events, imported.events);
    assert(advanced.body.world.civilizations[0].technologies.includes('Electricity'));
  } finally { await api.close(); }
});

test('rename, duplication and invalid requests do not corrupt existing saves', async () => {
  const api = await fixture();
  try {
    const world = await api.create('validation-test');
    assert.equal((await api.request('/api/worlds', 'POST', { seed: false })).status, 400);
    assert.equal((await api.request(`/api/worlds/${world.id}`, 'PATCH', { name: '  ' })).status, 400);
    assert.equal((await api.request(`/api/worlds/${world.id}/advance`, 'POST', { command: 'bananas' })).status, 400);
    assert.deepEqual((await api.request(`/api/worlds/${world.id}`)).body, world);
    const renamed = await api.request(`/api/worlds/${world.id}`, 'PATCH', { name: 'The Second Dawn' });
    assert.equal(renamed.body.name, 'The Second Dawn');
    const duplicate = await api.request(`/api/worlds/${world.id}/duplicate`, 'POST', {});
    assert.equal(duplicate.status, 201);
    assert.notEqual(duplicate.body.id, world.id);
    assert.deepEqual(duplicate.body.events, world.events);
    assert.equal((await api.request('/api/worlds/missing')).status, 404);
    assert.equal((await api.request('/api/not-a-route')).status, 404);
    const config = (await api.request('/api/config')).body;
    assert.equal(config.persistence, 'sqlite');
    assert(!JSON.stringify(config).includes('GENESIS_AI_KEY'));
  } finally { await api.close(); }
});

test('interventions require an unchanged preview, create checkpoints, and cannot apply twice', async () => {
  const api = await fixture();
  try {
    const world = await api.create('intervention-test');
    const endpoint = `/api/worlds/${world.id}/intervention`;
    const preview = await api.request(`${endpoint}/preview`, 'POST', { text: 'Increase the food harvest by 20 percent' });
    assert.equal(preview.status, 200);
    const tampered = structuredClone(preview.body);
    tampered.operations.push({ type: 'delete-all' });
    assert.equal((await api.request(`${endpoint}/apply`, 'POST', { proposal: tampered })).status, 400);
    assert.deepEqual((await api.request(`/api/worlds/${world.id}`)).body, world);
    const applied = await api.request(`${endpoint}/apply`, 'POST', { proposal: preview.body });
    assert.equal(applied.status, 200);
    assert(applied.body.events.length > world.events.length);
    assert.equal((await api.request(`/api/worlds/${world.id}/snapshots`)).body.length, 1);
    assert.equal((await api.request(`${endpoint}/apply`, 'POST', { proposal: preview.body })).status, 409);
    const stale = (await api.request(`${endpoint}/preview`, 'POST', { text: 'Increase food production' })).body;
    await api.request(`/api/worlds/${world.id}/advance`, 'POST', { command: '1 year' });
    assert.equal((await api.request(`${endpoint}/apply`, 'POST', { proposal: stale })).status, 409);
  } finally { await api.close(); }
});

test('grounded query synthesis falls back on provider failure and never changes world state', async () => {
  const oldConfig = {
    key: process.env.GENESIS_AI_KEY, base: process.env.GENESIS_AI_BASE_URL, model: process.env.GENESIS_AI_MODEL,
  };
  let healthy = false;
  let inventing = false;
  let received: Record<string, unknown> | undefined;
  const provider = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.setHeader('Content-Type', 'application/json');
    response.statusCode = healthy ? 200 : 503;
    response.end(JSON.stringify(healthy ? { choices: [{ message: { content: inventing ? 'The population is 999 trillion.' : '{"passageIndices":[0]}' } }] } : { error: 'unavailable' }));
  });
  provider.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => provider.once('listening', resolve));
  const address = provider.address();
  assert(address && typeof address !== 'string');
  process.env.GENESIS_AI_KEY = 'integration-test-key';
  process.env.GENESIS_AI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.GENESIS_AI_MODEL = 'local-provider-test';
  const api = await fixture();
  try {
    const world = await api.create('ask-test');
    const question = 'What civilizations exist?';
    const local = askWorld(world, question);
    const fallback = await api.request(`/api/worlds/${world.id}/ask`, 'POST', { question });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.body.answer, local.answer);
    assert.equal(fallback.body.mode, 'local');
    healthy = true;
    const synthesis = await api.request(`/api/worlds/${world.id}/ask`, 'POST', { question });
    assert.equal(synthesis.body.mode, 'ai');
    assert.equal(synthesis.body.answer, local.answer);
    assert.deepEqual(synthesis.body.sources, local.sources);
    assert(received && !('tools' in received));
    assert(JSON.stringify(received).includes('verifiedAnswer'));
    assert.deepEqual((await api.request(`/api/worlds/${world.id}`)).body, world);
    inventing = true;
    const ungrounded = await api.request(`/api/worlds/${world.id}/ask`, 'POST', { question });
    assert.equal(ungrounded.body.mode, 'local');
    assert.equal(ungrounded.body.answer, local.answer);
    const config = (await api.request('/api/config')).body;
    assert.equal(config.ai.available, true);
    assert(!JSON.stringify(config).includes('integration-test-key'));
  } finally {
    await api.close();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    for (const [name, value] of [['GENESIS_AI_KEY', oldConfig.key], ['GENESIS_AI_BASE_URL', oldConfig.base], ['GENESIS_AI_MODEL', oldConfig.model]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  }
});
