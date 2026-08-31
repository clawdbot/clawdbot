import {
  attachInternalToolResultProvenance,
  getInternalToolResultProvenance,
} from "../runtime/internal-hooks.js";

const coreTtsMediaByProvenance = new WeakMap<object, readonly string[]>();
// Attempt attestation stays on the exact result and operational run instance.
// Public fields and retained results cannot authorize a later run's delivery.
type CoreTtsAttemptProvenance = Readonly<{
  mediaUrls: readonly string[];
  operationalRunInstance: object;
}>;
const coreTtsProvenanceByAttemptResult = new WeakMap<object, CoreTtsAttemptProvenance>();

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
  operationalRunInstance: object,
): T {
  coreTtsProvenanceByAttemptResult.set(
    result,
    Object.freeze({ mediaUrls: Object.freeze([...mediaUrls]), operationalRunInstance }),
  );
  return result;
}

/** Transfer only built-in TTS provenance; callers cannot mint delivery authority. */
export function transferCoreTtsToolResultProvenance<T extends object>(
  toolResult: unknown,
  attemptResult: T,
  eligibleMediaUrls: readonly string[],
  operationalRunInstance: object,
): T {
  const toolMediaUrls = getCoreTtsToolResultMediaUrls(toolResult);
  if (!toolMediaUrls) {
    return attemptResult;
  }
  const eligible = new Set(eligibleMediaUrls.map((url) => url.trim()));
  const transferred = toolMediaUrls.filter((url) => eligible.has(url.trim()));
  if (transferred.length === 0) {
    return attemptResult;
  }
  const existing = coreTtsProvenanceByAttemptResult.get(attemptResult)?.mediaUrls ?? [];
  return markCoreTtsAttemptResult(
    attemptResult,
    [...new Set([...existing, ...transferred])],
    operationalRunInstance,
  );
}

/** Core lifecycle copies preserve attestation; plugin-created result copies stay untrusted. */
export function copyCoreTtsAttemptResultProvenance<T extends object>(source: object, target: T): T {
  const provenance = coreTtsProvenanceByAttemptResult.get(source);
  if (provenance) {
    coreTtsProvenanceByAttemptResult.set(target, provenance);
  }
  return target;
}

export function getCoreTtsAttemptResultMediaUrls(
  result: object,
  deliveredMediaUrls: readonly string[] | undefined,
  operationalRunInstance: object | undefined,
): string[] {
  const provenance = coreTtsProvenanceByAttemptResult.get(result);
  if (!provenance || provenance.operationalRunInstance !== operationalRunInstance) {
    return [];
  }
  const delivered = new Set(deliveredMediaUrls?.map((url) => url.trim()));
  return provenance.mediaUrls.filter((url) => delivered.has(url.trim()));
}
