import fs from "node:fs/promises";
import path from "node:path";
import {
  awaitAgentEndSideEffects,
  embeddedAgentLog,
  emitAgentEvent as emitGlobalAgentEvent,
  runAgentEndSideEffects,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { codexWorkspaceDirCache } from "./workspace-dir-cache.js";

const CODEX_APP_SERVER_PROJECTED_CHARS_PER_TOKEN = 4;

export function shouldKeepCodexSharedAbortOpen(params: {
  trigger: EmbeddedRunAttemptParams["trigger"];
  result: EmbeddedRunAttemptResult;
  attemptSucceeded: boolean;
  explicitCancellationObserved: boolean;
}): boolean {
  if (params.explicitCancellationObserved || params.result.aborted || params.result.externalAbort) {
    return false;
  }
  // Memory attempts are preparatory. Failed attempts can still enter runner
  // retries or model fallback. The reply orchestrator owns the shared terminal
  // freeze after those paths settle.
  return params.trigger === "memory" || !params.attemptSucceeded;
}

export function withCodexAppServerFastModeServiceTier(
  appServer: CodexAppServerRuntimeOptions,
  params: EmbeddedRunAttemptParams,
): CodexAppServerRuntimeOptions {
  const fastMode = typeof params.fastMode === "function" ? params.fastMode() : params.fastMode;
  const serviceTier =
    fastMode === undefined ? appServer.serviceTier : fastMode ? "priority" : undefined;
  if (serviceTier === appServer.serviceTier) {
    return appServer;
  }
  if (serviceTier) {
    return { ...appServer, serviceTier };
  }
  return { ...appServer, serviceTier: null };
}

export function estimateCodexAppServerProjectedTurnTokens(params: {
  prompt: string;
  developerInstructions?: string;
}): number {
  const inputChars = params.prompt.length + (params.developerInstructions?.length ?? 0);
  return Math.max(1, Math.ceil(inputChars / CODEX_APP_SERVER_PROJECTED_CHARS_PER_TOKEN));
}

export async function ensureCodexWorkspaceDirOnce(workspaceDir: string): Promise<void> {
  const normalized = path.resolve(workspaceDir);
  if (codexWorkspaceDirCache.has(normalized)) {
    try {
      const stat = await fs.stat(normalized);
      if (stat.isDirectory()) {
        return;
      }
    } catch (error) {
      const code =
        typeof error === "object" && error ? (error as { code?: unknown }).code : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
    }
    codexWorkspaceDirCache.delete(normalized);
  }
  // Codex attempts re-enter the same workspace repeatedly; caching successful
  // mkdirs avoids repeated fs work while still recovering if cleanup prunes
  // the directory between attempts.
  await fs.mkdir(normalized, { recursive: true });
  codexWorkspaceDirCache.add(normalized);
}

export async function emitCodexAppServerEvent(
  params: EmbeddedRunAttemptParams,
  event: Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0],
): Promise<void> {
  try {
    emitGlobalAgentEvent({
      runId: params.runId,
      stream: event.stream,
      data: event.data,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
  } catch (error) {
    embeddedAgentLog.debug("codex app-server global agent event emit failed", { error });
  }
  try {
    await params.onAgentEvent?.(event);
  } catch (error) {
    // Event consumers are observational; they must not abort or strand the
    // canonical app-server turn lifecycle.
    embeddedAgentLog.debug("codex app-server agent event handler threw", { error });
  }
}

type CodexAgentEndHookParams = Parameters<typeof runAgentEndSideEffects>[0];

export async function runCodexAgentEndHook(
  params: EmbeddedRunAttemptParams,
  hookParams: CodexAgentEndHookParams,
): Promise<void> {
  const sideEffectParams = {
    ...hookParams,
    ctx: { ...hookParams.ctx, config: params.config },
  };
  if (!params.messageChannel && !params.messageProvider) {
    await awaitAgentEndSideEffects(sideEffectParams);
    return;
  }
  runAgentEndSideEffects(sideEffectParams);
}
