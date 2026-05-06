import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { stripRuntimeContextCustomMessages } from "../internal-runtime-context.js";
import { runContextEngineMaintenance } from "../pi-embedded-runner/context-engine-maintenance.js";
import {
  buildAfterTurnRuntimeContext,
  buildAfterTurnRuntimeContextFromUsage,
} from "../pi-embedded-runner/run/attempt.prompt-helpers.js";
import type { SessionWriteLockAcquireTimeoutConfig } from "../session-write-lock.js";

export type HarnessContextEngine = ContextEngine;

/**
 * Run optional bootstrap + bootstrap maintenance for a harness-owned context engine.
 */
export async function bootstrapHarnessContextEngine(params: {
  hadSessionFile: boolean;
  contextEngine?: HarnessContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  sessionManager?: unknown;
  runtimeContext?: ContextEngineRuntimeContext;
  runMaintenance?: typeof runHarnessContextEngineMaintenance;
  config?: SessionWriteLockAcquireTimeoutConfig;
  warn: (message: string) => void;
}): Promise<void> {
  if (
    !params.hadSessionFile ||
    !(params.contextEngine?.bootstrap || params.contextEngine?.maintain)
  ) {
    return;
  }
  try {
    if (typeof params.contextEngine?.bootstrap === "function") {
      await params.contextEngine.bootstrap({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
      });
    }
    await (params.runMaintenance ?? runHarnessContextEngineMaintenance)({
      contextEngine: params.contextEngine,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      reason: "bootstrap",
      sessionManager: params.sessionManager,
      runtimeContext: params.runtimeContext,
      config: params.config,
    });
  } catch (bootstrapErr) {
    params.warn(`context engine bootstrap failed: ${String(bootstrapErr)}`);
  }
}

/**
 * Assemble model context through the active harness-owned context engine.
 */
export async function assembleHarnessContextEngine(params: {
  contextEngine?: HarnessContextEngine;
  sessionId: string;
  sessionKey?: string;
  messages: AgentMessage[];
  tokenBudget?: number;
  availableTools?: Set<string>;
  citationsMode?: MemoryCitationsMode;
  modelId: string;
  prompt?: string;
}) {
  if (!params.contextEngine) {
    return undefined;
  }
  const messages = stripRuntimeContextCustomMessages(params.messages);
  return await params.contextEngine.assemble({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    messages,
    tokenBudget: params.tokenBudget,
    ...(params.availableTools ? { availableTools: params.availableTools } : {}),
    ...(params.citationsMode ? { citationsMode: params.citationsMode } : {}),
    model: params.modelId,
    ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
  });
}

/**
 * Finalize a completed harness turn via afterTurn or ingest fallbacks.
 */
