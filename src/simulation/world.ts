import type { Civilization, CreateWorldInput, World, Religion, Geography } from './types';
import { addEvent, clamp, hashSeed, nextId, populationTotal, random } from './utils';
import { makeCharacter } from './agents';

export const TECHNOLOGIES = [
  { name: 'Agriculture', prerequisites: [], category: 'Agriculture', cost: 0, impact: 'Reliable harvests and settled life' },
  { name: 'Pottery', prerequisites: [], category: 'Construction', cost: 0, impact: 'Food storage and trade' },
  { name: 'Ironworking', prerequisites: ['Agriculture'], category: 'Metallurgy', cost: 0, impact: 'Tools and organized armies' },
  { name: 'Writing', prerequisites: [], category: 'Communication', cost: 0, impact: 'Archives, laws, and records' },
  { name: 'Sailing', prerequisites: ['Writing'], category: 'Transportation', cost: 70, impact: 'Trade routes and distant exploration' },
  { name: 'Mathematics', prerequisites: ['Writing'], category: 'Science', cost: 110, impact: 'Accurate accounts and engineering' },
  { name: 'Irrigation', prerequisites: ['Agriculture', 'Mathematics'], category: 'Agriculture', cost: 130, impact: 'Higher yields and drought resilience' },
  { name: 'Medicine', prerequisites: ['Writing', 'Mathematics'], category: 'Medicine', cost: 160, impact: 'Lower disease mortality' },
  { name: 'Steel', prerequisites: ['Ironworking'], category: 'Metallurgy', cost: 180, impact: 'Stronger tools and weapons' },
  { name: 'Navigation', prerequisites: ['Sailing', 'Mathematics'], category: 'Navigation', cost: 190, impact: 'Ocean crossings and new settlements' },
  { name: 'Printing', prerequisites: ['Writing', 'Mathematics'], category: 'Communication', cost: 210, impact: 'Wider literacy and religious debate' },
  { name: 'Gunpowder', prerequisites: ['Steel', 'Mathematics'], category: 'Military', cost: 230, impact: 'New siege warfare' },
  { name: 'Steam Power', prerequisites: ['Steel', 'Printing'], category: 'Energy', cost: 260, impact: 'Industrial production' },
  { name: 'Electricity', prerequisites: ['Steam Power', 'Mathematics'], category: 'Energy', cost: 300, impact: 'Electric machines and new communication' },
  { name: 'Germ Theory', prerequisites: ['Medicine', 'Printing'], category: 'Medicine', cost: 300, impact: 'Prevention of infectious disease' },
  { name: 'Radio', prerequisites: ['Electricity'], category: 'Communication', cost: 340, impact: 'Rapid information networks' },
  { name: 'Computing', prerequisites: ['Electricity', 'Radio'], category: 'Computing', cost: 400, impact: 'Automated calculation' },
  { name: 'Spaceflight', prerequisites: ['Computing', 'Gunpowder'], category: 'Transportation', cost: 520, impact: 'Travel beyond the planet' },
  { name: 'Fusion', prerequisites: ['Computing', 'Spaceflight'], category: 'Energy', cost: 800, impact: 'Abundant energy' },
];

