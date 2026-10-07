import type { AdvanceResult, Civilization, HistoryEvent, ParsedTime, World } from './types';
import { addEvent, chance, clamp, nextId, populationTotal, random, recentCause } from './utils';
import { parseTime, chooseStep } from './time';
import { TECHNOLOGIES } from './world';
import { updateAgents } from './agents';

function recordPopulation(world: World): void {
  const point = { year: world.year + world.day / 365, population: populationTotal(world), civilizations: Object.fromEntries(world.civilizations.map(civ => [civ.id, civ.population])) };
  world.populationHistory.push(point);
  // Samples are data, not the permanent ledger; retain the first point and sample the rest.
  if (world.populationHistory.length > 1200) world.populationHistory = [world.populationHistory[0], ...world.populationHistory.slice(1).filter((_, index) => index % 2 === 1)];
}

function economyAndPopulation(world: World, civ: Civilization, years: number): void {
  const before = { population: civ.population, food: civ.food, treasury: civ.treasury, military: civ.military, happiness: civ.happiness, stability: civ.stability, debt: civ.debt };
  if (!civ.active) {
    if (civ.population === 0) return;
    civ.population = Math.max(1, Math.round(civ.population * Math.exp(-.002 * Math.min(years, 100))));
    addEvent(world, { category: 'Demographic', severity: 1, title: `${civ.name}: the diaspora endures`, description: 'People preserve their language and customs after the collapse of centralized government.', factions: [civ.id], causes: recentCause(world, civ.id, ['collapse']), tags: ['population', 'diaspora'], stateChanges: [{ entityId: civ.id, field: 'population', before: before.population, after: civ.population }] });
    if (chance(world, .018, years)) {
      civ.active = true; civ.government = 'Confederation'; civ.stability = 49; civ.happiness = 52; civ.treasury = Math.max(civ.treasury, 5000); civ.debt *= .7;
      addEvent(world, { category: 'Political', severity: 4, title: `${civ.name} forms a new confederation`, description: 'Surviving communities negotiate a shared council. Institutions change, while the population and earlier history remain continuous.', factions: [civ.id], causes: recentCause(world, civ.id, ['collapse']), tags: ['recovery', 'government'], stateChanges: [{ entityId: civ.id, field: 'active', before: false, after: true }, { entityId: civ.id, field: 'government', before: 'Interregnum', after: civ.government }] });
    }
    return;
  }
  const time = Math.min(years, 120);
  const tech = civ.technologies.length;
  const drought = Number(civ.attributes.droughtUntil ?? -Infinity) >= world.year;
  const irrigation = civ.technologies.includes('Irrigation') ? .16 : 0;
  const industry = civ.technologies.includes('Steam Power') ? .26 : 0;
  const support = .6 + civ.soil * .44 + irrigation + industry;
  const harvestMultiplier = clamp(Number(civ.attributes.harvestMultiplier ?? 1), 0, 4);
  const targetFood = clamp(support * civ.climate * harvestMultiplier * (drought ? .62 : 1) - (civ.population / Math.max(500000, civ.territory * 4000 * (1 + tech * .15))) * .12, .05, 2.4);
  civ.food = clamp(targetFood + (civ.food - targetFood) * Math.exp(-.55 * time), .05, 3);
  const shortage = Math.max(0, 1 - civ.food);
  const carryingCapacity = Math.max(180000, civ.territory * 2500 * (1 + Math.max(0, tech - 4) * .5));
  const baseGrowth = .011 + (civ.technologies.includes('Medicine') ? .003 : 0) + (civ.technologies.includes('Germ Theory') ? .004 : 0) - shortage * .045;
  // Closed-form logistic growth remains stable at epoch resolution.
  if (baseGrowth > 0) {
    const growth = Math.exp(-Math.min(100, baseGrowth * time));
    civ.population = Math.max(1, Math.round(carryingCapacity / (1 + (carryingCapacity / Math.max(1, civ.population) - 1) * growth)));
  } else civ.population = Math.max(1, Math.round(civ.population * Math.exp(Math.max(-12, baseGrowth * time))));
  const revenue = civ.population * civ.taxRate * .055 * Math.min(time, 15);
  const spending = (civ.military * .24 + civ.population * .002 + civ.debt * .02) * Math.min(time, 15);
  civ.treasury = clamp(civ.treasury + revenue - spending, 0, civ.population * 80);
  if (revenue < spending && before.treasury < spending - revenue) civ.debt = Math.min(civ.population * 10, civ.debt + spending - revenue - before.treasury);
  if (civ.treasury > civ.population * .4 && civ.debt > 0) { const repayment = Math.min(civ.debt, revenue * .1); civ.treasury -= repayment; civ.debt -= repayment; }
  const targetHappy = clamp(87 - civ.taxRate * 85 - shortage * 65 - (world.wars.some(war => war.active && war.participants.includes(civ.id)) ? 12 : 0) + (civ.government.includes('republic') ? 4 : 0), 3, 94);
  civ.happiness = clamp(targetHappy + (civ.happiness - targetHappy) * Math.exp(-.16 * time), 0, 100);
  const targetStability = clamp(civ.happiness * .82 + 15 - civ.debt / Math.max(1, civ.population) * 8 - (civ.treasury === 0 ? 12 : 0), 0, 98);
  civ.stability = clamp(targetStability + (civ.stability - targetStability) * Math.exp(-.09 * time), 0, 100);
  const militaryTarget = civ.population * (civ.government.toLowerCase().includes('warrior') ? .038 : .025);
  civ.military = Math.max(0, Math.round(militaryTarget + (civ.military - militaryTarget) * Math.exp(-.08 * time)));
  for (const resource of civ.resources) {
    const commodityFactor = resource.name === 'Grain' ? civ.food : 1 + tech * .023;
    resource.production = Math.round(civ.population * (resource.name === 'Grain' ? commodityFactor : resource.name === 'Iron' ? .019 : .025));
    resource.demand = Math.round(civ.population * (resource.name === 'Grain' ? 1 : resource.name === 'Iron' ? .017 : .022));
    resource.stock = clamp(resource.stock + (resource.production - resource.demand) * Math.min(time, 8), 0, civ.population * 8);
    resource.price = clamp(resource.demand / Math.max(1, resource.production) * (resource.stock < resource.demand * .1 ? 1.45 : 1), .3, 8);
  }
  if (civ.disease && civ.disease.infected > civ.population) civ.disease.infected = civ.population;
  for (const group of civ.groups) {
    group.happiness = clamp(civ.happiness + (group.name === 'Commoners' ? -civ.taxRate * 30 : group.name === 'Merchants' ? civ.treasury / Math.max(1, civ.population) * 15 : 7), 0, 100);
    if (group.name === 'Commoners') group.influence = clamp(group.influence + (group.happiness < 35 ? .8 : -.2) * Math.min(time, 5), 8, 85);
  }
  for (const town of world.geography.settlements.filter(town => town.civId === civ.id)) town.population = Math.max(0, Math.round(town.population * civ.population / Math.max(1, before.population)));
  const changes = Object.keys(before).map(field => ({ entityId: civ.id, field, before: before[field as keyof typeof before], after: civ[field as keyof Civilization] })).filter(change => change.before !== change.after);
  if (changes.length) addEvent(world, { category: 'Demographic', severity: 1, title: `${civ.name}: population and accounts updated`, description: `Population ${before.population.toLocaleString()} → ${civ.population.toLocaleString()}; food security ${civ.food.toFixed(2)}; treasury ${Math.round(civ.treasury).toLocaleString()}. Births, ordinary mortality, production, demand, military upkeep and taxation are calculated by the engine.`, factions: [civ.id], tags: ['background', 'population', 'economy'], stateChanges: changes });
  if (before.food >= .95 && civ.food < .95) addEvent(world, { category: 'Economic', severity: 3, title: `Food shortage in ${civ.name}`, description: `Harvests supply ${(civ.food * 100).toFixed(0)}% of annual demand. Grain prices rise and commoners begin to question the governing order.`, factions: [civ.id], causes: recentCause(world, civ.id, ['drought', 'disaster']), tags: ['shortage', 'grain', 'unrest'], stateChanges: [{ entityId: civ.id, field: 'food', before: before.food, after: civ.food }] });
}

