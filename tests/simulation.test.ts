import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceWorld, applyIntervention, askWorld, createWorld, parseTime, populationTotal, previewIntervention, validateWorld } from '../src/simulation/index';
import { addEvent } from '../src/simulation/utils';

test('same seed produces identical geography, societies and agent personalities', () => {
  const a = createWorld({ seed: 'deterministic', unusual: 'Magic is exceptionally rare.' });
  const b = createWorld({ seed: 'deterministic', unusual: 'Magic is exceptionally rare.' });
  assert.deepEqual(a.geography, b.geography);
  assert.deepEqual(a.civilizations, b.civilizations);
  assert.deepEqual(a.characters, b.characters);
  assert.deepEqual(a.events, b.events);
  assert.equal(a.characters.length, 30);
  assert.equal(a.civilizations.length, 3);
  assert.ok(a.characters.every(person => person.thoughts.length && person.plans.length));
  validateWorld(a);
});

test('duration parser accepts days, compound months, thousands, millions and billions', () => {
  const cases: [string, number][] = [['1 day', 1 / 365], ['17 days', 17 / 365], ['3 months', .25], ['47 years', 47], ['12,000 years', 12000], ['2 million years', 2e6], ['4.2 billion years', 4.2e9], ['2 thousand years', 2000], ['a hundred years', 100], ['twenty-seven years', 27], ['3 years and 6 months', 3.5]];
  for (const [text, years] of cases) assert.equal(parseTime(text).years, years, text);
  for (const text of ['0 years', '-2 years', 'forever', '3 cats', '1 day and -2 years']) assert.throws(() => parseTime(text));
});

test('daily aging is exact and monthly fractional days accumulate to a full year', () => {
  const world = createWorld({ seed: 'age' });
  const person = world.characters[0]; const age = person.age;
  advanceWorld(world, '1 day');
  assert.equal(world.day, 1); assert.equal(person.age, age + 1 / 365);
  const monthly = createWorld({ seed: 'calendar' });
  for (let month = 0; month < 12; month++) advanceWorld(monthly, '1 month');
  assert.equal(monthly.year, 843); assert.equal(monthly.day, 0);
  validateWorld(monthly);
});

test('ruler death follows the correct civilization dynasty and preserves the biography', () => {
  const world = createWorld({ seed: 'succession' }); const civ = world.civilizations[0];
  const former = civ.leaderId, heir = civ.succession[0], government = civ.government;
  const result = applyIntervention(world, previewIntervention(world, 'Kill the current king of Valora'));
  assert.equal(result.civilizations[0].leaderId, heir);
  assert.equal(result.civilizations[0].government, government);
  assert.equal(result.characters.find(person => person.id === former)!.alive, false);
  assert.ok(result.events.some(event => event.tags.includes('succession') && event.actors.includes(heir)));
  assert.equal(world.characters.find(person => person.id === former)!.alive, true, 'Applying a proposal returns a separate transactional world');
  validateWorld(result);
});

test('plague deaths reduce actual population and leave a causal disease ledger', () => {
  let world = createWorld({ seed: 'plague' });
  world = applyIntervention(world, previewIntervention(world, 'A plague starts in Valora that kills roughly 20% of infected people'));
  assert.equal(world.civilizations[0].disease!.fatality, .2);
  advanceWorld(world, '5 years');
  const deaths = world.events.filter(event => event.factions.includes('valora') && event.category === 'Biological' && event.tags.includes('deaths'));
  assert.ok(deaths.length);
  assert.ok(deaths.some(event => event.stateChanges.some(change => change.field === 'population' && Number(change.before) > Number(change.after))));
  assert.ok(deaths.every(event => event.causes.length));
  validateWorld(world);
});

