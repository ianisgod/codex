import { z } from 'zod';
import type { World } from './types';

const finite = z.number().finite();
const positive = finite.nonnegative();
const ratio = finite.min(0).max(1);
const score = finite.min(0).max(100);
const strings = z.array(z.string());
const attributes = z.record(z.unknown());
const relationship = z.object({ characterId: z.string(), type: z.string(), affection: score, trust: score, fear: score, respect: score, resentment: score, loyalty: score });
const knowledge = z.object({ id: z.string(), topic: z.string(), belief: z.string(), actual: finite.optional(), perceived: finite.optional(), confidence: ratio, source: z.string(), eventId: z.string().optional(), learnedYear: finite, isRumor: z.boolean() });
const memory = z.object({ eventId: z.string(), year: finite, description: z.string(), emotion: z.string() });
const plan = z.object({ action: z.string(), target: z.string(), intensity: ratio, reason: z.string(), knowledgeIds: strings, considered: z.array(z.object({ action: z.string(), label: z.string(), preference: z.enum(['High', 'Moderate', 'Low']), score, reason: z.string() })), year: finite, executed: z.boolean() });
const character = z.object({ id: z.string(), name: z.string(), civId: z.string(), role: z.string(), age: positive, alive: z.boolean(), traits: z.record(finite), goals: strings, beliefs: strings, fears: strings, knowledge: z.array(knowledge), memories: z.array(memory), relationships: z.array(relationship), thoughts: strings, plans: z.array(plan), health: score, influence: score, wealth: positive, deathYear: finite.optional(), bornYear: finite, sex: z.string(), culture: z.string(), socialClass: z.string(), dynasty: z.string().optional(), publicPosition: z.string(), skills: z.record(finite), secrets: strings, tags: strings, attributes });
const group = z.object({ id: z.string(), name: z.string(), share: ratio, influence: score, happiness: score, wealth: positive, ideology: z.string(), goals: strings });
const resource = z.object({ name: z.string(), stock: positive, production: positive, demand: positive, price: positive });
const culture = z.object({ language: z.string(), values: strings, customs: strings, architecture: z.string(), cuisine: z.string(), traditions: strings });
const disease = z.object({ id: z.string(), name: z.string(), infected: positive, fatality: ratio, transmissibility: ratio, immunity: ratio, startedYear: finite, causeEventId: z.string(), deaths: positive });
const civilization = z.object({ id: z.string(), name: z.string(), color: z.string(), population: positive, government: z.string(), capital: z.string(), leaderId: z.string(), religionId: z.string(), territory: positive, food: positive, treasury: positive, taxRate: ratio, happiness: score, stability: score, military: positive, technologies: strings, research: positive, resources: z.array(resource), culture, groups: z.array(group), relations: z.array(z.object({ civId: z.string(), trust: score, trade: score, grievance: score, alliance: z.boolean() })), dynasty: z.string(), succession: strings, debt: positive, literacy: ratio, climate: positive, soil: positive, disease: disease.optional(), active: z.boolean(), collapsedYear: finite.optional(), attributes });
const religion = z.object({ id: z.string(), name: z.string(), origin: z.string(), deity: z.string(), doctrines: strings, rituals: strings, holyText: z.string(), clergy: z.string(), followers: positive, influence: score, denominations: strings, parentId: z.string().optional(), foundedYear: finite, tags: strings });
const war = z.object({ id: z.string(), name: z.string(), attackerId: z.string(), defenderId: z.string(), participants: strings, cause: z.string(), causeEventId: z.string(), goals: strings, startedYear: finite, endedYear: finite.optional(), active: z.boolean(), casualties: positive, battles: strings, morale: z.record(score), winnerId: z.string().optional(), commanderIds: strings, logistics: z.record(positive) });
const event = z.object({ id: z.string(), timestamp: finite, year: finite, day: finite.int().min(0).max(364), category: z.enum(['Political', 'Military', 'Economic', 'Religious', 'Scientific', 'Technological', 'Cultural', 'Environmental', 'Biological', 'Demographic', 'Diplomatic', 'Criminal', 'Personal', 'Disaster', 'Exploration', 'Cosmic']), severity: finite.int().min(1).max(5), location: z.string(), actors: strings, factions: strings, title: z.string(), description: z.string(), causes: strings, effects: strings, stateChanges: z.array(z.object({ entityId: z.string(), field: z.string(), before: z.unknown(), after: z.unknown() })), relatedEvents: strings, visibility: z.enum(['public', 'private', 'rumor']), tags: strings });
const canon = z.object({ id: z.string(), description: z.string(), year: finite, origin: z.enum(['creation', 'intervention', 'emergent']), facts: strings, disputedFacts: strings, entityIds: strings, tags: strings, attributes: attributes.optional() });
const geography = z.object({ width: finite.int().positive().max(1000), height: finite.int().positive().max(1000), cells: z.array(z.object({ x: finite.int().nonnegative(), y: finite.int().nonnegative(), elevation: ratio, biome: z.enum(['ocean', 'plains', 'forest', 'mountains', 'desert', 'river']), civId: z.string().optional(), resource: z.string().optional() })), settlements: z.array(z.object({ id: z.string(), name: z.string(), x: positive, y: positive, civId: z.string(), population: positive })), seed: z.string() });
const schema = z.object({ version: z.literal(1), id: z.string().min(1), name: z.string().min(1), seed: z.string(), origin: z.string(), unusual: z.string(), year: finite.int().min(0).max(2e12), day: finite.int().min(0).max(364), era: z.string(), createdAt: z.string(), updatedAt: z.string(), civilizations: z.array(civilization).min(1), characters: z.array(character), religions: z.array(religion), wars: z.array(war), events: z.array(event), canon: z.array(canon), geography, populationHistory: z.array(z.object({ year: finite, population: positive, civilizations: z.record(positive) })), rngState: finite.int().min(1).max(4294967295), nextEntity: finite.int().positive(), tick: finite.int().nonnegative(), attributes });

