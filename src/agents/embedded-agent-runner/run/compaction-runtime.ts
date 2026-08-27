import type { resolveContextEngine } from "../../../context-engine/registry.js";
import type { buildContextEngineRuntimeSettings } from "../../../context-engine/runtime-settings.js";
import {
  resolveCompactionSuccessorTranscript,
  type ContextEngineSessionTarget,
} from "../../../context-engine/types.js";
import { listActiveProcessSessionReferences } from "../../bash-process-references.js";
import { resolveProcessToolScopeKey } from "../../bash-process-scope.js";
import { buildEmbeddedCompactionRuntimeContext } from "../compaction-runtime-context.js";
import {
  compactContextEngineWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "../compaction-safety-timeout.js";
import { resolveContextEngineCapabilities } from "../context-engine-capabilities.js";
import { log } from "../logger.js";
import type { EmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { buildContextEngineCompactionSessionTarget } from "./session-bootstrap.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

type ContextEngine = Awaited<ReturnType<typeof resolveContextEngine>>;
type SessionPromptState = ReturnType<typeof createEmbeddedRunSessionPromptState>;
type CompactionResult = Awaited<ReturnType<ContextEngine["compact"]>>;

export type EmbeddedRunCompactionRecoveryInput = {
  runParams: RunEmbeddedAgentParams;
  state: EmbeddedRunContextRecoveryState;
  contextEngine: ContextEngine;
  contextTokenBudget?: number;
  genericCompactionRecoveryAllowed: boolean;
  attempt: EmbeddedRunAttemptResult;
  runtimeAuthPlan: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["runtimeAuthPlan"];
  resolvedSessionKey: string;
  sessionAgentId: string;
  contextEngineAgentId?: string;
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
    degradedReason?: string | null;
  }) => ReturnType<typeof buildContextEngineRuntimeSettings>;
  onCompactionHookMessages: (payload: {
    phase: "before" | "after";
    messages: string[];
  }) => Promise<void>;
  runOwnsCompactionBeforeHook: (reason: string) => Promise<void>;
  runOwnsCompactionAfterHook: (
    reason: string,
    result: CompactionResult,
    previousSessionId?: string,
  ) => Promise<void>;
  adoptCompactionTranscript: (result: CompactionResult) => Promise<string | undefined>;
  getActiveSession: () => {
    id: string;
    file: string;
    target?: ContextEngineSessionTarget;
  };
  prepareCompactedTranscriptRetry: () => Promise<void>;
  armPostCompactionGuard: () => void;
};

/** Preserve one prepared owner snapshot for both timeout and overflow recovery. */
export async function compactEmbeddedRunForRecovery(
  input: EmbeddedRunCompactionRecoveryInput,
  recovery: {
    tokenBudget: number;
    trigger: "overflow" | "timeout_recovery";
    diagId: string;
    attempt: number;
    maxAttempts: number;
    currentTokenCount?: number;
  },
) {
  const { runParams } = input;
  const activeSession = input.getActiveSession();
  const runtimeContext = {
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
      bootstrapWorkspaceDir: runParams.bootstrapWorkspaceDir,
      permissionMode: runParams.permissionMode,
      sessionRoot: runParams.sessionRoot,
      agentDir: input.agentDir,
      config: runParams.config,
      toolOverrides: runParams.toolOverrides,
      toolsAllow: runParams.toolsAllow,
      skillsSnapshot: runParams.skillsSnapshot,
      senderId: runParams.senderId,
      provider: input.provider,
      modelId: input.modelId,
      harnessRuntime: input.harnessRuntime,
      modelSelectionLocked: runParams.modelSelectionLocked,
      modelFallbacksOverride: runParams.modelFallbacksOverride,
      thinkLevel: input.thinkLevel,
      reasoningLevel: runParams.reasoningLevel,
      execOverrides: runParams.execOverrides,
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
      explicitAgentId: input.contextEngineAgentId,
      contextEnginePluginId: input.resolveContextEnginePluginId(),
      purpose:
        recovery.trigger === "overflow"
          ? "context-engine.overflow-compaction"
          : "context-engine.timeout-compaction",
    }),
    onCompactionHookMessages: input.onCompactionHookMessages,
    ...(input.attempt.promptCache ? { promptCache: input.attempt.promptCache } : {}),
    runId: runParams.runId,
    trigger: recovery.trigger,
    ...(recovery.currentTokenCount !== undefined
      ? { currentTokenCount: recovery.currentTokenCount }
      : {}),
    diagId: recovery.diagId,
    attempt: recovery.attempt,
    maxAttempts: recovery.maxAttempts,
  };
  const runtimeSettings = input.buildRuntimeSettings({
    tokenBudget: recovery.tokenBudget,
    ...(recovery.trigger === "overflow" ? { degradedReason: "context_overflow" } : {}),
  });
  const result = await compactContextEngineWithSafetyTimeout(
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
      tokenBudget: recovery.tokenBudget,
      ...(recovery.currentTokenCount !== undefined
        ? { currentTokenCount: recovery.currentTokenCount }
        : {}),
      force: true,
      compactionTarget: "budget",
      runtimeContext,
      runtimeSettings,
    },
    resolveCompactionTimeoutMs(runParams.config),
    runParams.abortSignal,
  );
  return { result, runtimeContext, runtimeSettings };
}

