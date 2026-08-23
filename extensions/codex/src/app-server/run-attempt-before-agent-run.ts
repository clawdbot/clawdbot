/**
 * Fail-closed before_agent_run gate for Codex native app-server attempts.
 *
 * Runs once per admitted turn after the final turn prompt, developer
 * instructions, and history projection are settled, and before any
 * `thread/start`, `turn/start`, or `llm_input` emission, so a block starts no
 * Codex work at all. The core gate records its decision in the run-scoped
 * admission memo, so outer attempt re-dispatch replays it instead of charging
 * the gate again.
 */
import {
  embeddedAgentLog,
  formatErrorMessage,
  runAgentHarnessBeforeAgentRunHook,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { buildCodexTurnStartFailureResult } from "./attempt-results.js";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { emitCodexAppServerEvent, runCodexAgentEndHook } from "./run-attempt-lifecycle.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";

type CodexBeforeAgentRunBlock = { blockedBy: string; message: string };

type CodexUserTurnRecorder = NonNullable<EmbeddedRunAttemptParams["userTurnTranscriptRecorder"]>;
type CodexBlockedUserTurnMessage = Parameters<CodexUserTurnRecorder["persistBlocked"]>[0] & {
  idempotencyKey: string;
};

/**
 * Returns a blocked attempt result when a plugin gate rejects this turn, or
 * `undefined` when the attempt may proceed to Codex startup.
 */
export async function runCodexAttemptBeforeAgentRunGate(
  resources: CodexAttemptResources,
): Promise<{ result: EmbeddedRunAttemptResult } | undefined> {
  const { prompt, trajectoryRecorder, markTrajectoryEndRecorded, runCleanupStep } = resources;
  const { context, turnState, systemPromptReport, buildRenderedCodexDeveloperInstructions } =
    prompt;
  const { runtime, attemptTools, historyState, hookContext, hookRunner } = context;
  const { connection } = runtime;
  const { params, attemptStartedAt, abortFromUpstream } = connection;
  const outcome = await runAgentHarnessBeforeAgentRunHook({
    event: {
      prompt: turnState.codexTurnPromptText,
      systemPrompt: buildRenderedCodexDeveloperInstructions(),
      messages: historyState.messages,
      channelId: hookContext.channelId,
      // Trusted attempt identity is hook-only evidence; it never becomes model
      // or tool input and grants no additional privilege to the turn.
      accountId: params.agentAccountId ?? undefined,
      senderId: params.senderId ?? undefined,
      senderIsOwner: params.senderIsOwner ?? undefined,
    },
    ctx: hookContext,
    hookRunner,
    // Run-scoped memo owned by the outer run loop: outer re-dispatch of this
    // same admitted run replays its decision instead of recharging the gate.
    ...(params.beforeAgentRunAdmission ? { admission: params.beforeAgentRunAdmission } : {}),
  });
  if (outcome.action !== "blocked") {
    return undefined;
  }

  const blockedUserMessage = buildCodexBlockedUserTurnMessage(params, outcome);
  await persistCodexBlockedUserTurn(params, blockedUserMessage);
  void emitCodexAppServerEvent(params, {
    stream: "codex_app_server.lifecycle",
    data: { phase: "before_agent_run_blocked", blockedBy: outcome.blockedBy },
  });
  trajectoryRecorder?.recordEvent("session.ended", {
    status: "error",
    promptError: outcome.message,
  });
  markTrajectoryEndRecorded();
  // agent_end carries the redacted blocked turn as evidence; the plugin-local
  // block reason stays inside the gate decision and never reaches consumers.
  const blockedMessagesSnapshot = [...historyState.messages, blockedUserMessage];
  await runCodexAgentEndHook(params, {
    event: {
      messages: blockedMessagesSnapshot,
      success: false,
      error: outcome.message,
      durationMs: Date.now() - attemptStartedAt,
    },
    ctx: hookContext,
    hookRunner,
  });
  // Startup never ran, so no client lease, thread, route, relay, or sandbox
  // environment exists; only the surfaces materialized during tool preparation
  // and the upstream abort listener need releasing here.
  await runCleanupStep("codex-before-agent-run-scoped-mcp-dispose", () =>
    attemptTools.scopedMcpTools?.dispose(),
  );
  await runCleanupStep("codex-before-agent-run-scheduled-mcp-dispose", () =>
    attemptTools.scheduledConfiguredMcp?.dispose(),
  );
  await runCleanupStep("codex-before-agent-run-trajectory-flush", () =>
    trajectoryRecorder?.flush(),
  );
  await runCleanupStep("codex-before-agent-run-abort-listener", () => {
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
  });
  return {
    result: buildCodexTurnStartFailureResult({
      params,
      message: outcome.message,
      promptError: new Error(outcome.message),
      promptErrorSource: "hook:before_agent_run",
      messagesSnapshot: blockedMessagesSnapshot,
      systemPromptReport,
    }),
  };
}

/**
 * Builds the redacted blocked user turn. Only the rendered block text is
 * retained; the idempotency key gives the canonical recorder a stable identity
 * for the blocked turn while its self-persistence guard owns re-dispatch dedupe.
 */
function buildCodexBlockedUserTurnMessage(
  params: EmbeddedRunAttemptParams,
  block: CodexBeforeAgentRunBlock,
): CodexBlockedUserTurnMessage {
  const nowMs = Date.now();
  return {
    role: "user",
    content: [{ type: "text", text: block.message }],
    timestamp: nowMs,
    idempotencyKey: `hook-block:before_agent_run:user:${params.runId}`,
    __openclaw: {
      beforeAgentRunBlocked: { blockedBy: block.blockedBy, blockedAt: nowMs },
    },
  };
}

/**
 * Commits the blocked turn through the canonical user-turn recorder so blocked
 * bookkeeping and the persistence notification stay owned by that boundary.
 */
async function persistCodexBlockedUserTurn(
  params: EmbeddedRunAttemptParams,
  blockedUserMessage: CodexBlockedUserTurnMessage,
): Promise<void> {
  const recorder = params.userTurnTranscriptRecorder;
  if (!recorder) {
    return;
  }
  try {
    const persisted = await recorder.persistBlocked(blockedUserMessage);
    if (!persisted) {
      return;
    }
    params.onUserMessagePersisted?.(persisted.message);
  } catch (error) {
    embeddedAgentLog.warn(
      `before_agent_run block: failed to persist redacted Codex user message: ${formatErrorMessage(
        error,
      )}`,
    );
  }
}