/** JSON imports can contain overflowed numbers (for example 1e309). Check open-ended
 * attributes too, so serialization never quietly turns invalid numerical reality into null.
 * An explicit stack handles deeply nested values and distinguishes cycles from shared data. */
function assertSerializableNumbers(value: unknown): void {
  type Frame = { value: unknown; path: string; exit?: boolean };
  const stack: Frame[] = [{ value, path: 'root' }];
  const ancestors = new WeakSet<object>();
  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.exit) { ancestors.delete(frame.value as object); continue; }
    if (typeof frame.value === 'number' && !Number.isFinite(frame.value)) throw new Error(`Invalid world at ${frame.path}: numbers must be finite.`);
    if (frame.value === null || frame.value === undefined || typeof frame.value === 'string' || typeof frame.value === 'boolean' || typeof frame.value === 'number') continue;
    if (typeof frame.value !== 'object') throw new Error(`Invalid world at ${frame.path}: custom values must be JSON-compatible data.`);
    if (ancestors.has(frame.value)) throw new Error(`Invalid world at ${frame.path}: cyclic references cannot be saved.`);
    const prototype = Object.getPrototypeOf(frame.value);
    if (!Array.isArray(frame.value) && prototype !== Object.prototype && prototype !== null) throw new Error(`Invalid world at ${frame.path}: custom values must be plain JSON objects.`);
    ancestors.add(frame.value);
    stack.push({ ...frame, exit: true });
    for (const [key, child] of Object.entries(frame.value)) stack.push({ value: child, path: `${frame.path.slice(-400)}.${key.slice(0, 100)}` });
  }
}

