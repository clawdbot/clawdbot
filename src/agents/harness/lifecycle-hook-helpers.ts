/**
 * Agent harness lifecycle hook helpers.
 *
 * This module dispatches LLM/agent lifecycle plugin hooks and normalizes
 * before-finalize retry/finalize decisions with bounded retry accounting.
 */
import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as normalizeTrimmedString } from "@openclaw/normalization-core/string-coerce";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveBlockMessage } from "../../plugins/hook-decision-types.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookAgentEndEvent,
  PluginHookBeforeAgentFinalizeEvent,
  PluginHookBeforeAgentFinalizeResult,
  PluginHookBeforeAgentRunEvent,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
} from "../../plugins/hook-types.js";
import type { VoidHookRunOptions } from "../../plugins/hooks.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { AgentHarnessBeforeAgentRunAdmission } from "./before-agent-run-admission.js";
import { buildAgentHookContext, type AgentHarnessHookContext } from "./hook-context.js";
import { limitAgentHookHistoryMessages } from "./hook-history.js";

const log = createSubsystemLogger("agents/harness");
const FINALIZE_RETRY_BUDGET_KEY = Symbol.for("openclaw.pluginFinalizeRetryBudget");
const FINALIZE_RETRY_BUDGET_MAX_ENTRIES = 2048;

type AgentHarnessHookRunner = ReturnType<typeof getGlobalHookRunner>;
type FinalizeRetryBudget = Map<string, Map<string, number>>;

/** Returns the current global hook runner for harness lifecycle hooks. */
export function getAgentHarnessHookRunner(): AgentHarnessHookRunner {
  return getGlobalHookRunner();
}

function getFinalizeRetryBudget(): FinalizeRetryBudget {
  return resolveGlobalSingleton<FinalizeRetryBudget>(FINALIZE_RETRY_BUDGET_KEY, () => new Map());
}

function countFinalizeRetryBudgetEntries(budget: FinalizeRetryBudget): number {
  let count = 0;
  for (const runBudget of budget.values()) {
    count += runBudget.size;
  }
  return count;
}

function pruneFinalizeRetryBudget(budget: FinalizeRetryBudget): void {
  while (countFinalizeRetryBudgetEntries(budget) > FINALIZE_RETRY_BUDGET_MAX_ENTRIES) {
    const oldestRunId = budget.keys().next().value;
    if (oldestRunId === undefined) {
      return;
    }
    const oldestRunBudget = budget.get(oldestRunId);
    const oldestRetryKey = oldestRunBudget?.keys().next().value;
    if (oldestRunBudget && oldestRetryKey !== undefined) {
      oldestRunBudget.delete(oldestRetryKey);
    }
    if (!oldestRunBudget || oldestRunBudget.size === 0) {
      budget.delete(oldestRunId);
    }
  }
}

function buildFinalizeRetryInstructionKey(instruction: string): string {
  return `instruction:${createHash("sha256").update(instruction).digest("hex")}`;
}

/** Dispatches best-effort LLM input hooks for a harness attempt. */
export function runAgentHarnessLlmInputHook(params: {
  event: PluginHookLlmInputEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): void {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("llm_input") || typeof hookRunner.runLlmInput !== "function") {
    return;
  }
  void hookRunner
    .runLlmInput(params.event, buildAgentHookContext(params.ctx))
    .catch((error: unknown) => {
      log.warn(`llm_input hook failed: ${String(error)}`);
    });
}

/** Dispatches best-effort LLM output hooks for a harness attempt. */
export function runAgentHarnessLlmOutputHook(params: {
  event: PluginHookLlmOutputEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): void {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("llm_output") || typeof hookRunner.runLlmOutput !== "function") {
    return;
  }
  void hookRunner
    .runLlmOutput(params.event, buildAgentHookContext(params.ctx))
    .catch((error: unknown) => {
      log.warn(`llm_output hook failed: ${String(error)}`);
    });
}

/** Closed outcome of the fail-closed before_agent_run gate. */
type AgentHarnessBeforeAgentRunOutcome =
  | { action: "proceed" }
  | { action: "blocked"; blockedBy: string; message: string };

/** Attribution used when the gate itself fails rather than a plugin deciding to block. */
const BEFORE_AGENT_RUN_FAILURE_ATTRIBUTION = "before_agent_run";

