import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export function isGemma4ModelId(modelId?: string | null): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return /(?:^|[/_:-])gemma[-_]?4(?:$|[/_.:-])/.test(normalized);
}