function civilization(id: string, name: string, color: string, population: number, government: string, capital: string, religionId: string, dynasty: string): Civilization {
  const talria = id === 'talria'; const esen = id === 'esen';
  return {
    id, name, color, population, government, capital, leaderId: '', religionId, territory: 0,
    food: esen ? 0.89 : talria ? 1.16 : 1.29, treasury: talria ? 148000 : esen ? 67000 : 95000,
    taxRate: esen ? .19 : talria ? .14 : .23, happiness: esen ? 60 : talria ? 72 : 55,
    stability: talria ? 67 : esen ? 72 : 62, military: Math.round(population * (esen ? .037 : .021)),
    technologies: ['Agriculture', 'Pottery', 'Ironworking', 'Writing', ...(talria ? ['Sailing'] : [])], research: talria ? 46 : 12,
    resources: [{ name: 'Grain', stock: population * (esen ? .9 : 1.2), production: population * (esen ? .8 : 1.25), demand: population, price: esen ? 1.24 : .88 }, { name: 'Iron', stock: population * .04, production: population * .02, demand: population * .015, price: esen ? .83 : 1.12 }, { name: 'Timber', stock: population * .08, production: population * .04, demand: population * .03, price: .96 }, { name: 'Textiles', stock: population * .035, production: population * .019, demand: population * .016, price: talria ? .72 : 1.24 }],
    culture: { language: talria ? 'Talric' : esen ? 'Esenic' : 'Old Valoran', values: talria ? ['commerce', 'debate', 'pluralism'] : esen ? ['honor', 'discipline', 'ancestors'] : ['tradition', 'family', 'solar devotion'], customs: talria ? ['Elected consuls', 'Harbor markets'] : esen ? ['Ancestor feasts', 'Oaths of service'] : ['Harvest festivals', 'Royal procession'], architecture: talria ? 'White-stone harbor colonnades' : esen ? 'Hilltop keeps and longhouses' : 'Terraced stone cities', cuisine: talria ? 'Seafood, olives and barley' : esen ? 'Millet, smoked meat and mountain herbs' : 'Wheat, orchard fruit and spiced stews', traditions: ['Oral histories', 'Naming ceremonies'] },
    groups: [
      { id: `${id}-elite`, name: talria ? 'Patricians' : 'Nobility', share: .035, influence: talria ? 64 : 83, happiness: 74, wealth: 75, ideology: talria ? 'republican' : 'dynastic', goals: ['Protect privilege', 'Secure succession'] },
      { id: `${id}-commoners`, name: 'Commoners', share: .73, influence: 22, happiness: esen ? 49 : talria ? 64 : 46, wealth: 15, ideology: 'communal', goals: ['Fair taxation', 'Reliable food'] },
      { id: `${id}-military`, name: 'Military', share: .045, influence: esen ? 88 : 61, happiness: 68, wealth: 42, ideology: 'militarist', goals: ['Secure supplies', 'Preserve honor'] },
      { id: `${id}-clergy`, name: 'Clergy', share: .055, influence: talria ? 40 : 76, happiness: 70, wealth: 55, ideology: 'devout', goals: ['Protect doctrine', 'Expand the faith'] },
      { id: `${id}-merchants`, name: 'Merchants', share: .08, influence: talria ? 89 : 47, happiness: 60, wealth: 71, ideology: 'commercial', goals: ['Keep trade open', 'Lower tariffs'] },
      { id: `${id}-scholars`, name: 'Scholars and artisans', share: .055, influence: 30, happiness: 58, wealth: 33, ideology: 'reformist', goals: ['Preserve knowledge', 'Improve tools'] },
    ], relations: [], dynasty, succession: [], debt: 0, literacy: talria ? .16 : .08, climate: esen ? .86 : 1, soil: esen ? .82 : talria ? 1.05 : 1.23, active: true, attributes: {},
  };
}

