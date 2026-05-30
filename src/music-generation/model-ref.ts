import { parseGenerationModelRef } from "../../packages/media-generation-core/src/model-ref.js";

export function parseMusicGenerationModelRef(
  raw: string | undefined,
): { provider: string; model: string } | null {
  return parseGenerationModelRef(raw);
}