test('intervention previews are pure and unfamiliar phenomena become lasting canon', () => {
  const world = createWorld({ seed: 'canon' }); const before = JSON.stringify(world);
  const proposal = previewIntervention(world, 'A giant black monolith appears overnight in the capital');
  assert.equal(JSON.stringify(world), before);
  const changed = applyIntervention(world, proposal);
  assert.equal(changed.canon.length, 1);
  assert.match(changed.canon[0].description, /monolith/);
  advanceWorld(changed, '47 years');
  assert.ok(changed.events.some(event => event.tags.includes('legacy') && event.tags.includes('monolith')));
  assert.ok(changed.canon[0].disputedFacts.length);
  validateWorld(changed);
});

test('trade transfers conserve combined treasury and migration conserves population', () => {
  let world = createWorld({ seed: 'transactions' }); const before = populationTotal(world);
  world = applyIntervention(world, previewIntervention(world, 'Migrate 10% from Valora to Esen'));
  assert.equal(populationTotal(world), before);
  advanceWorld(world, '1 year');
  const transfers = world.events.filter(event => event.tags.includes('trade') && event.stateChanges.filter(change => change.field === 'treasury').length === 2);
  assert.ok(transfers.length);
  for (const event of transfers) {
    const changes = event.stateChanges.filter(change => change.field === 'treasury');
    assert.ok(Math.abs(changes.reduce((total, change) => total + Number(change.after) - Number(change.before), 0)) < 1e-8);
  }
  validateWorld(world);
});

test('agents do not learn private events they did not witness', () => {
  const world = createWorld({ seed: 'private' });
  const actor = world.characters[2], observer = world.characters[6];
  const event = addEvent(world, { category: 'Criminal', title: 'A hidden agreement', description: 'The general privately signs an agreement.', actors: [actor.id], factions: ['valora'], visibility: 'private' });
  advanceWorld(world, '1 day');
  assert.ok(actor.knowledge.some(item => item.eventId === event.id));
  assert.ok(!observer.knowledge.some(item => item.eventId === event.id));
});

test('autonomous systems produce wars, inventions, rumors and scored agent decisions', () => {
  const world = createWorld({ seed: 'genesis' }); advanceWorld(world, '100 years');
  assert.ok(world.wars.length > 0);
  assert.ok(world.events.some(event => event.category === 'Technological'));
  assert.ok(world.events.some(event => event.visibility === 'rumor'));
  assert.ok(world.characters.some(person => person.knowledge.some(item => item.isRumor && item.source)));
  assert.ok(world.characters.some(person => person.plans.some(plan => plan.executed && plan.considered.length > 1)));
  for (const war of world.wars) assert.ok(world.civilizations.some(civ => civ.id === war.attackerId) && world.civilizations.some(civ => civ.id === war.defenderId));
  validateWorld(world);
});

test('event-based advancement stops on a tracked ruler death', () => {
  const world = createWorld({ seed: 'until' }); const rulerId = world.civilizations[0].leaderId;
  const result = advanceWorld(world, 'until the king dies');
  assert.equal(world.characters.find(person => person.id === rulerId)!.alive, false);
  assert.match(result.summary.stoppedReason!, /Condition reached/);
  assert.ok(result.summary.steps < 750);
  validateWorld(world);
});

test('billion-year jumps honor exact duration with bounded work and plausible lifespans', () => {
  const world = createWorld({ seed: 'epoch' }); const initialYear = world.year;
  const result = advanceWorld(world, '4.2 billion years');
  assert.equal(world.year, initialYear + 4.2e9); assert.equal(world.day, 0);
  assert.ok(result.summary.steps <= 250);
  assert.ok(world.events.length > 1000, 'Earlier history is retained, not regenerated');
  for (const person of world.characters.filter(person => !person.alive && !person.tags.includes('immortal'))) {
    assert.ok(person.age < 120);
    assert.ok(Math.abs(person.bornYear + person.age - person.deathYear!) < 1.1);
    assert.ok(!person.plans.some(plan => plan.executed && plan.year > person.deathYear!));
  }
  for (const civ of world.civilizations) for (const amount of [civ.population, civ.military, civ.food, civ.treasury, civ.research]) assert.ok(Number.isFinite(amount) && amount >= 0);
  validateWorld(world);
});