export function createEmbeddedRunCompactionRuntime(input: {
  runParams: PreparedEmbeddedRunInput["runParams"];
  contextEngine: ContextEngine;
  hookRunner: PreparedEmbeddedRunInput["hookRunner"];
  hookContext: PreparedEmbeddedRunInput["hookContext"];
  sessionPromptState: SessionPromptState;
}) {
  const { runParams: params, contextEngine, hookRunner, hookContext, sessionPromptState } = input;
  const resolveActiveHookContext = () => ({
    ...hookContext,
    sessionId: sessionPromptState.sessionId,
  });
  const adoptCompactionTranscript = async (
    compactResult: Awaited<ReturnType<ContextEngine["compact"]>>,
  ): Promise<string | undefined> => {
    const previousSessionId = sessionPromptState.sessionId;
    const nextSessionTarget = compactResult.result?.sessionTarget;
    const successor = resolveCompactionSuccessorTranscript(compactResult);
    await sessionPromptState.adoptSessionTarget(
      nextSessionTarget && successor.sessionId
        ? {
            ...nextSessionTarget,
            sessionId: nextSessionTarget.sessionId ?? successor.sessionId,
          }
        : nextSessionTarget,
    );
    if (
      !nextSessionTarget &&
      successor.sessionFile &&
      successor.sessionFile !== sessionPromptState.sessionFile
    ) {
      sessionPromptState.sessionFile = successor.sessionFile;
    }
    sessionPromptState.adoptSessionId(successor.sessionId);
    return successor.sessionId && successor.sessionId !== previousSessionId
      ? previousSessionId
      : undefined;
  };
  const onCompactionHookMessages = async (payload: {
    phase: "before" | "after";
    messages: string[];
  }) => {
    const messages = payload.messages.filter((message) => message.trim().length > 0);
    if (messages.length === 0) {
      return;
    }
    await params.onAgentEvent?.({
      stream: "compaction",
      data: {
        phase: payload.phase === "before" ? "start" : "end",
        ...(payload.phase === "after" ? { completed: true } : {}),
        messages,
      },
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
  };
  const runOwnsCompactionBeforeHook = async (reason: string) => {
    if (contextEngine.info.ownsCompaction !== true || !hookRunner?.hasHooks("before_compaction")) {
      return;
    }
    try {
      await hookRunner.runBeforeCompaction(
        { messageCount: -1, sessionFile: sessionPromptState.sessionFile },
        resolveActiveHookContext(),
      );
    } catch (error) {
      log.warn(`before_compaction hook failed during ${reason}: ${String(error)}`);
    }
  };
  const runOwnsCompactionAfterHook = async (
    reason: string,
    compactResult: Awaited<ReturnType<ContextEngine["compact"]>>,
    previousSessionId?: string,
  ) => {
    if (
      contextEngine.info.ownsCompaction !== true ||
      !compactResult.ok ||
      !compactResult.compacted ||
      !hookRunner?.hasHooks("after_compaction")
    ) {
      return;
    }
    try {
      await hookRunner.runAfterCompaction(
        {
          messageCount: -1,
          compactedCount: -1,
          tokenCount: compactResult.result?.tokensAfter,
          sessionFile:
            resolveCompactionSuccessorTranscript(compactResult).sessionFile ??
            sessionPromptState.sessionFile,
          ...(previousSessionId ? { previousSessionId } : {}),
        },
        resolveActiveHookContext(),
      );
    } catch (error) {
      log.warn(`after_compaction hook failed during ${reason}: ${String(error)}`);
    }
  };

  return {
    adoptCompactionTranscript,
    onCompactionHookMessages,
    runOwnsCompactionBeforeHook,
    runOwnsCompactionAfterHook,
  };
}
