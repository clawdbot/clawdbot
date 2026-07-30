/**
 * Native claude-bridge compaction for bound OpenClaw sessions. Mirrors the
 * codex extension's compact.ts in role: OpenClaw's compaction router
 * (src/agents/harness/compaction.ts) calls the harness `compact` hook, and we
 * forward it to the bridge's `thread/compact/start` — which drives the Claude
 * CLI's own `/compact` inside the thread's real model context. OpenClaw-native
 * transcript compaction can't do this: the OpenClaw session file is a mirror,
 * while the context that's actually full lives in the CLI session the bound
 * thread resumes.
 *
 * Completion is notification-driven (same pattern as codex): we subscribe
 * before issuing the request, then wait for `thread/compact/completed` for the
 * compaction turn. The bridge guarantees that notification (success, failure,
 * or crash), so the only local guards are the compaction timeout and bridge
 * exit.
 *
 * Old-bridge behavior: `thread/compact/start` shipped in bridge 0.7.0. On an
 * older bridge the request fails with JSON-RPC -32601 (method not found),
 * which we map to an actionable "upgrade the bridge" failure instead of
 * raising the extension's version floor — compaction is additive, and the
 * floor refusing an otherwise-working install would be worse than compaction
 * being unavailable.
 */

import {
  embeddedAgentLog,
  resolveCompactionTimeoutMs,
  type CompactEmbeddedAgentSessionParams,
  type EmbeddedAgentCompactResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  ClaudeAppServerRpcError,
  getSharedClaudeAppServerClient,
  type ClaudeAppServerClient,
} from "./client.js";
import { claudeAppServerPoolKey, resolveClaudeAppServerConfig } from "./config.js";
import { resolveManagedClaudeBridgeStartOptions } from "./managed-binary.js";
import { assertClaudeBridgeCredentials, resolveClaudeBridgeStartEnv } from "./run-attempt.js";
import { claudeBindingSessionIdentity, type ClaudeAppServerBindingStore } from "./thread-store.js";

const RPC_METHOD_NOT_FOUND = -32601;

export type ClaudeAppServerCompactOptions = {
  pluginConfig?: unknown;
  /** Plugin-scoped SQLite-backed store for per-session thread bindings. */
  bindingStore: ClaudeAppServerBindingStore;
  /** Test seam: supplies a started client instead of the shared pool. */
  clientFactory?: () => Promise<ClaudeAppServerClient> | ClaudeAppServerClient;
  /** Test seam / override for the completion wait (default: compaction timeout). */
  completionTimeoutMs?: number;
};

type CompactCompletedPayload = {
  threadId?: string;
  turnId?: string;
  compacted?: boolean;
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  error?: { message?: string } | null;
};

/** Runs bridge-native compaction for the thread bound to this session. */
export async function maybeCompactClaudeAppServerSession(
  params: CompactEmbeddedAgentSessionParams,
  options: ClaudeAppServerCompactOptions,
): Promise<EmbeddedAgentCompactResult> {
  const binding = await options.bindingStore.read(claudeBindingSessionIdentity(params));
  if (!binding?.threadId) {
    embeddedAgentLog.warn("claude app-server compaction found no thread binding", {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });
    return {
      ok: false,
      compacted: false,
      reason: "no claude-bridge thread is bound to this session",
      failure: { reason: "missing_thread_binding" },
    };
  }
  const threadId = binding.threadId;

  let client: ClaudeAppServerClient;
  try {
    client = options.clientFactory
      ? await options.clientFactory()
      : await acquireSharedCompactionClient(params, options.pluginConfig);
  } catch (error) {
    return {
      ok: false,
      compacted: false,
      reason: `claude-bridge unavailable for compaction: ${formatError(error)}`,
    };
  }

  const timeoutMs = options.completionTimeoutMs ?? resolveCompactionTimeoutMs(params.config);
  // Subscribe BEFORE the request so a fast completion can't slip past us.
  const completion = watchCompactionCompletion({ client, threadId, timeoutMs });
  let turnId: string | undefined;
  try {
    const response = (await client.request("thread/compact/start", { threadId })) as {
      turn?: { id?: string };
    } | null;
    turnId = typeof response?.turn?.id === "string" ? response.turn.id : undefined;
  } catch (error) {
    completion.cancel();
    if (error instanceof ClaudeAppServerRpcError && error.code === RPC_METHOD_NOT_FOUND) {
      return {
        ok: false,
        compacted: false,
        reason:
          "the running claude-bridge does not support thread/compact/start — " +
          "upgrade @zeroaltitude/openclaw-claude-bridge to >= 0.7.0 to enable native compaction",
        failure: { reason: "unsupported_bridge_compaction" },
      };
    }
    return {
      ok: false,
      compacted: false,
      reason: `thread/compact/start failed: ${formatError(error)}`,
    };
  }

  embeddedAgentLog.info("started claude app-server compaction", {
    sessionId: params.sessionId,
    threadId,
    turnId,
  });

  const outcome = await completion.result;
  if (outcome.kind !== "completed") {
    embeddedAgentLog.warn("claude app-server compaction did not complete", {
      sessionId: params.sessionId,
      threadId,
      turnId,
      reason: outcome.reason,
    });
    return { ok: false, compacted: false, reason: outcome.reason };
  }

  const payload = outcome.payload;
  if (!payload.compacted) {
    const reason = payload.error?.message ?? "claude-bridge reported an uncompacted turn";
    embeddedAgentLog.warn("claude app-server compaction failed", {
      sessionId: params.sessionId,
      threadId,
      turnId,
      reason,
    });
    return { ok: false, compacted: false, reason };
  }

  embeddedAgentLog.info("completed claude app-server compaction", {
    sessionId: params.sessionId,
    threadId,
    turnId,
    preTokens: payload.preTokens,
    postTokens: payload.postTokens,
  });
  return {
    ok: true,
    compacted: true,
    result: {
      // Native compaction happens inside the CLI session; OpenClaw's own
      // transcript keeps its entries, so there's no kept-entry marker or
      // host-visible summary. Token accounting comes from the SDK's
      // compact_boundary metadata when present.
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: payload.preTokens ?? params.currentTokenCount ?? 0,
      ...(payload.postTokens !== undefined ? { tokensAfter: payload.postTokens } : {}),
      details: {
        backend: "claude-bridge",
        signal: "thread/compact/start",
        threadId,
        ...(turnId ? { turnId } : {}),
        ...(payload.trigger ? { trigger: payload.trigger } : {}),
        ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
      },
    },
  };
}

