// Parses model references for music generation requests.
import { parseGenerationModelRef } from "../../packages/media-generation-core/src/model-ref.js";

/**
 * Model reference parsing for music generation.
 *
 * Music generation uses the same provider/model ref grammar as other media
 * capabilities, but keeps this wrapper for a dedicated capability boundary.
 */
/** Parse a music generation model ref into provider and model ids. */
export function parseMusicGenerationModelRef(
  raw: string | undefined,
): { provider: string; model: string } | null {
  return parseGenerationModelRef(raw);
}
