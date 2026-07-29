// Video model ref helpers parse provider-qualified video generation model ids.
import { parseGenerationModelRef } from "../../packages/media-generation-core/src/model-ref.js";

// Video model refs share the generic media-generation provider/model grammar:
// "provider/model" when explicit, otherwise null for default resolution.
export function parseVideoGenerationModelRef(
  raw: string | undefined,
): { provider: string; model: string } | null {
  return parseGenerationModelRef(raw);
}
