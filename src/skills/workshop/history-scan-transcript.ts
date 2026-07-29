import { readTranscriptStatsSync } from "../../config/sessions/session-accessor.js";
import { readSessionMessagesAsync } from "../../gateway/session-transcript-readers.js";
import type { SkillHistoryScanCandidate } from "./history-scan-candidates.js";
import type { SkillHistoryScanPromptSession } from "./history-scan-prompt.js";
import {
  formatSkillHistoryScanTranscript,
  isSkillHistoryScanLocalTranscriptSizeEligible,
  prepareSkillHistoryScanReviewMessages,
} from "./history-scan-transcript-content.js";

export type SkillHistoryScanBatchSession = SkillHistoryScanPromptSession & {
  updatedAtMs: number;
};

const HISTORY_SCAN_MAX_CANDIDATES = 60;
const HISTORY_SCAN_MAX_SESSIONS = 20;
const HISTORY_SCAN_MAX_TRANSCRIPT_CHARS = 80_000;
export const HISTORY_SCAN_MAX_SESSION_CHARS = 16_000;
export const HISTORY_SCAN_SESSION_OVERHEAD_CHARS = 256;
const HISTORY_SCAN_DEFAULT_CONTEXT_TOKENS = 8_192;
const HISTORY_SCAN_MIN_MODEL_ITERATIONS = 6;

export function resolveSkillHistoryScanTranscriptBudget(contextTokens?: number): number {
  const effectiveContextTokens =
    Number.isFinite(contextTokens) && (contextTokens ?? 0) > 0
      ? Math.floor(contextTokens as number)
      : HISTORY_SCAN_DEFAULT_CONTEXT_TOKENS;
  return Math.min(
    HISTORY_SCAN_MAX_TRANSCRIPT_CHARS,
    Math.max(256, Math.floor(effectiveContextTokens * 0.35)),
  );
}

export async function readHistoryScanSession(params: {
  agentId: string;
  candidate: SkillHistoryScanCandidate;
  heartbeatPrompt: string;
  maxTranscriptChars: number;
  storePath: string;
}): Promise<SkillHistoryScanPromptSession | undefined> {
  const transcriptScope = {
    agentId: params.agentId,
    sessionId: params.candidate.entry.sessionId,
    sessionKey: params.candidate.sessionKey,
    sessionEntry: params.candidate.entry,
    storePath: params.storePath,
  };
  // Legacy rows may predate explicit hook provenance. Inspect every local turn
  // before choosing a bounded provider-facing window so old hook payloads can
  // never age out of the exclusion check.
  if (
    !isSkillHistoryScanLocalTranscriptSizeEligible(
      readTranscriptStatsSync(transcriptScope).sizeBytes,
    )
  ) {
    return undefined;
  }
  const allMessages = await readSessionMessagesAsync(transcriptScope, {
    mode: "full",
    reason: "Skill Workshop legacy hook provenance check",
  });
  const review = prepareSkillHistoryScanReviewMessages(allMessages, params.heartbeatPrompt);
  if (!review || review.modelIterations < HISTORY_SCAN_MIN_MODEL_ITERATIONS) {
    return undefined;
  }
  const transcript = formatSkillHistoryScanTranscript(review.messages, params.maxTranscriptChars);
  if (!transcript.trim()) {
    return undefined;
  }
  return {
    instanceId: params.candidate.instanceId,
    sessionKey: params.candidate.sessionKey,
    updatedAt: new Date(params.candidate.updatedAtMs).toISOString(),
    modelIterations: review.modelIterations,
    transcript,
  };
}

export async function collectSkillHistoryScanBatch(params: {
  candidates: readonly SkillHistoryScanCandidate[];
  isSessionActive?: (candidate: SkillHistoryScanCandidate) => boolean;
  maxTranscriptChars?: number;
  readSession: (
    candidate: SkillHistoryScanCandidate,
  ) => Promise<SkillHistoryScanPromptSession | undefined>;
}): Promise<{
  blockedByActive: boolean;
  considered: SkillHistoryScanCandidate[];
  sessions: SkillHistoryScanBatchSession[];
}> {
  const considered: SkillHistoryScanCandidate[] = [];
  const sessions: SkillHistoryScanBatchSession[] = [];
  const maxTranscriptChars = params.maxTranscriptChars ?? HISTORY_SCAN_MAX_TRANSCRIPT_CHARS;
  let blockedByActive = false;
  let transcriptChars = 0;
  for (const candidate of params.candidates.slice(0, HISTORY_SCAN_MAX_CANDIDATES)) {
    if (params.isSessionActive?.(candidate)) {
      blockedByActive = true;
      break;
    }
    const session = await params.readSession(candidate);
    // An active run can claim the session while its transcript is being read.
    // Stop before advancing the cursor so a later scan sees a stable snapshot.
    if (params.isSessionActive?.(candidate)) {
      blockedByActive = true;
      break;
    }
    if (
      session &&
      sessions.length > 0 &&
      transcriptChars + session.transcript.length + HISTORY_SCAN_SESSION_OVERHEAD_CHARS >
        maxTranscriptChars
    ) {
      break;
    }
    considered.push(candidate);
    if (!session) {
      continue;
    }
    const updatedAtMs = Date.parse(session.updatedAt);
    // Pending cursors must identify every reviewed session for exact replay.
    // Drop malformed sessions before they become canonical batch members.
    if (!Number.isFinite(updatedAtMs)) {
      continue;
    }
    sessions.push({ ...session, updatedAtMs });
    transcriptChars += session.transcript.length + HISTORY_SCAN_SESSION_OVERHEAD_CHARS;
    if (sessions.length >= HISTORY_SCAN_MAX_SESSIONS) {
      break;
    }
  }
  return { blockedByActive, considered, sessions };
}
