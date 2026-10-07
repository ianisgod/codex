import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { WorldDatabase } from './database.js';
import { aiMetadata, synthesizeAnswer } from './ai.js';
import {
  createWorld, advanceWorld, previewIntervention, applyIntervention, askWorld, validateWorld,
} from '../src/simulation/index.js';
import type { CreateWorldInput, World, InterventionProposal } from '../src/simulation/types.js';

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'A JSON object is required.');
  return value as Record<string, unknown>;
}

function textField(value: unknown, label: string, max = 2_000): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${label} is required.`);
  if (value.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer.`);
  return value.trim();
}

function validated(value: unknown): World {
  try { return validateWorld(value); }
  catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid world save.'); }
}

function digest(world: World): string {
  return createHash('sha256').update(JSON.stringify(world)).digest('hex');
}

function branchWorld(world: World, name: string): World {
  const clone = structuredClone(world);
  clone.id = randomUUID();
  clone.name = name.slice(0, 120);
  clone.createdAt = clone.updatedAt = new Date().toISOString();
  return clone;
}

function suffixName(name: string, suffix: string): string {
  return name.slice(0, Math.max(0, 120 - suffix.length)) + suffix;
}

function createInput(value: unknown): CreateWorldInput {
  const body = record(value);
  const input: CreateWorldInput = {};
  for (const field of ['name', 'origin', 'unusual', 'scenario'] as const) {
    if (field !== 'name' && body[field] === '') continue;
    if (body[field] !== undefined) input[field] = textField(body[field], field, field === 'name' ? 120 : 4_000);
  }
  if (body.seed !== undefined) {
    if (typeof body.seed === 'number') {
      if (!Number.isSafeInteger(body.seed)) throw new HttpError(400, 'seed must be a finite safe integer or string.');
      input.seed = body.seed;
    } else input.seed = textField(body.seed, 'seed', 200);
  }
  return input;
}

