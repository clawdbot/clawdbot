// Replay-shim for the GitHub Copilot agent runtime.
//
// Owns three concerns:
//   1. Pre-call: should this attempt resume an existing SDK session or
//      start a new one? Honours `initialReplayState.sdkSessionId` and
//      `initialReplayState.replayInvalid`.
//   2. Post-call: if `resumeSession` fails, was the failure recoverable
//      (session-gone) so we should downgrade to `createSession`, or
//      unrecoverable so the error should surface as a prompt error?
//   3. Result-time: compute the `replayMetadata` to attach to the attempt
//      result, propagating prior state with worst-case-wins semantics so
//      the orchestrator never replays an attempt that may have committed
//      partial side effects.
//
// Host back-pointers (NOT imported here to keep the package boundary
// clean):
//   - `src/agents/pi-embedded-runner/replay-state.ts` — canonical
//     `EmbeddedRunReplayState` / `EmbeddedRunReplayMetadata` shapes
//     and `replayMetadataFromState`.
//   - `src/agents/pi-embedded-runner/run/types.ts` —
//     `AgentHarnessAttemptResult.replayMetadata` field requirement.

type ReplayDecision =
  | {
      readonly action: "resume";
      readonly sdkSessionId: string;
      readonly downgradedFromResume: false;
    }
  | {
      readonly action: "create";
      readonly downgradedFromResume: boolean;
      readonly downgradeReason: "no-replay-state" | "no-sdk-session-id" | "replay-invalid";
    };

interface ReplayShimInput {
  readonly sdkSessionId?: string;
  readonly replayInvalid?: boolean;
}

function normalizeSdkSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Pure pre-call decision: should attempt.ts call resumeSession or
 * createSession?
 *
 * Rules:
 *   - No input                            → create (no-replay-state)
 *   - No (trimmed) sdkSessionId          → create (no-sdk-session-id)
 *   - sdkSessionId + replayInvalid=true   → create (replay-invalid),
 *                                            downgradedFromResume=true
 *   - sdkSessionId + replayInvalid=false  → resume
 */
export function decideReplayAction(input?: ReplayShimInput): ReplayDecision {
  if (!input) {
    return {
      action: "create",
      downgradedFromResume: false,
      downgradeReason: "no-replay-state",
    };
  }
  const sdkSessionId = normalizeSdkSessionId(input.sdkSessionId);
  if (!sdkSessionId) {
    return {
      action: "create",
      downgradedFromResume: false,
      downgradeReason: "no-sdk-session-id",
    };
  }
  if (input.replayInvalid === true) {
    return {
      action: "create",
      downgradedFromResume: true,
      downgradeReason: "replay-invalid",
    };
  }
  return {
    action: "resume",
    sdkSessionId,
    downgradedFromResume: false,
  };
}

type ResumeFailureKind = "missing" | "unknown";

interface ResumeFailureClassification {
  readonly recoverable: boolean;
  readonly kind: ResumeFailureKind;
}

const MISSING_SESSION_CODES = new Set([
  "SESSION_NOT_FOUND",
  "session_not_found",
  "NotFound",
  "ENOENT",
]);

const MISSING_SESSION_MESSAGE_PATTERNS: readonly RegExp[] = [
  /\bsession not found\b/i,
  /\bsession .* not found\b/i,
  /\bunknown session id\b/i,
  /\bsession id .* (does not exist|not found)\b/i,
  /\bsession .* does not exist\b/i,
  /\bno such session\b/i,
];

function readErrorField(error: unknown, key: string): unknown {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return (error as Record<string, unknown>)[key];
}

/**
 * Post-call: classify a resumeSession() failure so attempt.ts can
 * decide whether to downgrade silently to createSession.
 *
 * Conservative: only treats clearly session-gone signals as recoverable.
 * Structured signals (status === 404, recognised code strings) are
 * checked first; message matching is a fallback because SDK error
 * messages are not part of the typed contract.
 *
 * Everything else (transport errors, auth failures, generic Error) is
 * unrecoverable and should surface to the outer attempt.ts try/catch
 * which converts it to a prompt error.
 */