function environmentAndDisease(world: World, civ: Civilization, years: number): void {
  if (!civ.active) return;
  if (chance(world, .012, years) && Number(civ.attributes.droughtUntil ?? 0) < world.year) {
    civ.attributes.droughtUntil = world.year + 3 + Math.floor(random(world) * 5);
    addEvent(world, { category: 'Environmental', severity: 3, title: `Drought settles over ${civ.name}`, description: 'Failed rains reduce crop yields. Grain reserves and irrigation determine how long households can endure.', factions: [civ.id], tags: ['drought', 'disaster'], stateChanges: [{ entityId: civ.id, field: 'attributes.droughtUntil', before: null, after: civ.attributes.droughtUntil }] });
  }
  if (!civ.disease && chance(world, .009, years)) {
    const event = addEvent(world, { category: 'Biological', severity: 4, title: `Marsh fever emerges in ${civ.capital}`, description: 'Travelers report a contagious fever. Its spread follows population density and trade, while medical knowledge changes the outcome.', factions: [civ.id], location: civ.capital, tags: ['plague', 'disease'] });
    civ.disease = { id: nextId(world, 'disease'), name: 'Marsh fever', infected: Math.round(civ.population * .013), fatality: .12, transmissibility: .38, immunity: 0, startedYear: world.year, causeEventId: event.id, deaths: 0 };
    event.stateChanges.push({ entityId: civ.id, field: 'disease', before: null, after: { ...civ.disease } });
  }
  if (!civ.disease) return;
  const disease = civ.disease;
  const beforePopulation = civ.population; const beforeInfected = disease.infected;
  const time = Math.min(5, years);
  const susceptible = Math.max(0, civ.population * (1 - disease.immunity) - disease.infected);
  const newlyInfected = Math.round(susceptible * (1 - Math.exp(-disease.transmissibility * time)) * Math.min(.8, disease.infected / Math.max(1, civ.population) * 8 + .02));
  const affected = disease.infected + newlyInfected;
  const resolved = Math.min(affected, Math.round(affected * (1 - Math.exp(-.8 * time))));
  const medicalFactor = civ.technologies.includes('Germ Theory') ? .18 : civ.technologies.includes('Medicine') ? .55 : 1;
  const deaths = Math.min(civ.population - 1, Math.round(resolved * disease.fatality * medicalFactor));
  disease.infected = Math.max(0, affected - resolved);
  disease.immunity = clamp(disease.immunity + (resolved - deaths) / Math.max(1, beforePopulation), 0, .99);
  disease.deaths += deaths; civ.population -= deaths;
  for (const person of world.characters.filter(person => person.civId === civ.id && person.alive)) person.health = Math.max(0, person.health - deaths / Math.max(1, beforePopulation) * 70);
  const event = addEvent(world, { category: 'Biological', severity: deaths > 1000 ? 4 : 2, title: `${disease.name}: ${deaths.toLocaleString()} deaths in ${civ.name}`, description: `${disease.infected.toLocaleString()} residents remain infected. Fatality is ${Math.round(disease.fatality * medicalFactor * 100)}% of resolved cases; public health depends on known medicine.`, factions: [civ.id], causes: [disease.causeEventId], tags: ['disease', 'plague', 'deaths'], stateChanges: [{ entityId: civ.id, field: 'population', before: beforePopulation, after: civ.population }, { entityId: disease.id, field: 'infected', before: beforeInfected, after: disease.infected }] });
  disease.causeEventId = event.id;
  if (years > 10 || world.year - disease.startedYear > 7 || disease.infected < 10 || disease.immunity > .7) {
    addEvent(world, { category: 'Biological', severity: 3, title: `The ${disease.name} outbreak recedes`, description: `${disease.deaths.toLocaleString()} deaths remain in the record. Survivors remember the losses and the response of their leaders.`, factions: [civ.id], causes: [event.id], tags: ['recovery', 'disease'], stateChanges: [{ entityId: civ.id, field: 'disease', before: { ...disease }, after: null }] });
    delete civ.disease;
  }
}

