import type { HistoryEvent, World } from './types';

const eventIndexes = new WeakMap<World, { count: number; events: Map<string, HistoryEvent> }>();
const characterIndexes = new WeakMap<World, { count: number; characters: Map<string, World['characters'][number]> }>();

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0 || 1;
}
/** Serializable PRNG: identical seed and actions produce identical numerical outcomes. */
export function random(world: Pick<World, 'rngState'>): number {
  let value = world.rngState >>> 0;
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  world.rngState = value >>> 0 || 1;
  return world.rngState / 4294967296;
}
export function nextId(world: World, prefix: string): string { return `${prefix}-${world.nextEntity++}`; }
export function chance(world: World, annualRate: number, years: number): boolean {
  return random(world) < 1 - Math.exp(-Math.max(0, annualRate) * Math.max(0, years));
}
export function addEvent(world: World, input: Partial<HistoryEvent> & Pick<HistoryEvent, 'title' | 'description' | 'category'>): HistoryEvent {
  const event: HistoryEvent = {
    id: nextId(world, 'evt'), timestamp: world.year * 365 + world.day, year: world.year,
    day: world.day, severity: 2, location: world.name, actors: [], factions: [],
    causes: [], effects: [], stateChanges: [], relatedEvents: [], visibility: 'public', tags: [], ...input,
  };
  event.timestamp = event.year * 365 + event.day;
  // Causes only point backwards; child links make chronology independently inspectable.
  let cached = eventIndexes.get(world);
  if (!cached || cached.count > world.events.length) { cached = { count: 0, events: new Map() }; eventIndexes.set(world, cached); }
  if (cached.count < world.events.length) {
    for (let index = cached.count; index < world.events.length; index++) cached.events.set(world.events[index].id, world.events[index]);
    cached.count = world.events.length;
  }
  const known = cached.events;
  event.causes = [...new Set(event.causes)].filter(id => known.has(id));
  for (const causeId of event.causes) {
    const cause = known.get(causeId)!;
    if (!cause.relatedEvents.includes(event.id)) cause.relatedEvents.push(event.id);
    if (!cause.effects.includes(event.title)) cause.effects.push(event.title);
  }
  world.events.push(event);
  cached.events.set(event.id, event); cached.count++;
  if (!event.actors.length) return event;
  let people = characterIndexes.get(world);
  if (!people || people.count > world.characters.length) { people = { count: 0, characters: new Map() }; characterIndexes.set(world, people); }
  if (people.count < world.characters.length) {
    for (let index = people.count; index < world.characters.length; index++) people.characters.set(world.characters[index].id, world.characters[index]);
    people.count = world.characters.length;
  }
  for (const actorId of event.actors) {
    const person = people.characters.get(actorId);
    if (!person?.alive) continue;
    person.memories.push({ eventId: event.id, year: event.year, description: event.title, emotion: event.category === 'Military' ? 'anxiety' : event.category === 'Personal' ? 'grief' : 'attention' });
  }
  return event;
}
export function recentCause(world: World, civId: string, tags: string[]): string[] {
  for (let index = world.events.length - 1; index >= 0; index--) {
    const event = world.events[index];
    if (event.factions.includes(civId) && event.tags.some(tag => tags.includes(tag))) return [event.id];
  }
  return [];
}
export function populationTotal(world: World): number { return world.civilizations.reduce((total, civ) => total + civ.population, 0); }
