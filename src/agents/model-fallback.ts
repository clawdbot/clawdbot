import { shouldDiscardDeferredSessionSuspension } from "./model-fallback-attempt.js";
import { resolveCooldownDecision } from "./model-fallback-cooldown.js";

export {
  resolveImageFallbackCandidates,
  resolveImageFallbackDefaultProvider,
  resolveModelCandidateChain,
} from "./model-fallback-candidates.js";
export {
  isFallbackSummaryError,
  type ModelFallbackResultClassification,
} from "./model-fallback-attempt.js";
export { runWithModelFallback } from "./model-fallback-runner.js";
export { runWithImageModelFallback } from "./model-fallback-image.js";

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.modelFallbackTestApi")] = {
    resolveCooldownDecision,
    shouldDiscardDeferredSessionSuspension,
  };
}
