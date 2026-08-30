import { Type } from "typebox";
import { getPluginToolSideEffectOwnerKey } from "../../../plugins/tools.js";
import type { NestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
  type InternalToolExecutionPreparer,
} from "../../runtime/internal-hooks.js";
import { toolEffectStateProvesNoEffect } from "../../tool-effect-receipt.js";
import { hashToolCall } from "../../tool-loop-detection.js";
import { buildToolMutationState } from "../../tool-mutation.js";
import { normalizeToolPolicyName } from "../../tool-policy.js";
import { isToolResultError } from "../../tool-result-error.js";
import { TOOL_SEARCH_CONTROL_TOOL_NAMES } from "../../tool-search-types.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { textResult, ToolInputError } from "../../tools/common.js";
import { readCodeModeRecoveryJournalEntry } from "./code-mode-recovery-journal.js";
import type {
  CodeModeRecoveryCandidate,
  CodeModeRecoveryState,
  EmbeddedRunTerminalRetryState,
} from "./terminal-retry-state.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const CODE_MODE_RECOVERY_RESUME_TOOL_NAME = "recovery_resume";
type ToolExecutionPreparation = Awaited<ReturnType<InternalToolExecutionPreparer>>;

export function isCodeModeRecoveryResumeTool(tool: { name?: string }): boolean {
  return normalizeToolPolicyName(tool.name ?? "") === CODE_MODE_RECOVERY_RESUME_TOOL_NAME;
}

const CODE_MODE_POST_RECONCILIATION_INSTRUCTION =
  "The previous uncertain Code Mode mutation was inspected. Code Mode is disabled for this bounded recovery. Use the available normal tools and their real schemas. OpenClaw permits at most one mutation attempt, blocks exact repeats whose earlier effect was committed or uncertain, and keeps reads and schema discovery available so you can verify and report the result.";

function reconciliationPrompt(canResume: boolean): string {
  const resume =
    " If work remains, call recovery_resume by itself after the read result. It performs no mutation and starts one bounded recovery with the normal tool surface.";
  return (
    "OpenClaw activated this temporary read-only recovery because the previous Code Mode mutation may have partially applied. First use read by itself to determine the authoritative current state." +
    (canResume ? resume : "") +
    " If no work remains, report the authoritative state. Do not repeat or finish a mutation during inspection."
  );
}

function recoveryBlocked(message: string): ToolExecutionPreparation {
  return {
    kind: "immediate",
    outcome: {
      kind: "result",
      result: textResult(message, {
        status: "blocked",
        deniedReason: "code-mode-recovery",
      }),
      isError: true,
    },
    dispose() {},
  };
}

function createReadyToolExecution(
  tool: AnyAgentTool,
  params: Parameters<NonNullable<ReturnType<typeof getInternalToolExecutionPreparer>>>[0],
): ToolExecutionPreparation {
  return {
    kind: "ready",
    args: params.args,
    execute: async (onImplementationStart) => {
      onImplementationStart?.();
      return await tool.execute(
        params.toolCallId,
        params.args as never, // SAFETY: AnyAgentTool erases concrete input after schema validation.
        params.signal,
        params.onUpdate,
      );
    },
    dispose() {},
  };
}

function gatePreparedRecoveryTool<T extends { name: string }>(
  tool: T,
  state: Extract<CodeModeRecoveryState, { kind: "resume" }>,
  originalPreparer: InternalToolExecutionPreparer,
  ownerKey?: string,
): T {
  attachInternalToolExecutionPreparer(tool, async (params) => {
    const prepared = await originalPreparer(params);
    if (prepared.kind === "immediate") {
      return prepared;
    }
    const mutation = buildToolMutationState(
      tool.name,
      prepared.args,
      ownerKey ? { ownerKey } : undefined,
    );
    if (mutation.replaySafe) {
      return prepared;
    }
    const actionKey = hashToolCall(normalizeToolPolicyName(tool.name), prepared.args);
    if (state.blockedActionKeys.has(actionKey)) {
      prepared.dispose();
      return recoveryBlocked(
        "Blocked an exact repeat of a Code Mode call whose earlier effect was committed or uncertain. Inspect the current state and choose a different operation.",
      );
    }
    if (state.mutationAttempt !== "available") {
      prepared.dispose();
      return recoveryBlocked(
        "This recovery already attempted one mutation. Use read-only tools to inspect the result and report any remaining work.",
      );
    }
    state.mutationAttempt = "reserved";
    let started = false;
    return {
      ...prepared,
      execute: async (onImplementationStart) => {
        return await prepared.execute(() => {
          state.mutationAttempt = "consumed";
          started = true;
          onImplementationStart?.();
        });
      },
      dispose: () => {
        prepared.dispose();
        if (!started && state.mutationAttempt === "reserved") {
          state.mutationAttempt = "available";
        }
      },
    };
  });
  return tool;
}

