import type { Server as HttpServer } from "node:http";
import type { WebSocketServer } from "ws";
import { disposeRegisteredAgentHarnesses } from "../agents/harness/registry.js";
import { disposeAllSessionMcpRuntimes } from "../agents/pi-bundle-mcp-tools.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { closePluginStateSqliteStore } from "../plugin-state/plugin-state-store.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "./chat-abort.js";
import {
  collectGatewayProcessMemoryUsageMb,
  measureGatewayRestartTrace,
  recordGatewayRestartTrace,
} from "./restart-trace.js";
import type { ChatRunState } from "./server-chat-state.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

const shutdownLog = createSubsystemLogger("gateway/shutdown");
const GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS = 5_000;
const GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS = 10_000;
const ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS = 2_000;
const WEBSOCKET_CLOSE_GRACE_MS = 1_000;
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;
const HTTP_CLOSE_GRACE_MS = 1_000;
const HTTP_CLOSE_FORCE_WAIT_MS = 5_000;
const MCP_RUNTIME_CLOSE_GRACE_MS = 5_000;
const LSP_RUNTIME_CLOSE_GRACE_MS = 5_000;
const RESTART_REPLY_DRAIN_POLL_MS = 100;
const RESTART_REPLY_POST_ABORT_DRAIN_TIMEOUT_MS = 1_000;
const RESTART_REPLY_POST_ABORT_DRAIN_POLL_MS = 50;

export type ShutdownResult = {
  durationMs: number;
  warnings: string[];
};

function createTimeoutRace<T>(timeoutMs: number, onTimeout: () => T) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  timer = setTimeout(() => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    resolve(onTimeout());
  }, timeoutMs);
  timer.unref?.();

  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return {
    promise,
    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

async function shutdownStep(
  name: string,
  fn: () => Promise<void> | void,
  warnings: string[],
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    shutdownLog.warn(`${name}: ${detail}`);
    recordShutdownWarning(warnings, name);
    return false;
  }
}

function recordShutdownWarning(warnings: string[], name: string): void {
  if (!warnings.includes(name)) {
    warnings.push(name);
  }
}

function getRestartReplyDrainCounts(params: {
  getPendingReplyCount: () => number;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
}) {
  const pendingReplyCount = params.getPendingReplyCount();
  const activeChatRuns = listRestartDrainChatRuns(params.chatAbortControllers).length;
  return {
    pendingReplies:
      Number.isFinite(pendingReplyCount) && pendingReplyCount > 0
        ? Math.floor(pendingReplyCount)
        : 0,
    activeChatRuns,
  };
}

function listRestartDrainChatRuns(
  chatAbortControllers: Map<string, ChatAbortControllerEntry>,
): Array<[string, ChatAbortControllerEntry]> {
  return Array.from(chatAbortControllers.entries()).filter(([, entry]) => entry.kind !== "agent");
}

function formatRestartReplyDrainDetails(counts: {
  pendingReplies: number;
  activeChatRuns: number;
}): string {
  const details: string[] = [];
  if (counts.pendingReplies > 0) {
    details.push(`${counts.pendingReplies} pending reply(ies)`);
  }
  if (counts.activeChatRuns > 0) {
    details.push(`${counts.activeChatRuns} active chat run(s)`);
  }
  return details.length > 0 ? details.join(", ") : "no pending reply work";
}

async function sleepForRestartReplyDrain(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

async function waitForRestartReplyDrain(params: {
  getPendingReplyCount: () => number;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  timeoutMs: number;
  pollMs?: number;
}): Promise<{
  drained: boolean;
  elapsedMs: number;
  counts: { pendingReplies: number; activeChatRuns: number };
}> {
  const timeoutMs = Math.max(0, Math.floor(params.timeoutMs));
  const pollMs = Math.max(25, Math.floor(params.pollMs ?? RESTART_REPLY_DRAIN_POLL_MS));
  let counts = getRestartReplyDrainCounts(params);
  if (counts.pendingReplies <= 0 && counts.activeChatRuns <= 0) {
    return { drained: true, elapsedMs: 0, counts };
  }
  if (timeoutMs <= 0) {
    return { drained: false, elapsedMs: 0, counts };
  }

  const startedAt = Date.now();
  for (;;) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      return { drained: false, elapsedMs, counts };
    }
    await sleepForRestartReplyDrain(Math.min(pollMs, timeoutMs - elapsedMs));
    counts = getRestartReplyDrainCounts(params);
    if (counts.pendingReplies <= 0 && counts.activeChatRuns <= 0) {
      return { drained: true, elapsedMs: Date.now() - startedAt, counts };
    }
  }
}