/**
 * Same client-acquisition path as runClaudeAppServerAttempt: managed binary,
 * configured env (with the host-resolved API key threaded through), shared
 * per-provider pool slot. Compaction reuses whatever bridge process is already
 * serving turns for this provider — the live attempt registry inside it is
 * exactly what lets `/compact` run in the thread's real in-memory context.
 */
async function acquireSharedCompactionClient(
  params: CompactEmbeddedAgentSessionParams,
  pluginConfig: unknown,
): Promise<ClaudeAppServerClient> {
  const cfg = resolveClaudeAppServerConfig(pluginConfig);
  const startEnv = resolveClaudeBridgeStartEnv({
    configuredEnv: cfg.appServer.env,
    resolvedApiKey: params.resolvedApiKey,
    queryThreadTimeoutMs: cfg.appServer.queryThreadTimeoutMs,
  });
  assertClaudeBridgeCredentials({
    env: startEnv,
    resolvedApiKey: params.resolvedApiKey,
    modelProvider: cfg.appServer.modelProvider,
  });
  const startOptions = await resolveManagedClaudeBridgeStartOptions({
    command: cfg.appServer.command,
    commandSource: cfg.appServer.commandSource,
    args: cfg.appServer.args,
    env: startEnv,
  });
  const client = getSharedClaudeAppServerClient(
    claudeAppServerPoolKey(cfg.appServer.modelProvider),
    startOptions,
  );
  await client.start();
  return client;
}

type CompletionOutcome =
  | { kind: "completed"; payload: CompactCompletedPayload }
  | { kind: "timeout"; reason: string }
  | { kind: "exit"; reason: string };

function watchCompactionCompletion(input: {
  client: ClaudeAppServerClient;
  threadId: string;
  timeoutMs: number;
}): { result: Promise<CompletionOutcome>; cancel: () => void } {
  let settled = false;
  let removeNotificationHandler = () => {};
  let removeExitHandler = () => {};
  let resolveOutcome = (_outcome: CompletionOutcome) => {};
  const result = new Promise<CompletionOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const finish = (outcome: CompletionOutcome) => {
    if (settled) {
      return;
    }
    settled = true;
    removeNotificationHandler();
    removeExitHandler();
    clearTimeout(timeout);
    resolveOutcome(outcome);
  };
  removeNotificationHandler = input.client.onNotification((notification) => {
    if (notification.method !== "thread/compact/completed") {
      return;
    }
    const payload = (notification.params ?? {}) as CompactCompletedPayload;
    // One compaction per thread at a time — threadId is a sufficient match.
    if (payload.threadId !== input.threadId) {
      return;
    }
    finish({ kind: "completed", payload });
  });
  removeExitHandler = input.client.onExit((error) => {
    finish({ kind: "exit", reason: `claude-bridge exited during compaction: ${error.message}` });
  });
  // Safe to declare after `finish`: the exit/notification handlers above can
  // only fire asynchronously, never inside this synchronous setup block.
  const timeout = setTimeout(() => {
    finish({
      kind: "timeout",
      reason: `claude-bridge compaction did not complete within ${input.timeoutMs}ms`,
    });
  }, input.timeoutMs);
  timeout.unref?.();
  return { result, cancel: () => finish({ kind: "timeout", reason: "cancelled" }) };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
