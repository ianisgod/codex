import type { Character, Civilization, DecisionOption, HistoryEvent, Intention, Knowledge, Relationship, World } from './types';
import { addEvent, clamp, nextId, random } from './utils';

const givenNames = ['Aela', 'Darin', 'Mira', 'Teren', 'Sorin', 'Elara', 'Vey', 'Oren', 'Nara', 'Thalen', 'Iria', 'Kael', 'Sella', 'Ren', 'Liora', 'Jorin'];
const familyNames = ['Ash', 'Vale', 'Renn', 'Mar', 'Sol', 'Reed', 'Toll', 'Dawn', 'Venn', 'Stone', 'Kest', 'Aster'];
const rulerRole = /ruler|king|queen|monarch|emperor|president|consul|sovereign/i;
const heirRole = /heir|prince|princess/i;
const militaryRole = /general|commander|soldier/i;
const clericalRole = /priest|cleric|clergy|prophet/i;
const scholarlyRole = /scholar|scientist|inventor/i;
const monarchic = (civ: Civilization) => /monarch|king|dynast|empire/i.test(civ.government);
const calendar = (world: World) => world.year + world.day / 365;
const round = (value: number) => Math.round(value * 100) / 100;
const supplyScore = (civ: Civilization) => clamp(civ.food * 60, 0, 100);
const immortal = (person: Character) => person.traits.immortality >= 100 || person.attributes.immortal === true || person.tags.includes('immortal');
const deferredEpochSuccession = new WeakSet<World>();

function relationship(person: Character, otherId: string, type = 'acquaintance'): Relationship {
  let found = person.relationships.find(item => item.characterId === otherId);
  if (!found) {
    found = { characterId: otherId, type, affection: 40, trust: 45, fear: 5, respect: 45, resentment: 5, loyalty: 35 };
    person.relationships.push(found);
  }
  return found;
}

function learn(world: World, person: Character, topic: string, belief: string, perceived: number | undefined, source: string, eventId?: string, isRumor = false): Knowledge {
  const item: Knowledge = {
    id: nextId(world, 'knowledge'), topic, belief, perceived, confidence: isRumor ? 0.42 : 0.87,
    source, eventId, learnedYear: world.year, isRumor,
  };
  person.knowledge.push(item);
  if (person.knowledge.length > 48) person.knowledge.splice(0, person.knowledge.length - 48);
  return item;
}

function linkFamily(parent: Character, child: Character) {
  const children = Array.isArray(parent.attributes.childIds) ? parent.attributes.childIds as string[] : [];
  if (!children.includes(child.id)) children.push(child.id);
  parent.attributes.childIds = children;
  child.attributes.parentIds = [parent.id];
  Object.assign(relationship(parent, child.id, 'child'), { type: 'child', affection: 88, trust: 74, respect: 65, loyalty: 85 });
  Object.assign(relationship(child, parent.id, 'parent'), { type: 'parent', affection: 83, trust: 78, respect: 87, loyalty: 82 });
}