/** Fail-closed outcome for a gate that could not produce a plugin decision. */
function buildBeforeAgentRunGateFailure(reason: string): AgentHarnessBeforeAgentRunOutcome {
  return {
    action: "blocked",
    blockedBy: BEFORE_AGENT_RUN_FAILURE_ATTRIBUTION,
    message: resolveBlockMessage(
      { outcome: "block", reason },
      { blockedBy: BEFORE_AGENT_RUN_FAILURE_ATTRIBUTION },
    ),
  };
}

/**
 * Runs the fail-closed before_agent_run gate for a harness attempt.
 *
 * Block-message rendering stays here so plugin-local `reason` text can never
 * reach a user-facing surface, and history is bounded/cloned here so every
 * runtime gets the same isolated snapshot without copying the policy.
 */
export async function runAgentHarnessBeforeAgentRunHook(params: {
  event: Omit<PluginHookBeforeAgentRunEvent, "messages"> & { messages?: readonly unknown[] };
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
  /** Run-scoped memo; outer attempt re-dispatch replays its recorded decision. */
  admission?: AgentHarnessBeforeAgentRunAdmission;
}): Promise<AgentHarnessBeforeAgentRunOutcome> {
  const admission = params.admission;
  if (admission?.decision) {
    return admission.decision;
  }
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_agent_run")) {
    return { action: "proceed" };
  }
  if (typeof hookRunner.runBeforeAgentRun !== "function") {
    // Enforcement is configured but cannot execute; an unrunnable gate must
    // never silently admit the turn.
    log.warn("before_agent_run gate is registered but not runnable; blocking request");
    return recordBeforeAgentRunOutcome(
      admission,
      buildBeforeAgentRunGateFailure("before_agent_run gate is not runnable"),
    );
  }
  let result: Awaited<ReturnType<NonNullable<typeof hookRunner>["runBeforeAgentRun"]>> | undefined;
  try {
    result = await hookRunner.runBeforeAgentRun(
      {
        ...params.event,
        /** Gives hooks a bounded snapshot they cannot mutate in-session. */
        messages: limitAgentHookHistoryMessages(params.event.messages ?? []).map((message) =>
          structuredClone(message),
        ),
      },
      buildAgentHookContext(params.ctx),
    );
  } catch (error) {
    log.warn(`before_agent_run hook failed; blocking request: ${String(error)}`);
    return recordBeforeAgentRunOutcome(
      admission,
      buildBeforeAgentRunGateFailure("before_agent_run hook failed"),
    );
  }
  const decision = result?.decision;
  if (decision?.outcome !== "block") {
    return recordBeforeAgentRunOutcome(admission, { action: "proceed" });
  }
  const blockedBy = result?.pluginId ?? "unknown";
  log.warn(`before_agent_run hook blocked by ${blockedBy}`);
  return recordBeforeAgentRunOutcome(admission, {
    action: "blocked",
    blockedBy,
    message: resolveBlockMessage(decision, { blockedBy }),
  });
}

function recordBeforeAgentRunOutcome(
  admission: AgentHarnessBeforeAgentRunAdmission | undefined,
  outcome: AgentHarnessBeforeAgentRunOutcome,
): AgentHarnessBeforeAgentRunOutcome {
  if (admission) {
    admission.decision = outcome;
  }
  return outcome;
}

async function executeAgentHarnessAgentEndHook(params: {
  event: PluginHookAgentEndEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
  unrefTimeout?: boolean;
}): Promise<void> {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("agent_end") || typeof hookRunner.runAgentEnd !== "function") {
    return;
  }
  try {
    const options: VoidHookRunOptions = { unrefTimeout: params.unrefTimeout ?? false };
    await hookRunner.runAgentEnd(params.event, buildAgentHookContext(params.ctx), options);
  } catch (error) {
    log.warn(`agent_end hook failed: ${String(error)}`);
  }
}