export function classifyResumeFailure(error: unknown): ResumeFailureClassification {
  if (error === undefined || error === null) {
    return { recoverable: false, kind: "unknown" };
  }

  const status = readErrorField(error, "status");
  if (status === 404) {
    return { recoverable: true, kind: "missing" };
  }
  const statusCode = readErrorField(error, "statusCode");
  if (statusCode === 404) {
    return { recoverable: true, kind: "missing" };
  }

  const code = readErrorField(error, "code");
  if (typeof code === "string" && MISSING_SESSION_CODES.has(code)) {
    return { recoverable: true, kind: "missing" };
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object"
        ? typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : undefined
        : undefined;
  if (typeof message === "string") {
    for (const pattern of MISSING_SESSION_MESSAGE_PATTERNS) {
      if (pattern.test(message)) {
        return { recoverable: true, kind: "missing" };
      }
    }
  }

  return { recoverable: false, kind: "unknown" };
}

interface ReplayMetadataComputeInput {
  readonly priorReplayInvalid?: boolean;
  readonly priorHadPotentialSideEffects?: boolean;
  readonly thisAttemptTimedOut?: boolean;
  readonly thisAttemptHadPotentialSideEffects?: boolean;
  readonly thisAttemptDowngradedFromResume?: boolean;
  readonly thisAttemptResumeFailureRecovered?: boolean;
}

interface ComputedReplayMetadata {
  readonly hadPotentialSideEffects: boolean;
  readonly replaySafe: boolean;
}

/**
 * Compute the `EmbeddedRunReplayMetadata` to attach to the attempt
 * result. Worst-case-wins:
 *
 *   hadPotentialSideEffects = priorHadPotentialSideEffects OR timedOut
 *     OR thisAttemptHadPotentialSideEffects
 *     (timeout means we cannot prove the prompt was not partially
 *     committed server-side; treat as side-effecting so the
 *     orchestrator will not blindly re-issue the same prompt).
 *
 *   replaySafe = NOT (
 *     priorReplayInvalid
 *     OR thisAttemptDowngradedFromResume
 *     OR thisAttemptResumeFailureRecovered
 *     OR hadPotentialSideEffects
 *   )
 *
 * Matches the parity rule in
 * `src/agents/pi-embedded-runner/replay-state.ts#replayMetadataFromState`.
 */
export function computeReplayMetadata(input: ReplayMetadataComputeInput): ComputedReplayMetadata {
  const priorReplayInvalid = input.priorReplayInvalid === true;
  const priorHadPotentialSideEffects = input.priorHadPotentialSideEffects === true;
  const timedOut = input.thisAttemptTimedOut === true;
  const thisAttemptHadPotentialSideEffects = input.thisAttemptHadPotentialSideEffects === true;
  const downgraded = input.thisAttemptDowngradedFromResume === true;
  const recovered = input.thisAttemptResumeFailureRecovered === true;
  const hadPotentialSideEffects =
    priorHadPotentialSideEffects || timedOut || thisAttemptHadPotentialSideEffects;
  const replaySafe = !(priorReplayInvalid || downgraded || recovered || hadPotentialSideEffects);
  return { hadPotentialSideEffects, replaySafe };
}

const COPILOT_REPLAY_SAFE_READ_ONLY_TOOL_NAMES = new Set([
  "get",
  "file_read",
  "glob",
  "grep",
  "inspect",
  "list",
  "ls",
  "memory_get",
  "probe",
  "query",
  "read",
  "search",
  "sessions_history",
  "sessions_list",
  "status",
  "tool_search",
  "update_plan",
  "view",
  "web_fetch",
  "web_search",
]);

export function copilotToolMetasHavePotentialSideEffects(
  toolMetas?: readonly { asyncStarted?: boolean; toolName: string }[],
): boolean {
  return (toolMetas ?? []).some(
    (entry) => entry.asyncStarted === true || !isReplaySafeReadOnlyToolName(entry.toolName),
  );
}

function isReplaySafeReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return COPILOT_REPLAY_SAFE_READ_ONLY_TOOL_NAMES.has(normalized);
}