function gateRecoveryTool<T extends AnyAgentTool>(
  tool: T,
  state: Extract<CodeModeRecoveryState, { kind: "resume" }>,
): T {
  if (TOOL_SEARCH_CONTROL_TOOL_NAMES.has(normalizeToolPolicyName(tool.name))) {
    return tool;
  }
  const originalPreparer = getInternalToolExecutionPreparer(tool);
  return gatePreparedRecoveryTool(
    tool,
    state,
    originalPreparer ?? (async (params) => createReadyToolExecution(tool, params)),
    getPluginToolSideEffectOwnerKey(tool),
  );
}

export function applyCodeModeRecoveryPreparedToolSurface<T extends { name: string }>(params: {
  tools: T[];
  state: Extract<CodeModeRecoveryState, { kind: "resume" }>;
}): T[] {
  return params.tools.map((tool) => {
    const preparer = getInternalToolExecutionPreparer(tool);
    if (!preparer) {
      throw new Error(`Code Mode recovery tool ${tool.name} has no execution preparer`);
    }
    return gatePreparedRecoveryTool(tool, params.state, preparer);
  });
}

function createRecoveryResumeTool(
  state: Extract<CodeModeRecoveryState, { kind: "inspect" }>,
): AnyAgentTool {
  return {
    name: CODE_MODE_RECOVERY_RESUME_TOOL_NAME,
    label: "Resume recovery",
    description:
      "After a completed read, end inspection and start one bounded recovery with the normal tool surface.",
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async () => {
      if (state.phase !== "ready") {
        throw new ToolInputError("Use read by itself and wait for its result before resuming.");
      }
      return {
        ...textResult("Read-only inspection completed; bounded recovery requested.", {
          status: "ok",
        }),
        terminate: true,
      };
    },
  };
}

function gateInspectionRead<T extends AnyAgentTool>(
  tool: T,
  state: Extract<CodeModeRecoveryState, { kind: "inspect" }>,
): T {
  const originalPreparer = getInternalToolExecutionPreparer(tool);
  attachInternalToolExecutionPreparer(tool, async (params) => {
    const prepared = originalPreparer
      ? await originalPreparer(params)
      : createReadyToolExecution(tool, params);
    if (prepared.kind === "immediate") {
      return prepared;
    }
    return {
      ...prepared,
      execute: async (onImplementationStart) => {
        const result = await prepared.execute(onImplementationStart);
        if (!isToolResultError(result)) {
          state.phase = "ready";
        }
        return result;
      },
    };
  });
  tool.executionMode = "sequential";
  return tool;
}

export function applyCodeModeRecoveryToolSurface<T extends AnyAgentTool>(params: {
  tools: T[];
  state: Exclude<CodeModeRecoveryState, { kind: "idle" }>;
}): T[] {
  const state = params.state;
  if (state.kind === "inspect") {
    const read = params.tools.find((tool) => normalizeToolPolicyName(tool.name) === "read");
    return [
      ...(read ? [gateInspectionRead(read, state)] : []),
      ...(state.blockedActionKeys
        ? [
            createRecoveryResumeTool(state) as T, // SAFETY: T is the erased AgentTool surface.
          ]
        : []),
    ];
  }
  return params.tools.map((tool) => gateRecoveryTool(tool, state));
}

