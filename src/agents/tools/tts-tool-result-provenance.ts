import {
  attachInternalToolResultProvenance,
  getInternalToolResultProvenance,
} from "../runtime/internal-hooks.js";

const coreTtsMediaByProvenance = new WeakMap<object, readonly string[]>();
// Attempt attestation stays on the exact result object. Public harness fields
// cannot create the source-suppression delivery authority checked at terminal output.
const coreTtsMediaByAttemptResult = new WeakMap<object, readonly string[]>();

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

export function markCoreTtsAttemptResult<T extends object>(
  result: T,
  mediaUrls: readonly string[],
): T {
  coreTtsMediaByAttemptResult.set(result, Object.freeze([...mediaUrls]));
  return result;
}

/** Core lifecycle copies preserve attestation; plugin-created result copies stay untrusted. */
export function copyCoreTtsAttemptResultProvenance<T extends object>(source: object, target: T): T {
  const mediaUrls = coreTtsMediaByAttemptResult.get(source);
  if (mediaUrls) {
    coreTtsMediaByAttemptResult.set(target, mediaUrls);
  }
  return target;
}

export function getCoreTtsAttemptResultMediaUrls(
  result: object,
  deliveredMediaUrls: readonly string[] | undefined,
): string[] {
  const delivered = new Set(deliveredMediaUrls?.map((url) => url.trim()));
  return (coreTtsMediaByAttemptResult.get(result) ?? []).filter((url) => delivered.has(url.trim()));
}
