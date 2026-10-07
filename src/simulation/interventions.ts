import type { Character, Civilization, HistoryEvent, InterventionOperation, InterventionProposal, StateChange, World, WorldAnswer } from './types';
import { addEvent, hashSeed, nextId } from './utils';
import { killCharacter, makeCharacter } from './agents';
import { validateWorld } from './validation';

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
const titleCase = (value: string) => value.replace(/\b[a-z]/g, letter => letter.toUpperCase());
const format = (value: number) => Math.round(value).toLocaleString('en-US');
const percent = (text: string, fallback: number) => {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/i);
  return match ? clamp(Number(match[1]) / 100, 0, 1) : fallback;
};
const duration = (text: string, fallback = 3) => {
  const match = text.match(/(?:for|lasts?|disappears? for)\s+(\d+(?:\.\d+)?)\s*(hours?|days?|months?|years?|centuries)/i);
  if (!match) return fallback;
  const factor = /hour/i.test(match[2]) ? 1 / 8760 : /day/i.test(match[2]) ? 1 / 365 : /month/i.test(match[2]) ? 1 / 12 : /centur/i.test(match[2]) ? 100 : 1;
  return clamp(Number(match[1]) * factor, 1 / 8760, 1000000);
};

function mentionedCivilizations(world: World, text: string): Civilization[] {
  const normalized = clean(text);
  return world.civilizations.filter(civ => ` ${normalized} `.includes(` ${clean(civ.id)} `) || normalized.includes(clean(civ.name)) || normalized.includes(clean(civ.capital)) || normalized.includes(clean(civ.name.replace(/^(?:kingdom|republic|empire|confederation) of /i, ''))));
}

