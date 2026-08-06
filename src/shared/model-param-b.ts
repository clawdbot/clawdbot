// Model parameter B helpers normalize provider-specific reasoning budget values.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Infers the largest `<number>b` parameter-size token from a model id or display name. */
export function inferParamBFromIdOrName(text: string): number | null {
  const raw = normalizeLowercaseStringOrEmpty(text);
  // Trailing boundary is a lookahead so two adjacent `<num>b` tokens sharing one delimiter (e.g.
  // "8b 70b" / "8b-70b") both match; a consuming boundary ate the delimiter and skipped the second.
  const matches = raw.matchAll(/(?:^|[^a-z0-9])[a-z]?(\d+(?:\.\d+)?)b(?=[^a-z0-9]|$)/g);
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
