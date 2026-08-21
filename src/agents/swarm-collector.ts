import { stableStringify, truncateUtf16Safe } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCommitHash } from "../infra/git-commit.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { VERSION } from "../version.js";
import { sanitizeUserFacingText } from "./embedded-agent-helpers/sanitize-user-facing-text.js";
import { ensureCompletionState } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { backfillCollectorArchiveAtMs } from "./subagent-registry-helpers.js";
import type {
  SubagentRunRecord,
  SwarmCollectorCompletion,
  SwarmCollectorStatus,
  SwarmTerminalEvidence,
} from "./subagent-registry.types.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";
import { hashSwarmEvidenceBytes } from "./swarm-replay-ledger.js";
import { consumeSwarmStructuredOutput } from "./tools/structured-output-tool.js";

const SWARM_TERMINAL_FAILURE_MAX_CHARS = 1_000;

function stripControlCharacters(value: string): string {
  const c0Start = String.fromCharCode(0x00);
  const c0End = String.fromCharCode(0x1f);
  const del = String.fromCharCode(0x7f);
  const c1Start = String.fromCharCode(0x80);
  const c1End = String.fromCharCode(0x9f);
  return value.replace(new RegExp(`[${c0Start}-${c0End}${del}${c1Start}-${c1End}]`, "g"), " ");
}

function resolveBoundedExecutionFailure(entry: SubagentRunRecord): string | undefined {
  const raw = entry.execution.outcome?.error;
  if (!raw || raw === "completed") {
    return undefined;
  }
  const sanitized = stripControlCharacters(sanitizeUserFacingText(raw, { errorContext: true }))
    .replace(/\s+/g, " ")
    .trim();
  if (!sanitized) {
    return undefined;
  }
  if (sanitized.length <= SWARM_TERMINAL_FAILURE_MAX_CHARS) {
    return sanitized;
  }
  return `${truncateUtf16Safe(sanitized, SWARM_TERMINAL_FAILURE_MAX_CHARS - 1).trimEnd()}…`;
}

function resolveStatus(
  entry: SubagentRunRecord,
  hasStructuredResult: boolean,
): SwarmCollectorStatus {
  if (entry.endedReason === SUBAGENT_ENDED_REASON_KILLED) {
    return "killed";
  }
  if (entry.execution.outcome?.status === "timeout") {
    return "timeout";
  }
  if (entry.execution.outcome?.status === "ok") {
    return "done";
  }
  // Tool-only structured turns can surface the runner's synthetic completion
  // marker as an error despite having fulfilled the collector contract.
  return hasStructuredResult && entry.execution.outcome?.error === "completed" ? "done" : "failed";
}

function resolveRuntimePins(
  entry: SubagentRunRecord,
  session: ReturnType<typeof loadSubagentSessionEntry>,
): SwarmTerminalEvidence["runtime"] {
  const harness = session?.agentHarnessId ?? session?.agentRuntimeOverride;
  const provider = session?.modelProvider ?? session?.providerOverride;
  const modelName = session?.model ?? session?.modelOverride ?? entry.model;
  const model =
    modelName && provider && !modelName.includes("/") ? `${provider}/${modelName}` : modelName;
  const commit = resolveCommitHash({ moduleUrl: import.meta.url });
  return {
    openClawVersion: VERSION,
    openClawBuildIdentity: commit ? `git:${commit}` : `version:${VERSION}`,
    ...(harness ? { harness } : {}),
    ...(model ? { model } : {}),
    ...(session?.reasoningLevel ? { reasoning: session.reasoningLevel } : {}),
    ...(session?.thinkingLevel ? { thinking: session.thinkingLevel } : {}),
    ...(entry.swarmEffectiveAuthorityProof
      ? { authorityProof: entry.swarmEffectiveAuthorityProof }
      : {}),
  };
}

