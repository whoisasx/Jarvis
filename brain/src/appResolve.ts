const DISTINGUISHERS = new Set(['music', 'lite', 'go', 'tv', 'studio', 'kids', 'premium']);

export function normalizeAppText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value: string): string[] {
  return normalizeAppText(value)
    .split(' ')
    .filter(Boolean)
    .map(token => (token === 'yt' ? 'youtube' : token));
}

function sameTokens(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((token, index) => token === right[index]);
}

export function scoreAppName(queryRaw: string, labelRaw: string, packageRaw: string): number {
  const query = normalizeAppText(queryRaw);
  const label = normalizeAppText(labelRaw);
  const pkg = normalizeAppText(packageRaw);
  if (!query) return 0;

  if (packageRaw === queryRaw || packageRaw.toLowerCase() === queryRaw.toLowerCase()) return 100;

  const queryTokens = tokens(query);
  const labelTokens = tokens(label);
  const extra = labelTokens.filter(token => !queryTokens.includes(token));
  const extraDistinguisher = extra.some(token => DISTINGUISHERS.has(token));

  if (label === query || sameTokens(queryTokens, labelTokens)) return 95;
  if (extraDistinguisher) return 0;

  const lastSegment = packageRaw.split('.').pop()?.toLowerCase() ?? '';
  if (lastSegment && lastSegment === query.replace(/ /g, '')) return 90;
  if (pkg.replace(/ /g, '') === query.replace(/ /g, '')) return 88;
  if (label.startsWith(query) && extra.length === 0) return 82;
  if (label.includes(query) && extra.length === 0) return 72;
  if (pkg.includes(query) && extra.length === 0 && !labelTokens.some(token => DISTINGUISHERS.has(token))) return 64;

  if (queryTokens.length > 1 && queryTokens.every(token => label.includes(token) || pkg.includes(token))) {
    return extraDistinguisher ? 0 : 76;
  }
  return 0;
}

export function pickBestApp(
  query: string,
  apps: Array<{label: string; packageName: string}>,
): {label: string; packageName: string; score: number} | null {
  const ranked = apps
    .map(app => ({...app, score: scoreAppName(query, app.label, app.packageName)}))
    .filter(app => app.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0] ?? null;
}