function politics(world: World, civ: Civilization, years: number): void {
  if (!civ.active) return;
  const commoners = civ.groups.find(group => group.name === 'Commoners')!;
  if (commoners.happiness < 38 && chance(world, .035 + (38 - commoners.happiness) * .009, years)) {
    const leader = world.characters.find(person => person.civId === civ.id && person.alive && /farmer|reformer|artisan/i.test(person.role));
    const before = civ.stability; civ.stability = Math.max(0, civ.stability - 9);
    if (leader) { leader.role = 'Rebel leader'; leader.influence = Math.min(100, leader.influence + 22); leader.goals.unshift('Win political representation for the commoners'); }
    const protest = addEvent(world, { category: 'Political', severity: 4, title: `${leader?.name ?? 'The commoners'} leads a tax protest`, description: `Food security of ${civ.food.toFixed(2)} and a tax rate of ${Math.round(civ.taxRate * 100)}% drive organized opposition. Commoners act through their own group interests.`, actors: leader ? [leader.id] : [], factions: [civ.id], causes: recentCause(world, civ.id, ['shortage', 'taxes', 'drought']), tags: ['rebellion', 'unrest', 'protest'], stateChanges: [{ entityId: civ.id, field: 'stability', before, after: civ.stability }] });
    if (civ.stability < 37 && leader) {
      const former = civ.leaderId; const oldGovernment = civ.government;
      civ.leaderId = leader.id; leader.role = 'Ruler'; civ.government = 'Popular republic'; civ.taxRate = Math.max(.09, civ.taxRate - .045); civ.stability = 52; civ.happiness = Math.min(90, civ.happiness + 13);
      addEvent(world, { category: 'Political', severity: 5, title: `${leader.name} overturns the old order`, description: 'Organized resistance and declining legitimacy bring a revolution. The protest leader assumes power and promises lower taxes; the population and old record remain intact.', actors: [leader.id, former], factions: [civ.id], causes: [protest.id], tags: ['revolution', 'government'], stateChanges: [{ entityId: civ.id, field: 'leaderId', before: former, after: leader.id }, { entityId: civ.id, field: 'government', before: oldGovernment, after: civ.government }] });
    }
  }
  if ((civ.stability < 16 || (civ.population < 5000 && civ.food < .6)) && chance(world, .2, years)) {
    const old = civ.government; civ.active = false; civ.collapsedYear = world.year; civ.government = 'Interregnum'; civ.military = Math.round(civ.military * .35);
    addEvent(world, { category: 'Political', severity: 5, title: `${civ.name} collapses`, description: 'Local communities survive, but the central treasury, army and ruling institutions can no longer maintain authority. Its people continue as a diaspora.', factions: [civ.id], causes: recentCause(world, civ.id, ['rebellion', 'shortage', 'plague', 'war']), tags: ['collapse', 'historic'], stateChanges: [{ entityId: civ.id, field: 'active', before: true, after: false }, { entityId: civ.id, field: 'government', before: old, after: 'Interregnum' }] });
  }
}