function abortActiveChatRunsForRestart(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunState: ChatRunState;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => { sessionKey: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
}): number {
  let aborted = 0;
  for (const [runId, entry] of listRestartDrainChatRuns(params.chatAbortControllers)) {
    const result = abortChatRunById(
      {
        chatAbortControllers: params.chatAbortControllers,
        chatRunBuffers: params.chatRunState.buffers,
        chatDeltaSentAt: params.chatRunState.deltaSentAt,
        chatDeltaLastBroadcastLen: params.chatRunState.deltaLastBroadcastLen,
        chatDeltaLastBroadcastText: params.chatRunState.deltaLastBroadcastText,
        agentDeltaSentAt: params.chatRunState.agentDeltaSentAt,
        bufferedAgentEvents: params.chatRunState.bufferedAgentEvents,
        chatAbortedRuns: params.chatRunState.abortedRuns,
        removeChatRun: params.removeChatRun,
        agentRunSeq: params.agentRunSeq,
        broadcast: params.broadcast,
        nodeSendToSession: params.nodeSendToSession,
      },
      {
        runId,
        sessionKey: entry.sessionKey,
        stopReason: "restart",
      },
    );
    if (result.aborted) {
      aborted += 1;
    }
  }
  return aborted;
}

async function drainRestartPendingRepliesForShutdown(params: {
  getPendingReplyCount: () => number;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunState: ChatRunState;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => { sessionKey: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  timeoutMs: number;
  warnings: string[];
}): Promise<void> {
  const initialCounts = getRestartReplyDrainCounts(params);
  if (initialCounts.pendingReplies <= 0 && initialCounts.activeChatRuns <= 0) {
    return;
  }

  const timeoutMs = Math.max(0, Math.floor(params.timeoutMs));
  if (timeoutMs > 0) {
    shutdownLog.info(
      `waiting for ${formatRestartReplyDrainDetails(initialCounts)} before restart shutdown (timeout ${timeoutMs}ms)`,
    );
  }

  const drainResult = await waitForRestartReplyDrain({
    getPendingReplyCount: params.getPendingReplyCount,
    chatAbortControllers: params.chatAbortControllers,
    timeoutMs,
  });
  if (drainResult.drained) {
    shutdownLog.info(`restart reply drain completed after ${drainResult.elapsedMs}ms`);
    return;
  }

  shutdownLog.warn(
    `restart reply drain timed out after ${drainResult.elapsedMs}ms with ${formatRestartReplyDrainDetails(drainResult.counts)} still active; continuing shutdown`,
  );
  recordShutdownWarning(params.warnings, "restart-reply-drain");

  if (drainResult.counts.activeChatRuns <= 0) {
    return;
  }

  const abortedRuns = abortActiveChatRunsForRestart(params);
  if (abortedRuns <= 0) {
    return;
  }

  shutdownLog.warn(`aborted ${abortedRuns} active chat run(s) during restart shutdown`);
  const postAbortDrain = await waitForRestartReplyDrain({
    getPendingReplyCount: params.getPendingReplyCount,
    chatAbortControllers: params.chatAbortControllers,
    timeoutMs: RESTART_REPLY_POST_ABORT_DRAIN_TIMEOUT_MS,
    pollMs: RESTART_REPLY_POST_ABORT_DRAIN_POLL_MS,
  });
  if (postAbortDrain.drained) {
    shutdownLog.info("restart reply drain completed after abort cleanup");
  }
}

async function triggerGatewayLifecycleHookWithTimeout(params: {
  event: ReturnType<typeof createInternalHookEvent>;
  hookName: "gateway:shutdown" | "gateway:pre-restart";
  timeoutMs: number;
}): Promise<"completed" | "timeout"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const hookPromise = triggerInternalHook(params.event);
  void hookPromise.catch(() => undefined);
  try {
    const result = await Promise.race([
      hookPromise.then(() => "completed" as const),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), params.timeoutMs);
        timeout.unref?.();
      }),
    ]);
    if (result === "timeout") {
      shutdownLog.warn(
        `${params.hookName} hook timed out after ${params.timeoutMs}ms; continuing shutdown`,
      );
    }
    return result;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function disposeRuntimeWithShutdownGrace(params: {
  label: "bundle-mcp" | "bundle-lsp";
  dispose: () => Promise<void>;
  graceMs: number;
  warnings: string[];
}): Promise<void> {
  const disposePromise = Promise.resolve()
    .then(params.dispose)
    .catch((err: unknown) => {
      shutdownLog.warn(`${params.label} runtime disposal failed during shutdown: ${String(err)}`);
      recordShutdownWarning(params.warnings, params.label);
    });
  const disposeTimeout = createTimeoutRace(params.graceMs, () => {
    shutdownLog.warn(
      `${params.label} runtime disposal exceeded ${params.graceMs}ms; continuing shutdown`,
    );
    recordShutdownWarning(params.warnings, params.label);
  });
  await Promise.race([disposePromise, disposeTimeout.promise]);
  disposeTimeout.clear();
}

