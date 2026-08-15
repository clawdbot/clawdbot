import type {
  InternalBeforeToolBatchResult,
  InternalToolBatchCall,
  ToolLoopIntervention,
} from "@openclaw/agent-core";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import {
  beforeToolCallLog as log,
  emitLoopWarning,
  loadBeforeToolCallRuntime,
} from "./agent-tools.before-tool-call.diagnostics.js";
import {
  recordBatchAdmittedToolCall,
  releaseBatchAdmittedToolCalls,
} from "./agent-tools.before-tool-call.state.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import { hashToolCall } from "./tool-loop-detection.js";
import { normalizeToolPolicyName } from "./tool-policy.js";

type ToolLoopCall = {
  toolName: string;
  params: unknown;
  toolCallId?: string;
};

type ToolLoopBatchAdmission = InternalBeforeToolBatchResult & {
  commitReadyCalls?: (calls: readonly { toolCallId: string; args: unknown }[]) => void;
  releaseSkippedCalls?: (toolCallIds: readonly string[]) => void;
};

function toolLoopScope(ctx: HookContext) {
  const cwd = ctx.cwd ?? ctx.workspaceDir;
  return ctx.runId || cwd ? { runId: ctx.runId, cwd } : undefined;
}

async function evaluateToolLoopCall(
  call: ToolLoopCall,
  ctx: HookContext,
  stateOverride?: SessionState,
): Promise<ToolLoopIntervention | undefined> {
  if (!ctx.sessionKey || ctx.loopDetection?.enabled !== true) {
    return undefined;
  }
  const toolName = normalizeToolPolicyName(call.toolName || "tool");
  const { getDiagnosticSessionState, logToolLoopAction, detectToolCallLoop } =
    await loadBeforeToolCallRuntime();
  const sessionState =
    stateOverride ??
    getDiagnosticSessionState({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
    });
  const result = detectToolCallLoop(
    sessionState,
    toolName,
    call.params,
    ctx.loopDetection,
    toolLoopScope(ctx),
  );
  if (!result.stuck) {
    return undefined;
  }
  if (result.level === "critical") {
    log.error(`Blocking ${toolName} due to critical loop: ${result.message}`);
    logToolLoopAction({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      toolName,
      level: "critical",
      action: "block",
      detector: result.detector,
      count: result.count,
      message: result.message,
      pairedToolName: result.pairedToolName,
    });
    return {
      kind: "critical-tool-loop",
      toolCallId: call.toolCallId ?? "",
      toolName,
      actionKey: hashToolCall(toolName, call.params),
      detector: result.detector,
      count: result.count,
      reason: result.message,
    };
  }
  emitLoopWarning({ ctx, sessionState, toolName, warning: result, logToolLoopAction });
  return undefined;
}

async function recordToolLoopCall(call: ToolLoopCall, ctx: HookContext): Promise<void> {
  if (!ctx.sessionKey || ctx.loopDetection?.enabled !== true) {
    return;
  }
  const { getDiagnosticSessionState, recordToolCall } = await loadBeforeToolCallRuntime();
  recordToolCall(
    getDiagnosticSessionState({ sessionKey: ctx.sessionKey, sessionId: ctx.sessionId }),
    normalizeToolPolicyName(call.toolName || "tool"),
    call.params,
    call.toolCallId,
    ctx.loopDetection,
    toolLoopScope(ctx),
  );
}

/** Preserve the existing single-call admission path for harnesses without batch control. */
export async function admitSingleToolCallLoop(
  call: ToolLoopCall,
  ctx: HookContext,
): Promise<ToolLoopIntervention | undefined> {
  const intervention = await evaluateToolLoopCall(call, ctx);
  if (!intervention) {
    await recordToolLoopCall(call, ctx);
  }
  return intervention;
}

/**
 * Admit an assistant tool batch atomically. Successful calls reserve exact
 * markers here, then agent-core commits their history in assistant order at
 * the final launch boundary. A later veto still records only denial evidence.
 */
