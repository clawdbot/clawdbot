/**
 * Builds extension factories available to embedded-agent runtime sessions.
 */
import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { normalizeAcceptedSessionSpawnResult } from "../accepted-session-spawn.js";
import { setCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../agent-hooks/compaction-safeguard.js";
import { resolveEffectiveCompactionMode } from "../agent-settings.js";
import {
  finalizeToolTerminalPresentation,
  peekAdjustedParamsForToolCall,
} from "../agent-tools.before-tool-call.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { createAgentToolResultMiddlewareRunner } from "../harness/tool-result-middleware.js";
import type { AgentToolResult } from "../runtime/index.js";
import type { ExtensionFactory, SessionManager } from "../sessions/index.js";
import { isToolResultError } from "../tool-result-error.js";
import { recordEmbeddedToolSendReceipt } from "./tool-send-receipts.js";

type AgentToolResultEvent = {
  threadId?: string;
  turnId?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  content?: AgentToolResult<unknown>["content"];
  details?: unknown;
  isError?: boolean;
};

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function snapshotToolSendReceipt(details: unknown): unknown {
  const toolSend = recordFromUnknown(details).toolSend;
  return toolSend && typeof toolSend === "object" && !Array.isArray(toolSend)
    ? { ...(toolSend as Record<string, unknown>) }
    : toolSend;
}

function buildAgentToolResultMiddlewareFactory(
  sessionManager: SessionManager,
  context: {
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
    runId?: string;
  },
): ExtensionFactory {
  const { agentId, sessionKey, runId } = context;
  // Snapshot the prepared session once; tool results must never rediscover
  // mutable session identity after a later turn has started.
  const sessionId = context.sessionId ?? sessionManager.getSessionId?.();
  const runner = createAgentToolResultMiddlewareRunner({
    runtime: "openclaw",
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
  });
  return (agent) => {
    agent.on("tool_result", async (rawEvent: unknown, ctx: { cwd?: string }) => {
      const event = recordFromUnknown(rawEvent) as AgentToolResultEvent;
      if (!event.toolName) {
        return undefined;
      }
      const eventToolCallId =
        typeof event.toolCallId === "string" && event.toolCallId.trim()
          ? event.toolCallId
          : undefined;
      const toolCallId = eventToolCallId ?? `openclaw-${randomUUID()}`;
      const content = Array.isArray(event.content) ? event.content : [];
      const current = {
        content,
        details: event.details,
      } satisfies AgentToolResult<unknown>;
      const rawToolSend = snapshotToolSendReceipt(current.details);
      if (eventToolCallId && rawToolSend !== undefined) {
        // Routing evidence stays private so middleware may fully replace result details.
        recordEmbeddedToolSendReceipt(sessionManager, eventToolCallId, rawToolSend);
      }
      const inputHadErrorStatus = isToolResultError(current);
      const adjustedInput = eventToolCallId
        ? peekAdjustedParamsForToolCall(eventToolCallId, runId)
        : undefined;
      const result = await runner.applyToolResultMiddleware({
        threadId: event.threadId,
        turnId: event.turnId,
        toolCallId,
        toolName: event.toolName,
        args: recordFromUnknown(adjustedInput ?? event.input),
        cwd: ctx.cwd,
        isError: event.isError,
        result: current,
      });
      const isAcceptedSessionSpawn =
        event.toolName === "sessions_spawn" && normalizeAcceptedSessionSpawnResult(result) !== null;
      const isError =
        !isAcceptedSessionSpawn &&
        (event.isError === true || inputHadErrorStatus || isToolResultError(result));
      const clearsAcceptedSessionSpawnError =
        isAcceptedSessionSpawn &&
        (event.isError === true || inputHadErrorStatus || isToolResultError(result));
      if (eventToolCallId) {
        finalizeToolTerminalPresentation({
          toolCallId: eventToolCallId,
          runId,
          result,
          isError,
        });
      }
      return {
        content: result.content,
        details: result.details,
        ...(isError ? { isError: true } : {}),
        ...(clearsAcceptedSessionSpawnError ? { isError: false } : {}),
      };
    });
  };
}

export function buildEmbeddedExtensionFactories(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel | undefined;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
}): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  if (resolveEffectiveCompactionMode(params.cfg) === "safeguard") {
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
    const qualityGuardCfg = compactionCfg?.qualityGuard;
    const contextWindowInfo = resolveContextWindowInfo({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
      modelContextTokens: params.model?.contextTokens,
      modelContextWindow: params.model?.contextWindow,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
    });
    setCompactionSafeguardRuntime(params.sessionManager, {
      contextWindowTokens: contextWindowInfo.tokens,
      identifierPolicy: compactionCfg?.identifierPolicy,
      qualityGuardEnabled: qualityGuardCfg?.enabled ?? true,
      qualityGuardMaxRetries: qualityGuardCfg?.maxRetries,
      model: params.model,
      recentTurnsPreserve: compactionCfg?.recentTurnsPreserve,
      workspaceDir: params.workspaceDir,
      postCompactionSections: compactionCfg?.postCompactionSections,
      provider: compactionCfg?.provider,
    });
    factories.push(compactionSafeguardExtension);
  }
  factories.push(
    buildAgentToolResultMiddlewareFactory(params.sessionManager, {
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      runId: params.runId,
    }),
  );
  return factories;
}