async function disposeAllBundleLspRuntimesOnDemand(): Promise<void> {
  const { disposeAllBundleLspRuntimes } = await import("../agents/pi-bundle-lsp-runtime.js");
  await disposeAllBundleLspRuntimes();
}

async function stopGmailWatcherOnDemand(): Promise<void> {
  const { stopGmailWatcher } = await import("../hooks/gmail-watcher.js");
  await stopGmailWatcher();
}

export async function runGatewayClosePrelude(params: {
  stopDiagnostics?: () => void;
  clearSkillsRefreshTimer?: () => void;
  skillsChangeUnsub?: () => void;
  disposeAuthRateLimiter?: () => void;
  disposeBrowserAuthRateLimiter: () => void;
  stopModelPricingRefresh?: () => void;
  stopChannelHealthMonitor?: () => void;
  stopReadinessEventLoopHealth?: () => void;
  clearSecretsRuntimeSnapshot?: () => void;
  closeMcpServer?: () => Promise<void>;
}): Promise<void> {
  params.stopDiagnostics?.();
  params.clearSkillsRefreshTimer?.();
  params.skillsChangeUnsub?.();
  params.disposeAuthRateLimiter?.();
  params.disposeBrowserAuthRateLimiter();
  params.stopModelPricingRefresh?.();
  params.stopChannelHealthMonitor?.();
  params.stopReadinessEventLoopHealth?.();
  params.clearSecretsRuntimeSnapshot?.();
  await params.closeMcpServer?.().catch(() => {});
}

function isServerNotRunningError(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: unknown }).code === "ERR_SERVER_NOT_RUNNING",
  );
}