/** Characters own imperfect knowledge. No world-state mutation is implied by a thought. */
export function makeCharacter(world: World, civ: Civilization, role: string, name?: string): Character {
  const leader = world.characters.find(person => person.id === civ.leaderId && person.alive);
  const isHeir = heirRole.test(role);
  const age = isHeir ? 18 + Math.floor(random(world) * 9) : rulerRole.test(role) ? 42 + Math.floor(random(world) * 16) : 22 + Math.floor(random(world) * 33);
  const traits: Record<string, number> = {};
  for (const trait of ['ambition', 'loyalty', 'empathy', 'courage', 'rationality', 'religiosity', 'curiosity', 'greed', 'paranoia', 'discipline']) traits[trait] = 25 + Math.floor(random(world) * 60);
  if (scholarlyRole.test(role)) { traits.curiosity = 82; traits.rationality = 78; }
  if (clericalRole.test(role)) traits.religiosity = 90;
  if (militaryRole.test(role)) { traits.courage = 85; traits.discipline = 80; }
  if (world.attributes.immortality === true || (/immortal/i.test(world.unusual) && (!/ruler/i.test(world.unusual) || rulerRole.test(role)))) traits.immortality = 100;
  const person: Character = {
    id: nextId(world, 'char'), name: name || `${givenNames[Math.floor(random(world) * givenNames.length)]} ${familyNames[Math.floor(random(world) * familyNames.length)]}`,
    civId: civ.id, role, age: isHeir && leader && leader.age >= 34 ? Math.min(age, leader.age - 18) : age, alive: true,
    traits, goals: [], beliefs: [], fears: [], knowledge: [], memories: [], relationships: [], thoughts: [], plans: [],
    health: 78 + Math.floor(random(world) * 22), influence: rulerRole.test(role) ? 92 : isHeir ? 65 : militaryRole.test(role) ? 72 : 20 + Math.floor(random(world) * 45),
    wealth: rulerRole.test(role) ? 85 : /merchant/i.test(role) ? 72 : 8 + Math.floor(random(world) * 34),
    bornYear: world.year - age, sex: random(world) > 0.5 ? 'Female' : 'Male', culture: civ.culture.language,
    socialClass: rulerRole.test(role) || isHeir ? 'Nobility' : /farmer|artisan/i.test(role) ? 'Commoner' : 'Professional',
    dynasty: rulerRole.test(role) || isHeir ? civ.dynasty : undefined,
    publicPosition: role, skills: { leadership: 35 + Math.floor(random(world) * 50), diplomacy: 25 + Math.floor(random(world) * 55), scholarship: scholarlyRole.test(role) ? 85 : 20 + Math.floor(random(world) * 45), warfare: militaryRole.test(role) ? 85 : 15 + Math.floor(random(world) * 45) },
    secrets: [], tags: traits.immortality === 100 ? ['immortal'] : [], attributes: { lastDecisionAt: calendar(world) - 0.25, seenEventIndex: world.events.length },
  };
  person.bornYear = calendar(world) - person.age;
  person.goals = [rulerRole.test(role) ? `Preserve the stability of ${civ.name}` : scholarlyRole.test(role) ? 'Understand the natural world' : clericalRole.test(role) ? 'Protect the faith' : militaryRole.test(role) ? 'Defend the homeland' : 'Provide for my household', traits.ambition > 65 ? 'Increase my influence' : 'Maintain the trust of my community'];
  person.beliefs = [civ.culture.values[0] || 'Duty binds a community', traits.religiosity > 65 ? 'Sacred traditions deserve protection' : 'Evidence should guide important decisions'];
  person.fears = [traits.paranoia > 60 ? 'Betrayal by those closest to me' : 'The suffering of my family', 'War reaching the capital'];
  world.characters.push(person);
  learn(world, person, 'food', civ.food < 0.9 ? 'The markets show signs of scarcity.' : 'The markets currently appear adequately supplied.', Math.round(clamp(supplyScore(civ) + (random(world) - 0.5) * 12, 0, 100)), 'Direct observation of local markets');
  learn(world, person, 'stability', 'I judge public confidence by conversations and local gatherings.', Math.round(clamp(civ.stability + (random(world) - 0.5) * 16, 0, 100)), 'Conversations in the capital');
  learn(world, person, 'treasury', rulerRole.test(role) ? 'I have reviewed the treasury accounts.' : 'I hear estimates of the state treasury from traders.', Math.round(Math.max(0, civ.treasury + (random(world) - 0.5) * Math.max(1, civ.treasury * (rulerRole.test(role) ? 0.02 : 0.6)))), rulerRole.test(role) ? 'Official treasury accounts' : 'Market gossip', undefined, !rulerRole.test(role));
  if (leader && isHeir && monarchic(civ)) {
    if (leader.age >= person.age + 16) linkFamily(leader, person);
    else {
      relationship(leader, person.id, 'dynastic relative');
      relationship(person, leader.id, 'dynastic relative');
    }
    if (!civ.succession.includes(person.id)) civ.succession.push(person.id);
  } else if (leader && leader.id !== person.id) {
    Object.assign(relationship(person, leader.id, 'subject'), { trust: 45 + traits.loyalty / 3, loyalty: traits.loyalty, respect: 60 });
    relationship(leader, person.id, militaryRole.test(role) ? 'commander' : 'citizen');
  }
  const initialPlan = decision(world, person, civ);
  person.plans.push(initialPlan);
  person.thoughts = [`${initialPlan.considered[0].label}: ${initialPlan.reason}`, `I want to ${person.goals[0].charAt(0).toLowerCase()}${person.goals[0].slice(1)}.`];
  return person;
}

