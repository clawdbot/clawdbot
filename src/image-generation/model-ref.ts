import { parseGenerationModelRef } from "../../packages/media-generation-core/src/model-ref.js";

export function parseImageGenerationModelRef(
  raw: string | undefined,
): { provider: string; model: string } | null {
  return parseGenerationModelRef(raw);
}
