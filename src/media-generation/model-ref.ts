import { normalizeOptionalString } from "../shared/string-coerce.js";

type ParsedGenerationModelRef = {
  provider: string;
  model: string;
};

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
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}
