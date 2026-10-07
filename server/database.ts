import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface SavedWorld {
  id: string;
  name: string;
  year: number;
  population?: number;
  seed: number | string;
  civilizations?: Array<{ population: number }>;
}

export interface WorldMetadata extends SavedWorld {
  population: number;
  updatedAt: string;
}

function populationOf(world: SavedWorld): number {
  return world.civilizations?.reduce((total, civ) => total + civ.population, 0) ?? world.population ?? 0;
}

export interface SnapshotMetadata {
  id: string;
  worldId: string;
  name: string;
  year: number;
  population: number;
  reason: string;
  label: string;
  createdAt: string;
}

/** Each save is atomic. Snapshots retain the complete simulation, including its PRNG state. */
export class WorldDatabase {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS worlds (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        year INTEGER NOT NULL,
        population INTEGER NOT NULL,
        seed TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        year INTEGER NOT NULL,
        population INTEGER NOT NULL,
        reason TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshots_world ON snapshots(world_id, created_at DESC);
    `);
  }

  list(): WorldMetadata[] {
    const rows = this.db.prepare('SELECT id, name, year, population, seed, updated_at AS updatedAt FROM worlds ORDER BY updated_at DESC, id').all();
    return rows.map(row => ({ ...row, seed: JSON.parse(String(row.seed)) })) as unknown as WorldMetadata[];
  }

  get<T>(id: string): T | null {
    const row = this.db.prepare('SELECT state FROM worlds WHERE id = ?').get(id);
    return row ? JSON.parse(String(row.state)) as T : null;
  }

  largestSaveBytes(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(length(CAST(state AS BLOB))), 0) AS size FROM worlds').get();
    return Number(row?.size ?? 0);
  }

  save<T extends SavedWorld>(world: T): T {
    // Serializing before the write means unsupported values cannot leave a partial record.
    const state = JSON.stringify(world);
    this.db.prepare(`INSERT INTO worlds (id, name, year, population, seed, state, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, year = excluded.year,
      population = excluded.population, seed = excluded.seed, state = excluded.state,
      updated_at = excluded.updated_at`).run(world.id, world.name, world.year,
      populationOf(world), JSON.stringify(world.seed), state, new Date().toISOString());
    return world;
  }

  remove(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM worlds WHERE id = ?').run(id).changes) > 0;
  }

  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  checkpoint<T extends SavedWorld>(world: T, reason: string): SnapshotMetadata {
    const snapshot: SnapshotMetadata = {
      id: randomUUID(), worldId: world.id, name: world.name, year: world.year,
      population: populationOf(world), reason, label: reason, createdAt: new Date().toISOString(),
    };
    this.db.prepare(`INSERT INTO snapshots (id, world_id, name, year, population, reason, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(snapshot.id, snapshot.worldId, snapshot.name,
      snapshot.year, snapshot.population, snapshot.reason, JSON.stringify(world), snapshot.createdAt);
    // Keep the newest 30 complete checkpoints per world; the current save is separate.
    this.db.prepare(`DELETE FROM snapshots WHERE world_id = ? AND id NOT IN
      (SELECT id FROM snapshots WHERE world_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 30)`)
      .run(world.id, world.id);
    return snapshot;
  }

  snapshots(id: string): SnapshotMetadata[] {
    return this.db.prepare(`SELECT id, world_id AS worldId, name, year, population, reason, reason AS label,
      created_at AS createdAt FROM snapshots WHERE world_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(id) as unknown as SnapshotMetadata[];
  }

  snapshot<T>(worldId: string, snapshotId: string): T | null {
    const row = this.db.prepare('SELECT state FROM snapshots WHERE world_id = ? AND id = ?').get(worldId, snapshotId);
    return row ? JSON.parse(String(row.state)) as T : null;
  }

  close(): void { this.db.close(); }
}