function researchAndReligion(world: World, civ: Civilization, years: number): void {
  if (!civ.active) return;
  const scholar = world.characters.find(person => person.civId === civ.id && person.alive && /scholar/i.test(person.role));
  const researchBefore = civ.research;
  const support = civ.treasury > 10000 && civ.stability > 30 ? 1 : .22;
  civ.research += Math.min(years, 500) * (5.5 + civ.literacy * 25 + (scholar?.traits.curiosity ?? 50) / 100 * 3) * support;
  const eligible = TECHNOLOGIES.filter(tech => !civ.technologies.includes(tech.name) && tech.prerequisites.every(prerequisite => civ.technologies.includes(prerequisite)));
  const budget = years > 100 ? 4 : 1;
  for (let index = 0; index < budget; index++) {
    const available = eligible.filter(tech => !civ.technologies.includes(tech.name) && civ.research >= tech.cost);
    if (!available.length) break;
    const tech = available[Math.floor(random(world) * available.length)];
    civ.research -= tech.cost; const before = [...civ.technologies]; civ.technologies.push(tech.name);
    const event = addEvent(world, { category: 'Technological', severity: tech.name === 'Spaceflight' || tech.name === 'Electricity' ? 5 : 3, title: `${civ.name} develops ${tech.name}`, description: `${scholar?.name ?? 'Local scholars'} builds on ${tech.prerequisites.join(', ') || 'craft knowledge'}. ${tech.impact}. Funding and available prerequisites determine the discovery.`, actors: scholar ? [scholar.id] : [], factions: [civ.id], causes: recentCause(world, civ.id, ['research', 'technology']), tags: ['technology', 'research', tech.category.toLowerCase()], stateChanges: [{ entityId: civ.id, field: 'technologies', before, after: [...civ.technologies] }] });
    if (scholar) scholar.knowledge.push({ id: nextId(world, 'knowledge'), topic: tech.name, belief: tech.impact, confidence: .98, source: 'personal experiment', eventId: event.id, learnedYear: world.year, isRumor: false });
  }
  if (researchBefore !== civ.research) addEvent(world, { category: 'Scientific', severity: 1, title: `${civ.name} funds inquiry`, description: 'Scholarly skill, literacy, stability and available treasury set the research budget.', factions: [civ.id], tags: ['background', 'research'], stateChanges: [{ entityId: civ.id, field: 'research', before: researchBefore, after: civ.research }] });
  if (civ.stability < 24 && civ.technologies.length > 4 && chance(world, .025, years)) {
    const forgotten = civ.technologies.pop()!;
    addEvent(world, { category: 'Technological', severity: 4, title: `The practice of ${forgotten} is lost in ${civ.name}`, description: 'Dispersed specialists and neglected archives leave a gap between remembered ideas and usable technical knowledge.', factions: [civ.id], causes: recentCause(world, civ.id, ['rebellion', 'collapse']), tags: ['technology', 'regression'], stateChanges: [{ entityId: civ.id, field: 'technologies', before: [...civ.technologies, forgotten], after: [...civ.technologies] }] });
  }
  civ.literacy = clamp(civ.literacy + Math.min(years, 100) * (civ.technologies.includes('Printing') ? .004 : .0007) * support, 0, .98);
  const religion = world.religions.find(faith => faith.id === civ.religionId);
  if (!religion) return;
  if (world.religions.length < 15 && civ.technologies.includes('Printing') && chance(world, .014, years) && !religion.parentId) {
    const reformer = world.characters.find(person => person.civId === civ.id && person.alive && /reform|priest/i.test(person.role));
    const id = nextId(world, 'faith'); const name = `Reformed ${religion.name}`;
    religion.denominations.push(id);
    const followers = Math.round(religion.followers * .34); religion.followers -= followers;
    const shares = civ.attributes.religiousShares as Record<string, number> | undefined ?? { [religion.id]: .82 };
    const movedShare = (shares[religion.id] ?? .82) * .34;
    civ.attributes.religiousShares = { ...shares, [religion.id]: (shares[religion.id] ?? .82) - movedShare, [id]: movedShare };
    world.religions.push({ ...religion, id, name, origin: `${reformer?.name ?? 'Reformers'} calls for a return to founding principles`, doctrines: ['Conscience stands above inherited authority', ...religion.doctrines.slice(0, 2)], denominations: [], parentId: religion.id, followers, influence: 42, foundedYear: world.year, tags: ['reform', 'schism'] });
    civ.religionId = id; civ.stability = Math.max(0, civ.stability - 7);
    addEvent(world, { category: 'Religious', severity: 4, title: `${religion.name} splits`, description: `Printed debates and unequal political influence produce ${name}. ${followers.toLocaleString()} adherents join the new branch; older communities preserve the original doctrine.`, actors: reformer ? [reformer.id] : [], factions: [civ.id], causes: recentCause(world, civ.id, ['technology', 'unrest', 'canon']), tags: ['religion', 'schism'], stateChanges: [{ entityId: civ.id, field: 'religionId', before: religion.id, after: id }] });
  }
  if (civ.technologies.includes('Navigation') && !civ.attributes.exploredContinent && chance(world, .08, years)) {
    civ.attributes.exploredContinent = true;
    const sailor = world.characters.find(person => person.civId === civ.id && person.alive && /merchant|diplomat/i.test(person.role));
    addEvent(world, { category: 'Exploration', severity: 4, title: `${civ.name} reaches another continent`, description: 'Ocean navigation and supplies make a successful long voyage possible. The expedition reports unfamiliar coasts and exchanges knowledge with distant settlements.', actors: sailor ? [sailor.id] : [], factions: [civ.id], causes: recentCause(world, civ.id, ['technology']), tags: ['exploration', 'continent'] });
  }
}