function installSuccessor(world: World, civ: Civilization, previous: Character, death: HistoryEvent): HistoryEvent {
  let eligible = world.characters.filter(person => person.alive && person.civId === civ.id && person.age >= 16 && person.id !== previous.id);
  const childIds = [...(Array.isArray(previous.attributes.childIds) ? previous.attributes.childIds as string[] : []), ...previous.relationships.filter(tie => tie.type === 'child').map(tie => tie.characterId)];
  const score = (person: Character) => {
    if (monarchic(civ)) return (childIds.includes(person.id) ? 1000 : 0) + (person.dynasty === previous.dynasty && person.dynasty ? 500 : 0) + (heirRole.test(person.role) ? 300 : 0) + (civ.succession.includes(person.id) ? 150 : 0) + person.influence + (militaryRole.test(person.role) ? 40 : 0);
    return person.influence + person.skills.leadership * 0.55 + person.traits.loyalty * 0.2 + (/diplomat|consul|reformer/i.test(person.role) ? 25 : 0);
  };
  eligible.sort((left, right) => score(right) - score(left) || right.age - left.age || left.id.localeCompare(right.id));
  const successor = eligible[0] || makeCharacter(world, civ, 'Steward');
  const oldRole = successor.role;
  const oldStability = civ.stability;
  civ.leaderId = successor.id;
  civ.succession = civ.succession.filter(id => id !== previous.id && id !== successor.id && world.characters.some(person => person.id === id && person.alive));
  successor.attributes.previousRole = oldRole;
  successor.role = 'Ruler';
  successor.publicPosition = monarchic(civ) ? 'Sovereign' : /republic|council|democr/i.test(civ.government) ? 'First Consul' : 'Head of State';
  successor.influence = Math.max(85, successor.influence);
  const hereditary = monarchic(civ) && successor.dynasty === previous.dynasty;
  if (monarchic(civ) && !hereditary) {
    successor.dynasty = `House ${successor.name.split(' ').at(-1)}`;
    civ.dynasty = successor.dynasty;
  }
  civ.stability = clamp(civ.stability + (hereditary ? -2 : -9), 0, 100);
  const event = addEvent(world, {
    category: 'Political', severity: hereditary ? 3 : 4, location: civ.capital, actors: [successor.id], factions: [civ.id], causes: [death.id],
    title: `${successor.name} succeeds ${previous.name}`,
    description: hereditary ? `Following ${previous.name}'s death, ${successor.name} inherits the throne through ${civ.dynasty}. The ${civ.government.toLowerCase()} continues under a new sovereign.` : `After ${previous.name}'s death, ${civ.name}'s leading households and officials recognize ${successor.name}, formerly ${oldRole.toLowerCase()}, as the new head of state. The existing ${civ.government.toLowerCase()} remains in place.`,
    stateChanges: [{ entityId: civ.id, field: 'leaderId', before: previous.id, after: successor.id }, { entityId: successor.id, field: 'role', before: oldRole, after: successor.role }, { entityId: civ.id, field: 'stability', before: oldStability, after: civ.stability }],
    effects: ['A new leader takes office', hereditary ? 'The dynasty continues' : 'Officials negotiate a new balance of power'], tags: ['succession', 'ruler', ...(hereditary ? ['dynasty'] : [])],
  });
  for (const person of eligible) {
    if (person.id === successor.id) continue;
    const tie = relationship(person, successor.id, 'ruler');
    tie.loyalty = clamp(person.traits.loyalty + (hereditary ? 10 : -10), 0, 100);
    if (heirRole.test(person.role)) tie.resentment = clamp(tie.resentment + 25, 0, 100);
  }
  if (monarchic(civ) && !world.characters.some(person => person.alive && person.civId === civ.id && heirRole.test(person.role))) {
    const heir = makeCharacter(world, civ, 'Heir');
    addEvent(world, { category: 'Political', title: `${heir.name} is named heir`, description: `${successor.name} recognizes ${heir.name} as heir to ${civ.dynasty}, securing the next succession.`, actors: [successor.id, heir.id], factions: [civ.id], causes: [event.id], location: civ.capital, tags: ['succession', 'dynasty'] });
  }
  return event;
}

/** Death preserves the person's biography, relationships and causal history. */
export function killCharacter(world: World, character: Character, causeEventId?: string, reason = 'natural causes'): HistoryEvent {
  const priorDeath = typeof character.attributes.deathEventId === 'string' ? world.events.find(event => event.id === character.attributes.deathEventId) : undefined;
  if (!character.alive && priorDeath) return priorDeath;
  const previousHealth = character.health;
  character.alive = false;
  character.health = 0;
  character.deathYear = world.year;
  const civ = world.civilizations.find(item => item.id === character.civId);
  const leaderDied = civ?.leaderId === character.id;
  const death = addEvent(world, {
    category: 'Personal', severity: leaderDied ? 4 : 2, title: `${character.name} dies`,
    description: `${character.name}, ${character.role.toLowerCase()} of ${civ?.name || 'an unknown homeland'}, dies aged ${Math.floor(character.age)} from ${reason}. Their life and relationships remain part of the world's history.`,
    actors: [character.id], factions: civ ? [civ.id] : [], location: civ?.capital || world.name, causes: causeEventId ? [causeEventId] : [],
    stateChanges: [{ entityId: character.id, field: 'alive', before: true, after: false }, { entityId: character.id, field: 'health', before: previousHealth, after: 0 }],
    effects: ['A life ends', ...(leaderDied ? ['Succession must be resolved'] : [])], tags: ['death', ...(leaderDied ? ['ruler-death'] : [])],
  });
  character.attributes.deathEventId = death.id;
  character.memories.push({ eventId: death.id, year: world.year, description: `My life ended from ${reason}.`, emotion: 'finality' });
  for (const person of world.characters.filter(item => item.alive)) {
    const tie = person.relationships.find(item => item.characterId === character.id);
    if (!tie || tie.affection < 30) continue;
    person.memories.push({ eventId: death.id, year: world.year, description: `${character.name}, my ${tie.type}, has died.`, emotion: 'grief' });
    person.thoughts.unshift(`I will remember ${character.name}. Their death changes the people I can rely on.`);
    person.thoughts = person.thoughts.slice(0, 10);
  }
  if (civ && leaderDied && civ.active && !deferredEpochSuccession.has(world)) installSuccessor(world, civ, character, death);
  return death;
}

