import { buildContextEngineRuntimeSettings } from "../../../context-engine/runtime-settings.js";
import type { ContextEngine, ContextEngineSessionTarget } from "../../../context-engine/types.js";
import { resolveProcessToolScopeKey } from "../../agent-tools.js";
import { listActiveProcessSessionReferences } from "../../bash-process-references.js";
import { deriveContextPromptTokens, normalizeUsage } from "../../usage.js";
import { runPostCompactionSideEffects } from "../compaction-hooks.js";
import { buildEmbeddedCompactionRuntimeContext } from "../compaction-runtime-context.js";
import {
  compactContextEngineWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "../compaction-safety-timeout.js";
import { resolveContextEngineCapabilities } from "../context-engine-capabilities.js";
import { log } from "../logger.js";
import type { EmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { createCompactionDiagId } from "./helpers.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { buildContextEngineCompactionSessionTarget } from "./session-bootstrap.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const MAX_TIMEOUT_COMPACTION_ATTEMPTS = 2;

type CompactResult = Awaited<ReturnType<ContextEngine["compact"]>>;

type ActiveSession = {
  id: string;
  file: string;
  target?: ContextEngineSessionTarget;
};

export async function recoverEmbeddedRunTimeout(input: {
  runParams: RunEmbeddedAgentParams;
  state: EmbeddedRunContextRecoveryState;
  contextEngine: ContextEngine;
  contextTokenBudget?: number;
  genericCompactionRecoveryAllowed: boolean;
  timedOut: boolean;
  signalOwnedInterruption: boolean;
  timedOutDuringCompaction: boolean;
  timedOutDuringToolExecution: boolean;
  timedOutByRunBudget: boolean;
  lastRunPromptUsage?: ReturnType<typeof normalizeUsage>;
  attempt: EmbeddedRunAttemptResult;
  runtimeAuthPlan: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["runtimeAuthPlan"];
  resolvedSessionKey: string;
  sessionAgentId: string;
  agentDir: string;
  workspaceDir: string;
  provider: string;
  modelId: string;
  harnessRuntime: string;
  thinkLevel: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["thinkLevel"];
  authProfileId?: string;
  authProfileIdSource: "auto" | "user";
  resolveContextEnginePluginId: () => string | undefined;
  buildRuntimeSettings: (settings: {
    tokenBudget?: number | null;
  }) => ReturnType<typeof buildContextEngineRuntimeSettings>;
  onCompactionHookMessages: (payload: {
    phase: "before" | "after";
    messages: string[];
  }) => Promise<void>;
  runOwnsCompactionBeforeHook: (reason: string) => Promise<void>;
  runOwnsCompactionAfterHook: (
    reason: string,
    result: CompactResult,
    previousSessionId?: string,
  ) => Promise<void>;
  adoptCompactionTranscript: (result: CompactResult) => Promise<string | undefined>;
  getActiveSession: () => ActiveSession;
  armPostCompactionGuard: () => void;
}): Promise<boolean> {
  if (
    !input.genericCompactionRecoveryAllowed ||
    input.contextTokenBudget === undefined ||
    !input.timedOut ||
    input.signalOwnedInterruption ||
    input.timedOutDuringCompaction ||
    input.timedOutDuringToolExecution ||
    input.timedOutByRunBudget
  ) {
    return false;
  }

  // API totals include output tokens. Timeout compaction only considers the
  // prompt-side pressure that can actually be reduced by compaction.
  const lastTurnPromptTokens = deriveContextPromptTokens({
    lastCallUsage: input.lastRunPromptUsage,
  });
  const tokenUsedRatio =
    lastTurnPromptTokens != null && input.contextTokenBudget > 0
      ? lastTurnPromptTokens / input.contextTokenBudget
      : 0;
  if (input.state.timeoutCompactionAttempts >= MAX_TIMEOUT_COMPACTION_ATTEMPTS) {
    log.warn(
      `[timeout-compaction] already attempted timeout compaction ${input.state.timeoutCompactionAttempts} time(s); falling through to failover rotation`,
    );
    return false;
  }
  if (tokenUsedRatio <= 0.65) {
    return false;
  }

  const timeoutDiagId = createCompactionDiagId();
  input.state.timeoutCompactionAttempts += 1;
  log.warn(
    `[timeout-compaction] LLM timed out with high prompt token usage (${Math.round(tokenUsedRatio * 100)}%); ` +
      `attempting compaction before retry (attempt ${input.state.timeoutCompactionAttempts}/${MAX_TIMEOUT_COMPACTION_ATTEMPTS}) diagId=${timeoutDiagId}`,
  );
  let timeoutCompactResult: CompactResult;
  await input.runOwnsCompactionBeforeHook("timeout recovery");
  try {
    const activeSession = input.getActiveSession();
    const runParams = input.runParams;
    const timeoutCompactionRuntimeContext = {
      ...buildEmbeddedCompactionRuntimeContext({
        sessionKey: runParams.sessionKey,
        messageChannel: runParams.messageChannel,
        messageProvider: runParams.messageProvider,
        clientCaps: runParams.clientCaps,
        chatType: runParams.chatType,
        agentAccountId: runParams.agentAccountId,
        currentChannelId: runParams.currentChannelId,
        currentThreadTs: runParams.currentThreadTs,
        currentMessageId: runParams.currentMessageId,
        authProfileId: input.authProfileId,
        authProfileIdSource: input.authProfileIdSource,
        runtimeAuthPlan: input.runtimeAuthPlan,
        workspaceDir: input.workspaceDir,
        agentDir: input.agentDir,
        config: runParams.config,
        skillsSnapshot: runParams.skillsSnapshot,
        senderId: runParams.senderId,
        provider: input.provider,
        modelId: input.modelId,
        harnessRuntime: input.harnessRuntime,
        modelSelectionLocked: runParams.modelSelectionLocked,
        modelFallbacksOverride: runParams.modelFallbacksOverride,
        thinkLevel: input.thinkLevel,
        reasoningLevel: runParams.reasoningLevel,
        bashElevated: runParams.bashElevated,
        extraSystemPrompt: runParams.extraSystemPrompt,
        sourceReplyDeliveryMode: runParams.sourceReplyDeliveryMode,
        ownerNumbers: runParams.ownerNumbers,
        activeProcessSessions: listActiveProcessSessionReferences({
          scopeKey: resolveProcessToolScopeKey({
            sessionKey: runParams.sandboxSessionKey?.trim() || runParams.sessionKey,
            sessionId: activeSession.id,
            agentId: input.sessionAgentId,
          }),
        }),
      }),
      ...resolveContextEngineCapabilities({
        config: runParams.config,
        sessionKey: runParams.sessionKey,
        agentId: input.sessionAgentId,
        contextEnginePluginId: input.resolveContextEnginePluginId(),
        purpose: "context-engine.timeout-compaction",
      }),
      onCompactionHookMessages: input.onCompactionHookMessages,
      ...(input.attempt.promptCache ? { promptCache: input.attempt.promptCache } : {}),
      runId: runParams.runId,
      trigger: "timeout_recovery",
      diagId: timeoutDiagId,
      attempt: input.state.timeoutCompactionAttempts,
      maxAttempts: MAX_TIMEOUT_COMPACTION_ATTEMPTS,
    };
    timeoutCompactResult = await compactContextEngineWithSafetyTimeout(
      input.contextEngine,
      {
        sessionId: activeSession.id,
        sessionKey: input.resolvedSessionKey,
        agentId: input.sessionAgentId,
        sessionTarget: buildContextEngineCompactionSessionTarget({
          agentId: input.sessionAgentId,
          config: runParams.config,
          sessionFile: activeSession.file,
          sessionId: activeSession.id,
          sessionKey: input.resolvedSessionKey,
          sessionTarget: activeSession.target,
        }),
        tokenBudget: input.contextTokenBudget,
        force: true,
        compactionTarget: "budget",
        runtimeContext: timeoutCompactionRuntimeContext,
        runtimeSettings: input.buildRuntimeSettings({ tokenBudget: input.contextTokenBudget }),
      },
      resolveCompactionTimeoutMs(runParams.config),
      runParams.abortSignal,
    );
  } catch (compactErr) {
    log.warn(
      `[timeout-compaction] contextEngine.compact() threw during timeout recovery for ${input.provider}/${input.modelId}: ${String(compactErr)}`,
    );
    timeoutCompactResult = {
      ok: false,
      compacted: false,
      reason: String(compactErr),
    };
  }

  const previousSessionId = timeoutCompactResult.compacted
    ? await input.adoptCompactionTranscript(timeoutCompactResult)
    : undefined;
  await input.runOwnsCompactionAfterHook(
    "timeout recovery",
    timeoutCompactResult,
    previousSessionId,
  );
  if (!timeoutCompactResult.compacted) {
    log.warn(
      `[timeout-compaction] compaction did not reduce context for ${input.provider}/${input.modelId}; falling through to normal handling`,
    );
    return false;
  }

  input.state.autoCompactionCount += 1;
  const tokensAfter = timeoutCompactResult.result?.tokensAfter;
  if (typeof tokensAfter === "number" && Number.isFinite(tokensAfter) && tokensAfter >= 0) {
    input.state.lastCompactionTokensAfter = Math.floor(tokensAfter);
  }
  if (input.contextEngine.info.ownsCompaction === true) {
    const activeSession = input.getActiveSession();
    await runPostCompactionSideEffects({
      config: input.runParams.config,
      sessionKey: input.runParams.sessionKey,
      sessionId: activeSession.id,
      agentId: input.sessionAgentId,
      sessionFile: activeSession.file,
    });
  }
  log.info(
    `[timeout-compaction] compaction succeeded for ${input.provider}/${input.modelId}; retrying prompt`,
  );
  input.armPostCompactionGuard();
  return true;
}