function generateGeography(world: World): Geography {
  const width = 80, height = 48;
  const sites = [{ id: 'valora', x: 28, y: 24, name: 'Solhaven' }, { id: 'esen', x: 49, y: 14, name: 'Vennhold' }, { id: 'talria', x: 52, y: 33, name: 'Port Talria' }];
  const cells: Geography['cells'] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const noise = (Math.sin(x * .54 + y * .21) + Math.cos(y * .6 - x * .18)) * .085;
    const main = Math.pow((x - 40) / 29, 2) + Math.pow((y - 25) / 21, 2);
    const island = Math.pow((x - 9) / 4.5, 2) + Math.pow((y - 15) / 7, 2);
    const eastIsland = Math.pow((x - 72) / 3.5, 2) + Math.pow((y - 35) / 5, 2);
    const westBay = Math.pow((x - 17) / 7, 2) + Math.pow((y - 34) / 5, 2) < .9;
    const eastBay = Math.pow((x - 65) / 8, 2) + Math.pow((y - 25) / 6, 2) < .8;
    const northInlet = Math.pow((x - 34) / 3.5, 2) + Math.pow((y - 8) / 7, 2) < .8;
    const land = (main < .86 + noise && !westBay && !eastBay && !northInlet) || island < .72 + noise || eastIsland < .75 + noise;
    const elevation = land ? clamp(.18 + (1 - main) * .43 + random(world) * .2 + (Math.abs(x - 44) < 4 && y < 29 ? .3 : 0), .13, .99) : random(world) * .09;
    let biome: Geography['cells'][number]['biome'] = !land ? 'ocean' : elevation > .75 ? 'mountains' : y < 10 || (x > 59 && y < 23) ? 'desert' : random(world) < .31 ? 'forest' : 'plains';
    if (land && Math.abs(x - (31 + 2 * Math.sin(y * .3))) < .8 && y > 14 && y < 38) biome = 'river';
    const nearest = sites.reduce((best, current) => Math.hypot(x - current.x, y - current.y) < Math.hypot(x - best.x, y - best.y) ? current : best);
    const civId = land && main < 1.2 ? nearest.id : undefined;
    const resource = land && random(world) < .075 ? biome === 'mountains' ? 'Iron' : biome === 'forest' ? 'Timber' : biome === 'plains' ? 'Grain' : 'Stone' : undefined;
    cells.push({ x, y, elevation, biome, ...(civId ? { civId } : {}), ...(resource ? { resource } : {}) });
  }
  const settlements = sites.flatMap((site, index) => [
    { id: `${site.id}-capital`, name: site.name, x: site.x, y: site.y, civId: site.id, population: Math.round(world.civilizations[index].population * .11) },
    { id: `${site.id}-town`, name: ['Ashfield', 'Tal Ridge', 'Marrow Bay'][index], x: site.x - 4, y: site.y + 5, civId: site.id, population: Math.round(world.civilizations[index].population * .045) },
  ]);
  for (const civ of world.civilizations) civ.territory = cells.filter(cell => cell.civId === civ.id).length;
  return { width, height, cells, settlements, seed: world.seed };
}

