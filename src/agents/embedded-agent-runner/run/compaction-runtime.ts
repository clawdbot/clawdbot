import {
  loadSessionEntry,
  type SessionTranscriptRuntimeTarget,
} from "../../../config/sessions/session-accessor.js";
import {
  withOwnedSessionTranscriptWrites,
  SessionTranscriptWriterClaimReboundError,
} from "../../../config/sessions/transcript-write-context.js";
import { inheritRuntimeCompactionDelegate } from "../../../context-engine/compaction-watchdog.js";
import type { resolveContextEngine } from "../../../context-engine/registry.js";
import type { buildContextEngineRuntimeSettings } from "../../../context-engine/runtime-settings.js";
import {
  resolveCompactionSuccessorTranscript,
  type ContextEngineSessionTarget,
} from "../../../context-engine/types.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import { listActiveProcessSessionReferences } from "../../bash-process-references.js";
import { resolveProcessToolScopeKey } from "../../bash-process-scope.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { buildEmbeddedCompactionRuntimeContext } from "../compaction-runtime-context.js";
import {
  compactContextEngineWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "../compaction-safety-timeout.js";
import {
  acceptCompactionSuccessor,
  resolveContextEngineCompactionSuccessor,
  type AcceptedCompactionSuccessor,
} from "../compaction-successor.js";
import { resolveContextEngineCapabilities } from "../context-engine-capabilities.js";
import { log } from "../logger.js";
import { mergeUsageIntoAccumulator, type UsageAccumulator } from "../usage-accumulator.js";
import { attachCompactionAccountingRecorder } from "./compaction-accounting-bridge.js";
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
  adoptCompactionTranscript: (
    result: CompactionResult,
    onAccepted?: () => void,
  ) => Promise<string | undefined>;
  getActiveSession: () => {
    id: string;
    file: string;
    target?: ContextEngineSessionTarget;
  };
  assertRecoveryActive: () => void;
  prepareRecoveryOwner: ReturnType<
    typeof createEmbeddedRunCompactionRuntime
  >["prepareRecoveryOwner"];
  prepareRecoverySession: ReturnType<
    typeof createEmbeddedRunCompactionRuntime
  >["prepareRecoverySession"];
  prepareCompactedTranscriptRetry: (assertActive: () => void) => Promise<void>;
  armPostCompactionGuard: () => void;
  usageAccumulator: UsageAccumulator;
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
  const owner = input.prepareRecoveryOwner();
  const activeSession = owner.session;
  const reason = recovery.trigger === "overflow" ? "overflow recovery" : "timeout recovery";
  await input.runOwnsCompactionBeforeHook(reason);
  owner.assertActive();
  const runtimeContext = {
    ...buildEmbeddedCompactionRuntimeContext({
      sessionKey: runParams.sessionKey,
      messageChannel: runParams.messageChannel,
      messageProvider: runParams.messageProvider,
      clientCaps: runParams.clientCaps,
      chatType: runParams.chatType,
      agentAccountId: runParams.agentAccountId,
      conversationRoutePeerId: runParams.conversationRoutePeerId,
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
  let observedCompactions = 0;
  const runtimeSettings = input.buildRuntimeSettings({
    tokenBudget: recovery.tokenBudget,
    ...(recovery.trigger === "overflow" ? { degradedReason: "context_overflow" } : {}),
  });
  const compactParams: Parameters<ContextEngine["compact"]>[0] = {
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
  };
  let result: CompactionResult;
  try {
    result = await compactContextEngineWithSafetyTimeout(
      {
        info: input.contextEngine.info,
        // oxlint-disable-next-line typescript/unbound-method -- tag inheritance uses identity, not invocation.
        compact: inheritRuntimeCompactionDelegate(input.contextEngine.compact, (backendParams) =>
          owner.withTranscriptWrites(backendParams.abortSignal, () => {
            // The watchdog may copy runtimeContext to install its progress callback.
            // Attach private facts to the object the delegate actually receives.
            if (backendParams.runtimeContext) {
              attachCompactionAccountingRecorder(backendParams.runtimeContext, {
                recordUsage: (usage) => mergeUsageIntoAccumulator(input.usageAccumulator, usage),
                recordCompaction: (tokensAfter) => {
                  observedCompactions += 1;
                  input.state.observeContextAccounting({ kind: "compaction", tokensAfter });
                },
              });
            }
            return input.contextEngine.compact(backendParams);
          }),
        ),
      },
      compactParams,
      resolveCompactionTimeoutMs(runParams.config),
      runParams.abortSignal,
    );
  } catch (error) {
    // Only a live owner's backend failure is recoverable. Caller cancellation,
    // replacement, and claim loss must never become a truncation/retry request.
    owner.assertActive();
    log.warn(
      `contextEngine.compact() threw during ${reason} for ${input.provider}/${input.modelId}: ${String(error)}`,
    );
    result = { ok: false, compacted: false, reason: String(error) };
  }
  if (observedCompactions > 0 && !result.compacted) {
    // Post-commit failure is not an unperformed compaction. Retry the observed
    // current context, but never adopt a failed backend's successor proposal.
    result = { ok: result.ok, compacted: true, reason: result.reason };
  }
  const successor = resolveCompactionSuccessorTranscript(result);
  const target = result.result?.sessionTarget;
  const sameTarget =
    (!successor.sessionId || successor.sessionId === activeSession.id) &&
    (!successor.sessionFile || successor.sessionFile === activeSession.file) &&
    (!target?.agentId || target.agentId === activeSession.target?.agentId) &&
    (!target?.sessionKey || target.sessionKey === activeSession.target?.sessionKey) &&
    (!target?.storePath || target.storePath === activeSession.target?.storePath);
  const reportedTokens = result.result?.tokensAfter;
  const tokensAfter =
    typeof reportedTokens === "number" && Number.isFinite(reportedTokens) && reportedTokens >= 0
      ? Math.floor(reportedTokens)
      : undefined;
  const recordTokensAfter = () => {
    input.state.lastCompactionTokensAfter = tokensAfter;
    input.state.currentContextSnapshot = { tokens: tokensAfter };
  };
  if (result.compacted && observedCompactions === 0) {
    // Opaque engines report completion on return. Stock commits are already
    // recorded before hooks; their late result must not replace a newer context.
    // A proposed successor's token snapshot transfers only on host acceptance.
    input.state.observeContextAccounting({
      kind: "compaction",
      tokensAfter: sameTarget ? tokensAfter : undefined,
    });
  }
  owner.assertActive();
  const previousSessionId = result.compacted
    ? await input.adoptCompactionTranscript(result, sameTarget ? undefined : recordTokensAfter)
    : undefined;
  input.assertRecoveryActive();
  return { result, runtimeContext, runtimeSettings, previousSessionId };
}

export function createEmbeddedRunCompactionRuntime(input: {
  runParams: PreparedEmbeddedRunInput["runParams"];
  contextEngine: ContextEngine;
  hookRunner: PreparedEmbeddedRunInput["hookRunner"];
  hookContext: PreparedEmbeddedRunInput["hookContext"];
  sessionPromptState: SessionPromptState;
}) {
  const { runParams: params, contextEngine, hookRunner, hookContext, sessionPromptState } = input;
  const abortSignal = params.abortSignal;
  const admittedAssertion = params.admittedRunContext
    ? resolveAdmittedRunActiveAssertion(params.admittedRunContext)
    : undefined;
  const runId = params.runId;
  const memoryManager =
    params.sessionManager && !params.sessionManager.getSessionTarget()
      ? params.sessionManager
      : undefined;
  const detached = params.sessionPersistence === "detached";
  const assertAdmittedActive = () => {
    // Preserve the caller's reason before a closed admission can replace it.
    abortSignal?.throwIfAborted();
    if (!admittedAssertion) {
      throw new Error("compaction recovery requires an active admitted run");
    }
    admittedAssertion();
  };
  const assertRecoveryTarget = (
    target: ContextEngineSessionTarget | undefined,
    sessionId = sessionPromptState.sessionId,
    writerFence = sessionPromptState.sessionWriterFence,
  ) => {
    assertAdmittedActive();
    if (memoryManager || detached) {
      return;
    }
    const entry =
      target?.sessionKey && target.storePath
        ? loadSessionEntry({
            agentId: target.agentId,
            sessionKey: target.sessionKey,
            storePath: target.storePath,
            readConsistency: "latest",
          })
        : undefined;
    if (
      !writerFence ||
      writerFence.expectedWriterRunId !== runId ||
      entry?.sessionId !== sessionId ||
      entry.lifecycleRevision !== writerFence.expectedLifecycleRevision ||
      entry.activeWriterRunId !== writerFence.expectedWriterRunId
    ) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
  };
  const assertRecoveryActive = () => assertRecoveryTarget(sessionPromptState.sessionTarget);
  const getPreparedTarget = (): SessionTranscriptRuntimeTarget => {
    const target = sessionPromptState.sessionTarget;
    if (!target?.agentId || !target.sessionKey || !target.storePath) {
      throw new Error("compaction recovery requires a complete transcript target");
    }
    return {
      ...target,
      agentId: target.agentId,
      sessionId: sessionPromptState.sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
    };
  };
  const prepareRecoveryOwner = () => {
    assertRecoveryActive();
    const sessionId = sessionPromptState.sessionId;
    const sessionFile = sessionPromptState.sessionFile;
    const writerFence = sessionPromptState.sessionWriterFence;
    const target = { ...getPreparedTarget(), ...writerFence };
    const assertActive = () => {
      assertRecoveryTarget(target, sessionId, writerFence);
      const current = sessionPromptState.sessionTarget;
      if (
        sessionPromptState.sessionId !== sessionId ||
        sessionPromptState.sessionFile !== sessionFile ||
        current?.agentId !== target.agentId ||
        current?.sessionKey !== target.sessionKey ||
        current?.storePath !== target.storePath
      ) {
        throw new Error("active session changed after recovery transcript preparation");
      }
    };
    return {
      session: { id: sessionId, file: sessionFile, target },
      assertActive,
      withTranscriptWrites: <T>(signal: AbortSignal | undefined, run: () => Promise<T>) => {
        const assertInvocationActive = () => {
          signal?.throwIfAborted();
          assertActive();
        };
        const assertCommitAllowed = () => {
          assertInvocationActive();
          if (detached || memoryManager) {
            throw new Error("detached recovery cannot persist a session transcript");
          }
        };
        // Bind the original owner and the safety wrapper's child signal to every
        // nested write, including callbacks retained beyond the backend result.
        return withOwnedSessionTranscriptWrites(
          {
            sessionTarget: target,
            assertCommitAllowed,
            withTranscriptWrite: async (write) => await write(),
          },
          async () => {
            assertInvocationActive();
            return await run();
          },
        );
      },
    };
  };
  const prepareRecoverySession = () => {
    const owner = prepareRecoveryOwner();
    const sessionManager =
      memoryManager ??
      (detached ? undefined : SessionManager.open(owner.session.target, params.workspaceDir));
    return {
      sessionManager,
      assertActive: owner.assertActive,
      withSessionManagerRewriteLock: <T>(operation: () => Promise<T> | T): Promise<T> =>
        owner.withTranscriptWrites(undefined, async () => {
          if (!sessionManager) {
            throw new Error("detached recovery has no caller-owned transcript to rewrite");
          }
          sessionManager.reloadPersistedTranscript();
          return await operation();
        }),
    };
  };
  const resolveActiveHookContext = () => ({
    ...hookContext,
    sessionId: sessionPromptState.sessionId,
  });
  const adoptCompactionTranscript = async (
    compactResult: CompactionResult,
    onAccepted?: () => void,
  ): Promise<string | undefined> => {
    assertRecoveryActive();
    const currentTarget = getPreparedTarget();
    if (memoryManager || detached) {
      const successor = await resolveContextEngineCompactionSuccessor({
        config: params.config,
        currentSessionFile: sessionPromptState.sessionFile,
        currentTarget,
        result: compactResult,
      });
      assertAdmittedActive();
      sessionPromptState.capturePreparedCompactionTarget(successor);
      onAccepted?.();
      sessionPromptState.notifyCompactionSessionAdopted(currentTarget.sessionId);
      assertAdmittedActive();
      return successor.sessionId !== currentTarget.sessionId ? currentTarget.sessionId : undefined;
    }
    const writerFence = sessionPromptState.sessionWriterFence;
    const recordAccepted = (accepted: AcceptedCompactionSuccessor) => {
      sessionPromptState.recordCommittedCompactionSuccessor(accepted);
      onAccepted?.();
    };
    const accepted = await acceptCompactionSuccessor({
      config: params.config,
      currentSessionFile: sessionPromptState.sessionFile,
      currentTarget,
      result: compactResult,
      expectedEntry: {
        sessionId: currentTarget.sessionId,
        lifecycleRevision: writerFence?.expectedLifecycleRevision,
        activeWriterRunId: writerFence?.expectedWriterRunId,
      },
      assertActive: assertAdmittedActive,
      onCommitted: recordAccepted,
    });
    // Unchanged identity has no storage publication, but its validated current
    // row still identifies the already-recorded compaction for accounting.
    if (!accepted.previousSessionId) {
      recordAccepted(accepted);
    }
    assertRecoveryActive();
    sessionPromptState.notifyCompactionSessionAdopted(accepted.previousSessionId);
    assertRecoveryActive();
    return accepted.previousSessionId;
  };
  const onCompactionHookMessages = async (payload: {
    phase: "before" | "after";
    messages: string[];
  }) => {
    const messages = payload.messages.filter((message) => message.trim().length > 0);
    if (messages.length === 0) {
      return;
    }
    assertRecoveryActive();
    await params.onAgentEvent?.({
      stream: "compaction",
      data: {
        phase: payload.phase === "before" ? "start" : "end",
        ...(payload.phase === "after" ? { completed: true } : {}),
        messages,
      },
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
    assertRecoveryActive();
  };
  const runOwnsCompactionBeforeHook = async (reason: string) => {
    assertRecoveryActive();
    if (contextEngine.info.ownsCompaction !== true || !hookRunner?.hasHooks("before_compaction")) {
      return;
    }
    try {
      await hookRunner.runBeforeCompaction(
        { messageCount: -1, sessionFile: sessionPromptState.sessionFile },
        resolveActiveHookContext(),
      );
    } catch (error) {
      assertRecoveryActive();
      log.warn(`before_compaction hook failed during ${reason}: ${String(error)}`);
    }
    assertRecoveryActive();
  };
  const runOwnsCompactionAfterHook = async (
    reason: string,
    compactResult: Awaited<ReturnType<ContextEngine["compact"]>>,
    previousSessionId?: string,
  ) => {
    assertRecoveryActive();
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
      assertRecoveryActive();
      log.warn(`after_compaction hook failed during ${reason}: ${String(error)}`);
    }
    assertRecoveryActive();
  };

  return {
    assertRecoveryActive,
    prepareRecoveryOwner,
    prepareRecoverySession,
    adoptCompactionTranscript,
    onCompactionHookMessages,
    runOwnsCompactionBeforeHook,
    runOwnsCompactionAfterHook,
  };
}