function observeEvents(world: World, person: Character) {
  const start = Number(person.attributes.seenEventIndex ?? 0);
  const recent = world.events.slice(Math.max(start, world.events.length - 40));
  for (const event of recent) {
    const witnessed = event.actors.includes(person.id);
    const localPublic = event.visibility === 'public' && event.factions.includes(person.civId);
    const rumor = event.visibility === 'rumor' && event.factions.includes(person.civId);
    if (!witnessed && !localPublic && !rumor) continue;
    if (!person.knowledge.some(item => item.eventId === event.id)) learn(world, person, event.category.toLowerCase(), event.title, undefined, witnessed ? 'Personal experience' : rumor ? `Rumor circulating in ${event.location}` : `Public report from ${event.location}`, event.id, rumor);
    if (localPublic && !witnessed && event.severity >= 3 && !person.memories.some(item => item.eventId === event.id)) person.memories.push({ eventId: event.id, year: event.year, description: event.title, emotion: event.category === 'Disaster' || event.category === 'Military' ? 'fear' : 'concern' });
    if (event.tags.some(tag => /betray|corruption|coup|assassin/.test(tag))) {
      for (const actor of event.actors) {
        if (actor === person.id) continue;
        const tie = relationship(person, actor);
        tie.trust = clamp(tie.trust - (rumor ? 4 : 12), 0, 100);
        tie.fear = clamp(tie.fear + 8, 0, 100);
      }
    }
  }
  person.attributes.seenEventIndex = world.events.length;
  if (person.memories.length > 80) person.memories.splice(0, person.memories.length - 80);
}

function decision(world: World, person: Character, civ: Civilization): Intention {
  const latest = (topic: string) => [...person.knowledge].reverse().find(item => item.topic === topic && item.perceived !== undefined);
  const food = latest('food');
  const stability = latest('stability');
  const treasury = latest('treasury');
  const leaderTie = person.relationships.find(item => item.characterId === civ.leaderId);
  const isLeader = person.id === civ.leaderId;
  const options: Array<Omit<DecisionOption, 'preference'>> = [
    { action: 'aid', label: 'Support relief efforts', score: (100 - (food?.perceived ?? 55)) * 0.8 + person.traits.empathy * 0.3, reason: `Local market observations suggest supplies at ${Math.round(food?.perceived ?? 55)}/100; compassion influences my response.` },
    { action: 'commerce', label: 'Improve household wealth', score: person.traits.ambition * 0.4 + person.traits.greed * 0.35 + (/merchant|artisan|farmer/i.test(person.role) ? 30 : 0), reason: 'My ambitions and the needs of my household favor productive work.' },
    { action: 'research', label: 'Support study and experiment', score: person.traits.curiosity * 0.55 + person.traits.rationality * 0.2 + (scholarlyRole.test(person.role) ? 30 : 0), reason: 'My curiosity and experience make new knowledge valuable.' },
    { action: 'faith', label: 'Strengthen religious community', score: person.traits.religiosity * 0.65 + (clericalRole.test(person.role) ? 30 : 0), reason: 'My beliefs give religious gatherings and teaching priority.' },
    { action: 'defense', label: 'Prepare the defenses', score: person.traits.courage * 0.25 + person.traits.paranoia * 0.35 + (militaryRole.test(person.role) ? 30 : 0), reason: 'I fear threats to the homeland and believe preparation matters.' },
    { action: 'diplomacy', label: 'Seek goodwill abroad', score: person.skills.diplomacy * 0.35 + person.traits.empathy * 0.3 + (/diplomat/i.test(person.role) ? 30 : 0), reason: 'My diplomatic experience and preference for cooperation favor outreach.' },
    { action: 'embezzle', label: 'Divert treasury funds', score: person.traits.greed * 0.55 + person.traits.ambition * 0.25 - person.traits.loyalty * 0.45 + ((isLeader || /merchant|minister/i.test(person.role)) && (treasury?.perceived ?? 0) > 40 ? 14 : -25), reason: `Reports suggest a treasury of ${Math.round(treasury?.perceived ?? 0)}; personal gain competes with my loyalty.` },
    { action: 'seize-power', label: 'Challenge the current ruler', score: isLeader ? -100 : person.traits.ambition * 0.55 + (leaderTie?.resentment ?? 5) * 0.4 + (100 - (stability?.perceived ?? 60)) * 0.35 - person.traits.loyalty * 0.35 + (militaryRole.test(person.role) ? 8 : -25), reason: `I perceive public stability at ${Math.round(stability?.perceived ?? 60)}/100, and weigh my ambition against loyalty to the ruler.` },
  ];
  const considered = options.map(option => ({ ...option, score: round(clamp(option.score, 0, 100)), preference: option.score >= 65 ? 'High' : option.score >= 40 ? 'Moderate' : 'Low' } as DecisionOption)).sort((left, right) => right.score - left.score);
  const chosen = considered[0];
  const knowledgeIds = [food, stability, treasury].filter((item): item is Knowledge => !!item).map(item => item.id);
  return { action: chosen.action, target: chosen.action === 'seize-power' ? civ.leaderId : civ.id, intensity: chosen.score / 100, reason: chosen.reason, knowledgeIds, considered, year: world.year, executed: false };
}

