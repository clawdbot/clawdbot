// Media Generation Core module implements model ref behavior.
import { normalizeOptionalString } from "./string.js";

/** Provider/model pair parsed from a generation model reference like `provider/model`. */
export type ParsedGenerationModelRef = {
  provider: string;
  model: string;
};

/** Parses strict generation model refs and rejects missing provider or model segments. */
export function parseGenerationModelRef(raw: string | undefined): ParsedGenerationModelRef | null {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return null;
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return null;
  }
  const provider = normalizeOptionalString(trimmed.slice(0, slashIndex));
  const model = normalizeOptionalString(trimmed.slice(slashIndex + 1));
  return provider && model ? { provider, model } : null;
}
