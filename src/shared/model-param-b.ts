import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export function inferParamBFromIdOrName(text: string): number | null {
  const raw = normalizeLowercaseStringOrEmpty(text);
  const matches = raw.matchAll(/(?:^|[^a-z0-9])[a-z]?(\d+(?:\.\d+)?)b(?:[^a-z0-9]|$)/g);
  let best: number | null = null;
  for (const match of matches) {
    const numRaw = match[1];
    if (!numRaw) {
      continue;
    }
    const value = Number(numRaw);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    if (best === null || value > best) {
      best = value;
    }
  }
  return best;
}