function execute(world: World, person: Character, civ: Civilization, plan: Intention): boolean {
  if (!person.alive || !civ.active || person.civId !== civ.id) return false;
  const evidence = person.knowledge.filter(item => plan.knowledgeIds.includes(item.id) && item.eventId).map(item => item.eventId!);
  const base = { actors: [person.id], factions: [civ.id], location: civ.capital, causes: evidence, tags: ['agent-action', plan.action] };
  if (plan.action === 'aid') {
    if (civ.food < 0.05 || person.wealth < 2) return false;
    const food = civ.food, happiness = civ.happiness, wealth = person.wealth;
    civ.food = Math.max(0, civ.food - 0.002); civ.happiness = clamp(civ.happiness + 0.45, 0, 100); person.wealth -= 1;
    addEvent(world, { ...base, category: 'Personal', title: `${person.name} organizes local relief`, description: `Moved by reports of scarcity, ${person.name} pays for a modest distribution of supplies. The relief reaches households but consumes existing reserves.`, stateChanges: [{ entityId: civ.id, field: 'food', before: food, after: civ.food }, { entityId: civ.id, field: 'happiness', before: happiness, after: civ.happiness }, { entityId: person.id, field: 'wealth', before: wealth, after: person.wealth }] });
  } else if (plan.action === 'commerce') {
    if (civ.population <= 0 || civ.food <= 0) return false;
    const wealth = person.wealth, treasury = civ.treasury;
    person.wealth = round(person.wealth + 1.4); civ.treasury = round(civ.treasury + 0.35);
    addEvent(world, { ...base, category: 'Economic', title: `${person.name}'s enterprise prospers`, description: `${person.name} organizes local production and trade. Household wealth rises, and a small tax payment reaches the state.`, stateChanges: [{ entityId: person.id, field: 'wealth', before: wealth, after: person.wealth }, { entityId: civ.id, field: 'treasury', before: treasury, after: civ.treasury }] });
  } else if (plan.action === 'research') {
    if (person.skills.scholarship < 25 || civ.food < 0.65) return false;
    const research = civ.research;
    civ.research += 0.45 + person.skills.scholarship / 100;
    person.skills.scholarship = clamp(person.skills.scholarship + 0.3, 0, 100);
    addEvent(world, { ...base, category: 'Scientific', title: `${person.name} contributes a new study`, description: `${person.name} records a careful observation and shares it with local scholars. It adds research progress; an invention still requires the society's technological prerequisites.`, stateChanges: [{ entityId: civ.id, field: 'research', before: research, after: civ.research }] });
  } else if (plan.action === 'faith') {
    const religion = world.religions.find(item => item.id === civ.religionId);
    if (!religion) return false;
    const influence = religion.influence;
    religion.influence = clamp(religion.influence + 0.15, 0, 100);
    addEvent(world, { ...base, category: 'Religious', title: `${person.name} leads a gathering`, description: `A gathering in ${civ.capital} renews devotion to ${religion.name}. ${person.name}'s teaching reaches the local community.`, stateChanges: [{ entityId: religion.id, field: 'influence', before: influence, after: religion.influence }] });
  } else if (plan.action === 'defense') {
    if (!(militaryRole.test(person.role) || person.id === civ.leaderId) || civ.treasury < 1 || civ.food < 0.75) return false;
    const military = civ.military, treasury = civ.treasury;
    civ.treasury -= 0.8; civ.military += 0.6;
    addEvent(world, { ...base, category: 'Military', title: `${person.name} drills the garrison`, description: `The garrison of ${civ.capital} improves its readiness under ${person.name}. Equipment and training are paid from the treasury.`, stateChanges: [{ entityId: civ.id, field: 'military', before: military, after: civ.military }, { entityId: civ.id, field: 'treasury', before: treasury, after: civ.treasury }] });
  } else if (plan.action === 'diplomacy') {
    const relation = civ.relations.find(item => world.civilizations.some(other => other.id === item.civId && other.active) && !world.wars.some(war => war.active && war.participants.includes(civ.id) && war.participants.includes(item.civId)));
    if (!relation || !(/diplomat/i.test(person.role) || person.id === civ.leaderId)) return false;
    const target = world.civilizations.find(item => item.id === relation.civId)!;
    const trust = relation.trust;
    relation.trust = clamp(relation.trust + 0.7, 0, 100);
    const reciprocal = target.relations.find(item => item.civId === civ.id);
    if (reciprocal) reciprocal.trust = clamp(reciprocal.trust + 0.5, 0, 100);
    addEvent(world, { ...base, factions: [civ.id, target.id], category: 'Diplomatic', title: `${person.name} opens talks with ${target.name}`, description: `Diplomatic correspondence improves mutual confidence between ${civ.name} and ${target.name}. No alliance is promised without agreement by both governments.`, stateChanges: [{ entityId: civ.id, field: `relations.${target.id}.trust`, before: trust, after: relation.trust }] });
  } else if (plan.action === 'embezzle') {
    if (!(person.id === civ.leaderId || /minister|merchant/i.test(person.role)) || civ.treasury < 8) return false;
    const treasury = civ.treasury, wealth = person.wealth;
    civ.treasury -= 3; person.wealth += 3;
    person.secrets.push(`Diverted 3 treasury units in ${world.year}.`);
    addEvent(world, { ...base, visibility: 'private', category: 'Criminal', title: `${person.name} diverts public funds`, description: `Using access to state accounts, ${person.name} quietly transfers public money into personal holdings. The transfer is real; the wider public has not learned of it.`, stateChanges: [{ entityId: civ.id, field: 'treasury', before: treasury, after: civ.treasury }, { entityId: person.id, field: 'wealth', before: wealth, after: person.wealth }] });
  } else if (plan.action === 'seize-power') {
    if (civ.stability >= 35 || person.influence < 60 || !militaryRole.test(person.role) || person.id === civ.leaderId || civ.military < 20) return false;
    const previous = world.characters.find(item => item.id === civ.leaderId && item.alive);
    if (!previous) return false;
    const oldStability = civ.stability, oldRole = person.role;
    civ.leaderId = person.id; civ.stability = clamp(civ.stability - 12, 0, 100);
    previous.role = 'Deposed ruler'; previous.publicPosition = 'Under guard'; person.role = 'Ruler'; person.publicPosition = 'Head of State'; person.influence = 92;
    Object.assign(relationship(previous, person.id, 'usurper'), { trust: 0, resentment: 100, fear: 75 });
    addEvent(world, { ...base, actors: [person.id, previous.id], category: 'Political', severity: 5, title: `${person.name} seizes power in ${civ.name}`, description: `With public order weak and troops under their command, ${person.name} removes ${previous.name} from office. The former ruler survives under guard; the struggle deepens political instability.`, stateChanges: [{ entityId: civ.id, field: 'leaderId', before: previous.id, after: person.id }, { entityId: person.id, field: 'role', before: oldRole, after: person.role }, { entityId: civ.id, field: 'stability', before: oldStability, after: civ.stability }], tags: ['agent-action', 'coup', 'betrayal'] });
  } else return false;
  return true;
}

