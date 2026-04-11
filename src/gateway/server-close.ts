import type { Server as HttpServer } from "node:http";
import type { WebSocketServer } from "ws";
import { disposeRegisteredAgentHarnesses } from "../agents/harness/registry.js";
import type { CanvasHostHandler, CanvasHostServer } from "../canvas-host/server.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { stopGmailWatcher } from "../hooks/gmail-watcher.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

const shutdownLog = createSubsystemLogger("gateway/shutdown");
const WEBSOCKET_CLOSE_GRACE_MS = 1_000;
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;

export async function runGatewayClosePrelude(params: {
  stopDiagnostics?: () => void;
  clearSkillsRefreshTimer?: () => void;
  skillsChangeUnsub?: () => void;
  disposeAuthRateLimiter?: () => void;
  disposeBrowserAuthRateLimiter: () => void;
  stopModelPricingRefresh?: () => void;
  stopChannelHealthMonitor?: () => void;
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
  params.clearSecretsRuntimeSnapshot?.();
  await params.closeMcpServer?.().catch(() => {});
}

export function createGatewayCloseHandler(params: {
  bonjourStop: (() => Promise<void>) | null;
  tailscaleCleanup: (() => Promise<void>) | null;
  canvasHost: CanvasHostHandler | null;
  canvasHostServer: CanvasHostServer | null;
  releasePluginRouteRegistry?: (() => void) | null;
  stopChannel: (name: ChannelId, accountId?: string) => Promise<void>;
  pluginServices: PluginServicesHandle | null;
  cron: { stop: () => void };
  heartbeatRunner: HeartbeatRunner;
  updateCheckStop?: (() => void) | null;
  stopTaskRegistryMaintenance?: (() => void) | null;
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
}) {
  return async (opts?: { reason?: string; restartExpectedMs?: number | null }) => {
    try {
      const reasonRaw = normalizeOptionalString(opts?.reason) ?? "";
      const reason = reasonRaw || "gateway stopping";
      const restartExpectedMs =
        typeof opts?.restartExpectedMs === "number" && Number.isFinite(opts.restartExpectedMs)
          ? Math.max(0, Math.floor(opts.restartExpectedMs))
          : null;
      if (params.bonjourStop) {
        try {
          await params.bonjourStop();
        } catch {
          /* ignore */
        }
      }
      if (params.tailscaleCleanup) {
        await params.tailscaleCleanup();
      }
      if (params.canvasHost) {
        try {
          await params.canvasHost.close();
        } catch {
          /* ignore */
        }
      }
      if (params.canvasHostServer) {
        try {
          await params.canvasHostServer.close();
        } catch {
          /* ignore */
        }
      }
      for (const plugin of listChannelPlugins()) {
        await params.stopChannel(plugin.id);
      }
      await disposeRegisteredAgentHarnesses();
      if (params.pluginServices) {
        await params.pluginServices.stop().catch(() => {});
      }
      await stopGmailWatcher();
      params.cron.stop();
      params.heartbeatRunner.stop();
      try {
        params.stopTaskRegistryMaintenance?.();
      } catch {
        /* ignore */
      }
      try {
        params.updateCheckStop?.();
      } catch {
        /* ignore */
      }
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
        try {
          params.agentUnsub();
        } catch {
          /* ignore */
        }
      }
      if (params.heartbeatUnsub) {
        try {
          params.heartbeatUnsub();
        } catch {
          /* ignore */
        }
      }
      if (params.transcriptUnsub) {
        try {
          params.transcriptUnsub();
        } catch {
          /* ignore */
        }
      }
      if (params.lifecycleUnsub) {
        try {
          params.lifecycleUnsub();
        } catch {
          /* ignore */
        }
      }
      params.chatRunState.clear();
      for (const c of params.clients) {
        try {
          c.socket.close(1012, "service restart");
        } catch {
          /* ignore */
        }
      }
      params.clients.clear();
      await params.configReloader.stop().catch(() => {});
      const wsClients = params.wss.clients ?? new Set();
      const closePromise = new Promise<void>((resolve) => params.wss.close(() => resolve()));
      const closedWithinGrace = await Promise.race([
        closePromise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), WEBSOCKET_CLOSE_GRACE_MS)),
      ]);
      if (!closedWithinGrace) {
        shutdownLog.warn(
          `websocket server close exceeded ${WEBSOCKET_CLOSE_GRACE_MS}ms; forcing shutdown continuation with ${wsClients.size} tracked client(s)`,
        );
        for (const client of wsClients) {
          try {
            client.terminate();
          } catch {
            /* ignore */
          }
        }
        await Promise.race([
          closePromise,
          new Promise<void>((resolve) =>
            setTimeout(() => {
              shutdownLog.warn(
                `websocket server close still pending after ${WEBSOCKET_CLOSE_FORCE_CONTINUE_MS}ms force window; continuing shutdown`,
              );
              resolve();
            }, WEBSOCKET_CLOSE_FORCE_CONTINUE_MS),
          ),
        ]);
      }
      const servers =
        params.httpServers && params.httpServers.length > 0
          ? params.httpServers
          : [params.httpServer];
      for (const server of servers) {
        const httpServer = server as HttpServer & {
          closeIdleConnections?: () => void;
        };
        if (typeof httpServer.closeIdleConnections === "function") {
          httpServer.closeIdleConnections();
        }
        await new Promise<void>((resolve, reject) =>
          httpServer.close((err) => (err ? reject(err) : resolve())),
        );
      }
    } finally {
      try {
        params.releasePluginRouteRegistry?.();
      } catch {
        /* ignore */
      }
    }
  };
}
