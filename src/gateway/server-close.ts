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

const shutdownLog = createSubsystemLogger("gateway/shutdown");
const GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS = 1_000;
const GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS = 1_000;
const ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS = 2_000;
const WEBSOCKET_CLOSE_GRACE_MS = 1_000;
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;
const HTTP_CLOSE_GRACE_MS = 1_000;
const HTTP_CLOSE_FORCE_WAIT_MS = 5_000;
const MCP_RUNTIME_CLOSE_GRACE_MS = 5_000;
const LSP_RUNTIME_CLOSE_GRACE_MS = 5_000;

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
  chatRunState: { clear: () => void };
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
  }): Promise<ShutdownResult> => {
    const start = Date.now();
    const warnings: string[] = [];
    try {
      const reasonRaw = normalizeOptionalString(opts?.reason) ?? "";
      const reason = reasonRaw || "gateway stopping";
      const restartExpectedMs =
        typeof opts?.restartExpectedMs === "number" && Number.isFinite(opts.restartExpectedMs)
          ? Math.max(0, Math.floor(opts.restartExpectedMs))
          : null;
      shutdownLog.info(`shutdown started: ${reason}`);

      await shutdownStep(
        "gateway:shutdown",
        async () => {
          const shutdownEvent = createInternalHookEvent("gateway", "shutdown", "gateway:shutdown", {
            reason,
            restartExpectedMs,
          });
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
      );
      if (restartExpectedMs !== null) {
        await shutdownStep(
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
        );
      }
      if (params.drainActiveSessionsForShutdown) {
        await shutdownStep(
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
        );
      }
      if (params.bonjourStop) {
        await shutdownStep("bonjour", () => params.bonjourStop!(), warnings);
      }
      if (params.tailscaleCleanup) {
        await shutdownStep("tailscale", () => params.tailscaleCleanup!(), warnings);
      }
      const channelIds = params.channelIds ?? listChannelPlugins().map((plugin) => plugin.id);
      for (const channelId of channelIds) {
        await shutdownStep(`channel/${channelId}`, () => params.stopChannel(channelId), warnings);
      }
      await shutdownStep("agent-harnesses", () => disposeRegisteredAgentHarnesses(), warnings);
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
      if (params.pluginServices) {
        await shutdownStep("plugin-services", () => params.pluginServices!.stop(), warnings);
      }
      await shutdownStep("plugin-state-store", () => closePluginStateSqliteStore(), warnings);
      await shutdownStep("gmail-watcher", () => stopGmailWatcherOnDemand(), warnings);
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
      await shutdownStep("config-reloader", () => params.configReloader.stop(), warnings);
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

    return { durationMs, warnings };
  };
}