function religiousCensus(world: World): void {
  const followers = Object.fromEntries(world.religions.map(faith => [faith.id, 0]));
  for (const civ of world.civilizations) {
    const shares = civ.attributes.religiousShares as Record<string, number> | undefined ?? { [civ.religionId]: .82 };
    const totalShare = Object.values(shares).reduce((total, share) => total + (Number.isFinite(share) ? Math.max(0, share) : 0), 0);
    for (const [id, share] of Object.entries(shares)) if (id in followers && Number.isFinite(share)) followers[id] += Math.floor(civ.population * Math.max(0, share) / Math.max(1, totalShare));
  }
  for (const faith of world.religions) {
    if (faith.followers === followers[faith.id]) continue;
    const before = faith.followers; faith.followers = followers[faith.id];
    addEvent(world, { category: 'Religious', severity: 1, title: `${faith.name}: community estimate updated`, description: `The faith has approximately ${faith.followers.toLocaleString()} adherents across all settlements. Conversion shares and population, including deaths, determine the census.`, tags: ['background', 'religion'], stateChanges: [{ entityId: faith.id, field: 'followers', before, after: faith.followers }] });
  }
}

function rumors(world: World, years: number): void {
  if (!chance(world, .14, years)) return;
  const living = world.characters.filter(person => person.alive);
  const source = living.find(person => /merchant|diplomat/i.test(person.role));
  if (!source) return;
  const subject = world.civilizations.find(civ => civ.active && civ.id !== source.civId);
  if (!subject) return;
  const estimate = Math.round(subject.military * (.5 + random(world) * 1.7));
  const recipients = living.filter(person => person.civId === source.civId && person.id !== source.id).slice(0, 4);
  const event = addEvent(world, { category: 'Cultural', severity: 2, title: `Rumors of ${subject.name}'s army spread`, description: `${source.name}'s traveling contacts report an army of roughly ${estimate.toLocaleString()}. This is an unverified estimate, distinct from the actual army ledger; retellings may exaggerate it.`, visibility: 'rumor', factions: [source.civId], actors: [source.id], causes: recentCause(world, subject.id, ['war', 'battle']), tags: ['rumor', 'information', 'misinformation'] });
  for (const person of [source, ...recipients]) {
    const perceived = person.id === source.id ? estimate : Math.round(estimate * (.82 + random(world) * .4));
    const item = { id: nextId(world, 'knowledge'), topic: `${subject.id} military`, belief: `Reports put ${subject.name}'s army at approximately ${perceived.toLocaleString()}.`, perceived, confidence: .37, source: person.id === source.id ? 'Unverified caravan report' : `${source.name}, retold through local contacts`, eventId: event.id, learnedYear: world.year, isRumor: true };
    person.knowledge.push(item);
    event.stateChanges.push({ entityId: person.id, field: 'knowledge', before: null, after: item });
  }
}

function trade(world: World, years: number): void {
  const active = world.civilizations.filter(civ => civ.active);
  for (let a = 0; a < active.length; a++) for (let b = a + 1; b < active.length; b++) {
    const left = active[a], right = active[b];
    if (world.wars.some(war => war.active && war.participants.includes(left.id) && war.participants.includes(right.id))) continue;
    const relation = left.relations.find(item => item.civId === right.id);
    if (!relation || relation.trust < 20) continue;
    const amount = Math.min(left.treasury * .01, right.treasury * .01, Math.min(years, 5) * relation.trade * 8);
    if (amount > 0) {
      // Trade transfer conserves total treasury; the exporter is whichever has a stronger harvest.
      const seller = left.food >= right.food ? left : right; const buyer = seller === left ? right : left;
      const sellerBefore = seller.treasury, buyerBefore = buyer.treasury;
      seller.treasury += amount; buyer.treasury -= amount;
      addEvent(world, { category: 'Economic', severity: 1, title: `${buyer.name} buys grain from ${seller.name}`, description: `${Math.round(amount).toLocaleString()} treasury units transfer along the trade route. This exchange conserves treasury across the participants.`, factions: [buyer.id, seller.id], tags: ['background', 'trade'], stateChanges: [{ entityId: seller.id, field: 'treasury', before: sellerBefore, after: seller.treasury }, { entityId: buyer.id, field: 'treasury', before: buyerBefore, after: buyer.treasury }] });
    }
    if (chance(world, .035, years)) {
      const available = left.technologies.filter(tech => !right.technologies.includes(tech));
      if (available.length) {
        const tech = available[Math.floor(random(world) * available.length)]; const before = [...right.technologies]; right.technologies.push(tech);
        addEvent(world, { category: 'Technological', severity: 3, title: `${tech} spreads to ${right.name}`, description: `Merchants and visiting craftspeople carry practical knowledge from ${left.name}.`, factions: [left.id, right.id], causes: recentCause(world, left.id, ['technology']), tags: ['technology', 'trade', 'diffusion'], stateChanges: [{ entityId: right.id, field: 'technologies', before, after: [...right.technologies] }] });
      }
    }
  }
}