/** Resolve real named lifetimes, then represent skipped generations explicitly. */
function updateEpochAgents(world: World, years: number): void {
  const end = calendar(world), start = end - years;
  const savedYear = world.year, savedDay = world.day;
  const detailedEnd = years > 250 ? start + 100 : end;
  const scheduled = new Map<string, number>();
  const setClock = (date: number) => {
    world.year = Math.floor(date);
    world.day = Math.round((date - world.year) * 365);
    if (world.day >= 365) { world.year++; world.day -= 365; }
  };
  const ageAt = (date: number) => {
    for (const person of world.characters) if (person.alive) person.age = Math.max(0, date - person.bornYear);
  };
  const scheduleNew = (date: number) => {
    for (const person of world.characters) {
      if (!person.alive || immortal(person) || scheduled.has(person.id)) continue;
      const lifespan = Math.max(person.age + 0.25, 68 + random(world) * 27);
      scheduled.set(person.id, date + lifespan - person.age);
    }
  };
  const nextDeath = (limit: number) => {
    let selected: Character | undefined, at = Infinity;
    for (const person of world.characters) {
      const candidate = scheduled.get(person.id);
      if (person.alive && candidate !== undefined && candidate <= limit && candidate < at) { selected = person; at = candidate; }
    }
    return selected ? { person: selected, at } : undefined;
  };
  try {
    setClock(start);
    ageAt(start);
    scheduleNew(start);
    // At most several represented generations, even for a billion-year interval.
    let next = nextDeath(detailedEnd);
    while (next) {
      setClock(next.at);
      ageAt(next.at);
      killCharacter(world, next.person, undefined, 'old age');
      scheduleNew(next.at);
      next = nextDeath(detailedEnd);
    }
    if (years > 250) {
      const lastNamedLeaders = new Map(world.civilizations.map(civ => [civ.id, world.characters.find(person => person.id === civ.leaderId)]));
      // Their unrepresented successors cannot be mistaken for a single immortal person.
      deferredEpochSuccession.add(world);
      next = nextDeath(end);
      while (next) {
        setClock(next.at);
        ageAt(next.at);
        killCharacter(world, next.person, undefined, 'old age');
        next = nextDeath(end);
      }
      deferredEpochSuccession.delete(world);
      setClock(end);
      ageAt(end);
      for (const civ of world.civilizations.filter(item => item.active)) {
        const existingLeader = world.characters.find(person => person.id === civ.leaderId && person.alive);
        if (existingLeader) continue;
        const predecessor = lastNamedLeaders.get(civ.id);
        const oldLeaderId = civ.leaderId;
        const generations = Math.max(1, Math.floor((end - detailedEnd) / 28));
        const ruler = makeCharacter(world, civ, 'Ruler');
        civ.leaderId = ruler.id;
        civ.succession = [];
        ruler.attributes.unrepresentedGenerations = generations;
        if (predecessor) {
          ruler.attributes.ancestorIds = [predecessor.id];
          relationship(ruler, predecessor.id, monarchic(civ) ? 'distant ancestor' : 'historical predecessor');
          relationship(predecessor, ruler.id, monarchic(civ) ? 'distant descendant' : 'historical successor');
        }
        const deathId = predecessor?.attributes.deathEventId;
        addEvent(world, {
          category: 'Political', severity: 3, actors: [ruler.id], factions: [civ.id], location: civ.capital,
          title: `${civ.name}'s chronicle spans ${generations.toLocaleString('en-US')} generations`,
          description: `This coarse epoch summarizes approximately ${generations.toLocaleString('en-US')} unrepresented generations after the last named cohort. ${monarchic(civ) ? `${civ.dynasty} is recorded as a continuing dynastic tradition; ${ruler.name} is a distant descendant, not a direct child of its ancient rulers.` : `Successive officeholders preserve the ${civ.government.toLowerCase()}; ${ruler.name} is the current representative.`} Individual lifetimes are finite; the intervening people are not reconstructed.`,
          causes: typeof deathId === 'string' ? [deathId] : [],
          stateChanges: [{ entityId: civ.id, field: 'leaderId', before: oldLeaderId, after: ruler.id }],
          effects: ['The final living generation is represented', 'Intervening generations are recorded in aggregate'], tags: ['epoch', 'succession', 'generations', ...(monarchic(civ) ? ['dynasty'] : [])],
        });
      }
    }
    setClock(end);
    ageAt(end);
    const roles = ['Heir', 'General', 'High Priest', 'Merchant', 'Scholar', 'Farmer', 'Diplomat', 'Artisan', 'Reformer'];
    for (const civ of world.civilizations.filter(item => item.active)) {
      const living = world.characters.filter(person => person.alive && person.civId === civ.id);
      for (const role of roles) {
        if (living.some(person => person.role === role)) continue;
        const person = makeCharacter(world, civ, role);
        living.push(person);
        addEvent(world, { category: 'Personal', actors: [person.id], factions: [civ.id], location: civ.capital, title: `${person.name} joins the living generation`, description: `${person.name}, born in year ${Math.floor(person.bornYear)}, is a contemporary ${role.toLowerCase()} of ${civ.name}. Their childhood and family belong to the current generation.`, tags: ['new-generation', 'epoch'] });
      }
    }
    for (const person of world.characters.filter(item => item.alive)) observeEvents(world, person);
  } finally {
    deferredEpochSuccession.delete(world);
    world.year = savedYear; world.day = savedDay;
  }
}