export function createApp(dbPath = process.env.DATABASE_PATH || resolve('.local/genesis.sqlite')) {
  const app = express();
  const database = new WorldDatabase(dbPath);
  app.locals.database = database;
  app.disable('x-powered-by');
  // Imports need room for accumulated history. Also cover every locally exported save,
  // even if it has grown past the ordinary import allowance through years of play.
  app.post('/api/worlds/import', (request, response, next) => {
    const limit = Math.max(64 * 1024 * 1024, database.largestSaveBytes() + 1024 * 1024);
    express.json({ limit })(request, response, next);
  });
  app.use(express.json({ limit: '16mb' }));
  const previews = new Map<string, { proposal: InterventionProposal; digest: string; created: number }>();

  const getWorld = (id: string): World => {
    const world = database.get<World>(id);
    if (!world) throw new HttpError(404, 'World not found.');
    try { return validateWorld(world); }
    catch { throw new HttpError(500, 'This save is damaged or uses an unsupported version. Import a valid backup to recover it.'); }
  };
  const idParam = (request: Request): string => String(request.params.id);

  app.get('/api/health', (_request, response) => response.json({ status: 'ok', persistence: 'sqlite' }));
  app.get('/api/config', (_request, response) => response.json({ ai: aiMetadata(), persistence: 'sqlite', snapshots: { retention: 30 } }));
  app.get('/api/worlds', (_request, response) => response.json(database.list()));
  app.post('/api/worlds', (request, response) => {
    const world = createWorld(createInput(request.body));
    validateWorld(world);
    database.save(world);
    response.status(201).json(world);
  });
  app.post('/api/worlds/import', (request, response) => {
    const world = validated(record(request.body).world);
    const imported = branchWorld(world, suffixName(world.name, ' (imported)'));
    database.save(imported);
    response.status(201).json(imported);
  });
  app.get('/api/worlds/:id', (request, response) => response.json(getWorld(idParam(request))));
  app.post('/api/worlds/:id/save', (request, response) => {
    const world = getWorld(idParam(request));
    world.updatedAt = new Date().toISOString();
    database.save(world);
    response.json(world);
  });

  const rename = (request: Request, response: Response) => {
    const world = getWorld(idParam(request));
    world.name = textField(record(request.body).name, 'name', 120);
    world.updatedAt = new Date().toISOString();
    database.save(world);
    response.json(world);
  };
  app.patch('/api/worlds/:id', rename);
  app.put('/api/worlds/:id', rename);
  app.delete('/api/worlds/:id', (request, response) => {
    if (!database.remove(idParam(request))) throw new HttpError(404, 'World not found.');
    response.status(204).end();
  });
  app.post('/api/worlds/:id/duplicate', (request, response) => {
    const world = getWorld(idParam(request));
    const name = request.body?.name === undefined ? suffixName(world.name, ' (copy)') : textField(request.body.name, 'name', 120);
    const duplicate = branchWorld(world, name);
    database.save(duplicate);
    response.status(201).json(duplicate);
  });
  app.post('/api/worlds/:id/advance', (request, response) => {
    const before = getWorld(idParam(request));
    const command = textField(record(request.body).command, 'command', 300);
    let result: ReturnType<typeof advanceWorld>;
    try { result = advanceWorld(structuredClone(before), command); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid time command.'); }
    validateWorld(result.world);
    database.transaction(() => {
      const majorEvent = result.summary.events.find(event => event.severity === 5);
      if (result.summary.toYear - result.summary.fromYear > 10) database.checkpoint(before, `Before ${command}`);
      else if (majorEvent) database.checkpoint(before, `Before major event: ${majorEvent.title}`);
      database.save(result.world);
    });
    response.json(result);
  });
  app.post('/api/worlds/:id/intervention/preview', (request, response) => {
    const world = getWorld(idParam(request));
    const body = record(request.body);
    const text = textField(body.text, 'Intervention', 4_000);
    const targetId = body.targetId === undefined ? undefined : textField(body.targetId, 'targetId', 200);
    let proposal: InterventionProposal;
    try { proposal = previewIntervention(world, text, targetId); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid intervention.'); }
    for (const [key, preview] of previews) if (Date.now() - preview.created > 3_600_000) previews.delete(key);
    if (previews.size >= 1_000) previews.delete(previews.keys().next().value!);
    // Store the same JSON representation sent to the browser (optional undefined fields disappear).
    previews.set(proposal.id, { proposal: JSON.parse(JSON.stringify(proposal)) as InterventionProposal, digest: digest(world), created: Date.now() });
    response.json(proposal);
  });
  app.post('/api/worlds/:id/intervention/apply', (request, response) => {
    const world = getWorld(idParam(request));
    const proposal = record(record(request.body).proposal);
    const preview = previews.get(String(proposal.id));
    if (!preview || preview.proposal.worldId !== world.id) throw new HttpError(409, 'Preview this intervention before applying it.');
    if (Date.now() - preview.created > 3_600_000 || preview.digest !== digest(world)) throw new HttpError(409, 'The world changed after the preview. Preview the intervention again.');
    if (!isDeepStrictEqual(proposal, preview.proposal)) throw new HttpError(400, 'The intervention does not match its preview.');
    let updated: World;
    try { updated = applyIntervention(structuredClone(world), structuredClone(preview.proposal)); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid intervention.'); }
    validateWorld(updated);
    database.transaction(() => {
      database.checkpoint(world, `Before intervention: ${preview.proposal.action}`);
      database.save(updated);
    });
    previews.delete(preview.proposal.id);
    response.json(updated);
  });
  app.post('/api/worlds/:id/ask', async (request, response) => {
    const world = getWorld(idParam(request));
    const question = textField(record(request.body).question, 'Question', 2_000);
    const answer = await synthesizeAnswer(world, question, askWorld(world, question));
    response.json(answer);
  });
  app.get('/api/worlds/:id/snapshots', (request, response) => {
    getWorld(idParam(request));
    response.json(database.snapshots(idParam(request)));
  });
  app.post('/api/worlds/:id/snapshots', (request, response) => {
    const world = getWorld(idParam(request));
    const supplied = request.body?.label ?? request.body?.name;
    const label = supplied === undefined ? `Year ${world.year} — manual checkpoint` : textField(supplied, 'label', 160);
    response.status(201).json(database.transaction(() => database.checkpoint(world, label)));
  });
  app.post('/api/worlds/:id/snapshots/:snapshotId/restore', (request, response) => {
    getWorld(idParam(request));
    const snapshot = database.snapshot<World>(idParam(request), String(request.params.snapshotId));
    if (!snapshot) throw new HttpError(404, 'Snapshot not found.');
    try { validateWorld(snapshot); }
    catch { throw new HttpError(500, 'This checkpoint is damaged or uses an unsupported version. The current world has not changed.'); }
    const branch = branchWorld(snapshot, suffixName(snapshot.name, ` — year ${snapshot.year} branch`));
    database.save(branch);
    response.status(201).json(branch);
  });
  app.get('/api/worlds/:id/export', (request, response) => {
    const world = getWorld(idParam(request));
    const filename = (world.name.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80) || 'world') + '.genesis.json';
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.json(world);
  });

  app.use('/api', (_request, _response, next) => next(new HttpError(404, 'API endpoint not found.')));
  const dist = resolve('dist');
  if (existsSync(resolve(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.get('/{*path}', (_request, response) => response.sendFile(resolve(dist, 'index.html')));
  }
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof HttpError) { response.status(error.status).json({ error: error.message }); return; }
    const bodyError = error as { status?: number; type?: string; limit?: number };
    if (bodyError?.type === 'entity.too.large') {
      const limit = Math.floor((bodyError.limit || 16 * 1024 * 1024) / 1024 / 1024);
      response.status(413).json({ error: `This request is too large (current allowance ${limit} MB).` }); return;
    }
    if (bodyError?.status === 400) { response.status(400).json({ error: 'Invalid JSON request.' }); return; }
    console.error('GENESIS server error:', error instanceof Error ? error.message : 'Unknown error');
    response.status(500).json({ error: 'The operation could not be saved. Your previous world remains intact.' });
  });
  return app;
}