/** Parse imports and validate relationships before a caller stores or executes a world. */
export function validateWorld(value: unknown): World {
  assertSerializableNumbers(value);
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid world at ${issue.path.join('.') || 'root'}: ${issue.message}`);
  }
  const world = parsed.data as World;
  const ids = (items: { id: string }[], label: string) => {
    const set = new Set(items.map(item => item.id));
    if (set.size !== items.length) throw new Error(`Invalid world: duplicate ${label} identifiers.`);
    return set;
  };
  const civIds = ids(world.civilizations, 'civilization'), characterIds = ids(world.characters, 'character'), religionIds = ids(world.religions, 'religion'), eventIds = ids(world.events, 'event');
  ids(world.wars, 'war'); ids(world.canon, 'canon'); ids(world.geography.settlements, 'settlement');
  const requireRef = (exists: boolean, message: string) => { if (!exists) throw new Error(`Invalid world: ${message}`); };
  for (const civ of world.civilizations) {
    const leader = world.characters.find(person => person.id === civ.leaderId);
    requireRef(!!leader && leader.civId === civ.id && (!civ.active || leader.alive), `${civ.name} references an invalid ruler.`);
    requireRef(religionIds.has(civ.religionId), `${civ.name} references a missing religion.`);
    civ.relations.forEach(relation => requireRef(civIds.has(relation.civId), 'A diplomatic relationship references a missing civilization.'));
    civ.succession.forEach(id => requireRef(characterIds.has(id), 'A succession references a missing character.'));
    if (civ.disease) { requireRef(eventIds.has(civ.disease.causeEventId), 'Disease source event is missing.'); requireRef(civ.disease.infected <= civ.population, 'Disease infections exceed the population.'); }
    requireRef(civ.military <= civ.population, 'Military exceeds the population.');
  }
  for (const person of world.characters) {
    requireRef(civIds.has(person.civId), 'A character references a missing civilization.');
    if (!person.alive) requireRef(person.deathYear !== undefined && person.health === 0, 'A dead character has no consistent death record.');
    person.relationships.forEach(tie => requireRef(characterIds.has(tie.characterId), 'A relationship references a missing character.'));
    person.memories.forEach(memory => requireRef(eventIds.has(memory.eventId), 'A character memory references missing history.'));
    person.knowledge.forEach(item => requireRef(!item.eventId || eventIds.has(item.eventId), 'Knowledge references missing history.'));
  }
  let previous = -Infinity;
  const visited = new Set<string>();
  for (const item of world.events) {
    requireRef(item.timestamp >= previous && item.timestamp === item.year * 365 + item.day, 'History timestamps are not ordered.');
    requireRef(item.timestamp <= world.year * 365 + world.day, 'History contains a future event.');
    item.causes.forEach(id => requireRef(visited.has(id), 'An event cause is missing or does not precede its consequence.'));
    item.relatedEvents.forEach(id => requireRef(eventIds.has(id), 'A related event is missing.'));
    item.actors.forEach(id => requireRef(characterIds.has(id), 'An event references a missing character.'));
    item.factions.forEach(id => requireRef(civIds.has(id), 'An event references a missing civilization.'));
    visited.add(item.id); previous = item.timestamp;
  }
  for (const conflict of world.wars) {
    requireRef(civIds.has(conflict.attackerId) && civIds.has(conflict.defenderId) && conflict.attackerId !== conflict.defenderId, 'A war has invalid participants.');
    conflict.participants.forEach(id => requireRef(civIds.has(id), 'A war references a missing civilization.'));
    conflict.battles.forEach(id => requireRef(eventIds.has(id), 'A war references a missing battle.'));
    conflict.commanderIds.forEach(id => requireRef(characterIds.has(id), 'A war references a missing commander.'));
    requireRef(eventIds.has(conflict.causeEventId), 'A war source event is missing.');
  }
  for (const cell of world.geography.cells) requireRef(cell.x < world.geography.width && cell.y < world.geography.height && (!cell.civId || civIds.has(cell.civId)), 'A map cell is outside its bounds or references a missing civilization.');
  for (const city of world.geography.settlements) requireRef(civIds.has(city.civId) && city.x < world.geography.width && city.y < world.geography.height, 'A settlement is outside the map or references a missing civilization.');
  for (const faith of world.religions) { requireRef(!faith.parentId || religionIds.has(faith.parentId), 'A religious branch has no parent.'); faith.denominations.forEach(id => requireRef(religionIds.has(id), 'A religion references a missing denomination.')); }
  let previousSample = -Infinity;
  for (const point of world.populationHistory) {
    requireRef(point.year >= previousSample && point.year <= world.year + world.day / 365, 'Population samples are not ordered or are in the future.');
    for (const id of Object.keys(point.civilizations)) requireRef(civIds.has(id), 'A population sample references a missing civilization.');
    previousSample = point.year;
  }
  return world;
}
