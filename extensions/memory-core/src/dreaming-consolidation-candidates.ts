import type { PromotionCandidate } from "./short-term-promotion-types.js";
import {
  isContaminatedDreamingSnippet,
  isShortTermSessionCorpusPath,
} from "./short-term-promotion-utils.js";

export function filterConsolidationCandidates(
  candidates: readonly PromotionCandidate[],
): PromotionCandidate[] {
  return candidates.filter(isConsolidationCandidateEligible);
}

/** Explicitly tainted origins must never promote through any durable write path. */
function isPromotionOriginBlocked(candidate: Pick<PromotionCandidate, "provenance">): boolean {
  const originClass = candidate.provenance?.originClass;
  return originClass === "untrusted" || originClass === "system";
}

type PromotionStaticRejectionReason =
  | "missing_provenance"
  | "origin_blocked"
  | "non_interactive_session"
  | "contaminated_snippet";

export function resolvePromotionStaticRejection(
  candidate: Pick<PromotionCandidate, "path" | "snippet" | "provenance">,
  options: { requireProvenance?: boolean } = {},
): PromotionStaticRejectionReason | null {
  if (options.requireProvenance && !candidate.provenance) {
    return "missing_provenance";
  }
  if (isPromotionOriginBlocked(candidate)) {
    return "origin_blocked";
  }
  const sessionCorpus = isShortTermSessionCorpusPath(candidate.path.replaceAll("\\", "/"));
  if (sessionCorpus && candidate.provenance?.sessionKind !== "interactive") {
    return "non_interactive_session";
  }
  if (
    isContaminatedDreamingSnippet(candidate.snippet, {
      allowTranscriptTurnSnippet: sessionCorpus,
    })
  ) {
    return "contaminated_snippet";
  }
  return null;
}

export function isConsolidationCandidateEligible(candidate: PromotionCandidate): boolean {
  const trustedOrigin =
    candidate.provenance?.originClass === "owner" || candidate.provenance?.originClass === "agent";
  const normalizedPath = candidate.path.replaceAll("\\", "/");
  const sessionDerived =
    isShortTermSessionCorpusPath(normalizedPath) || normalizedPath.startsWith("sessions/");
  return trustedOrigin && (!sessionDerived || candidate.provenance?.sessionKind === "interactive");
}