export async function finalizeHarnessContextEngineTurn(params: {
  contextEngine?: HarnessContextEngine;
  promptError: boolean;
  aborted: boolean;
  yieldAborted: boolean;
  sessionIdUsed: string;
  sessionKey?: string;
  sessionFile: string;
  messagesSnapshot: AgentMessage[];
  prePromptMessageCount: number;
  tokenBudget?: number;
  runtimeContext?: ContextEngineRuntimeContext;
  runMaintenance?: typeof runHarnessContextEngineMaintenance;
  sessionManager?: unknown;
  config?: SessionWriteLockAcquireTimeoutConfig;
  warn: (message: string) => void;
}) {
  if (!params.contextEngine) {
    return { postTurnFinalizationSucceeded: true };
  }

  const conversationSnapshot = buildContextEngineConversationSnapshot({
    messagesSnapshot: params.messagesSnapshot,
    prePromptMessageCount: params.prePromptMessageCount,
  });
  let postTurnFinalizationSucceeded = true;

  if (typeof params.contextEngine.afterTurn === "function") {
    try {
      await params.contextEngine.afterTurn({
        sessionId: params.sessionIdUsed,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        messages: conversationSnapshot.messages,
        prePromptMessageCount: conversationSnapshot.prePromptMessageCount,
        tokenBudget: params.tokenBudget,
        runtimeContext: params.runtimeContext,
      });
    } catch (afterTurnErr) {
      postTurnFinalizationSucceeded = false;
      params.warn(`context engine afterTurn failed: ${String(afterTurnErr)}`);
    }
  } else {
    const newMessages = conversationSnapshot.messages.slice(
      conversationSnapshot.prePromptMessageCount,
    );
    if (newMessages.length > 0) {
      if (typeof params.contextEngine.ingestBatch === "function") {
        try {
          await params.contextEngine.ingestBatch({
            sessionId: params.sessionIdUsed,
            sessionKey: params.sessionKey,
            messages: newMessages,
          });
        } catch (ingestErr) {
          postTurnFinalizationSucceeded = false;
          params.warn(`context engine ingest failed: ${String(ingestErr)}`);
        }
      } else {
        for (const msg of newMessages) {
          try {
            await params.contextEngine.ingest?.({
              sessionId: params.sessionIdUsed,
              sessionKey: params.sessionKey,
              message: msg,
            });
          } catch (ingestErr) {
            postTurnFinalizationSucceeded = false;
            params.warn(`context engine ingest failed: ${String(ingestErr)}`);
          }
        }
      }
    }
  }

  if (
    !params.promptError &&
    !params.aborted &&
    !params.yieldAborted &&
    postTurnFinalizationSucceeded
  ) {
    await (params.runMaintenance ?? runHarnessContextEngineMaintenance)({
      contextEngine: params.contextEngine,
      sessionId: params.sessionIdUsed,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      reason: "turn",
      sessionManager: params.sessionManager,
      runtimeContext: params.runtimeContext,
      config: params.config,
    });
  }

  return { postTurnFinalizationSucceeded };
}

function buildContextEngineConversationSnapshot(params: {
  messagesSnapshot: AgentMessage[];
  prePromptMessageCount: number;
}): { messages: AgentMessage[]; prePromptMessageCount: number } {
  const prePromptMessages = stripRuntimeContextCustomMessages(
    params.messagesSnapshot.slice(0, params.prePromptMessageCount),
  );
  const turnMessages = stripRuntimeContextCustomMessages(
    params.messagesSnapshot.slice(params.prePromptMessageCount),
  );
  return {
    messages: [...prePromptMessages, ...turnMessages],
    prePromptMessageCount: prePromptMessages.length,
  };
}

/**
 * Build runtime context passed into harness context-engine hooks.
 */
export function buildHarnessContextEngineRuntimeContext(
  params: Parameters<typeof buildAfterTurnRuntimeContext>[0],
): ContextEngineRuntimeContext {
  return buildAfterTurnRuntimeContext(params);
}

/**
 * Build runtime context passed into harness context-engine hooks from usage data.
 */
export function buildHarnessContextEngineRuntimeContextFromUsage(
  params: Parameters<typeof buildAfterTurnRuntimeContextFromUsage>[0],
): ContextEngineRuntimeContext {
  return buildAfterTurnRuntimeContextFromUsage(params);
}

/**
 * Run optional transcript maintenance for a harness-owned context engine.
 */
export async function runHarnessContextEngineMaintenance(params: {
  contextEngine?: HarnessContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  reason: "bootstrap" | "compaction" | "turn";
  sessionManager?: unknown;
  runtimeContext?: ContextEngineRuntimeContext;
  executionMode?: "foreground" | "background";
  config?: SessionWriteLockAcquireTimeoutConfig;
}) {
  return await runContextEngineMaintenance({
    contextEngine: params.contextEngine,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    reason: params.reason,
    sessionManager: params.sessionManager as Parameters<
      typeof runContextEngineMaintenance
    >[0]["sessionManager"],
    runtimeContext: params.runtimeContext,
    executionMode: params.executionMode,
    config: params.config,
  });
}

/**
 * Return true when a non-legacy context engine should affect plugin harness behavior.
 */
export function isActiveHarnessContextEngine(
  contextEngine: ContextEngine | undefined,
): contextEngine is ContextEngine {
  return Boolean(contextEngine && contextEngine.info.id !== "legacy");
}