export function buildCodeModeRecoveryCandidate(params: {
  parentToolCallId: string;
  nestedToolActivities: readonly NestedToolActivity[];
}): CodeModeRecoveryCandidate {
  const calls = params.nestedToolActivities.filter(
    (activity) => activity.details.parentToolCallId === params.parentToolCallId,
  );
  const journal = calls.map(readCodeModeRecoveryJournalEntry);
  if (calls.length === 0 || journal.some((entry) => entry === undefined)) {
    return {};
  }
  const blockedActionKeys = [
    ...new Set(
      journal.flatMap((entry) =>
        entry && !toolEffectStateProvesNoEffect(entry.effectState) ? [entry.actionKey] : [],
      ),
    ),
  ];
  return { blockedActionKeys };
}

function isQuiescentRecoveryAttempt(params: {
  attempt: EmbeddedRunAttemptResult;
  hostOwnsToolSurface: boolean;
}): boolean {
  const { attempt } = params;
  return (
    attempt.terminal.kind === "ok" &&
    params.hostOwnsToolSurface &&
    attempt.itemLifecycle.activeCount === 0 &&
    attempt.itemLifecycle.startedCount === attempt.itemLifecycle.completedCount &&
    !attempt.clientToolCalls &&
    !attempt.yieldDetected &&
    !attempt.didSendDeterministicApprovalPrompt &&
    !attempt.runtimeContinuationStarted &&
    !attempt.toolMetas.some((entry) => entry.asyncStarted === true) &&
    (attempt.acceptedSessionSpawns?.length ?? 0) === 0 &&
    !attempt.didSendViaMessagingTool &&
    (attempt.successfulCronAdds ?? 0) === 0
  );
}

function hasSuccessfulInspectionRead(attempt: EmbeddedRunAttemptResult): boolean {
  return attempt.toolMetas.some(
    (entry) =>
      normalizeToolPolicyName(entry.toolName) === "read" &&
      entry.isError !== true &&
      entry.terminate !== true &&
      entry.asyncStarted !== true,
  );
}

function hasSuccessfulResumeRequest(attempt: EmbeddedRunAttemptResult): boolean {
  return attempt.toolMetas.some(
    (entry) =>
      normalizeToolPolicyName(entry.toolName) === CODE_MODE_RECOVERY_RESUME_TOOL_NAME &&
      entry.isError !== true &&
      entry.terminate === true,
  );
}

export function advanceCodeModeRecovery(params: {
  attempt: EmbeddedRunAttemptResult;
  hostOwnsToolSurface: boolean;
  retryState: EmbeddedRunTerminalRetryState;
  activateInternalPrompt: (prompt: string) => void;
}): boolean {
  const state = params.retryState.codeModeRecovery;
  if (state.kind === "idle") {
    const candidate = params.attempt.codeModeRecoveryCandidate;
    if (!candidate || !isQuiescentRecoveryAttempt(params)) {
      return false;
    }
    params.retryState.codeModeRecovery = {
      kind: "inspect",
      phase: "read-required",
      ...(candidate.blockedActionKeys ? { blockedActionKeys: candidate.blockedActionKeys } : {}),
    };
    params.activateInternalPrompt(reconciliationPrompt(Boolean(candidate.blockedActionKeys)));
    return true;
  }
  if (state.kind === "inspect") {
    const resume =
      state.blockedActionKeys &&
      isQuiescentRecoveryAttempt(params) &&
      hasSuccessfulInspectionRead(params.attempt) &&
      hasSuccessfulResumeRequest(params.attempt);
    params.retryState.codeModeRecovery = resume
      ? {
          kind: "resume",
          blockedActionKeys: new Set(state.blockedActionKeys),
          mutationAttempt: "available",
        }
      : { kind: "idle" };
    if (!resume) {
      return false;
    }
    params.activateInternalPrompt(CODE_MODE_POST_RECONCILIATION_INSTRUCTION);
    return true;
  }
  params.retryState.codeModeRecovery = { kind: "idle" };
  return false;
}