test('one large skip and repeated yearly/monthly skips remain reasonably consistent', () => {
  const large = createWorld({ seed: 'macro' }), annual = structuredClone(large), monthly = structuredClone(large);
  advanceWorld(large, '10 years');
  for (let index = 0; index < 10; index++) advanceWorld(annual, '1 year');
  for (let index = 0; index < 120; index++) advanceWorld(monthly, '1 month');
  assert.equal(monthly.year, large.year); assert.equal(monthly.day, large.day);
  for (let index = 0; index < large.civilizations.length; index++) for (const small of [annual, monthly]) {
    const difference = Math.abs(large.civilizations[index].population - small.civilizations[index].population) / large.civilizations[index].population;
    assert.ok(difference < .2, `${large.civilizations[index].name}: ${(difference * 100).toFixed(1)}% population divergence`);
  }
  validateWorld(annual); validateWorld(monthly);
});

test('extinction and dead agents stay extinct through autonomous advancement', () => {
  let world = createWorld({ seed: 'extinction' });
  world = applyIntervention(world, previewIntervention(world, 'Reduce population of Valora by 100%'));
  assert.equal(world.civilizations[0].population, 0);
  assert.equal(world.civilizations[0].active, false);
  advanceWorld(world, '47 years');
  assert.equal(world.civilizations[0].population, 0);
  assert.ok(world.characters.filter(person => person.civId === 'valora').every(person => !person.alive));
  validateWorld(world);
});

test('grounded world questions cite stored evidence and never mutate the simulation', () => {
  const world = createWorld({ seed: 'ask' }); advanceWorld(world, '47 years'); const before = JSON.stringify(world);
  for (const question of ['What caused the war?', 'Who is the most powerful person alive?', 'Explain the last 100 years.', 'Why are peasants angry?', 'Which kingdom is technologically advanced?']) {
    const answer = askWorld(world, question);
    assert.ok(answer.answer.length > 20);
    assert.ok(answer.sources.every(id => world.events.some(event => event.id === id)));
  }
  assert.equal(JSON.stringify(world), before);
});

test('invalid imported worlds fail scalar, reference and chronological validation', () => {
  const world = createWorld({ seed: 'validation' });
  const negative = structuredClone(world); negative.civilizations[0].population = -1;
  assert.throws(() => validateWorld(negative), /Invalid world/);
  const dangling = structuredClone(world); dangling.civilizations[0].leaderId = 'missing';
  assert.throws(() => validateWorld(dangling), /ruler/);
  const unordered = structuredClone(world); unordered.events.reverse();
  assert.throws(() => validateWorld(unordered), /precede|ordered/);
  const futureSample = structuredClone(world); futureSample.populationHistory.push({ ...futureSample.populationHistory[0], year: 900 });
  assert.throws(() => validateWorld(futureSample), /Population samples/);
});

test('flexible canonical attributes reject non-finite numbers and cycles without data loss', () => {
  const world = createWorld({ seed: 'nested-validation' });
  const overflow = JSON.parse(JSON.stringify(world).replace('"attributes":{', '"attributes":{"experiment":{"measurements":[1e309]},'));
  assert.throws(() => validateWorld(overflow), /numbers must be finite/);
  const notANumber = structuredClone(world);
  notANumber.events[0].stateChanges.push({ entityId: world.id, field: 'custom experiment', before: null, after: { result: Number.NaN } });
  assert.throws(() => validateWorld(notANumber), /numbers must be finite/);
  const cyclic = structuredClone(world);
  cyclic.attributes.self = cyclic.attributes;
  assert.throws(() => validateWorld(cyclic), /cyclic references cannot be saved/);
  const shared = structuredClone(world);
  const detail = { resource: 'Unobtainium', strength: 12.5, traits: ['strange', 'stable'] };
  shared.attributes.first = detail; shared.attributes.second = detail;
  assert.deepEqual(validateWorld(shared).attributes.first, detail, 'Repeated noncyclic references remain valid JSON data');
});