function warfare(world: World, years: number): void {
  for (const civ of world.civilizations.filter(civ => civ.active)) {
    for (const relation of civ.relations) {
      const enemy = world.civilizations.find(other => other.id === relation.civId);
      if (!enemy?.active || world.wars.some(war => war.active && war.participants.includes(civ.id))) continue;
      const grievanceBefore = relation.grievance;
      relation.grievance = clamp(relation.grievance + (civ.food < 1 ? 1.1 : -.4) * Math.min(years, 10), 0, 100);
      const rate = .002 + Math.max(0, relation.grievance - 30) * .0003;
      if (relation.alliance || civ.military < 1000 || !chance(world, rate, years)) continue;
      const cause = addEvent(world, { category: 'Diplomatic', severity: 3, title: `${civ.name} demands access to border resources`, description: `Grievance rises from ${Math.round(grievanceBefore)} to ${Math.round(relation.grievance)}. Leaders view military strength as a means to solve shortages and rival claims.`, factions: [civ.id, enemy.id], actors: [civ.leaderId], causes: recentCause(world, civ.id, ['shortage', 'grievance', 'rebellion']), tags: ['grievance', 'diplomacy'] });
      const id = nextId(world, 'war');
      const commanders = world.characters.filter(person => person.alive && [civ.id, enemy.id].includes(person.civId) && /general/i.test(person.role)).map(person => person.id);
      const declaration = addEvent(world, { category: 'Military', severity: 4, title: `${civ.name} declares war on ${enemy.name}`, description: 'Border resources, stored grievances and available armies lead to open conflict. The war is resolved through logistics, morale, supplies and actual forces.', factions: [civ.id, enemy.id], actors: [civ.leaderId, ...commanders], causes: [cause.id], tags: ['war', 'declaration'] });
      world.wars.push({ id, name: `${civ.name.replace(/Kingdom of |Republic of /g, '')}–${enemy.name.replace(/Kingdom of |Republic of /g, '')} Border War`, attackerId: civ.id, defenderId: enemy.id, participants: [civ.id, enemy.id], cause: cause.description, causeEventId: declaration.id, goals: ['Control border grain routes'], startedYear: world.year, active: true, casualties: 0, battles: [], morale: { [civ.id]: civ.happiness, [enemy.id]: enemy.happiness }, commanderIds: commanders, logistics: { [civ.id]: civ.food, [enemy.id]: enemy.food } });
      declaration.stateChanges.push({ entityId: id, field: 'active', before: false, after: true });
      relation.trust = 8;
      break;
    }
  }
  for (const war of world.wars.filter(war => war.active)) {
    const attacker = world.civilizations.find(civ => civ.id === war.attackerId)!;
    const defender = world.civilizations.find(civ => civ.id === war.defenderId)!;
    war.commanderIds = world.characters.filter(person => person.alive && war.participants.includes(person.civId) && /general/i.test(person.role)).map(person => person.id);
    if (years < .08 && !chance(world, 4, years)) continue;
    const beforeA = attacker.population, beforeD = defender.population, beforeArmyA = attacker.military, beforeArmyD = defender.military;
    const powerA = attacker.military * Math.max(.2, attacker.food) * (1 + attacker.technologies.length * .05) * (.75 + random(world) * .5);
    const powerD = defender.military * Math.max(.2, defender.food) * (1 + defender.technologies.length * .05) * (.85 + random(world) * .5);
    const intensity = Math.min(.4, .035 * Math.min(years, 5));
    const lossA = Math.min(attacker.military, Math.round(attacker.military * intensity * (powerA >= powerD ? .7 : 1.4)));
    const lossD = Math.min(defender.military, Math.round(defender.military * intensity * (powerD > powerA ? .7 : 1.4)));
    attacker.military -= lossA; defender.military -= lossD; attacker.population = Math.max(1, attacker.population - lossA); defender.population = Math.max(1, defender.population - lossD); war.casualties += lossA + lossD;
    war.morale[attacker.id] = clamp(war.morale[attacker.id] - lossA / Math.max(1, beforeArmyA) * 40, 0, 100);
    war.morale[defender.id] = clamp(war.morale[defender.id] - lossD / Math.max(1, beforeArmyD) * 40, 0, 100);
    const winner = powerA >= powerD ? attacker : defender; const loser = winner === attacker ? defender : attacker;
    const event = addEvent(world, { category: 'Military', severity: lossA + lossD > 2000 ? 4 : 3, title: `Battle of the ${winner.id === 'esen' ? 'Tal Ridge' : 'Avarian border'}`, description: `${winner.name} gains the advantage. ${lossA.toLocaleString()} attackers and ${lossD.toLocaleString()} defenders die; supply and morale determine the result.`, factions: war.participants, actors: war.commanderIds, causes: [war.battles.at(-1) ?? war.causeEventId], tags: ['war', 'battle', 'deaths'], stateChanges: [{ entityId: attacker.id, field: 'population', before: beforeA, after: attacker.population }, { entityId: defender.id, field: 'population', before: beforeD, after: defender.population }, { entityId: attacker.id, field: 'military', before: beforeArmyA, after: attacker.military }, { entityId: defender.id, field: 'military', before: beforeArmyD, after: defender.military }] });
    war.battles.push(event.id);
    if (world.year - war.startedYear > 3 + random(world) * 4 || !attacker.active || !defender.active || war.morale[loser.id] < 30) {
      war.active = false; war.endedYear = world.year; war.winnerId = winner.id;
      const cells = world.geography.cells.filter(cell => cell.civId === loser.id && !world.geography.settlements.some(city => city.x === cell.x && city.y === cell.y));
      const transfer = Math.min(16, Math.floor(cells.length * .02));
      for (const cell of cells.slice(0, transfer)) cell.civId = winner.id;
      const oldWinnerTerritory = winner.territory, oldLoserTerritory = loser.territory;
      winner.territory += transfer; loser.territory = Math.max(0, loser.territory - transfer);
      addEvent(world, { category: 'Diplomatic', severity: 4, title: `Peace ends the ${war.name}`, description: `${winner.name} receives ${transfer} border districts. ${war.casualties.toLocaleString()} lives were lost; both societies retain their populations, institutions and historical claims.`, factions: war.participants, causes: [event.id], tags: ['war', 'peace', 'territory'], stateChanges: [{ entityId: war.id, field: 'active', before: true, after: false }, { entityId: winner.id, field: 'territory', before: oldWinnerTerritory, after: winner.territory }, { entityId: loser.id, field: 'territory', before: oldLoserTerritory, after: loser.territory }] });
      for (const civ of [attacker, defender]) for (const relation of civ.relations.filter(item => war.participants.includes(item.civId))) { relation.grievance *= .6; relation.trust = 28; }
    }
  }
}

