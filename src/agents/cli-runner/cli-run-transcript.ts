import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { resolvePersistedSessionStoreOwnerForTarget } from "../../config/sessions/session-store-owner.js";
import { appendExactAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import { buildGenericCliContextEngineHostSupport } from "../../context-engine/host-compat.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { isHeartbeatLifecycleRunKind } from "../bootstrap-mode.js";
import type { CliOutput } from "../cli-output-contracts.js";
import {
  awaitAgentEndSideEffects,
  runAgentEndSideEffects,
} from "../harness/agent-end-side-effects.js";
import {
  finalizeHarnessContextEngineTurn,
  runHarnessContextEngineMaintenance,
} from "../harness/context-engine-lifecycle.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../harness/hook-helpers.js";
import type { AgentMessage } from "../runtime/index.js";
import { SessionManager } from "../sessions/session-manager.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../stream-message-shared.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

const log = createSubsystemLogger("agents/cli-runner");

export function buildCliHookUserMessage(prompt: string): unknown {
  return {
    role: "user",
    content: prompt,
    timestamp: Date.now(),
  };
}

export function buildCliHookAssistantMessage(params: {
  text: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}): unknown {
  return {
    role: "assistant",
    content: [{ type: "text", text: params.text }],
    api: "responses",
    provider: params.provider,
    model: params.model,
    ...(params.usage ? { usage: params.usage } : {}),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function isAgentMessage(value: unknown): value is AgentMessage {
  return Boolean(value && typeof value === "object" && "role" in value);
}

function buildCliContextEngineUserMessage(prompt: string): AgentMessage {
  return {
    role: "user",
    content: prompt,
    timestamp: Date.now(),
  } as AgentMessage;
}

function buildCliContextEngineAssistantMessage(params: {
  text: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}): AgentMessage {
  return buildCliHookAssistantMessage(params) as AgentMessage;
}

type CliAgentEndHookParams = Parameters<typeof runAgentEndSideEffects>[0];

function shouldAwaitCliAgentEndHook(params: RunCliAgentParams): boolean {
  return !params.messageChannel && !params.messageProvider;
}

export async function runCliAgentEndHook(
  params: RunCliAgentParams,
  hookParams: CliAgentEndHookParams,
): Promise<void> {
  if (shouldAwaitCliAgentEndHook(params)) {
    await awaitAgentEndSideEffects(hookParams);
    return;
  }
  runAgentEndSideEffects(hookParams);
}

export async function persistApprovedCliUserTurnTranscript(
  params: RunCliAgentParams,
): Promise<boolean> {
  const recorder = params.userTurnTranscriptRecorder;
  const reusingPersistedTurn = params.suppressNextUserMessagePersistence === true;
  if (!recorder || (reusingPersistedTurn && !recorder.hasPersisted())) {
    return recorder?.isBlocked() === true;
  }

  const persisted = await recorder.persistApproved({
    cwd: params.cwd ?? params.workspaceDir,
  });
  if (!persisted && !recorder.hasPersisted() && (await recorder.resolveMessage())) {
    // A prepared user row can be rejected by before_message_write. Preserve
    // that terminal decision so outer transcript mirrors do not retry it.
    recorder.markBlocked();
  }
  if (persisted && !reusingPersistedTurn) {
    try {
      const notification = params.onUserMessagePersisted?.(persisted.message);
      if (notification) {
        void Promise.resolve(notification).catch((error: unknown) => {
          log.warn(`CLI user turn persistence notification failed: ${formatErrorMessage(error)}`);
        });
      }
    } catch (error) {
      log.warn(`CLI user turn persistence notification failed: ${formatErrorMessage(error)}`);
    }
  }
  return persisted !== undefined || recorder.hasPersisted() || recorder.isBlocked();
}

export async function persistCliAssistantTranscript(params: {
  runParams: RunCliAgentParams;
  text: string;
  modelId: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}): Promise<{
  owned: boolean;
  idempotencyKey?: string;
  terminalAnchor?: import("../../config/sessions/session-accessor.js").TranscriptEntryAnchor;
}> {
  const { runParams } = params;
  if (runParams.currentInboundEventKind === "room_event") {
    const admission = runParams.userTurnTranscriptRecorder?.getAdmissionReceipt();
    return {
      owned: true,
      ...(admission ? { terminalAnchor: admission } : {}),
    };
  }
  if (!params.text) {
    const admission = runParams.userTurnTranscriptRecorder?.getAdmissionReceipt();
    return {
      owned: false,
      ...(admission ? { terminalAnchor: admission } : {}),
    };
  }
  if (!runParams.persistAssistantTranscript || !runParams.sessionKey) {
    return { owned: false };
  }
  try {
    const idempotencyKey = `cli-assistant:${runParams.runId}`;
    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey: runParams.sessionKey,
      agentId: runParams.agentId,
      expectedSessionId: runParams.sessionId,
      ...(runParams.expectedLifecycleRevision !== undefined
        ? { expectedLifecycleRevision: runParams.expectedLifecycleRevision }
        : {}),
      ...(runParams.expectedWriterRunId !== undefined
        ? { expectedWriterRunId: runParams.expectedWriterRunId }
        : {}),
      storePath: runParams.storePath,
      idempotencyKey,
      config: runParams.config,
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      message: buildAssistantMessage({
        model: {
          api: "cli",
          provider: runParams.provider,
          id: params.modelId,
        },
        content: [{ type: "text", text: params.text }],
        stopReason: "stop",
        usage: buildUsageWithNoCost({
          input: params.usage?.input,
          output: params.usage?.output,
          cacheRead: params.usage?.cacheRead,
          cacheWrite: params.usage?.cacheWrite,
          totalTokens: params.usage?.total,
        }),
      }),
    });
    if (!result.ok) {
      log.warn(`CLI assistant transcript persistence skipped: ${result.reason}`);
      return { owned: result.code === "blocked" || result.code === "session-rebound" };
    }
    return {
      owned: true,
      idempotencyKey,
      ...(result.anchor ? { terminalAnchor: result.anchor } : {}),
    };
  } catch (error) {
    log.warn(`CLI assistant transcript persistence failed: ${formatErrorMessage(error)}`);
    return { owned: false };
  }
}

async function notifyCliUserMessagePersisted(
  params: RunCliAgentParams,
  message: Extract<AgentMessage, { role: "user" }>,
  context: string,
): Promise<void> {
  try {
    await Promise.resolve(params.onUserMessagePersisted?.(message));
  } catch (err) {
    log.warn(`${context} notification failed: ${formatErrorMessage(err)}`);
  }
}

export async function persistCliRunBlock(
  params: RunCliAgentParams,
  block: { message: string; pluginId: string },
): Promise<void> {
  const nowMs = Date.now();
  const redactedUserMessage = {
    role: "user" as const,
    content: [{ type: "text" as const, text: block.message }],
    timestamp: nowMs,
    idempotencyKey: `hook-block:before_agent_run:user:${params.runId}`,
    __openclaw: {
      beforeAgentRunBlocked: {
        blockedBy: block.pluginId,
        blockedAt: nowMs,
      },
    },
  };
  try {
    const persisted = await params.userTurnTranscriptRecorder?.persistBlocked(redactedUserMessage);
    if (persisted) {
      await notifyCliUserMessagePersisted(
        params,
        persisted.message,
        "before_agent_run block user-turn persistence",
      );
      return;
    }
  } catch (err) {
    log.warn(
      `before_agent_run block: failed to persist canonical CLI user message: ${formatErrorMessage(
        err,
      )}`,
    );
  }

  try {
    const sessionKey = params.sessionKey?.trim() || params.sessionId;
    const targetAgentId = params.sessionTarget?.agentId;
    const targetStorePath = params.sessionTarget?.storePath;
    const targetStoreOwner = resolvePersistedSessionStoreOwnerForTarget({
      config: params.config ?? {},
      sessionKey,
      storePath: targetStorePath,
    });
    const explicitAlternateStoreAgentId =
      targetAgentId &&
      targetStorePath &&
      !parseAgentSessionKey(sessionKey)?.agentId &&
      targetStoreOwner.kind === "none"
        ? targetAgentId
        : undefined;
    const agentId =
      explicitAlternateStoreAgentId ??
      resolveSessionAgentId({
        agentId: targetAgentId ?? params.agentId,
        config: params.config,
        sessionKey,
      });
    let sessionManager = params.sessionManager;
    if (!sessionManager) {
      const sessionTarget = params.sessionTarget ?? {
        agentId,
        sessionId: params.sessionId,
        sessionKey,
        storePath:
          params.storePath ??
          resolveSessionStorePathCore(params.config?.session?.store, {
            agentId,
          }),
      };
      const persistedEntry = await patchSessionEntryCore(
        sessionTarget,
        (entry, patchContext) => {
          if (patchContext.existingEntry && entry.sessionId !== sessionTarget.sessionId) {
            return null;
          }
          return {
            sessionId: sessionTarget.sessionId,
            updatedAt: Date.now(),
          };
        },
        {
          fallbackEntry: params.sessionEntry
            ? undefined
            : { sessionId: sessionTarget.sessionId, updatedAt: Date.now() },
          skipMaintenance: true,
        },
      );
      if (persistedEntry?.sessionId !== sessionTarget.sessionId) {
        // Skip only this stale blocked-message write; the outer runner still returns blocked.
        return;
      }
      sessionManager = SessionManager.open(sessionTarget);
    }
    sessionManager.appendMessage(
      redactedUserMessage as Parameters<typeof sessionManager.appendMessage>[0],
    );
    sessionManager.flushPendingPersistence();
  } catch (err) {
    log.warn(
      `before_agent_run block: failed to persist redacted CLI user message: ${formatErrorMessage(
        err,
      )}`,
    );
  }
}

export async function finalizeCliContextEngineTurn(params: {
  context: PreparedCliRunContext;
  historyMessages: unknown[];
  assistantText: string;
  terminalAnchor?: import("../../config/sessions/session-accessor.js").TranscriptEntryAnchor;
  output: CliOutput;
}): Promise<void> {
  const { context } = params;
  if (!context.contextEngine) {
    return;
  }

  const { params: runParams } = context;
  const prePromptMessages = params.historyMessages.filter(isAgentMessage);
  const turnMessages: AgentMessage[] = [];
  if (context.contextEngineTurnPrompt) {
    turnMessages.push(buildCliContextEngineUserMessage(context.contextEngineTurnPrompt));
  }
  if (params.assistantText) {
    turnMessages.push(
      buildCliContextEngineAssistantMessage({
        text: params.assistantText,
        provider: runParams.provider,
        model: context.modelId,
        usage: params.output.usage,
      }),
    );
  }

  const contextEngineHostSupport = buildGenericCliContextEngineHostSupport({
    backendId: context.backendResolved.id,
  });
  const finalizeTurn = async (transcript: {
    messagesSnapshot: AgentMessage[];
    prePromptMessageCount: number;
    sessionManager?: SessionManager;
    withSessionManagerRewriteLock: <T>(operation: () => Promise<T> | T) => Promise<T>;
  }) => {
    let deferredTurnMaintenance: Promise<void> | undefined;
    const result = await finalizeHarnessContextEngineTurn({
      contextEngine: context.contextEngine,
      promptError: false,
      aborted: runParams.abortSignal?.aborted === true,
      yieldAborted: false,
      sessionIdUsed: runParams.sessionId,
      sessionKey: runParams.sessionKey,
      sessionFile: runParams.sessionFile,
      isHeartbeat: isHeartbeatLifecycleRunKind(runParams.bootstrapContextRunKind),
      messagesSnapshot: transcript.messagesSnapshot,
      prePromptMessageCount: transcript.prePromptMessageCount,
      sessionManager: transcript.sessionManager,
      config: context.contextEngineConfig,
      contextEngineHostSupport,
      providerId: runParams.provider,
      modelId: context.modelId,
      runMaintenance: async (maintenanceParams) =>
        await runHarnessContextEngineMaintenance({
          ...maintenanceParams,
          withSessionManagerRewriteLock: transcript.withSessionManagerRewriteLock,
          onDeferredMaintenance: (promise) => {
            deferredTurnMaintenance = promise;
          },
        }),
      warn: (message) => log.warn(message),
    });
    if (result.postTurnFinalizationSucceeded && deferredTurnMaintenance) {
      context.contextEngineDeferredTurnMaintenance = deferredTurnMaintenance;
    }
  };
  const admission = runParams.userTurnTranscriptRecorder?.getAdmissionReceipt();
  if (runParams.onContextEngineTurnCandidate) {
    if (admission && params.terminalAnchor) {
      runParams.onContextEngineTurnCandidate({
        boundary: { admission, terminal: params.terminalAnchor },
        sessionIdUsed: runParams.sessionId,
        sessionKey: runParams.sessionKey,
        sessionTarget: runParams.sessionTarget,
        sessionFile: runParams.sessionFile,
        promptError: false,
        aborted: runParams.abortSignal?.aborted === true,
        yieldAborted: false,
        contextEngineHostSupport,
        providerId: runParams.provider,
        modelId: context.modelId,
        config: context.contextEngineConfig,
        isHeartbeat: isHeartbeatLifecycleRunKind(runParams.bootstrapContextRunKind),
      });
    }
  } else {
    await finalizeTurn({
      messagesSnapshot: [...prePromptMessages, ...turnMessages],
      prePromptMessageCount: prePromptMessages.length,
      withSessionManagerRewriteLock: async (operation) => await operation(),
    });
  }
}