export function createWorld(input: CreateWorldInput = {}): World {
  const seed = String(input.seed ?? Math.floor(Math.random() * 1e9));
  const now = new Date().toISOString();
  const world: World = {
    version: 1, id: `world-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, name: input.name?.trim() || 'Erya', seed,
    origin: input.origin || 'Big Bang', unusual: input.unusual?.trim() || '', year: 842, day: 0, era: 'Age of Iron', createdAt: now, updatedAt: now,
    civilizations: [], characters: [], religions: [], wars: [], events: [], canon: [], geography: { width: 80, height: 48, cells: [], settlements: [], seed },
    populationHistory: [], rngState: hashSeed(seed), nextEntity: 1, tick: 0, attributes: { scenario: 'The Three Kingdoms', cosmicAge: 13.8e9, continent: 'Avaria', aiMode: 'local' },
  };
  world.civilizations = [
    civilization('valora', 'Kingdom of Valora', '#d6ab67', 620000, 'Hereditary monarchy', 'Solhaven', 'solarianism', 'Dawnmere'),
    civilization('esen', 'Kingdom of Esen', '#a388c9', 410000, 'Warrior monarchy', 'Vennhold', 'ancestor-faith', 'House Venn'),
    civilization('talria', 'Republic of Talria', '#6daeb4', 530000, 'Merchant republic', 'Port Talria', 'tidal-way', 'Sol'),
  ];
  for (const civ of world.civilizations) civ.relations = world.civilizations.filter(other => other.id !== civ.id).map(other => ({ civId: other.id, trust: civ.id === 'esen' || other.id === 'esen' ? 35 : 67, trade: civ.id === 'talria' || other.id === 'talria' ? 62 : 29, grievance: civ.id === 'esen' || other.id === 'esen' ? 43 : 17, alliance: false }));
  world.religions = [
    { id: 'solarianism', name: 'Solarianism', origin: 'Valoran harvest rites', deity: 'Solara, the undying sun', doctrines: ['The sun witnesses every oath', 'The harvest belongs to all', 'Kings guard the sacred order'], rituals: ['Dawn prayer', 'Harvest procession'], holyText: 'The Book of Radiance', clergy: 'Hierarchical sun temples', followers: 570400, influence: 79, denominations: [], foundedYear: 201, tags: ['sun', 'established'] },
    { id: 'ancestor-faith', name: 'The Ancestor Path', origin: 'Esenic oral traditions', deity: 'The honored ancestors', doctrines: ['Keep faith with those before you', 'Courage preserves the clan'], rituals: ['Ancestor feast', 'Memorial fire'], holyText: 'The Remembered Names', clergy: 'Clan elders', followers: 393600, influence: 70, denominations: [], foundedYear: 123, tags: ['ancestors', 'warrior'] },
    { id: 'tidal-way', name: 'The Tidal Way', origin: 'Talrian port communities', deity: 'The sea and its many spirits', doctrines: ['All journeys change the traveler', 'Honor a stranger’s faith'], rituals: ['Departure offerings', 'The open table'], holyText: 'Voyages of the First Pilgrim', clergy: 'Independent harbor shrines', followers: 355100, influence: 43, denominations: [], foundedYear: 387, tags: ['sea', 'pluralist'] },
  ] satisfies Religion[];
  for (const civ of world.civilizations) {
    const faith = world.religions.find(faith => faith.id === civ.religionId)!;
    civ.attributes.religiousShares = { [faith.id]: faith.followers / civ.population };
  }
  world.geography = generateGeography(world);
  const roles = ['Ruler', 'Heir', 'General', 'High Priest', 'Merchant', 'Scholar', 'Farmer', 'Diplomat', 'Artisan', 'Reformer'];
  const named = [['Aeron IV Dawnmere', 'Cael Dawnmere', 'Marek Tal'], ['Eshara Venn', 'Kiran Venn', 'Oris Venn'], ['Consul Lyra Sol', 'Nera Sol', 'Vera Kest']];
  for (let c = 0; c < world.civilizations.length; c++) {
    const civ = world.civilizations[c];
    const people = roles.map((role, index) => {
      const person = makeCharacter(world, civ, role, named[c][index]);
      if (index === 0) civ.leaderId = person.id;
      return person;
    });
    civ.leaderId = people[0].id; civ.succession = [people[1].id];
    people[0].age = [48, 43, 37][c]; people[0].bornYear = world.year - people[0].age;
    people[1].age = [17, 21, 23][c]; people[1].bornYear = world.year - people[1].age;
    people[0].relationships.push({ characterId: people[1].id, type: 'child', affection: 87, trust: 73, fear: 5, respect: 55, resentment: 12, loyalty: 91 });
    people[1].relationships.push({ characterId: people[0].id, type: 'parent', affection: 82, trust: 68, fear: 24, respect: 85, resentment: 17, loyalty: 84 });
    people[0].relationships.push({ characterId: people[2].id, type: 'subordinate', affection: 35, trust: c === 0 ? 42 : 70, fear: c === 0 ? 52 : 18, respect: 84, resentment: 28, loyalty: 67 });
    people[2].relationships.push({ characterId: people[0].id, type: 'superior', affection: 48, trust: c === 0 ? 46 : 71, fear: 23, respect: 69, resentment: c === 0 ? 47 : 11, loyalty: 68 });
  }
  const cosmic = [
    [-13.8e9, world.origin === 'Big Bang' ? 'The universe begins' : `${world.origin}: the first remembered moment`, world.origin === 'Big Bang' ? 'Matter, energy and spacetime emerge. The civil calendar records these cosmic dates relative to the present.' : `The world’s origin is recorded as ${world.origin}. Its people may disagree about what came before.`],
    [-13.8e9 + 380000, 'The first atoms form', 'The universe cools and becomes transparent.'],
    [-13.6e9, 'The first stars ignite', 'Stellar furnaces begin forging the elements from which future worlds will form.'],
    [-4.7e9, 'The Eryan system forms', 'A young star gathers planets from a disk of gas and dust.'],
    [-4.2e9, 'Planet Erya takes shape', 'A rocky planet forms oceans, a crust, and a changing atmosphere.'],
    [-1e9, 'Primitive life appears', 'Self-replicating organisms establish the first enduring biological lineages.'],
    [-90000000, 'Complex life flourishes', 'Multicellular life diversifies across oceans and land.'],
    [-7000000, 'Intelligent ancestors emerge', 'Toolmaking species adapt through culture as well as biology.'],
    [-200000, 'The first settlements', 'Agriculture, shared ritual and memory anchor permanent communities.'],
  ] as const;
  for (const [year, title, description] of cosmic) addEvent(world, { year, category: 'Cosmic', severity: 5, title, description, tags: ['cosmic', 'origin'], causes: world.events.length ? [world.events.at(-1)!.id] : [] });
  const founding = addEvent(world, { year: 760, category: 'Political', severity: 4, title: 'The Three Kingdoms take shape', description: 'Valora’s harvest lords, Esen’s warrior clans, and Talria’s merchant councils consolidate on the continent of Avaria.', factions: world.civilizations.map(civ => civ.id), tags: ['founding', 'government'] });
  const routes = addEvent(world, { year: 832, category: 'Diplomatic', severity: 3, title: 'The Avarian grain compact opens', description: 'Talrian merchants connect fertile Valora to Esen’s upland markets. The pact brings wealth and dependence in equal measure.', factions: world.civilizations.map(civ => civ.id), causes: [founding.id], tags: ['trade', 'grain'] });
  addEvent(world, { year: 839, category: 'Economic', severity: 3, title: 'Esen’s thin harvest strains the border', description: 'Limited farmland leaves Esen importing grain, while Valoran landowners resist lower tariffs. Military leaders begin discussing access to the western fields.', factions: ['esen', 'valora'], causes: [routes.id], tags: ['shortage', 'grievance'], stateChanges: [{ entityId: 'esen', field: 'food', before: 1.1, after: .89 }] });
  addEvent(world, { category: 'Political', severity: 3, title: 'A fragile peace on Avaria', description: 'Three distinct societies begin this chronicle at an Iron Age level. Harvests, ambitions, beliefs and trade will shape their future without a script.', factions: world.civilizations.map(civ => civ.id), tags: ['scenario', 'present'] });
  if (world.unusual) {
    const tags = ['unusual', ...['magic', 'dragon', 'moon', 'alien', 'portal', 'immortal', 'vampire'].filter(tag => world.unusual.toLowerCase().includes(tag))];
    world.canon.push({ id: nextId(world, 'canon'), description: world.unusual, year: 842, origin: 'creation', facts: [world.unusual], disputedFacts: ['Different cultures interpret this feature in different ways.'], entityIds: [], tags, attributes: { kind: 'phenomenon', strength: .1, nextInteractionYear: 848 } });
    const event = addEvent(world, { category: 'Cultural', severity: 4, title: 'The nature of this world is recorded', description: world.unusual, tags: ['canon', ...tags] });
    for (const person of world.characters) person.knowledge.push({ id: nextId(world, 'knowledge'), topic: 'World nature', belief: world.unusual, confidence: person.role === 'Scholar' ? .84 : .57, source: person.role === 'Scholar' ? 'observation' : 'oral tradition', eventId: event.id, learnedYear: world.year, isRumor: person.role !== 'Scholar' });
  }
  world.populationHistory.push({ year: world.year, population: populationTotal(world), civilizations: Object.fromEntries(world.civilizations.map(civ => [civ.id, civ.population])) });
  return world;
}