export async function admitToolCallBatch(
  calls: InternalToolBatchCall[],
  ctx: HookContext,
): Promise<ToolLoopBatchAdmission> {
  if (!ctx.sessionKey || ctx.loopDetection?.enabled !== true) {
    return {};
  }
  const {
    buildArgumentChurnWarning,
    getDiagnosticSessionState,
    logToolLoopAction,
    markDiagnosticArgumentChurnObservation,
    reconcileToolCallExecutionParams,
    recordToolCall,
    resolveToolLoopWarningThreshold,
  } = await loadBeforeToolCallRuntime();
  const warningThreshold = resolveToolLoopWarningThreshold();
  const sessionState = getDiagnosticSessionState({
    sessionKey: ctx.sessionKey,
    sessionId: ctx.sessionId,
  });
  const projectedState: SessionState = {
    ...sessionState,
    toolCallHistory: [...(sessionState.toolCallHistory ?? [])],
  };
  const recordLoopVeto = (state: SessionState, call: InternalToolBatchCall) => {
    recordToolCall(
      state,
      normalizeToolPolicyName(call.toolCall.name || "tool"),
      call.args,
      call.toolCall.id,
      ctx.loopDetection,
      toolLoopScope(ctx),
    );
    const projectedCall = state.toolCallHistory?.at(-1);
    if (projectedCall) {
      projectedCall.outcomeKind = "tool-loop-veto";
    }
  };
  const projectLoopVeto = (call: InternalToolBatchCall) => {
    // A batch is admitted atomically, so unrelated siblings must not evict the
    // real pre-batch history before a later candidate is checked. Build each
    // synthetic record through the canonical recorder, then append it to the
    // unbounded projection used only for this admission pass.
    const scratchState: SessionState = {
      ...sessionState,
      toolCallHistory: [],
    };
    recordLoopVeto(scratchState, call);
    const projectedCall = scratchState.toolCallHistory?.at(-1);
    if (projectedCall) {
      projectedState.toolCallHistory?.push(projectedCall);
    }
  };
  for (const call of calls) {
    const toolName = normalizeToolPolicyName(call.toolCall.name || "tool");
    const intervention = await evaluateToolLoopCall(
      {
        toolName,
        params: call.args,
        toolCallId: call.toolCall.id,
      },
      ctx,
      projectedState,
    );
    if (intervention) {
      // Preserve only denial evidence. No call in this batch executed, but a
      // recovery retry must still see same-action siblings that crossed the
      // threshold. Unrelated skipped actions remain valid recovery choices.
      for (const rejectedCall of calls) {
        const rejectedActionKey = hashToolCall(
          normalizeToolPolicyName(rejectedCall.toolCall.name || "tool"),
          rejectedCall.args,
        );
        if (rejectedActionKey === intervention.actionKey) {
          recordLoopVeto(sessionState, rejectedCall);
        }
      }
      return { intervention };
    }
    // A later sibling must assume this candidate makes no progress.
    projectLoopVeto(call);
  }
  for (const call of calls) {
    recordBatchAdmittedToolCall(call.toolCall.id, ctx.runId);
  }
  const admittedById = new Map(
    calls.map((call) => [
      call.toolCall.id,
      { toolName: normalizeToolPolicyName(call.toolCall.name || "tool") },
    ]),
  );
  const committedIds = new Set<string>();
  const commitReadyCall = (readyCall: { toolCallId: string; args: unknown }) => {
    const admitted = admittedById.get(readyCall.toolCallId);
    if (!admitted || committedIds.has(readyCall.toolCallId)) {
      return;
    }
    recordToolCall(
      sessionState,
      admitted.toolName,
      readyCall.args,
      readyCall.toolCallId,
      ctx.loopDetection,
      toolLoopScope(ctx),
    );
    const churn = reconcileToolCallExecutionParams(sessionState, {
      toolName: admitted.toolName,
      toolParams: readyCall.args,
      toolCallId: readyCall.toolCallId,
      runId: ctx.runId,
      cwd: ctx.cwd ?? ctx.workspaceDir,
      warningThreshold,
    });
    if (churn.active && churn.kind === "write_mutation") {
      emitLoopWarning({
        ctx,
        sessionState,
        toolName: admitted.toolName,
        warning: buildArgumentChurnWarning(admitted.toolName, churn),
        logToolLoopAction,
      });
    }
    // Batch admission is advisory until the call completes. Do not let an
    // inactive partial verdict clear a lease owned by an earlier completed
    // mutation; recordLoopOutcome owns the authoritative clear.
    if (churn.active) {
      markDiagnosticArgumentChurnObservation({
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        active: true,
      });
    }
    committedIds.add(readyCall.toolCallId);
  };
  return {
    commitReadyCalls(readyCalls) {
      if (readyCalls.length === 1 && readyCalls[0]) {
        commitReadyCall(readyCalls[0]);
        return;
      }
      const readyById = new Map(readyCalls.map((call) => [call.toolCallId, call]));
      for (const call of calls) {
        const readyCall = readyById.get(call.toolCall.id);
        if (readyCall) {
          commitReadyCall(readyCall);
        }
      }
    },
    releaseSkippedCalls(toolCallIds) {
      // Agent-core only supplies admitted prepared calls suppressed at a steering checkpoint.
      releaseBatchAdmittedToolCalls(toolCallIds, ctx.runId);
    },
  };
}
