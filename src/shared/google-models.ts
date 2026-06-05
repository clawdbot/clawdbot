// Google model helpers normalize Google model identifiers and aliases.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Return true when a model id/name refers to the Gemma 4 family. */
export function isGemma4ModelId(modelId?: string | null): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return /(?:^|[/_:-])gemma[-_]?4(?:$|[/_.:-])/.test(normalized);
}