function mentionedPeople(world: World, text: string): Character[] {
  const normalized = ` ${clean(text)} `;
  return world.characters.map(person => {
    const name = clean(person.name);
    const words = name.split(' ').filter(word => word.length > 3 && !/^(king|queen|prince|general|scholar|merchant|priest|emperor)$/.test(word));
    const score = normalized.includes(` ${name} `) || normalized.includes(` ${clean(person.id)} `) ? 100 : words.reduce((sum, word) => sum + (normalized.includes(` ${word} `) ? 1 : 0), 0);
    return { person, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).map(item => item.person);
}

function resolveTargets(world: World, text: string, targetId?: string) {
  const chosenPerson = world.characters.find(person => person.id === targetId);
  const chosenCiv = world.civilizations.find(civ => civ.id === targetId || civ.id === chosenPerson?.civId);
  const namedCivs = mentionedCivilizations(world, text);
  const global = /\b(?:every|everyone|all|worldwide|global|entire world|whole world|all humanity)\b/i.test(text);
  const civs = global ? world.civilizations.filter(civ => civ.active) : namedCivs.length ? namedCivs : chosenCiv ? [chosenCiv] : world.civilizations.filter(civ => civ.active).slice(0, 1);
  const named = mentionedPeople(world, text);
  let person: Character | undefined = chosenPerson ?? named[0];
  if (!person && /\b(?:king|queen|ruler|emperor|president|current leader|monarch)\b/i.test(text)) person = world.characters.find(candidate => candidate.id === civs[0]?.leaderId);
  if (!person && /\bgeneral\b/i.test(text)) person = world.characters.find(candidate => candidate.civId === civs[0]?.id && /general|commander/i.test(candidate.role) && candidate.alive);
  return { civs, person, people: named, defaulted: !global && !namedCivs.length && !chosenCiv, global };
}

function technologyName(text: string): string {
  const known = ['Artificial intelligence', 'Quantum computing', 'Computing', 'Electricity', 'Steam engine', 'Gunpowder', 'Printing', 'Medicine', 'Sailing', 'Navigation', 'Mathematics', 'Irrigation', 'Ironworking', 'Steelworking', 'Agriculture', 'Radio', 'Internet', 'Flight', 'Calculus', 'Writing'];
  const named = known.find(name => clean(text).includes(clean(name)));
  if (named) return named;
  const quoted = text.match(/["“]([^"”]+)["”]/);
  if (quoted) return titleCase(quoted[1].trim()).slice(0, 100);
  const custom = text.match(/(?:technology (?:called|named|known as)|reveal|introduce|grant|give .+? knowledge of|discover)\s+(?:the technology of\s+)?(.+?)(?:\s+(?:to|in|years? early|\d+)|[.!]|$)/i);
  return titleCase(custom?.[1]?.trim() || 'Unusual Knowledge').slice(0, 100);
}

function personName(text: string): string | undefined {
  const named = text.match(/(?:named|called)\s+["“]?([A-Za-z][A-Za-z' -]{1,60}?)(?:["”.,]|\s+(?:in|from|who|with|to|of|and|aged)|$)/i);
  return named?.[1]?.trim();
}

/** Interpret user text into a bounded plan. This function never changes world state. */
export function previewIntervention(world: World, input: string, targetId?: string): InterventionProposal {
  const text = input.trim();
  if (!text || text.length > 4000) throw new Error('Describe a reality change using between 1 and 4,000 characters.');
  if (targetId && !world.characters.some(person => person.id === targetId) && !world.civilizations.some(civ => civ.id === targetId)) throw new Error('The selected intervention target no longer exists.');
  const { civs, person, people, defaulted, global } = resolveTargets(world, text, targetId);
  const assumptions: string[] = [];
  const immediateEffects: string[] = [];
  const operations: InterventionOperation[] = [];
  let action = 'Introduce a persistent world phenomenon';
  let destructive = false;
  const location = global ? world.name : civs.map(civ => civ.name).join(', ') || world.name;
  const targets = civs.map(civ => civ.id);
  if (defaulted) assumptions.push(`No recognized civilization was specified. Local effects apply to ${civs[0]?.name ?? world.name}; select another target to change this.`);
  const addForCivs = (type: string, value?: number | string, details?: Record<string, unknown>) => civs.forEach(civ => operations.push({ type, targetId: civ.id, value, details }));
  const requirePerson = () => {
    if (!person) throw new Error('No person matches this command. Include their name or select a person.');
    if (!person.alive) throw new Error(`${person.name} is already dead. Create a new person or choose someone living.`);
    if (!targets.includes(person.id)) targets.push(person.id);
    return person;
  };

  if (/\b(?:kill everyone|kill all (?:people|life)|wipe out|extinguish humanity)\b/i.test(text)) {
    action = 'Extinguish the selected populations';
    addForCivs('population', -1);
    immediateEffects.push('Population falls to zero in each target. Their civilizations become extinct; named characters die and all biographies and history are retained.');
    destructive = true;
  } else if (/\b(?:kill|assassinat\w*|execute|smite)\b/i.test(text) && !/\b(?:plague|disease|epidemic|infection)\b/i.test(text) && (/\b(?:person|king|queen|ruler|emperor|general|president|leader|monarch)\b/i.test(text) || Boolean(person))) {
    const victim = requirePerson();
    action = `End the life of ${victim.name}`;
    operations.push({ type: 'kill', targetId: victim.id });
    immediateEffects.push(`${victim.name} dies. Their biography and memories remain in history.`);
    if (civs.some(civ => civ.leaderId === victim.id)) immediateEffects.push('The government follows its existing succession order; a new ruler inherits current conditions.');
    destructive = true;
  } else if (/\b(?:immortal|immortality|mortal|eternal life|never (?:dies?|ages?))\b/i.test(text) && !/\bcreate\b.+\b(?:person|prophet|genius|general|character)\b/i.test(text)) {
    const subject = requirePerson();
    const revoke = /\bmortal\b|remove|revoke|no longer immortal/i.test(text);
    action = `${revoke ? 'Revoke' : 'Grant'} immortality ${revoke ? 'from' : 'to'} ${subject.name}`;
    operations.push({ type: 'immortal', targetId: subject.id, details: { granted: !revoke } });
    immediateEffects.push(revoke ? `${subject.name} loses immortality and is subject to natural aging deaths again.` : `${subject.name} gains a persistent immortality ability and is protected from natural aging deaths.`);
    assumptions.push('Immortality prevents natural aging death. An explicit divine intervention can still end their life.');
  } else if (/\b(?:plague|disease|epidemic|pandemic|infection)\b/i.test(text)) {
    const fatality = percent(text, .12);
    action = 'Seed an epidemic';
    addForCivs('plague', fatality, { name: personName(text) || 'The Pale Fever' });
    civs.forEach(civ => immediateEffects.push(`${civ.name}: seed ${format(Math.min(civ.population, Math.max(1, Math.round(civ.population * .005))))} infections. Fatality among infected people is ${(fatality * 100).toFixed(1)}%.`));
    immediateEffects.push('Deaths and spread occur through subsequent disease simulation; population is not reduced at introduction.');
    if (!/\d\s*(?:%|percent)/i.test(text)) assumptions.push('No fatality rate was supplied; use a deterministic 12% disease fatality parameter.');
    assumptions.push('Initial infections are 0.5% of the target population. The disease competes with any existing active outbreak.');
    destructive = true;
  } else if (/\b(?:drought|crop failure|failed harvest|famine)\b/i.test(text)) {
    action = 'Create a sustained harvest crisis';
    addForCivs('drought', .55, { durationYears: duration(text), kind: /famine/i.test(text) ? 'famine' : 'drought' });
    immediateEffects.push('Food stores fall by 25% and farming productivity is reduced while the drought persists. Shortages can lead to price increases, unrest, and mortality.');
    assumptions.push(`The harvest penalty lasts ${duration(text)} years. Weather, prices, and population consequences remain engine-controlled.`);
    destructive = true;
  } else if (/\bdestroy\b/i.test(text) && /\bcity\b/i.test(text)) {
    const settlement = world.geography.settlements.find(item => clean(text).includes(clean(item.name))) || world.geography.settlements.find(item => item.civId === civs[0]?.id);
    if (!settlement) throw new Error('No settlement matches this city destruction.');
    action = `Destroy ${settlement.name}`;
    operations.push({ type: 'destroy-city', targetId: settlement.civId, value: settlement.id });
    targets.push(settlement.id);
    immediateEffects.push(`${settlement.name} loses its ${format(settlement.population)} residents; the destroyed site remains visible in geography and history.`);
    destructive = true;
  } else if (/\b(?:earthquake|tsunami|flood|volcan\w*|asteroid|wildfire|meteor)\b/i.test(text)) {
    const kind = text.match(/earthquake|tsunami|flood|volcan\w*|asteroid|wildfire|meteor|destroy (?:the |a )?city/i)?.[0]?.toLowerCase() || 'disaster';
    const casualtyShare = percent(text, /asteroid|destroy.*city/i.test(kind) ? .08 : .015);
    action = `Manifest ${kind}`;
    addForCivs('disaster', casualtyShare, { kind });
    civs.forEach(civ => immediateEffects.push(`${civ.name}: ${format(Math.round(civ.population * casualtyShare))} immediate casualties (${(casualtyShare * 100).toFixed(1)}%); food and treasury damage are recorded.`));
    assumptions.push('An unspecified impact affects the selected civilization. Casualties are bounded by its existing population.');
    destructive = true;
    if (/material|metal|resource|stronger than steel/i.test(text)) {
      addForCivs('resource', 'Celestial alloy', { stock: 15000, description: text });
      immediateEffects.push('The impact exposes a deposit of Celestial alloy, a new persistent resource.');
      assumptions.push('The newly exposed deposit contains 15,000 stock units; production begins at 200 units per year.');
    }
  } else if (/\b(?:rebellion|revolt|revolution|uprising|coup)\b/i.test(text)) {
    action = 'Spark a political rebellion';
    addForCivs('rebel', 32);
    immediateEffects.push('Government stability falls by 32 points and popular happiness by 18 points. A named rebel develops a goal to challenge the government.');
    assumptions.push('A rebellion begins as organized resistance. A civil war or regime change must follow from political conditions.');
    destructive = true;
  } else if (/\b(?:create|summon|introduce|add)\b/i.test(text) && /\b(?:person|prophet|genius|inventor|scholar|rebel leader|general|explorer|character)\b/i.test(text)) {
    const role = /prophet/i.test(text) ? 'Prophet' : /genius|inventor|scholar/i.test(text) ? 'Scholar' : /general/i.test(text) ? 'General' : /explorer/i.test(text) ? 'Explorer' : /rebel/i.test(text) ? 'Rebel' : 'Commoner';
    const ageMatch = text.match(/(?:age[d]?\s*|\b)(\d{1,3})[ -]years? old/i) || text.match(/aged?\s+(\d{1,3})/i);
    const age = ageMatch ? clamp(Number(ageMatch[1]), 0, 120) : 30;
    action = `Create a ${role.toLowerCase()}`;
    operations.push({ type: 'create-person', targetId: civs[0]?.id, value: personName(text), details: { role, age, description: text } });
    immediateEffects.push(`A living ${role.toLowerCase()}, age ${age}, enters ${civs[0]?.name ?? world.name} with memories, limited knowledge, personality, and goals.`);
    assumptions.push('The person is promoted from the statistical population; creating a named agent does not create an extra population cohort.');
  } else if (/\b(?:make|appoint|crown|install)\b/i.test(text) && /\b(?:ruler|king|queen|emperor|president|leader)\b/i.test(text)) {
    const subject = requirePerson();
    action = `Install ${subject.name} as ruler`;
    operations.push({ type: 'make-ruler', targetId: subject.id });
    immediateEffects.push(`${subject.name} becomes the ruler of their civilization. The predecessor remains alive with reduced political influence.`);
    destructive = true;
  } else if (/\b(?:personality|ambitious|cruel|kind|brave|coward|ruthless|pacifist|greedy|generous|paranoid|loyal|fearless|curious|intelligent|smart|calm|ambition|empathy|courage|rationality|religiosity|curiosity|greed|paranoia|discipline|loyalty|alter traits?)\b/i.test(text) && person) {
    const subject = requirePerson();
    const traits: Record<string, number> = {};
    const map: Record<string, [string, number]> = { ambitious: ['ambition', 95], cruel: ['empathy', 5], ruthless: ['empathy', 5], kind: ['empathy', 95], generous: ['empathy', 90], brave: ['courage', 95], fearless: ['courage', 100], coward: ['courage', 5], pacifist: ['empathy', 95], greedy: ['greed', 95], paranoid: ['paranoia', 95], calm: ['paranoia', 10], loyal: ['loyalty', 95], curious: ['curiosity', 95], intelligent: ['rationality', 95], smart: ['rationality', 90] };
    for (const [word, [key, value]] of Object.entries(map)) if (clean(text).includes(word)) traits[key] = value;
    for (const key of ['ambition', 'empathy', 'courage', 'rationality', 'religiosity', 'curiosity', 'greed', 'paranoia', 'discipline', 'loyalty']) {
      const explicit = text.match(new RegExp(`\\b${key}\\b\\s*(?:(?:to|at|=|:)\\s*)?(\\d+(?:\\.\\d+)?)`, 'i'));
      if (explicit) traits[key] = clamp(Number(explicit[1]));
    }
    action = `Alter the personality of ${subject.name}`;
    operations.push({ type: 'traits', targetId: subject.id, details: { traits, description: text } });
    immediateEffects.push(`${subject.name}'s decision-making traits change: ${Object.entries(traits).map(([key, value]) => `${key} → ${value}`).join(', ') || 'the requested personality becomes a persistent custom trait'}.`);
  } else if (/\b(?:relationship|rivalry|rivals?|friends?|marry|marriage|lovers?)\b/i.test(text) && people.length >= 2) {
    const [first, second] = people;
    if (!first.alive || !second.alive) throw new Error('A new active relationship requires two living characters.');
    const type = /rival/i.test(text) ? 'rival' : /marry|marriage/i.test(text) ? 'spouse' : /lover/i.test(text) ? 'lover' : 'friend';
    action = `Create a ${type} relationship`;
    operations.push({ type: 'relationship', targetId: first.id, value: second.id, details: { type } });
    targets.push(first.id, second.id);
    immediateEffects.push(`${first.name} and ${second.name} gain a reciprocal ${type} relationship. Later decisions may change trust and resentment.`);
  } else if (/\b(?:dreams?|warning|prophecy|grant knowledge|give .+? knowledge|divine message)\b/i.test(text) && person) {
    const subject = requirePerson();
    action = `Deliver knowledge to ${subject.name}`;
    operations.push({ type: 'knowledge', targetId: subject.id, value: text });
    immediateEffects.push(`${subject.name} receives the message as sourced personal knowledge and a memory. Their interpretation and response remain autonomous.`);
    assumptions.push('A prophecy or dream is a belief, not proof that its predicted future must occur.');
  } else if (/\b(?:religion|faith|religious movement|cult|followers believe|worship)\b/i.test(text)) {
    const name = personName(text) || (/two moons|moon/i.test(text) ? 'The Twin Moon Covenant' : 'The New Revelation');
    action = `Found ${name}`;
    operations.push({ type: 'religion', targetId: civs[0]?.id, value: name, details: { doctrine: text, deity: /two moons|moon/i.test(text) ? 'The twin moons' : 'The transcendent mystery' } });
    immediateEffects.push(`A new faith begins with up to 2% of ${civs[0]?.name ?? world.name}'s population, converted from its existing dominant religion.`);
    assumptions.push('The doctrine is preserved verbatim. Conversion transfers followers rather than creating additional people.');
  } else if (/\b(?:technology|electricity|gunpowder|printing|steam engine|artificial intelligence|quantum computing|computing|internet|radio|flight|research|knowledge|ironworking|steelworking|calculus|irrigation|mathematics|navigation)\b/i.test(text)) {
    const name = technologyName(text);
    const remove = /destroy|remove|forget|erase|lose knowledge/i.test(text);
    const all = remove && /all knowledge|all technolog|every technolog/i.test(text);
    const accelerate = /accelerat|research faster|speed.*research/i.test(text);
    action = remove ? all ? 'Erase all technological knowledge' : `Erase knowledge of ${name}` : accelerate ? 'Accelerate scientific research' : `Reveal ${name}`;
    addForCivs('technology', name, { remove, accelerate, all });
    immediateEffects.push(remove ? `The target civilizations lose ${all ? 'all currently known technologies' : name}; the history of previous discoveries remains.` : accelerate ? 'Research progress increases by 45 points; normal discovery validation still applies.' : `The selected civilizations gain ${name}, bypassing ordinary discovery prerequisites through divine intervention.`);
    destructive = remove;
  } else if (/\b(?:food|harvest|grain|crop yield)\b/i.test(text) && /\b(?:increase|boost|improve|reduce|decrease|multiply|grant|give)\b/i.test(text)) {
    const reduce = /reduce|decrease/i.test(text);
    const share = percent(text, .2);
    action = reduce ? 'Reduce food abundance' : 'Increase food abundance';
    addForCivs('harvest', reduce ? -share : share);
    civs.forEach(civ => immediateEffects.push(`${civ.name}: food security changes from ${civ.food.toFixed(2)} to ${clamp(civ.food * (1 + (reduce ? -share : share)), 0, 4).toFixed(2)}; grain stocks and production change by ${(share * 100).toFixed(1)}%.`));
    assumptions.push('The requested percentage changes the current food supply and annual grain production. Future demand, climate, and harvests remain simulated.');
    destructive = reduce;
  } else if (/\b(?:baby boom|population (?:growth|decline)|reduce population|increase population|migration|migrate)\b/i.test(text)) {
    const decline = /decline|reduce/i.test(text);
    const migration = /migrat/i.test(text);
    action = migration ? 'Move a population cohort' : decline ? 'Reduce population' : 'Create a baby boom';
    const share = percent(text, .08);
    if (migration) {
      const source = civs[0];
      const destination = civs[1] || world.civilizations.find(civ => civ.active && civ.id !== source?.id);
      if (!source || !destination) throw new Error('Migration requires a source and a different destination civilization.');
      operations.push({ type: 'migration', targetId: source.id, value: share, details: { destinationId: destination.id } });
      targets.push(destination.id);
      immediateEffects.push(`${format(Math.round(source.population * share))} people move from ${source.name} to ${destination.name}; world population is conserved.`);
      if (civs.length < 2) assumptions.push(`No destination was specified; use ${destination.name}.`);
    } else {
      addForCivs('population', decline ? -share : share);
      civs.forEach(civ => immediateEffects.push(`${civ.name}: population ${decline ? 'falls' : 'rises'} by ${format(Math.round(civ.population * share))}.`));
    }
    destructive = decline || migration;
  } else if (/\b(?:island|river|alter climate|change climate|warm climate|cold climate|resource deposit|expose .+? deposit)\b/i.test(text)) {
    const kind = /island/i.test(text) ? 'island' : /river/i.test(text) ? 'river' : /climate/i.test(text) ? 'climate' : 'resource';
    action = kind === 'resource' ? 'Expose a resource deposit' : `Alter geography: ${kind}`;
    if (kind === 'resource') addForCivs('resource', personName(text) || text.match(/(?:of|expose)\s+(iron|gold|coal|oil|copper|rare minerals|metal|stone)/i)?.[1] || 'Rare minerals', { stock: 15000 });
    else operations.push({ type: 'geography', targetId: civs[0]?.id, value: kind, details: { inhabited: /inhabit|isolated civilization/i.test(text), description: text, cooling: /cold|cool|ice/i.test(text) } });
    immediateEffects.push(kind === 'island' ? 'Ocean map cells become a new island; existing geography and history are preserved.' : kind === 'river' ? 'A new river is carved through the selected territory and soil quality improves.' : kind === 'climate' ? 'The climate productivity multiplier changes by 0.15, affecting future harvests.' : 'A resource deposit of 15,000 stock units begins producing 200 units per year.');
    if (kind === 'island' && /inhabit|isolated civilization/i.test(text)) {
      immediateEffects.push('An isolated civilization with 35,000 inhabitants, its own government, ruler, and settlement is established on the island.');
      assumptions.push('No founding population was supplied; use a 35,000-person aggregate cohort. Map distances are abstract rather than literal miles.');
    }
  } else {
    const kind = /dragons?/i.test(text) ? 'dragons' : /vampir/i.test(text) ? 'vampires' : /portal/i.test(text) ? 'portal' : /monolith/i.test(text) ? 'monolith' : /magic/i.test(text) ? 'magic' : /sun.*disappear|darkness|eclipse/i.test(text) ? 'darkness' : /monster|creature|alien|species/i.test(text) ? 'species' : /artifact/i.test(text) ? 'artifact' : 'phenomenon';
    action = `Introduce ${kind === 'phenomenon' ? 'a new reality' : kind}`;
    operations.push({ type: 'phenomenon', targetId: civs[0]?.id, value: kind, details: { description: text, durationYears: kind === 'darkness' ? duration(text, 36 / 8760) : undefined } });
    immediateEffects.push(`The full request becomes permanent world canon, tagged ${kind}. It remains available to future agents, rumors, research, and religious interpretation.`);
    if (kind === 'dragons' || kind === 'vampires' || kind === 'species') immediateEffects.push('An unfamiliar species becomes a recurring influence on security, culture, scholarship, and belief; subsequent consequences are calculated by the engine.');
    if (kind === 'portal') immediateEffects.push('A persistent cross-world passage creates future exploration and trade opportunities.');
    if (kind === 'darkness') immediateEffects.push(`Daylight is disrupted for ${Math.round(duration(text, 36 / 8760) * 8760)} hours; food stores incur a proportional, bounded loss.`);
    assumptions.push('Custom phenomena retain their exact description and arbitrary attributes. Recurring effects use the closest supported simulation system; unsupported physics remain documented canon.');
  }

  if (!operations.length) throw new Error('No viable target exists for that reality change.');
  return { id: `proposal-${world.id}-${world.tick}-${world.events.length}-${hashSeed(`${text}:${targetId ?? ''}`)}`, text, action, location, targets: [...new Set(targets)], immediateEffects, assumptions, destructive, operations, worldId: world.id, year: world.year + world.day / 365 };
}

/** All mutations are explicit, validated engine operations and are committed atomically. */
export function applyIntervention(original: World, proposal: InterventionProposal): World {
  if (proposal.worldId !== original.id) throw new Error('This proposal belongs to another world.');
  if (proposal.year !== original.year + original.day / 365) throw new Error('Time has advanced since this preview. Preview the change again against the current world.');
  if (original.canon.some(item => item.attributes?.proposalId === proposal.id)) throw new Error('This reality change has already been applied.');
  if (!proposal.operations.length || proposal.operations.length > 200) throw new Error('The proposed operation list is invalid.');
  const world = structuredClone(original);
  const changes: StateChange[] = [];
  const outcomes: string[] = [];
  const createdIds: string[] = [];
  const event = addEvent(world, { category: 'Environmental', severity: proposal.destructive ? 5 : 4, title: proposal.action, description: proposal.text, location: proposal.location, actors: proposal.targets.filter(id => world.characters.some(person => person.id === id)), factions: proposal.targets.filter(id => world.civilizations.some(civ => civ.id === id)), causes: [], tags: ['intervention', 'canon'], stateChanges: changes });
  const change = <T extends object, K extends keyof T>(id: string, entity: T, field: K, after: T[K]) => {
    const before = structuredClone(entity[field]);
    entity[field] = after;
    changes.push({ entityId: id, field: String(field), before, after: structuredClone(after) });
  };
  const civFor = (operation: InterventionOperation) => {
    const civ = world.civilizations.find(candidate => candidate.id === operation.targetId);
    if (!civ || !civ.active) throw new Error('An operation references a missing or collapsed civilization.');
    return civ;
  };
  const personFor = (operation: InterventionOperation) => {
    const person = world.characters.find(candidate => candidate.id === operation.targetId);
    if (!person || !person.alive) throw new Error('An operation references a missing or deceased person.');
    return person;
  };
  const numberFor = (operation: InterventionOperation, min: number, max: number) => {
    if (typeof operation.value !== 'number' || !Number.isFinite(operation.value) || operation.value < min || operation.value > max) throw new Error('A numerical operation is outside its supported bounds.');
    return operation.value;
  };
  const sharesFor = (civ: Civilization): Record<string, number> => {
    const raw = civ.attributes.religiousShares;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? structuredClone(raw as Record<string, number>) : { [civ.religionId]: .82 };
  };
  const createCharacter = (civ: Civilization, role: string, name?: string) => {
    const leader = world.characters.find(person => person.id === civ.leaderId);
    const previousRelationships = leader ? structuredClone(leader.relationships) : undefined;
    const previousAttributes = leader ? structuredClone(leader.attributes) : undefined;
    const previousSuccession = structuredClone(civ.succession);
    const created = makeCharacter(world, civ, role, name);
    if (leader && JSON.stringify(previousRelationships) !== JSON.stringify(leader.relationships)) changes.push({ entityId: leader.id, field: 'relationships', before: previousRelationships, after: structuredClone(leader.relationships) });
    if (leader && JSON.stringify(previousAttributes) !== JSON.stringify(leader.attributes)) changes.push({ entityId: leader.id, field: 'attributes', before: previousAttributes, after: structuredClone(leader.attributes) });
    if (JSON.stringify(previousSuccession) !== JSON.stringify(civ.succession)) changes.push({ entityId: civ.id, field: 'succession', before: previousSuccession, after: structuredClone(civ.succession) });
    return created;
  };

  for (const operation of proposal.operations) {
    switch (operation.type) {
      case 'kill': {
        const person = personFor(operation);
        const death = killCharacter(world, person, event.id, 'divine intervention');
        if (!event.relatedEvents.includes(death.id)) event.relatedEvents.push(death.id);
        outcomes.push(`${person.name} died by divine intervention.`);
        event.category = 'Personal';
        break;
      }
      case 'immortal': {
        const person = personFor(operation);
        const granted = operation.details?.granted !== false;
        change(person.id, person, 'attributes', { ...person.attributes, immortal: granted });
        change(person.id, person, 'tags', granted ? [...new Set([...person.tags, 'immortal'])] : person.tags.filter(tag => tag !== 'immortal'));
        change(person.id, person, 'traits', { ...person.traits, immortality: granted ? 100 : 0 });
        if (granted) change(person.id, person, 'health', 100);
        outcomes.push(`${person.name} ${granted ? 'became immortal' : 'became mortal again'}.`);
        event.category = 'Personal';
        break;
      }
      case 'plague': {
        const civ = civFor(operation);
        const fatality = numberFor(operation, 0, 1);
        const infected = Math.min(civ.population, Math.max(1, Math.round(civ.population * .005)));
        change(civ.id, civ, 'disease', { id: nextId(world, 'disease'), name: String(operation.details?.name || 'The Pale Fever'), infected, fatality, transmissibility: .75, immunity: 0, startedYear: world.year, causeEventId: event.id, deaths: 0 });
        outcomes.push(`${civ.name} recorded ${format(infected)} initial infections with ${(fatality * 100).toFixed(1)}% fatality.`);
        event.category = 'Biological';
        break;
      }
      case 'drought': {
        const civ = civFor(operation);
        const severity = numberFor(operation, 0, 1);
        change(civ.id, civ, 'food', Math.max(0, civ.food * .75));
        const years = Number(operation.details?.durationYears ?? 3);
        if (!Number.isFinite(years) || years <= 0 || years > 1000000) throw new Error('Invalid drought duration.');
        change(civ.id, civ, 'attributes', { ...civ.attributes, droughtUntil: world.year + years, droughtSeverity: severity, droughtEventId: event.id });
        outcomes.push(`${civ.name} entered a harvest crisis lasting ${years} years.`);
        event.category = 'Disaster';
        break;
      }
      case 'disaster': {
        const civ = civFor(operation);
        const casualties = Math.round(civ.population * numberFor(operation, 0, 1));
        change(civ.id, civ, 'population', Math.max(0, civ.population - casualties));
        change(civ.id, civ, 'food', Math.max(0, civ.food * .65));
        change(civ.id, civ, 'treasury', Math.max(0, civ.treasury * .8));
        change(civ.id, civ, 'happiness', clamp(civ.happiness - 20));
        change(civ.id, civ, 'stability', clamp(civ.stability - 12));
        change(civ.id, civ, 'military', Math.min(civ.population, Math.round(civ.military * (1 - casualties / Math.max(1, civ.population + casualties)))));
        if (civ.disease) change(civ.id, civ, 'disease', { ...civ.disease, infected: Math.min(civ.disease.infected, civ.population) });
        for (const settlement of world.geography.settlements.filter(item => item.civId === civ.id)) change(settlement.id, settlement, 'population', Math.min(settlement.population, Math.round(settlement.population * (1 - numberFor(operation, 0, 1)))));
        outcomes.push(`${format(casualties)} people died in ${civ.name}; food, treasury, and stability losses were recorded.`);
        event.category = 'Disaster';
        break;
      }
      case 'destroy-city': {
        const civ = civFor(operation);
        const settlement = world.geography.settlements.find(item => item.id === operation.value && item.civId === civ.id);
        if (!settlement) throw new Error('The target settlement no longer exists.');
        const casualties = Math.min(civ.population, settlement.population);
        change(settlement.id, settlement, 'population', 0);
        change(civ.id, civ, 'population', civ.population - casualties);
        change(civ.id, civ, 'military', Math.min(civ.military, civ.population));
        change(civ.id, civ, 'stability', clamp(civ.stability - 20));
        if (civ.disease) change(civ.id, civ, 'disease', { ...civ.disease, infected: Math.min(civ.disease.infected, civ.population) });
        outcomes.push(`${settlement.name} was destroyed; ${format(casualties)} deaths were deducted from ${civ.name}'s population.`);
        event.category = 'Disaster';
        break;
      }
      case 'rebel': {
        const civ = civFor(operation);
        change(civ.id, civ, 'stability', clamp(civ.stability - numberFor(operation, 0, 100)));
        change(civ.id, civ, 'happiness', clamp(civ.happiness - 18));
        const rebel = createCharacter(civ, 'Rebel');
        rebel.goals = [`Replace the government of ${civ.name}`, 'Organize people who share grievances'];
        rebel.traits.ambition = 90;
        rebel.memories.push({ eventId: event.id, year: world.year, description: 'A divine disturbance sparked organized resistance.', emotion: 'resolve' });
        if (!world.characters.some(person => person.id === rebel.id)) world.characters.push(rebel);
        createdIds.push(rebel.id);
        changes.push({ entityId: rebel.id, field: 'entity', before: null, after: structuredClone(rebel) });
        outcomes.push(`${rebel.name} organized resistance in ${civ.name}.`);
        event.category = 'Political';
        break;
      }
      case 'create-person': {
        const civ = civFor(operation);
        const person = createCharacter(civ, String(operation.details?.role || 'Commoner'), typeof operation.value === 'string' ? operation.value : undefined);
        const age = Number(operation.details?.age ?? 30);
        if (!Number.isFinite(age) || age < 0 || age > 120) throw new Error('A created person must have an age between 0 and 120.');
        person.age = age;
        person.bornYear = world.year - age;
        person.attributes.createdBy = 'intervention';
        person.attributes.originDescription = proposal.text;
        if (/immortal/i.test(proposal.text)) { person.attributes.immortal = true; person.tags.push('immortal'); }
        if (/genius/i.test(proposal.text)) { person.skills.scholarship = 98; person.traits.curiosity = 98; }
        person.memories.push({ eventId: event.id, year: world.year, description: 'Entered the historical record through divine intervention.', emotion: 'wonder' });
        if (!world.characters.some(candidate => candidate.id === person.id)) world.characters.push(person);
        createdIds.push(person.id);
        changes.push({ entityId: person.id, field: 'entity', before: null, after: structuredClone(person) });
        outcomes.push(`${person.name}, age ${age}, became a named ${person.role.toLowerCase()} in ${civ.name}.`);
        event.category = 'Personal';
        break;
      }
      case 'make-ruler': {
        const person = personFor(operation);
        const civ = world.civilizations.find(candidate => candidate.id === person.civId && candidate.active);
        if (!civ) throw new Error('The prospective ruler has no active civilization.');
        const old = world.characters.find(candidate => candidate.id === civ.leaderId);
        if (old && old.id !== person.id) { change(old.id, old, 'role', 'Former ruler'); change(old.id, old, 'influence', Math.min(old.influence, 55)); }
        change(civ.id, civ, 'leaderId', person.id);
        change(civ.id, civ, 'succession', civ.succession.filter(id => id !== person.id));
        change(person.id, person, 'role', 'Ruler');
        change(person.id, person, 'influence', 95);
        outcomes.push(`${person.name} became ruler of ${civ.name}.`);
        event.category = 'Political';
        break;
      }
      case 'traits': {
        const person = personFor(operation);
        const proposed = operation.details?.traits;
        if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) throw new Error('Invalid personality trait changes.');
        const valid: Record<string, number> = {};
        for (const [key, value] of Object.entries(proposed)) {
          if (!/^[a-z][a-z-]{0,40}$/i.test(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error('Personality traits must be numbers from 0 to 100.');
          valid[key] = value;
        }
        change(person.id, person, 'traits', { ...person.traits, ...valid });
        change(person.id, person, 'attributes', { ...person.attributes, personalityCanon: proposal.text });
        outcomes.push(`${person.name}'s personality was altered: ${Object.keys(valid).join(', ') || proposal.text}.`);
        event.category = 'Personal';
        break;
      }
      case 'relationship': {
        const person = personFor(operation);
        const other = personFor({ ...operation, targetId: String(operation.value) });
        if (person.id === other.id) throw new Error('A relationship requires two different people.');
        const type = String(operation.details?.type || 'friend');
        for (const [a, b] of [[person, other], [other, person]]) {
          const relationship = { characterId: b.id, type, affection: type === 'rival' ? 10 : 75, trust: type === 'rival' ? 15 : 70, fear: type === 'rival' ? 35 : 10, respect: 60, resentment: type === 'rival' ? 80 : 5, loyalty: type === 'rival' ? 5 : 70 };
          change(a.id, a, 'relationships', [...a.relationships.filter(item => item.characterId !== b.id), relationship]);
        }
        outcomes.push(`${person.name} and ${other.name} became ${type}s.`);
        event.category = 'Personal';
        break;
      }
      case 'knowledge': {
        const person = personFor(operation);
        const message = String(operation.value ?? proposal.text).slice(0, 4000);
        change(person.id, person, 'knowledge', [...person.knowledge, { id: nextId(world, 'knowledge'), topic: 'Divine message', belief: message, confidence: .85, source: 'personal divine experience', eventId: event.id, learnedYear: world.year, isRumor: false }]);
        change(person.id, person, 'thoughts', [message, ...person.thoughts].slice(0, 10));
        outcomes.push(`${person.name} received a sourced personal message.`);
        event.category = 'Personal';
        break;
      }
      case 'technology': {
        const civ = civFor(operation);
        const name = String(operation.value || '').trim();
        if (!name || name.length > 100) throw new Error('A technology requires a name of 1 to 100 characters.');
        if (operation.details?.accelerate) change(civ.id, civ, 'research', Math.max(0, civ.research + 45));
        else change(civ.id, civ, 'technologies', operation.details?.remove ? operation.details?.all ? [] : civ.technologies.filter(tech => clean(tech) !== clean(name)) : [...new Set([...civ.technologies, name])]);
        outcomes.push(`${civ.name}: ${operation.details?.accelerate ? 'research progressed by 45 points' : operation.details?.remove ? `${operation.details?.all ? 'All technologies' : name} were removed from current knowledge` : `${name} became known`}.`);
        event.category = 'Technological';
        break;
      }
      case 'religion': {
        const civ = civFor(operation);
        const previousFaith = world.religions.find(faith => faith.id === civ.religionId);
        const existingShares = civ.attributes.religiousShares;
        const shares: Record<string, number> = existingShares && typeof existingShares === 'object' && !Array.isArray(existingShares) ? { ...existingShares as Record<string, number> } : { [civ.religionId]: clamp((previousFaith?.followers ?? 0) / Math.max(1, civ.population), 0, 1) };
        const followers = Math.min(Math.round(civ.population * .02), Math.floor(civ.population * Number(shares[civ.religionId] ?? 0)), previousFaith?.followers ?? 0);
        if (previousFaith) change(previousFaith.id, previousFaith, 'followers', previousFaith.followers - followers);
        const faith = { id: nextId(world, 'religion'), name: String(operation.value || 'The New Revelation').slice(0, 100), origin: `Divine intervention in ${civ.name}`, deity: String(operation.details?.deity || 'The transcendent mystery'), doctrines: [String(operation.details?.doctrine || proposal.text)], rituals: ['Gatherings to interpret the founding revelation'], holyText: 'The Founding Revelation', clergy: 'A council of interpreters', followers, influence: 15, denominations: [], foundedYear: world.year, tags: ['user-created', 'intervention'] };
        world.religions.push(faith);
        const convertedShare = followers / Math.max(1, civ.population);
        shares[civ.religionId] = Math.max(0, (shares[civ.religionId] ?? 0) - convertedShare);
        shares[faith.id] = convertedShare;
        change(civ.id, civ, 'attributes', { ...civ.attributes, religiousShares: shares });
        createdIds.push(faith.id);
        changes.push({ entityId: faith.id, field: 'entity', before: null, after: structuredClone(faith) });
        outcomes.push(`${faith.name} formed with ${format(followers)} converts in ${civ.name}.`);
        event.category = 'Religious';
        break;
      }
      case 'population': {
        const civ = civFor(operation);
        const delta = Math.round(civ.population * numberFor(operation, -1, 1));
        change(civ.id, civ, 'population', Math.max(0, civ.population + delta));
        change(civ.id, civ, 'military', Math.min(civ.military, civ.population));
        if (civ.disease) change(civ.id, civ, 'disease', { ...civ.disease, infected: Math.min(civ.disease.infected, civ.population) });
        outcomes.push(`${civ.name} population changed by ${delta >= 0 ? '+' : ''}${format(delta)}.`);
        event.category = 'Demographic';
        break;
      }
      case 'harvest': {
        const civ = civFor(operation);
        const factor = 1 + numberFor(operation, -1, 1);
        change(civ.id, civ, 'food', clamp(civ.food * factor, 0, 4));
        change(civ.id, civ, 'attributes', { ...civ.attributes, harvestMultiplier: clamp(Number(civ.attributes.harvestMultiplier ?? 1) * factor, 0, 4) });
        const resources = structuredClone(civ.resources);
        for (const resource of resources.filter(item => /grain|food/i.test(item.name))) { resource.stock = Math.max(0, resource.stock * factor); resource.production = Math.max(0, resource.production * factor); }
        change(civ.id, civ, 'resources', resources);
        outcomes.push(`${civ.name}'s food security became ${civ.food.toFixed(2)}; grain supply changed by ${((factor - 1) * 100).toFixed(1)}%.`);
        event.category = 'Economic';
        break;
      }
      case 'migration': {
        const civ = civFor(operation);
        const destination = civFor({ ...operation, targetId: String(operation.details?.destinationId) });
        if (civ.id === destination.id) throw new Error('Migration destination must differ from its source.');
        const migrants = Math.round(civ.population * numberFor(operation, 0, 1));
        const sourceShares = sharesFor(civ);
        const destinationShares = sharesFor(destination);
        const destinationPopulation = destination.population;
        const blended: Record<string, number> = {};
        for (const id of new Set([...Object.keys(sourceShares), ...Object.keys(destinationShares)])) blended[id] = (destinationPopulation * Number(destinationShares[id] ?? 0) + migrants * Number(sourceShares[id] ?? 0)) / Math.max(1, destinationPopulation + migrants);
        change(civ.id, civ, 'population', civ.population - migrants);
        change(destination.id, destination, 'population', destination.population + migrants);
        if (civ.population === 0) change(civ.id, civ, 'attributes', { ...civ.attributes, evacuatedTo: destination.id });
        change(destination.id, destination, 'attributes', { ...destination.attributes, religiousShares: blended });
        change(civ.id, civ, 'military', Math.min(civ.military, civ.population));
        if (civ.disease) change(civ.id, civ, 'disease', { ...civ.disease, infected: Math.min(civ.disease.infected, civ.population) });
        outcomes.push(`${format(migrants)} people migrated from ${civ.name} to ${destination.name}.`);
        event.category = 'Demographic';
        break;
      }
      case 'resource': {
        const civ = civFor(operation);
        const name = titleCase(String(operation.value || 'Rare minerals')).slice(0, 100);
        const stock = Number(operation.details?.stock ?? 15000);
        if (!Number.isFinite(stock) || stock < 0 || stock > 1e12) throw new Error('Invalid resource deposit size.');
        const existing = civ.resources.find(resource => clean(resource.name) === clean(name));
        const resources = structuredClone(civ.resources);
        if (existing) { const resource = resources.find(item => item.name === existing.name)!; resource.stock += stock; resource.production += 200; }
        else resources.push({ name, stock, production: 200, demand: 50, price: 8 });
        change(civ.id, civ, 'resources', resources);
        const deposit = world.geography.cells.find(cell => cell.civId === civ.id && cell.biome === 'mountains') || world.geography.cells.find(cell => cell.civId === civ.id);
        if (deposit) change(`cell-${deposit.x}-${deposit.y}`, deposit, 'resource', name);
        outcomes.push(`${civ.name} gained ${format(stock)} units of ${name}.`);
        event.category = 'Economic';
        break;
      }
      case 'geography': {
        const civ = civFor(operation);
        const kind = operation.value;
        if (kind === 'climate') { change(civ.id, civ, 'climate', clamp(civ.climate + (operation.details?.cooling ? -.15 : .15), .05, 2.5)); outcomes.push(`${civ.name}'s climate productivity multiplier became ${civ.climate.toFixed(2)}.`); }
        else if (kind === 'river') {
          const cells = world.geography.cells.filter(cell => cell.civId === civ.id && cell.biome !== 'ocean');
          const x = world.geography.settlements.find(settlement => settlement.civId === civ.id)?.x ?? cells[0]?.x;
          for (const cell of cells.filter(cell => Math.abs(cell.x - Number(x)) < 1.5)) change(`cell-${cell.x}-${cell.y}`, cell, 'biome', 'river');
          change(civ.id, civ, 'soil', clamp(civ.soil + .15, .05, 2.5));
          outcomes.push(`A river appeared in ${civ.name} and soil quality improved.`);
        } else if (kind === 'island') {
          const origin = world.geography.settlements.find(settlement => settlement.civId === civ.id);
          const ocean = world.geography.cells.filter(cell => cell.biome === 'ocean').sort((a, b) => Math.abs(a.x - Math.max(2, (origin?.x || 10) - 8)) + Math.abs(a.y - (origin?.y || 10)) - Math.abs(b.x - Math.max(2, (origin?.x || 10) - 8)) - Math.abs(b.y - (origin?.y || 10)));
          const center = ocean[0];
          if (!center) throw new Error('No ocean cells remain in which to create an island.');
          const island = ocean.filter(cell => Math.hypot(cell.x - center.x, cell.y - center.y) < 2.2);
          for (const cell of island) { change(`cell-${cell.x}-${cell.y}`, cell, 'biome', 'plains'); change(`cell-${cell.x}-${cell.y}`, cell, 'elevation', .65); }
          if (operation.details?.inhabited) {
            const id = nextId(world, 'civ');
            const name = 'The Western Enclave';
            const religiousShares = civ.attributes.religiousShares && typeof civ.attributes.religiousShares === 'object' && !Array.isArray(civ.attributes.religiousShares) ? structuredClone(civ.attributes.religiousShares as Record<string, number>) : { [civ.religionId]: 1 };
            const enclave: Civilization = { ...structuredClone(civ), id, name, capital: 'Haven', color: '#c899dd', population: 35000, government: 'tribal council', leaderId: '', territory: island.length, food: 1.2, treasury: 16000, military: 1050, happiness: 65, stability: 75, dynasty: 'House of Haven', succession: [], technologies: ['Agriculture', 'Pottery', 'Writing'], research: 0, debt: 0, disease: undefined, active: true, groups: civ.groups.map(group => ({ ...group, id: nextId(world, 'group') })), relations: [], resources: civ.resources.map(resource => ({ ...resource, stock: 1000, production: 80, demand: 50 })), culture: { ...structuredClone(civ.culture), language: 'Havenic', values: ['Isolation', 'Kinship'], customs: ['Ocean vigils'] }, attributes: { origin: proposal.text, isolated: true, religiousShares }, collapsedYear: undefined };
            const ruler = createCharacter(enclave, 'Ruler');
            enclave.leaderId = ruler.id;
            world.civilizations.push(enclave);
            if (!world.characters.some(person => person.id === ruler.id)) world.characters.push(ruler);
            const settlement = { id: nextId(world, 'settlement'), name: 'Haven', x: center.x, y: center.y, civId: id, population: 8000 };
            world.geography.settlements.push(settlement);
            for (const cell of island) change(`cell-${cell.x}-${cell.y}`, cell, 'civId', id);
            createdIds.push(id, ruler.id, settlement.id);
            changes.push({ entityId: id, field: 'entity', before: null, after: structuredClone(enclave) }, { entityId: ruler.id, field: 'entity', before: null, after: structuredClone(ruler) }, { entityId: settlement.id, field: 'entity', before: null, after: structuredClone(settlement) });
            for (const [faithId, share] of Object.entries(religiousShares)) {
              const religion = world.religions.find(faith => faith.id === faithId);
              if (religion) change(religion.id, religion, 'followers', religion.followers + Math.round(enclave.population * Number(share)));
            }
            outcomes.push(`${name} was founded on the new island with 35,000 inhabitants.`);
          } else outcomes.push(`A new island formed from ${island.length} ocean map cells.`);
        } else throw new Error('Unknown geography operation.');
        event.category = 'Environmental';
        break;
      }
      case 'phenomenon': {
        const kind = String(operation.value || 'phenomenon');
        const civ = operation.targetId ? civFor(operation) : undefined;
        if (kind === 'darkness' && civ) {
          const years = Number(operation.details?.durationYears ?? 36 / 8760);
          if (!Number.isFinite(years) || years <= 0) throw new Error('Invalid darkness duration.');
          change(civ.id, civ, 'food', Math.max(0, civ.food * (1 - Math.min(.9, years * .15))));
          change(civ.id, civ, 'attributes', { ...civ.attributes, darknessUntil: world.year + years });
        }
        if (civ) change(civ.id, civ, 'attributes', { ...civ.attributes, phenomena: [...new Set([...(Array.isArray(civ.attributes.phenomena) ? civ.attributes.phenomena : []), kind])] });
        outcomes.push(`Persistent canon established: ${proposal.text}`);
        break;
      }
      default: throw new Error(`Unsupported intervention operation: ${operation.type}`);
    }
  }

  for (const civ of world.civilizations.filter(civ => civ.population === 0 && civ.active)) {
    change(civ.id, civ, 'active', false);
    const evacuated = typeof civ.attributes.evacuatedTo === 'string';
    change(civ.id, civ, 'government', evacuated ? 'Diaspora' : 'Extinct');
    change(civ.id, civ, 'collapsedYear', world.year);
    for (const settlement of world.geography.settlements.filter(item => item.civId === civ.id)) change(settlement.id, settlement, 'population', 0);
    for (const person of world.characters.filter(candidate => candidate.alive && candidate.civId === civ.id)) {
      if (evacuated) change(person.id, person, 'attributes', { ...person.attributes, refugeeIn: civ.attributes.evacuatedTo });
      else {
        const death = killCharacter(world, person, event.id, 'the extinction of their civilization');
        if (!event.relatedEvents.includes(death.id)) event.relatedEvents.push(death.id);
      }
    }
    outcomes.push(evacuated ? `${civ.name}'s population emigrated. Named citizens remain alive as refugees, and the empty government becomes a diaspora.` : `${civ.name} became extinct. All named lives ended; their historical records remain.`);
  }
  const faithCensus = Object.fromEntries(world.religions.map(faith => [faith.id, 0]));
  for (const civ of world.civilizations) {
    const shares = sharesFor(civ);
    const totalShare = Object.values(shares).reduce((sum, share) => sum + (Number.isFinite(share) ? Math.max(0, share) : 0), 0);
    for (const [id, share] of Object.entries(shares)) if (id in faithCensus && Number.isFinite(share)) faithCensus[id] += Math.floor(civ.population * Math.max(0, share) / Math.max(1, totalShare));
  }
  for (const faith of world.religions) if (faith.followers !== faithCensus[faith.id]) change(faith.id, faith, 'followers', faithCensus[faith.id]);

  event.stateChanges = changes;
  event.effects = outcomes;
  event.description = `${proposal.text}\n\nRecorded consequences: ${outcomes.join(' ')}`;
  const kinds = proposal.operations.map(operation => String(operation.type === 'phenomenon' ? operation.value : operation.type));
  event.tags = [...new Set([...event.tags, ...kinds, ...(kinds.includes('rebel') ? ['rebellion', 'unrest'] : []), ...(kinds.includes('plague') ? ['disease'] : []), ...(kinds.includes('drought') ? ['disaster'] : [])])];
  const canon = { id: nextId(world, 'canon'), description: proposal.text, year: world.year, origin: 'intervention' as const, facts: outcomes, disputedFacts: /dream|prophecy|warning/i.test(proposal.text) ? ['The predicted future is not yet established.'] : [], entityIds: [...new Set([...proposal.targets, ...createdIds])], tags: [...new Set(['intervention', ...kinds])], attributes: { proposalId: proposal.id, eventId: event.id, kinds, targetIds: proposal.targets, introducedYear: world.year, nextInteractionYear: world.year + 1, operations: structuredClone(proposal.operations) } };
  world.canon.push(canon);
  changes.push({ entityId: canon.id, field: 'entity', before: null, after: structuredClone(canon) });
  const population = world.civilizations.reduce((sum, civ) => sum + civ.population, 0);
  world.populationHistory.push({ year: world.year + world.day / 365, population, civilizations: Object.fromEntries(world.civilizations.map(civ => [civ.id, civ.population])) });
  world.updatedAt = new Date().toISOString();
  return validateWorld(world);
}

function eventEvidence(events: HistoryEvent[]) {
  return events.map(event => `Year ${Math.floor(event.year).toLocaleString('en-US')}: ${event.title} [${event.id}]`);
}

/** Retrieval over measured reality and the event ledger. Unrecorded facts are never invented. */
export function askWorld(world: World, question: string): WorldAnswer {
  const text = question.trim();
  if (!text || text.length > 2000) throw new Error('Ask a question using between 1 and 2,000 characters.');
  const q = clean(text);
  const civs = mentionedCivilizations(world, text);
  const people = mentionedPeople(world, text);
  const roleWord = text.match(/\b(?:king|queen|ruler|emperor|president|current leader|monarch)\b/i);
  if (roleWord && !people.some(candidate => world.civilizations.some(civ => civ.leaderId === candidate.id))) {
    const homeland = civs[0] || world.civilizations.find(civ => civ.id === people[0]?.civId) || world.civilizations.find(civ => civ.active);
    const leader = world.characters.find(candidate => candidate.id === homeland?.leaderId);
    if (leader) {
      const namedPosition = people[0] ? clean(text).indexOf(clean(people[0].name).split(' ')[0]) : -1;
      if (namedPosition === -1 || (roleWord.index ?? 0) < namedPosition) people.unshift(leader);
      else people.push(leader);
    }
  }
  const person = people[0];
  const active = world.civilizations.filter(civ => civ.active);
  let facts: string[] = [];
  let evidence: HistoryEvent[] = [];
  let answer = '';
  const relatedTo = (ids: string[]) => world.events.filter(event => event.actors.some(id => ids.includes(id)) || event.factions.some(id => ids.includes(id)) || event.stateChanges.some(change => ids.includes(change.entityId)));

  if (/powerful|influential|strongest person/.test(q)) {
    const living = world.characters.filter(candidate => candidate.alive).sort((a, b) => b.influence - a.influence);
    const powerful = living[0];
    if (powerful) {
      const civ = world.civilizations.find(candidate => candidate.id === powerful.civId);
      facts = [`${powerful.name}: political influence ${powerful.influence.toFixed(0)}/100; ${powerful.role} in ${civ?.name ?? 'an unknown civilization'}.`, ...living.slice(1, 4).map(candidate => `${candidate.name}: influence ${candidate.influence.toFixed(0)}/100.`)];
      evidence = relatedTo([powerful.id]).slice(-5);
      answer = `${powerful.name} has the highest recorded political influence among living named characters. This compares influence, rather than claiming total power over every social group.\n\n${facts.join('\n')}`;
    }
  } else if (/technolog|advanced|research/.test(q) && !/why|caus|discover/.test(q)) {
    const ranked = (civs.length ? civs : active).slice().sort((a, b) => b.technologies.length - a.technologies.length || b.literacy - a.literacy);
      facts = ranked.map(civ => `${civ.name}: ${civ.technologies.length} known technologies, ${(civ.literacy * 100).toFixed(1)}% literacy; ${civ.technologies.join(', ')}.`);
    evidence = world.events.filter(event => event.category === 'Technological' && (!civs.length || event.factions.some(id => civs.some(civ => civ.id === id)))).slice(-6);
    answer = `${ranked[0]?.name ?? 'No active civilization'} leads this comparison by the number of currently known technologies, with literacy used to break ties.\n\n${facts.join('\n')}`;
  } else if (/peasant|commoner|angry|unrest|unhappy|rebell/.test(q) && !person) {
    facts = (civs.length ? civs : active).map(civ => {
      const commoners = civ.groups.filter(group => /peasant|commoner|worker|farmer/i.test(group.name));
      return `${civ.name}: happiness ${civ.happiness.toFixed(1)}/100; stability ${civ.stability.toFixed(1)}/100; tax ${(civ.taxRate * 100).toFixed(1)}%; food security index ${civ.food.toFixed(2)} (1.00 meets annual needs); ${commoners.map(group => `${group.name} happiness ${group.happiness.toFixed(1)}/100`).join('; ')}.`;
    });
    evidence = world.events.filter(event => /unrest|rebel|harvest|tax|shortage|crackdown|drought|food|protest/i.test(`${event.title} ${event.description}`) && (!civs.length || event.factions.some(id => civs.some(civ => civ.id === id)))).slice(-8);
    answer = `The measurable pressures on common people are listed below. Recorded events establish which pressures actually occurred; low metrics alone do not prove an undocumented cause.\n\n${facts.join('\n')}`;
  } else if (/war|battle|conflict/.test(q)) {
    const interval = text.match(/(?:last|past)\s+(\d+(?:\.\d+)?)\s*years?/i);
    const from = interval ? world.year - Number(interval[1]) : -Infinity;
    const wars = world.wars.filter(war => (war.active || (war.endedYear ?? war.startedYear) >= from) && (!civs.length || war.participants.some(id => civs.some(civ => civ.id === id))));
    const latest = wars.at(-1);
    facts = wars.slice(-8).map(war => `${war.name}: ${war.active ? 'active' : `ended in Year ${Math.floor(war.endedYear ?? world.year)}`}; stated cause: ${war.cause}; casualties ${format(war.casualties)}.`);
    if (latest) {
      const ids = new Set([latest.causeEventId, ...latest.battles]);
      evidence = world.events.filter(event => ids.has(event.id) || event.tags.includes(latest.id) || event.title.includes(latest.name)).slice(-12);
      const causes = evidence.flatMap(event => event.causes);
      evidence = [...world.events.filter(event => causes.includes(event.id)), ...evidence];
    }
    answer = wars.length ? `${facts.join('\n')}\n\nThe cited ledger entries describe declared causes and recorded battles. Casualties are accumulated by the engine.` : 'No war matching this question exists in the stored world history.';
  } else if (person) {
    const civ = world.civilizations.find(candidate => candidate.id === person.civId);
    facts = [`${person.name}: ${person.alive ? `alive, age ${person.age.toFixed(1)}` : `died in Year ${Math.floor(person.deathYear ?? world.year)}`}; ${person.role} of ${civ?.name ?? 'an unknown civilization'}.`];
    if (/hate|rival|relationship|trust|love/.test(q)) {
      const other = people[1];
      const relations = person.relationships.filter(relationship => !other || relationship.characterId === other.id);
      facts.push(...relations.map(relationship => `${world.characters.find(candidate => candidate.id === relationship.characterId)?.name ?? relationship.characterId}: ${relationship.type}; trust ${relationship.trust.toFixed(0)}, resentment ${relationship.resentment.toFixed(0)}, affection ${relationship.affection.toFixed(0)}.`));
      if (!relations.length) facts.push('No matching relationship has been recorded.');
      evidence = relatedTo([person.id]).filter(event => !other || event.actors.includes(other.id)).slice(-8);
    } else if (/think|thought|plan|want|goal|fear|decid/.test(q)) {
      facts.push(`Recorded thoughts: ${person.thoughts.join(' ') || 'None recorded.'}`, `Goals: ${person.goals.join('; ')}.`, `Fears: ${person.fears.join('; ')}.`);
      facts.push(...person.plans.slice(-3).map(plan => `${plan.executed ? 'Executed' : 'Considering'} ${plan.action}: ${plan.reason}.`));
      const sourceIds = person.knowledge.map(knowledge => knowledge.eventId).filter(Boolean);
      evidence = world.events.filter(event => sourceIds.includes(event.id) || person.memories.some(memory => memory.eventId === event.id)).slice(-8);
    } else {
      facts.push(`Traits: ${Object.entries(person.traits).map(([key, value]) => `${key} ${value.toFixed(0)}`).join(', ')}.`, `Goals: ${person.goals.join('; ')}.`, `Known information: ${person.knowledge.length} sourced beliefs, ${person.knowledge.filter(knowledge => knowledge.isRumor).length} rumors.`);
      evidence = relatedTo([person.id]).slice(-10);
    }
    answer = `${facts.join('\n')}\n\n${/why|cause/.test(q) && !evidence.length ? 'The ledger contains no supporting event for the requested explanation. I cannot establish an unrecorded motive.' : 'These observations come from the character record. Their beliefs may differ from reality; their thoughts do not reveal unobserved events.'}`;
  } else if (/religion|faith|schism|split|solar|moon/.test(q)) {
    const named = world.religions.filter(faith => q.includes(clean(faith.name)));
    const religions = named.length ? named : world.religions;
    facts = religions.map(faith => `${faith.name}: ${format(faith.followers)} followers; founded Year ${Math.floor(faith.foundedYear)}; doctrine: ${faith.doctrines.join('; ')}; denominations: ${faith.denominations.join(', ') || 'none recorded'}.`);
    evidence = world.events.filter(event => event.category === 'Religious' && (!named.length || named.some(faith => `${event.title} ${event.description}`.includes(faith.name)))).slice(-10);
    answer = `${facts.join('\n')}\n\nReligious claims are stored doctrines, rather than verified physical facts. The ledger below records observed conversions and schisms.`;
  } else if (/canon|dragon|vampire|monolith|portal|magic|unusual/.test(q)) {
    const items = world.canon.filter(item => !/dragon|vampire|monolith|portal|magic/.test(q) || item.tags.some(tag => q.includes(tag)) || clean(item.description).split(' ').some(word => word.length > 5 && q.includes(word)));
    facts = items.map(item => `Year ${Math.floor(item.year)}: ${item.description} Facts: ${item.facts.join(' ')}${item.disputedFacts.length ? ` Disputed: ${item.disputedFacts.join(' ')}` : ''}`);
    const ids = items.map(item => item.attributes?.eventId).filter(Boolean);
    evidence = world.events.filter(event => ids.includes(event.id) || event.tags.some(tag => items.some(item => item.tags.includes(tag) && !['intervention', 'canon', 'emergent'].includes(tag)))).slice(-12);
    answer = items.length ? facts.join('\n\n') : 'No matching world canon has been introduced. The simulator cannot infer an entity that is absent from its records.';
  } else if (/why|caus|happen|explain/.test(q) && !/last|past|years|history/.test(q)) {
    const words = q.split(' ').filter(word => word.length > 3 && !['what', 'this', 'that', 'happen', 'happened', 'explain', 'caused', 'cause', 'does', 'there', 'which'].includes(word));
    const ranked = world.events.map(event => ({ event, score: words.reduce((sum, word) => sum + (clean(`${event.title} ${event.description}`).includes(word) ? 1 : 0), 0) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.event.timestamp - a.event.timestamp);
    const latest = ranked[0]?.event || world.events.at(-1);
    if (latest) {
      const ids = new Set<string>([latest.id]);
      const visit = (event: HistoryEvent, depth: number) => {
        if (depth > 8) return;
        for (const id of event.causes) { if (ids.has(id)) continue; ids.add(id); const parent = world.events.find(candidate => candidate.id === id); if (parent) visit(parent, depth + 1); }
      };
      visit(latest, 0);
      evidence = world.events.filter(event => ids.has(event.id));
      facts = evidence.map(event => `${event.title}: ${event.description}`);
      answer = `The stored causal chain for “${latest.title}” contains ${evidence.length} event${evidence.length === 1 ? '' : 's'}.\n\n${facts.join('\n\n')}\n\nOnly explicit cause links were followed; the explanation does not add unstored causal claims.`;
    }
  } else {
    const years = text.match(/(?:last|past)\s+(\d+(?:\.\d+)?)\s*years?/i);
    const fromYear = years ? world.year - Number(years[1]) : -Infinity;
    evidence = world.events.filter(event => event.year >= fromYear && (!civs.length || event.factions.some(id => civs.some(civ => civ.id === id)))).filter(event => event.severity >= 3).slice(-14);
    facts = (civs.length ? civs : active).map(civ => `${civ.name}: population ${format(civ.population)}, ${civ.government}, ruler ${world.characters.find(candidate => candidate.id === civ.leaderId)?.name ?? 'none recorded'}, treasury ${format(civ.treasury)}, stability ${civ.stability.toFixed(1)}/100.`);
    answer = `The world is in Year ${Math.floor(world.year).toLocaleString('en-US')}. ${active.length} civilizations are active; ${world.wars.filter(war => war.active).length} wars are ongoing.\n\n${facts.join('\n')}\n\n${years ? `Major events in the requested ${years[1]}-year interval:` : 'Recent major events:'}`;
  }
  if (/why|caus/i.test(q) && evidence.length) {
    const seen = new Set(evidence.map(event => event.id));
    const frontier = [...evidence];
    for (let index = 0; index < frontier.length && index < 100; index++) {
      for (const id of frontier[index].causes) {
        if (seen.has(id)) continue;
        const cause = world.events.find(event => event.id === id);
        if (cause) { seen.add(id); frontier.push(cause); evidence.push(cause); }
      }
    }
  }
  const uniqueEvidence = [...new Map(evidence.map(event => [event.id, event])).values()].sort((a, b) => a.timestamp - b.timestamp);
  if (!answer) answer = 'There is not enough recorded information to answer this question. Try naming a civilization, person, war, religion, or event.';
  if (uniqueEvidence.length) answer += `\n\nEvidence:\n${eventEvidence(uniqueEvidence).join('\n')}`;
  return { answer, sources: uniqueEvidence.map(event => event.id), mode: 'local', facts };
}