function canonConsequences(world: World, years: number): void {
  for (const canon of world.canon) {
    if (canon.origin !== 'intervention' && canon.origin !== 'creation') continue;
    if (Number(canon.attributes?.nextInteractionYear ?? canon.year + 7) > world.year) continue;
    if (!canon.attributes) canon.attributes = {};
    canon.attributes.nextInteractionYear = world.year + 9 + Math.floor(random(world) * 13);
    const civ = world.civilizations.find(civ => canon.entityIds.includes(civ.id) && civ.active) ?? world.civilizations.find(civ => civ.active);
    if (!civ) continue;
    const scholar = world.characters.find(person => person.alive && person.civId === civ.id && /scholar|priest|reform/i.test(person.role));
    const tags = canon.tags.join(' ').toLowerCase();
    let title = `${civ.name} reinterprets a lasting mystery`;
    let description = `Communities debate the recorded phenomenon: “${canon.description}”. Its existence remains canon; interpretations depend on inherited beliefs.`;
    const stateChanges: HistoryEvent['stateChanges'] = [];
    if (/dragon/.test(tags)) {
      if (!civ.technologies.includes('Dragon husbandry') && civ.technologies.includes('Medicine') && chance(world, .07, Math.min(years, 8))) {
        const before = [...civ.technologies]; civ.technologies.push('Dragon husbandry'); title = 'The first dragon keepers establish a guild'; description = `Drawing on medicine and generations of observation, ${civ.name} develops safe handling methods. Dragon culture grows from an earlier reality change.`;
        stateChanges.push({ entityId: civ.id, field: 'technologies', before, after: [...civ.technologies] });
      } else { title = 'Dragons enter the heraldry of Avaria'; description = `Witness accounts become folk songs, temple carvings and military banners in ${civ.name}. Scholars disagree over whether the creatures are sacred or natural.`; }
    } else if (/monolith|artifact|portal|magic/.test(tags)) {
      title = `Scholars investigate ${/portal/.test(tags) ? 'the portal' : /monolith/.test(tags) ? 'the black monolith' : 'an extraordinary phenomenon'}`;
      description = `Researchers in ${civ.capital} collect evidence about “${canon.description}”. Priests preserve a competing spiritual account.`;
      const before = civ.research; civ.research += 14; stateChanges.push({ entityId: civ.id, field: 'research', before, after: civ.research });
    } else if (/vampir|monster/.test(tags)) {
      title = 'Night-watch customs spread through the settlements'; description = `Recorded encounters with “${canon.description}” lead to new community precautions and conflicting popular histories.`;
    }
    const causedBy = typeof canon.attributes.eventId === 'string' ? [canon.attributes.eventId] : world.events.filter(event => event.tags.includes('canon') && event.description.includes(canon.description)).map(event => event.id).slice(-1);
    const event = addEvent(world, { category: 'Cultural', severity: 3, title, description, factions: [civ.id], actors: scholar ? [scholar.id] : [], causes: causedBy, tags: ['canon', 'legacy', ...canon.tags], stateChanges });
    canon.disputedFacts.push(`Year ${world.year}: ${title}. Communities disagree about its meaning.`);
    if (scholar) scholar.knowledge.push({ id: nextId(world, 'knowledge'), topic: canon.description, belief: description, confidence: .65, source: 'research and conflicting witnesses', eventId: event.id, learnedYear: world.year, isRumor: false });
  }
}

