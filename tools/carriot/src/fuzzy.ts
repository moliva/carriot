const BOUNDARY = /[\s\-_/·:.#(]/;
const atBoundary = (text: string, i: number) => i === 0 || BOUNDARY.test(text[i - 1]);

/**
 * fzf-style match: every whitespace-separated term must appear in `text` in order, with its letters close together
 * (or as a plain substring with `substringOnly`). Returns null when a term is missing; higher is better: substrings
 * beat scattered letters, and word starts and early hits rank up.
 */
export function fuzzyScore(query: string, text: string, opts: { substringOnly?: boolean } = {}): number | null {
  const hay = text.toLowerCase();
  let total = 0;
  for (const term of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const score = termScore(term, hay, opts.substringOnly ?? false);
    if (score === null) return null;
    total += score;
  }
  return total;
}

/** Letters further apart than this are not a match; it keeps "trad" from matching across a whole sentence. */
const MAX_GAP = 6;

function termScore(term: string, hay: string, substringOnly: boolean): number | null {
  const sub = hay.indexOf(term);
  if (sub >= 0) return 100 + term.length * 4 - Math.min(sub, 30) + (atBoundary(hay, sub) ? 20 : 0);
  if (substringOnly) return null;
  // Try every place the first letter appears; a later start can give a tighter match than the first one.
  let best: number | null = null;
  for (let start = hay.indexOf(term[0]); start >= 0; start = hay.indexOf(term[0], start + 1)) {
    const score = scatteredFrom(term, hay, start);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}

function scatteredFrom(term: string, hay: string, start: number): number | null {
  let score = 1 + (atBoundary(hay, start) ? 3 : 0);
  let last = start;
  let run = 0;
  for (const ch of term.slice(1)) {
    const at = hay.indexOf(ch, last + 1);
    if (at < 0 || at - last - 1 > MAX_GAP) return null;
    run = at === last + 1 ? run + 1 : 0;
    score += 1 + run * 2 + (atBoundary(hay, at) ? 3 : 0) - Math.min(at - last - 1, 5) * 0.5;
    last = at;
  }
  return score;
}