/** Starts agent_end hooks with unref timeout behavior. */
export function runAgentHarnessAgentEndHook(params: {
  event: PluginHookAgentEndEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): void {
  void executeAgentHarnessAgentEndHook({ ...params, unrefTimeout: true });
}

/** Runs agent_end hooks and waits for completion. */
export async function awaitAgentHarnessAgentEndHook(params: {
  event: PluginHookAgentEndEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): Promise<void> {
  await executeAgentHarnessAgentEndHook({ ...params, unrefTimeout: false });
}

/** Normalized before-finalize hook decision consumed by harness loops. */
type AgentHarnessBeforeAgentFinalizeOutcome =
  | { action: "continue" }
  | { action: "revise"; reason: string }
  | { action: "finalize"; reason?: string };

/** Runs before-finalize hooks and normalizes finalize/revise/continue decisions. */
export async function runAgentHarnessBeforeAgentFinalizeHook(params: {
  event: PluginHookBeforeAgentFinalizeEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): Promise<AgentHarnessBeforeAgentFinalizeOutcome> {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (
    !hookRunner?.hasHooks("before_agent_finalize") ||
    typeof hookRunner.runBeforeAgentFinalize !== "function"
  ) {
    return { action: "continue" };
  }
  try {
    const eventForNormalization: PluginHookBeforeAgentFinalizeEvent = {
      ...params.event,
      runId: params.event.runId ?? params.ctx.runId,
    };
    return normalizeBeforeAgentFinalizeResult(
      await hookRunner.runBeforeAgentFinalize(
        eventForNormalization,
        buildAgentHookContext(params.ctx),
      ),
      eventForNormalization,
    );
  } catch (error) {
    log.warn(`before_agent_finalize hook failed: ${String(error)}`);
    return { action: "continue" };
  }
}

function normalizeBeforeAgentFinalizeResult(
  result: PluginHookBeforeAgentFinalizeResult | undefined,
  event?: PluginHookBeforeAgentFinalizeEvent,
): AgentHarnessBeforeAgentFinalizeOutcome {
  if (result?.action === "finalize") {
    const reason = normalizeTrimmedString(result.reason);
    return reason ? { action: "finalize", reason } : { action: "finalize" };
  }
  if (result?.action === "revise") {
    const retryCandidates = readBeforeAgentFinalizeRetryCandidates(result);
    if (retryCandidates.length > 0) {
      const reason = normalizeTrimmedString(result.reason);
      for (const retry of retryCandidates) {
        const retryInstruction = normalizeTrimmedString(retry.instruction);
        if (!retryInstruction) {
          continue;
        }
        const maxAttempts =
          typeof retry.maxAttempts === "number" && Number.isFinite(retry.maxAttempts)
            ? Math.max(1, Math.floor(retry.maxAttempts))
            : 1;
        const retryRunId = event?.runId ?? event?.sessionId ?? "unknown-run";
        const retryKey =
          normalizeTrimmedString(retry.idempotencyKey) ||
          buildFinalizeRetryInstructionKey(retryInstruction);
        // Track retry attempts per run+instruction to prevent finalize hooks
        // from creating an unbounded revise loop.
        const budget = getFinalizeRetryBudget();
        const runBudget = budget.get(retryRunId) ?? new Map<string, number>();
        const nextCount = (runBudget.get(retryKey) ?? 0) + 1;
        runBudget.delete(retryKey);
        runBudget.set(retryKey, nextCount);
        budget.delete(retryRunId);
        budget.set(retryRunId, runBudget);
        pruneFinalizeRetryBudget(budget);
        if (nextCount > maxAttempts) {
          continue;
        }
        const revisedReason =
          reason && reason.includes(retryInstruction)
            ? reason
            : [reason, retryInstruction].filter(Boolean).join("\n\n");
        return { action: "revise", reason: revisedReason };
      }
      return { action: "continue" };
    }
    const reason = normalizeTrimmedString(result.reason);
    return reason ? { action: "revise", reason } : { action: "continue" };
  }
  return { action: "continue" };
}

function readBeforeAgentFinalizeRetryCandidates(
  result: PluginHookBeforeAgentFinalizeResult,
): NonNullable<PluginHookBeforeAgentFinalizeResult["retry"]>[] {
  const candidateList = (
    result as {
      retryCandidates?: unknown;
    }
  ).retryCandidates;
  if (Array.isArray(candidateList) && candidateList.length > 0) {
    return candidateList.filter(isBeforeAgentFinalizeRetry);
  }
  return isBeforeAgentFinalizeRetry(result.retry) ? [result.retry] : [];
}

function isBeforeAgentFinalizeRetry(
  value: unknown,
): value is NonNullable<PluginHookBeforeAgentFinalizeResult["retry"]> {
  return isRecord(value);
}
