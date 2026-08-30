import {
  attachInternalToolResultProvenance,
  getInternalToolResultProvenance,
} from "../runtime/internal-hooks.js";

const coreTtsMediaByProvenance = new WeakMap<object, readonly string[]>();

export function markCoreTtsToolResult<T extends object>(result: T, mediaUrls: string[]): T {
  const provenance = {};
  coreTtsMediaByProvenance.set(provenance, Object.freeze([...mediaUrls]));
  return attachInternalToolResultProvenance(result, provenance);
}

export function getCoreTtsToolResultMediaUrls(result: unknown): readonly string[] | undefined {
  if (typeof result !== "object" || result === null) {
    return undefined;
  }
  const provenance = getInternalToolResultProvenance(result);
  return provenance ? coreTtsMediaByProvenance.get(provenance) : undefined;
}
