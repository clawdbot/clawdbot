import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  listSessionTranscriptInstances,
  type SessionTranscriptInstance,
} from "../../config/sessions/session-accessor.js";
import {
  compareSkillHistoryScanCandidates,
  isSkillHistoryScanSessionEligible,
} from "./history-scan-candidate-rules.js";
import type {
  SkillHistoryScanCursor,
  SkillHistoryScanDirection,
  SkillHistoryScanScope,
} from "./history-scan-state.js";

export type SkillHistoryScanCandidate = {
  entry: SessionTranscriptInstance["entry"];
  instanceId: string;
  sessionKey: string;
  updatedAtMs: number;
};

export function candidateOlderThanCursor(
  candidate: SkillHistoryScanCandidate,
  cursor: SkillHistoryScanCursor,
): boolean {
  return compareSkillHistoryScanCandidates(candidate, cursor) > 0;
}

function candidateNewerThanCursor(
  candidate: SkillHistoryScanCandidate,
  cursor: SkillHistoryScanCursor,
): boolean {
  return compareSkillHistoryScanCandidates(candidate, cursor) < 0;
}

export function selectSkillHistoryScanCandidates(params: {
  candidates: readonly SkillHistoryScanCandidate[];
  direction: SkillHistoryScanDirection;
  oldestCursor?: SkillHistoryScanCursor;
  newestCursor?: SkillHistoryScanCursor;
}): SkillHistoryScanCandidate[] {
  if (params.direction === "newer") {
    return params.newestCursor
      ? params.candidates
          .filter((candidate) => candidateNewerThanCursor(candidate, params.newestCursor!))
          .toReversed()
      : [...params.candidates].toReversed();
  }
  return params.oldestCursor
    ? params.candidates.filter((candidate) =>
        candidateOlderThanCursor(candidate, params.oldestCursor!),
      )
    : [...params.candidates];
}

export function listHistoryScanCandidates(
  params: SkillHistoryScanScope,
): SkillHistoryScanCandidate[] {
  const storePath = resolveStorePath(params.config.session?.store, {
    agentId: params.agentId,
    ...(params.env ? { env: params.env } : {}),
  });
  return listSessionTranscriptInstances({
    agentId: params.agentId,
    storePath,
    readConsistency: "latest",
    hydrateSkillPromptRefs: false,
    ...(params.env ? { env: params.env } : {}),
  })
    .filter(isSkillHistoryScanSessionEligible)
    .map(({ entry, sessionId, sessionKey, updatedAtMs }) => ({
      entry,
      instanceId: sessionId,
      sessionKey,
      updatedAtMs,
    }))
    .toSorted(compareSkillHistoryScanCandidates);
}