function buildTerminalEvidence(params: {
  entry: SubagentRunRecord;
  completion: SwarmCollectorCompletion;
  endedAt: number;
  frozenAt: number;
  session: ReturnType<typeof loadSubagentSessionEntry>;
}): SwarmTerminalEvidence | undefined {
  const { entry } = params;
  const replayKey = entry.swarmLaunchReplayKey;
  const requestFingerprint = entry.swarmLaunchRequestFingerprint;
  const launchIdentityDigest = entry.swarmLaunchIdentityDigest;
  const requesterSessionId = entry.swarmRequesterSessionId;
  const authority = entry.swarmLaunchAuthority;
  if (
    !replayKey ||
    !requestFingerprint?.startsWith("sha256:") ||
    !launchIdentityDigest ||
    !requesterSessionId ||
    !authority
  ) {
    return undefined;
  }
  const schemaCanonicalJson = stableStringify(entry.outputSchema ?? null);
  const resultCanonicalJson =
    params.completion.structured === undefined
      ? undefined
      : stableStringify(params.completion.structured);
  return {
    evidenceContractVersion: 1,
    launchIdentityDigest,
    runId: entry.swarmRunId ?? entry.runId,
    sessionKey: entry.childSessionKey,
    agentId: resolveAgentIdFromSessionKey(entry.childSessionKey),
    requesterSessionKey: entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
    requesterSessionId,
    ...(entry.swarmRequesterLifecycleRevision
      ? { requesterLifecycleRevision: entry.swarmRequesterLifecycleRevision }
      : {}),
    ...(entry.taskRunId ? { taskId: entry.taskRunId } : {}),
    replayKey,
    requestFingerprint: requestFingerprint as `sha256:${string}`,
    authority,
    schemaContractVersion: "openclaw/agent-structured-result/v1",
    schemaCanonicalJson,
    schemaHash: hashSwarmEvidenceBytes(schemaCanonicalJson),
    ...(resultCanonicalJson !== undefined
      ? {
          result: {
            canonicalJson: resultCanonicalJson,
            contentHash: hashSwarmEvidenceBytes(resultCanonicalJson),
          },
        }
      : {}),
    outcome: {
      status: params.completion.status,
      ...(params.completion.schemaError ? { schemaError: params.completion.schemaError } : {}),
      ...(params.completion.failure ? { failure: params.completion.failure } : {}),
    },
    endedAt: params.endedAt,
    frozenAt: params.frozenAt,
    runtime: resolveRuntimePins(entry, params.session),
    ...(params.completion.usage ? { usage: params.completion.usage } : {}),
  };
}

/** Freeze the waitable collector record after raw completion capture. */
export function updateSwarmCollectorCompletion(
  entry: SubagentRunRecord,
  cfg: OpenClawConfig,
): boolean {
  if (!entry.collect) {
    return false;
  }
  const clearedPendingLaunch = entry.swarmLaunchPending === true;
  entry.swarmLaunchPending = false;
  const completion = ensureCompletionState(entry);
  const capturedAtAdded = completion.capturedAt === undefined;
  completion.capturedAt ??= Date.now();
  const endedAtAdded = entry.execution.endedAt === undefined;
  entry.execution.endedAt ??= completion.capturedAt;
  const archiveDeadlineAdded = backfillCollectorArchiveAtMs(entry, cfg);
  if (entry.collectorCompletion) {
    return clearedPendingLaunch || capturedAtAdded || endedAtAdded || archiveDeadlineAdded;
  }
  const executionCaptured = consumeSwarmStructuredOutput(entry.runId);
  const publicCaptured =
    entry.swarmRunId && entry.swarmRunId !== entry.runId
      ? consumeSwarmStructuredOutput(entry.swarmRunId)
      : undefined;
  const captured = executionCaptured ?? publicCaptured ?? entry.structuredOutput;
  entry.structuredOutput = undefined;
  const outputSchemaError = entry.outputSchema
    ? (captured?.schemaError ??
      (captured?.structured === undefined ? "structured_output was not called" : undefined))
    : undefined;
  const authorityProofError =
    entry.swarmLaunchAuthority && !entry.swarmEffectiveAuthorityProof
      ? "factory native effective authority proof was not durably recorded"
      : undefined;
  const schemaError = outputSchemaError ?? authorityProofError;
  const session = loadSubagentSessionEntry({ childSessionKey: entry.childSessionKey });
  const usage =
    typeof session?.inputTokens === "number" || typeof session?.outputTokens === "number"
      ? {
          inputTokens: session.inputTokens ?? 0,
          outputTokens: session.outputTokens ?? 0,
        }
      : undefined;
  const resolvedStatus = resolveStatus(entry, captured?.structured !== undefined);
  const failure = resolveBoundedExecutionFailure(entry);
  const next = {
    status: schemaError && resolvedStatus === "done" ? ("failed" as const) : resolvedStatus,
    ...(captured?.structured !== undefined ? { structured: captured.structured } : {}),
    ...(schemaError ? { schemaError } : {}),
    ...(failure ? { failure } : {}),
    ...(usage ? { usage } : {}),
  };
  if (JSON.stringify(entry.collectorCompletion) === JSON.stringify(next)) {
    return false;
  }
  entry.collectorCompletion = next;
  if (!entry.swarmTerminalEvidence) {
    entry.swarmTerminalEvidence = buildTerminalEvidence({
      entry,
      completion: next,
      endedAt: entry.execution.endedAt,
      frozenAt: completion.capturedAt,
      session,
    });
  }
  return true;
}
