import type { ParsedTime } from './types';

const units: Record<string, number> = { day: 1 / 365, days: 1 / 365, week: 7 / 365, weeks: 7 / 365, month: 1 / 12, months: 1 / 12, year: 1, years: 1, decade: 10, decades: 10, century: 100, centuries: 100, millennium: 1000, millennia: 1000, eon: 1e9, eons: 1e9 };
const words: Record<string, string> = { a: '1', an: '1', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', twenty: '20', thirty: '30', forty: '40', fifty: '50', hundred: '100', thousand: '1000' };

/** Parses compound durations as well as stopping conditions. One civil year is 365 days. */
export function parseTime(command: string): ParsedTime {
  const original = command.trim();
  if (!original) throw new Error('Enter a duration such as 17 days, 47 years, or until the king dies.');
  let text = original.toLowerCase().replace(/,/g, '').replace(/\badvance\b|\bskip\b|\btime\b|\bforward\b|\bby\b|\bfast[- ]?forward\b/g, ' ').trim();
  if (/\buntil\b/.test(text)) {
    let until: ParsedTime['until'];
    if (/king|queen|ruler|emperor|leader|death|dies/.test(text)) until = 'ruler-death';
    else if (/war.*end|peace/.test(text)) until = 'war-end';
    else if (/continent|explor|ocean|discover.*land/.test(text)) until = 'exploration';
    else if (/collapse|fall.*civil/.test(text)) until = 'collapse';
    else if (/plague|disease/.test(text)) until = 'plague';
    else if (/religion|faith|schism/.test(text)) until = 'religion';
    else if (/technology|invention|research/.test(text)) until = 'technology';
    else if (/war/.test(text)) until = 'war';
    else if (/event|histor/.test(text)) until = 'major-event';
    else throw new Error('Supported conditions: ruler dies, war ends, exploration, major event, collapse, religion, technology, or plague.');
    return { years: until === 'exploration' ? 250 : 150, label: original, until };
  }
  text = text.replace(/\b(twenty|thirty|forty|fifty)[ -](one|two|three|four|five|six|seven|eight|nine)\b/g, (_, tens: string, ones: string) => String(Number(words[tens]) + Number(words[ones])));
  text = text.replace(/\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty)\b/g, word => words[word]);
  text = text.replace(/^\s*(hundred|thousand|million|billion)\s+(years?)/, '1 $1 $2');
  let years = 0;
  let matches = 0;
  const expression = /([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(million|billion|trillion|thousand|hundred|m|bn|b|k)?\s*(days?|weeks?|months?|years?|decades?|centur(?:y|ies)|millenni(?:um|a)|eons?)\b/g;
  let match: RegExpExecArray | null;
  let residual = text;
  while ((match = expression.exec(text))) {
    const multipliers: Record<string, number> = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9, trillion: 1e12, k: 1000, m: 1e6, b: 1e9, bn: 1e9 };
    const amount = Number(match[1]);
    if (amount <= 0) throw new Error('Time advances forward. Enter a positive duration. Use snapshots to rewind.');
    years += amount * (multipliers[match[2]] ?? 1) * units[match[3]];
    residual = residual.replace(match[0], ''); matches++;
  }
  if (!matches && /^\d+(\.\d+)?$/.test(text)) { years = Number(text); matches = 1; residual = ''; }
  if (!matches || residual.replace(/\band\b|[.\s]/g, '') !== '') throw new Error('Could not read that duration. Try “3 months”, “12,000 years”, “4.2 billion years”, or “until the king dies”.');
  if (!Number.isFinite(years) || years <= 0 || years > 1e12) throw new Error('Enter a positive duration of up to one trillion years.');
  if (years < 1 / 365) throw new Error('The minimum simulation step is one day.');
  return { years, label: original };
}

/** Bounded resolution protects interactive performance even across billions of years. */
export function chooseStep(totalYears: number, eventBased = false): number {
  if (eventBased) return 0.25;
  if (totalYears <= 31 / 365) return 1 / 365;
  if (totalYears <= 2) return 1 / 12;
  if (totalYears <= 20) return 0.25;
  if (totalYears <= 160) return 1;
  if (totalYears <= 1000) return 5;
  if (totalYears <= 12000) return 50;
  return totalYears / 96;
}