/** Small-time steps are supported; beliefs and actions are refreshed at most quarterly. */
export function updateAgents(world: World, years: number): void {
  if (!Number.isFinite(years) || years <= 0) return;
  if (years > 20) { updateEpochAgents(world, years); return; }
  const now = calendar(world);
  const roster = [...world.characters];
  const decisionPool: Character[] = [];
  for (const person of roster) {
    if (!person.alive) continue;
    const civ = world.civilizations.find(item => item.id === person.civId);
    person.age += years;
    if (!immortal(person)) {
      const scarcity = civ && civ.food < 0.8 ? (0.8 - civ.food) * 2 : 0;
      const diseaseBurden = civ?.disease && civ.population > 0 ? civ.disease.infected / civ.population * civ.disease.fatality * 10 : 0;
      person.health = clamp(person.health + years * (person.age > 60 ? -(person.age - 58) * 0.12 : 0.3) - years * (scarcity + diseaseBurden), 0, 100);
      const annualHazard = 0.0015 + Math.max(0, person.age - 45) ** 2 / 23000 + scarcity * 0.008 + diseaseBurden * 0.012 + (person.health < 20 ? 0.12 : 0);
      if (person.health <= 0 || person.age >= 112 || random(world) < 1 - Math.exp(-annualHazard * years)) {
        killCharacter(world, person, civ?.disease?.causeEventId, civ?.disease && diseaseBurden > 0.05 ? civ.disease.name : scarcity > 0.8 ? 'hunger and declining health' : person.age >= 60 ? 'old age' : 'illness');
        continue;
      }
    } else person.health = Math.max(80, person.health);
    observeEvents(world, person);
    if (civ?.active && person.age >= 16 && now - Number(person.attributes.lastDecisionAt ?? -1000) >= 0.25) decisionPool.push(person);
  }
  // Only a handful of visible agent actions per epoch; everyone can still form plans.
  let eventBudget = Math.min(4, Math.max(1, Math.ceil(years * 6)));
  for (let index = decisionPool.length - 1; index > 0; index--) {
    const other = Math.floor(random(world) * (index + 1));
    [decisionPool[index], decisionPool[other]] = [decisionPool[other], decisionPool[index]];
  }
  for (const person of decisionPool) {
    const civ = world.civilizations.find(item => item.id === person.civId)!;
    person.attributes.lastDecisionAt = now;
    if (random(world) < 0.35) {
      const perceived = Math.round(clamp(supplyScore(civ) + (random(world) - 0.5) * 14, 0, 100));
      learn(world, person, 'food', perceived < 30 ? 'I see growing scarcity in the markets.' : 'Recent market visits suggest sufficient supplies.', perceived, 'Recent market observation');
      learn(world, person, 'stability', 'I have updated my judgment of public confidence.', Math.round(clamp(civ.stability + (random(world) - 0.5) * 18, 0, 100)), 'Conversations with neighbors');
    }
    const plan = decision(world, person, civ);
    person.plans.push(plan);
    person.plans = person.plans.slice(-16);
    person.thoughts.unshift(`${plan.considered[0].label}: ${plan.reason}`);
    person.thoughts = person.thoughts.slice(0, 10);
    if (eventBudget > 0 && random(world) < 0.42) {
      plan.executed = execute(world, person, civ, plan);
      if (plan.executed) eventBudget--;
      else person.thoughts.unshift('My preferred action cannot proceed: the actual resources, authority, or support are insufficient.');
    }
  }
  if (years >= 0.25) {
    for (const civ of world.civilizations.filter(item => item.active)) {
      const living = world.characters.filter(person => person.alive && person.civId === civ.id);
      if (living.length >= 9) continue;
      const roles = ['General', 'High Priest', 'Merchant', 'Scholar', 'Farmer', 'Diplomat', 'Artisan', 'Reformer'];
      const absent = roles.filter(role => !living.some(person => person.role === role));
      for (const role of absent.slice(0, 2)) {
        const person = makeCharacter(world, civ, role);
        addEvent(world, { category: 'Personal', title: `${person.name} rises to prominence`, description: `A new ${role.toLowerCase()} emerges in ${civ.name}. ${person.name} joins a new generation whose ambitions will shape the society.`, actors: [person.id], factions: [civ.id], location: civ.capital, tags: ['new-generation'] });
      }
    }
  }
}