function stoppingMatch(condition: ParsedTime['until'], events: HistoryEvent[], trackedLeaderIds: Set<string>, world: World, trackedWarIds: Set<string>): boolean {
  switch (condition) {
    case 'ruler-death': return world.characters.some(person => trackedLeaderIds.has(person.id) && !person.alive);
    case 'war-end': return world.wars.some(war => (trackedWarIds.size === 0 || trackedWarIds.has(war.id)) && !war.active && events.some(event => event.tags.includes('peace')));
    case 'major-event': return events.some(event => event.severity >= 4);
    case 'exploration': return events.some(event => event.category === 'Exploration');
    case 'war': return events.some(event => event.tags.includes('declaration'));
    case 'collapse': return events.some(event => event.tags.includes('collapse'));
    case 'religion': return events.some(event => event.tags.includes('schism') || event.tags.includes('new-religion'));
    case 'technology': return events.some(event => event.category === 'Technological' && event.severity >= 3);
    case 'plague': return events.some(event => event.tags.includes('plague'));
    default: return false;
  }
}

/** Mutates the supplied world. Persistence/automatic pre-change snapshots are owned by the caller. */
export function advanceWorld(world: World, command: string): AdvanceResult {
  const parsed = parseTime(command);
  const fromYear = world.year; const initialCount = world.events.length;
  const namedCiv = world.civilizations.find(civ => command.toLowerCase().includes(civ.id) || command.toLowerCase().includes(civ.name.toLowerCase()));
  const rulerCivs = namedCiv ? [namedCiv] : /any|a ruler|a king|a queen/i.test(command) ? world.civilizations : [world.civilizations.find(civ => civ.active && /monarch/i.test(civ.government)) ?? world.civilizations[0]];
  const trackedLeaders = new Set(rulerCivs.map(civ => civ.leaderId));
  const trackedWars = new Set(world.wars.filter(war => war.active).map(war => war.id));
  const exactDays = parsed.years * 365 + (parsed.until ? 0 : clamp(Number(world.attributes.calendarRemainderDays ?? 0), 0, 1));
  const targetDays = Math.floor(exactDays + 1e-7);
  if (!Number.isSafeInteger(targetDays) || world.year + parsed.years > 2e12) throw new Error('This duration exceeds the calendar’s supported numerical precision.');
  const baseStepDays = Math.max(1, Math.round(chooseStep(parsed.years, !!parsed.until) * 365));
  let elapsedDays = 0, steps = 0, stoppedReason: string | undefined;
  // Conditions have a bounded horizon; fixed durations are always honored exactly.
  while (elapsedDays < targetDays && steps < 750) {
    const days = Math.min(baseStepDays, targetDays - elapsedDays); const years = days / 365;
    const oldCount = world.events.length;
    const serialDay = world.year * 365 + world.day + days;
    world.year = Math.floor(serialDay / 365); world.day = serialDay % 365;
    world.tick++;
    if (years > 20) updateAgents(world, years);
    for (const civ of world.civilizations) {
      environmentAndDisease(world, civ, years);
      economyAndPopulation(world, civ, years);
      politics(world, civ, years);
      researchAndReligion(world, civ, years);
    }
    trade(world, years);
    warfare(world, years);
    if (years <= 20) updateAgents(world, years);
    canonConsequences(world, years);
    religiousCensus(world);
    rumors(world, years);
    // Expanded life events inside a coarse interval precede its aggregate balance sheet.
    world.events.sort((left, right) => left.timestamp - right.timestamp);
    elapsedDays += days; steps++;
    recordPopulation(world);
    if (parsed.until && stoppingMatch(parsed.until, world.events.slice(oldCount), trackedLeaders, world, trackedWars)) { stoppedReason = `Condition reached: ${parsed.label}`; break; }
  }
  if (parsed.until && !stoppedReason) stoppedReason = `No matching event occurred within ${Math.round(elapsedDays / 365)} years. The world remains at the reached date.`;
  if (!parsed.until && elapsedDays < targetDays) throw new Error('Adaptive step limit reached unexpectedly.');
  if (!parsed.until) world.attributes.calendarRemainderDays = clamp(exactDays - targetDays, 0, 1);
  const mostAdvanced = Math.max(...world.civilizations.map(civ => civ.technologies.length));
  world.era = mostAdvanced >= 19 ? 'Age of Stars' : mostAdvanced >= 16 ? 'Information Age' : mostAdvanced >= 13 ? 'Industrial Age' : mostAdvanced >= 9 ? 'Age of Discovery' : 'Age of Iron';
  world.updatedAt = new Date().toISOString();
  const events = world.events.slice(initialCount);
  return { world, summary: { fromYear, toYear: world.year, duration: parsed.label, steps, events, eventCount: events.length, ...(stoppedReason ? { stoppedReason } : {}) } };
}
