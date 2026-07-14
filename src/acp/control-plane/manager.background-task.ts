/** Mirrors child ACP turns into detached-task status for requester-facing progress. */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import {
  createRunningTaskRun,
  completeTaskRunByRunId,
  failTaskRunByRunId,
  startTaskRunByRunId,
} from "../../tasks/detached-task-runtime.js";
import { resolveRequiredCompletionTerminalResult } from "../../tasks/task-completion-contract.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import type { AcpSessionManagerDeps } from "./manager.types.js";
import { normalizeText } from "./runtime-options.js";

const ACP_BACKGROUND_TASK_TEXT_MAX_LENGTH = 160;
const ACP_BACKGROUND_TASK_PROGRESS_MAX_LENGTH = 240;

/** Context needed to mirror a child ACP turn into the requester task registry. */
type BackgroundTaskContext = {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  childSessionKey: string;
  runId: string;
  label?: string;
  task: string;
};

/** Produces the bounded task label shown for a child ACP background run. */
function summarizeBackgroundTaskText(text: string): string {
  const normalized = normalizeText(text) ?? "ACP background task";
  if (normalized.length <= ACP_BACKGROUND_TASK_TEXT_MAX_LENGTH) {
    return normalized;
  }
  return `${truncateUtf16Safe(normalized, ACP_BACKGROUND_TASK_TEXT_MAX_LENGTH - 1)}…`;
}

/** Appends bounded progress text while preserving a single-line task summary. */
export function appendBackgroundTaskProgressSummary(current: string, chunk: string): string {
  const normalizedChunk = chunk.replace(/\s+/g, " ");
  if (!normalizedChunk) {
    return current;
  }
  const chunkToAppend = current ? normalizedChunk : normalizedChunk.trimStart();
  if (!chunkToAppend) {
    return current;
  }
  const combined = `${current}${chunkToAppend}`.replace(/\s+/g, " ");
  if (combined.length <= ACP_BACKGROUND_TASK_PROGRESS_MAX_LENGTH) {
    return combined;
  }
  return `${truncateUtf16Safe(combined, ACP_BACKGROUND_TASK_PROGRESS_MAX_LENGTH - 1)}…`;
}

/** Maps ACP runtime failures to detached-task terminal states. */
export function resolveBackgroundTaskFailureStatus(error: AcpRuntimeError): "failed" | "timed_out" {
  return /\btimed out\b/i.test(error.message) ? "timed_out" : "failed";
}

/** Infers blocked terminal outcomes from final progress text when the child turn reports one. */
export function resolveBackgroundTaskTerminalResult(progressSummary: string): {
  terminalOutcome?: "blocked";
  terminalSummary?: string;
} {
  const requiredCompletionResult = resolveRequiredCompletionTerminalResult(progressSummary);
  if (requiredCompletionResult.terminalOutcome) {
    return requiredCompletionResult;
  }
  const normalized = normalizeText(progressSummary)?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return {};
  }
  const permissionDeniedMatch = normalized.match(
    /\b(?:write failed:\s*)?permission denied(?: for (?<path>\S+))?\.?/i,
  );
  if (permissionDeniedMatch) {
    const path = normalizeText(permissionDeniedMatch.groups?.path)?.replace(/[.,;:!?]+$/, "");
    return {
      terminalOutcome: "blocked",
      terminalSummary: path ? `Permission denied for ${path}.` : "Permission denied.",
    };
  }
  if (
    /\bneed a writable session\b/i.test(normalized) ||
    /\bfilesystem authorization\b/i.test(normalized) ||
    /`?apply_patch`?/i.test(normalized)
  ) {
    return {
      terminalOutcome: "blocked",
      terminalSummary: "Writable session or apply_patch authorization required.",
    };
  }
  return {};
}

/** Resolves the requester task context for a spawned child ACP session. */
export function resolveBackgroundTaskContext(params: {
  deps: AcpSessionManagerDeps;
  cfg: OpenClawConfig;
  sessionKey: string;
  requestId: string;
  text: string;
}): BackgroundTaskContext | null {
  const childEntry = params.deps.loadSessionEntry({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  })?.entry;
  const requesterSessionKey =
    normalizeText(childEntry?.spawnedBy) ?? normalizeText(childEntry?.parentSessionKey);
  if (!requesterSessionKey) {
    return null;
  }
  const parentEntry = params.deps.loadSessionEntry({
    cfg: params.cfg,
    sessionKey: requesterSessionKey,
  })?.entry;
  return {
    requesterSessionKey,
    requesterOrigin: parentEntry?.deliveryContext ?? childEntry?.deliveryContext,
    childSessionKey: params.sessionKey,
    runId: params.requestId,
    label: normalizeText(childEntry?.label),
    task: summarizeBackgroundTaskText(params.text),
  };
}

export function createBackgroundTaskRecord(
  context: BackgroundTaskContext,
  startedAt: number,
): void {
  try {
    const task = createRunningTaskRun({
      runtime: "acp",
      sourceId: context.runId,
      ownerKey: context.requesterSessionKey,
      scopeKind: "session",
      requesterOrigin: context.requesterOrigin,
      childSessionKey: context.childSessionKey,
      runId: context.runId,
      label: context.label,
      task: context.task,
      startedAt,
    });
    if (!task) {
      logVerbose(
        `acp-manager: failed creating background task for ${context.runId}: persist_failed`,
      );
    }
  } catch (error) {
    logVerbose(
      `acp-manager: failed creating background task for ${context.runId}: ${String(error)}`,
    );
  }
}

export function markBackgroundTaskRunning(
  runId: string,
  params: {
    sessionKey?: string;
    lastEventAt?: number;
    progressSummary?: string | null;
  },
): void {
  try {
    startTaskRunByRunId({
      runId,
      runtime: "acp",
      sessionKey: params.sessionKey,
      lastEventAt: params.lastEventAt,
      progressSummary: params.progressSummary,
    });
  } catch (error) {
    logVerbose(`acp-manager: failed updating background task for ${runId}: ${String(error)}`);
  }
}

export function markBackgroundTaskTerminal(
  runId: string,
  params: {
    sessionKey?: string;
    status: "succeeded" | "failed" | "timed_out" | "cancelled";
    endedAt: number;
    lastEventAt?: number;
    error?: string;
    progressSummary?: string | null;
    terminalSummary?: string | null;
    terminalOutcome?: "succeeded" | "blocked" | null;
  },
): void {
  try {
    if (params.status === "succeeded") {
      completeTaskRunByRunId({
        runId,
        runtime: "acp",
        sessionKey: params.sessionKey,
        endedAt: params.endedAt,
        lastEventAt: params.lastEventAt,
        progressSummary: params.progressSummary,
        terminalSummary: params.terminalSummary,
        terminalOutcome: params.terminalOutcome,
      });
      return;
    }
    failTaskRunByRunId({
      runId,
      runtime: "acp",
      sessionKey: params.sessionKey,
      status: params.status,
      endedAt: params.endedAt,
      lastEventAt: params.lastEventAt,
      error: params.error,
      progressSummary: params.progressSummary,
      terminalSummary: params.terminalSummary,
    });
  } catch (error) {
    logVerbose(`acp-manager: failed updating background task for ${runId}: ${String(error)}`);
  }
}