export function createGatewayCloseHandler(params: {
  bonjourStop: (() => Promise<void>) | null;
  tailscaleCleanup: (() => Promise<void>) | null;
  releasePluginRouteRegistry?: (() => void) | null;
  channelIds?: readonly ChannelId[];
  stopChannel: (name: ChannelId, accountId?: string) => Promise<void>;
  pluginServices: PluginServicesHandle | null;
  postReadySidecars?: readonly GatewayPostReadySidecarHandle[];
  disposeSessionMcpRuntimes?: () => Promise<void>;
  disposeBundleLspRuntimes?: () => Promise<void>;
  cron: { stop: () => void };
  heartbeatRunner: HeartbeatRunner;
  updateCheckStop?: (() => void) | null;
  stopTaskRegistryMaintenance?: (() => Promise<void> | void) | null;
  nodePresenceTimers: Map<string, ReturnType<typeof setInterval>>;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  mediaCleanup: ReturnType<typeof setInterval> | null;
  agentUnsub: (() => void) | null;
  heartbeatUnsub: (() => void) | null;
  transcriptUnsub: (() => void) | null;
  lifecycleUnsub: (() => void) | null;
  chatRunState: ChatRunState;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => { sessionKey: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  getPendingReplyCount?: () => number;
  clients: Set<{ socket: { close: (code: number, reason: string) => void } }>;
  configReloader: { stop: () => Promise<void> };
  wss: WebSocketServer;
  httpServer: HttpServer;
  httpServers?: HttpServer[];
  drainActiveSessionsForShutdown?: (params: {
    reason: "shutdown" | "restart";
    totalTimeoutMs?: number;
  }) => Promise<{ emittedSessionIds: string[]; timedOut: boolean }>;
}) {
  return async (opts?: {
    reason?: string;
    restartExpectedMs?: number | null;
    drainTimeoutMs?: number | null;
  }): Promise<ShutdownResult> => {
    const start = Date.now();
    const warnings: string[] = [];
    const reasonRaw = normalizeOptionalString(opts?.reason) ?? "";
    const reason = reasonRaw || "gateway stopping";
    const restartExpectedMs =
      typeof opts?.restartExpectedMs === "number" && Number.isFinite(opts.restartExpectedMs)
        ? Math.max(0, Math.floor(opts.restartExpectedMs))
        : null;
    const measureCloseStep = <T>(name: string, run: () => Promise<T> | T) =>
      measureGatewayRestartTrace(`restart.close.${name}`, run, [["reason", reason]]);
    try {
      shutdownLog.info(`shutdown started: ${reason}`);

      await measureCloseStep("gateway-shutdown-hook", () =>
        shutdownStep(
          "gateway:shutdown",
          async () => {
            const shutdownEvent = createInternalHookEvent(
              "gateway",
              "shutdown",
              "gateway:shutdown",
              {
                reason,
                restartExpectedMs,
              },
            );
            const result = await triggerGatewayLifecycleHookWithTimeout({
              event: shutdownEvent,
              hookName: "gateway:shutdown",
              timeoutMs: GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS,
            });
            if (result === "timeout") {
              recordShutdownWarning(warnings, "gateway:shutdown");
            }
          },
          warnings,
        ),
      );
      if (restartExpectedMs !== null) {
        await measureCloseStep("gateway-pre-restart-hook", () =>
          shutdownStep(
            "gateway:pre-restart",
            async () => {
              const preRestartEvent = createInternalHookEvent(
                "gateway",
                "pre-restart",
                "gateway:pre-restart",
                {
                  reason,
                  restartExpectedMs,
                },
              );
              const result = await triggerGatewayLifecycleHookWithTimeout({
                event: preRestartEvent,
                hookName: "gateway:pre-restart",
                timeoutMs: GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS,
              });
              if (result === "timeout") {
                recordShutdownWarning(warnings, "gateway:pre-restart");
              }
            },
            warnings,
          ),
        );
      }
      if (restartExpectedMs !== null && params.getPendingReplyCount) {
        const drainTimeoutMs =
          typeof opts?.drainTimeoutMs === "number" && Number.isFinite(opts.drainTimeoutMs)
            ? Math.max(0, Math.floor(opts.drainTimeoutMs))
            : 0;
        await measureCloseStep("reply-drain", () =>
          shutdownStep(
            "restart-reply-drain",
            () =>
              drainRestartPendingRepliesForShutdown({
                getPendingReplyCount: params.getPendingReplyCount!,
                chatAbortControllers: params.chatAbortControllers,
                chatRunState: params.chatRunState,
                removeChatRun: params.removeChatRun,
                agentRunSeq: params.agentRunSeq,
                broadcast: params.broadcast,
                nodeSendToSession: params.nodeSendToSession,
                timeoutMs: drainTimeoutMs,
                warnings,
              }),
            warnings,
          ),
        );
      }
      if (params.drainActiveSessionsForShutdown) {
        await measureCloseStep("session-end-drain", () =>
          shutdownStep(
            "session-end-drain",
            async () => {
              const drainReason: "shutdown" | "restart" =
                restartExpectedMs !== null ? "restart" : "shutdown";
              const result = await params.drainActiveSessionsForShutdown!({
                reason: drainReason,
                totalTimeoutMs: ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS,
              });
              if (result.timedOut) {
                shutdownLog.warn(
                  `session-end-drain timed out after ${ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS}ms after ${result.emittedSessionIds.length} sessions; continuing shutdown`,
                );
                recordShutdownWarning(warnings, "session-end-drain");
              }
            },
            warnings,
          ),
        );
      }
      if (params.bonjourStop) {
        await shutdownStep("bonjour", () => params.bonjourStop!(), warnings);
      }
      if (params.tailscaleCleanup) {
        await shutdownStep("tailscale", () => params.tailscaleCleanup!(), warnings);
      }
      await measureCloseStep("channels", async () => {
        const channelIds = params.channelIds ?? listChannelPlugins().map((plugin) => plugin.id);
        for (const channelId of channelIds) {
          await shutdownStep(`channel/${channelId}`, () => params.stopChannel(channelId), warnings);
        }
      });
      await shutdownStep("agent-harnesses", () => disposeRegisteredAgentHarnesses(), warnings);
      await measureCloseStep("bundle-runtimes", async () => {
        await Promise.all([
          disposeRuntimeWithShutdownGrace({
            label: "bundle-mcp",
            dispose: params.disposeSessionMcpRuntimes ?? disposeAllSessionMcpRuntimes,
            graceMs: MCP_RUNTIME_CLOSE_GRACE_MS,
            warnings,
          }),
          disposeRuntimeWithShutdownGrace({
            label: "bundle-lsp",
            dispose: params.disposeBundleLspRuntimes ?? disposeAllBundleLspRuntimesOnDemand,
            graceMs: LSP_RUNTIME_CLOSE_GRACE_MS,
            warnings,
          }),
        ]);
      });
      if (params.pluginServices) {
        await measureCloseStep("plugin-services", () =>
          shutdownStep("plugin-services", () => params.pluginServices!.stop(), warnings),
        );
      }
      await shutdownStep("plugin-state-store", () => closePluginStateSqliteStore(), warnings);
      await measureCloseStep("config-reloader", () =>
        shutdownStep("config-reloader", () => params.configReloader.stop(), warnings),
      );
      await measureCloseStep("gmail-watcher", () =>
        shutdownStep("gmail-watcher", () => stopGmailWatcherOnDemand(), warnings),
      );
      params.cron.stop();
      params.heartbeatRunner.stop();
      await shutdownStep(
        "task-registry-maintenance",
        () => params.stopTaskRegistryMaintenance?.(),
        warnings,
      );
      await shutdownStep("update-check", () => params.updateCheckStop?.(), warnings);
      for (const timer of params.nodePresenceTimers.values()) {
        clearInterval(timer);
      }
      params.nodePresenceTimers.clear();
      params.broadcast("shutdown", {
        reason,
        restartExpectedMs,
      });
      clearInterval(params.tickInterval);
      clearInterval(params.healthInterval);
      clearInterval(params.dedupeCleanup);
      if (params.mediaCleanup) {
        clearInterval(params.mediaCleanup);
      }
      if (params.agentUnsub) {
        await shutdownStep("agent-unsub", () => params.agentUnsub!(), warnings);
      }
      if (params.heartbeatUnsub) {
        await shutdownStep("heartbeat-unsub", () => params.heartbeatUnsub!(), warnings);
      }
      if (params.transcriptUnsub) {
        await shutdownStep("transcript-unsub", () => params.transcriptUnsub!(), warnings);
      }
      if (params.lifecycleUnsub) {
        await shutdownStep("lifecycle-unsub", () => params.lifecycleUnsub!(), warnings);
      }
      params.chatRunState.clear();
      let clientCloseFailures = 0;
      for (const c of params.clients) {
        try {
          c.socket.close(1012, "service restart");
        } catch {
          clientCloseFailures++;
        }
      }
      if (clientCloseFailures > 0) {
        shutdownLog.warn(`failed to close ${clientCloseFailures} WebSocket client(s)`);
        recordShutdownWarning(warnings, "ws-clients");
      }
      params.clients.clear();
      await measureCloseStep("websocket-server", async () => {
        const wsClients = params.wss.clients ?? new Set();
        const closePromise = new Promise<void>((resolve) => params.wss.close(() => resolve()));
        const websocketGraceTimeout = createTimeoutRace(
          WEBSOCKET_CLOSE_GRACE_MS,
          () => false as const,
        );
        const closedWithinGrace = await Promise.race([
          closePromise.then(() => true),
          websocketGraceTimeout.promise,
        ]);
        websocketGraceTimeout.clear();
        if (!closedWithinGrace) {
          shutdownLog.warn(
            `websocket server close exceeded ${WEBSOCKET_CLOSE_GRACE_MS}ms; forcing shutdown continuation with ${wsClients.size} tracked client(s)`,
          );
          recordShutdownWarning(warnings, "websocket-server");
          for (const client of wsClients) {
            try {
              client.terminate();
            } catch {
              /* ignore */
            }
          }
          const websocketForceTimeout = createTimeoutRace(WEBSOCKET_CLOSE_FORCE_CONTINUE_MS, () => {
            shutdownLog.warn(
              `websocket server close still pending after ${WEBSOCKET_CLOSE_FORCE_CONTINUE_MS}ms force window; continuing shutdown`,
            );
          });
          await Promise.race([closePromise, websocketForceTimeout.promise]);
          websocketForceTimeout.clear();
        }
      });
      await measureCloseStep("http-server", async () => {
        const servers =
          params.httpServers && params.httpServers.length > 0
            ? params.httpServers
            : [params.httpServer];
        for (let i = 0; i < servers.length; i++) {
          const httpServer = servers[i] as HttpServer & {
            closeAllConnections?: () => void;
            closeIdleConnections?: () => void;
          };
          const label = servers.length > 1 ? `http-server[${i}]` : "http-server";
          if (typeof httpServer.closeIdleConnections === "function") {
            httpServer.closeIdleConnections();
          }
          const closePromise = new Promise<void>((resolve, reject) =>
            httpServer.close((err) => {
              if (!err || isServerNotRunningError(err)) {
                resolve();
                return;
              }
              reject(err);
            }),
          );
          void closePromise.catch(() => undefined);
          const httpGraceTimeout = createTimeoutRace(HTTP_CLOSE_GRACE_MS, () => false as const);
          const closedWithinGrace = await Promise.race([
            closePromise.then(
              () => true,
              (err: unknown) => {
                throw err;
              },
            ),
            httpGraceTimeout.promise,
          ]).catch((err: unknown) => {
            const detail = err instanceof Error ? err.message : String(err);
            shutdownLog.warn(`${label}: ${detail}`);
            recordShutdownWarning(warnings, label);
            return true;
          });
          httpGraceTimeout.clear();
          if (!closedWithinGrace) {
            shutdownLog.warn(
              `${label} close exceeded ${HTTP_CLOSE_GRACE_MS}ms; forcing connection shutdown and waiting for close`,
            );
            recordShutdownWarning(warnings, label);
            httpServer.closeAllConnections?.();
            const httpForceTimeout = createTimeoutRace(
              HTTP_CLOSE_FORCE_WAIT_MS,
              () => false as const,
            );
            const closedAfterForce = await Promise.race([
              closePromise.then(
                () => true,
                (err: unknown) => {
                  throw err;
                },
              ),
              httpForceTimeout.promise,
            ]).catch((err: unknown) => {
              const detail = err instanceof Error ? err.message : String(err);
              shutdownLog.warn(`${label}: ${detail}`);
              recordShutdownWarning(warnings, label);
              return true;
            });
            httpForceTimeout.clear();
            if (!closedAfterForce) {
              throw new Error(
                `${label} close still pending after forced connection shutdown (${HTTP_CLOSE_FORCE_WAIT_MS}ms)`,
              );
            }
          }
        }
      });
    } finally {
      try {
        params.releasePluginRouteRegistry?.();
      } catch {
        /* ignore */
      }
    }

    const durationMs = Date.now() - start;
    if (warnings.length > 0) {
      shutdownLog.warn(
        `shutdown completed in ${durationMs}ms with warnings: ${warnings.join(", ")}`,
      );
    } else {
      shutdownLog.info(`shutdown completed cleanly in ${durationMs}ms`);
    }

    recordGatewayRestartTrace("restart.close.total", durationMs, [
      ["reason", reason],
      ["restartExpectedMs", restartExpectedMs ?? "none"],
      ...collectGatewayProcessMemoryUsageMb(),
    ]);
    return { durationMs, warnings };
  };
}
