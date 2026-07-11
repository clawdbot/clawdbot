// Codex plugin module implements periodic Computer Use health probes.
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import {
  killStaleComputerUseMcpChildren,
  runCodexComputerUseLiveTest,
  type CodexComputerUseRepairStatus,
} from "./computer-use.js";
import type { ResolvedCodexComputerUseConfig } from "./config.js";

type ComputerUseHealthMonitor = {
  fingerprint: string;
  intervalMs: number;
  repairComputerUseMcpChildren?: () => Promise<CodexComputerUseRepairStatus>;
  timer: ReturnType<typeof setInterval>;
  disposeCloseHandler: () => void;
  running: boolean;
};

type ComputerUseHealthMonitorState = {
  monitors: WeakMap<CodexAppServerClient, ComputerUseHealthMonitor>;
};

const COMPUTER_USE_HEALTH_MONITOR_STATE = Symbol.for("openclaw.codexComputerUseHealthMonitorState");

function getComputerUseHealthMonitorState(): ComputerUseHealthMonitorState {
  const globalState = globalThis as typeof globalThis & {
    [COMPUTER_USE_HEALTH_MONITOR_STATE]?: ComputerUseHealthMonitorState;
  };
  globalState[COMPUTER_USE_HEALTH_MONITOR_STATE] ??= {
    monitors: new WeakMap(),
  };
  return globalState[COMPUTER_USE_HEALTH_MONITOR_STATE];
}

export function startCodexComputerUseHealthMonitor(params: {
  client: CodexAppServerClient;
  config: ResolvedCodexComputerUseConfig;
  repairComputerUseMcpChildren?: () => Promise<CodexComputerUseRepairStatus>;
}): { started: boolean; intervalMs?: number; reason?: string } {
  const state = getComputerUseHealthMonitorState();
  const existing = state.monitors.get(params.client);
  if (!params.config.enabled || !params.config.healthCheckEnabled) {
    if (existing) {
      clearComputerUseHealthMonitor(params.client, existing);
    }
    return {
      started: false,
      reason: params.config.enabled ? "health_disabled" : "disabled",
    };
  }
  const fingerprint = buildComputerUseHealthMonitorFingerprint(params.config);
  const intervalMs = params.config.healthCheckIntervalMinutes * 60_000;
  if (
    existing?.fingerprint === fingerprint &&
    existing.repairComputerUseMcpChildren === params.repairComputerUseMcpChildren
  ) {
    return { started: false, intervalMs, reason: "already_started" };
  }
  if (existing) {
    clearComputerUseHealthMonitor(params.client, existing);
  }
  const repairComputerUseMcpChildren =
    params.repairComputerUseMcpChildren ??
    (() => killStaleComputerUseMcpChildren({ ancestorPid: params.client.getTransportPid() }));
  const monitor: ComputerUseHealthMonitor = {
    fingerprint,
    intervalMs,
    repairComputerUseMcpChildren: params.repairComputerUseMcpChildren,
    timer: setInterval(() => {
      void runCodexComputerUseHealthProbe(params.client, params.config, monitor, {
        repairComputerUseMcpChildren,
      });
    }, intervalMs),
    disposeCloseHandler: () => undefined,
    running: false,
  };
  monitor.timer.unref?.();
  monitor.disposeCloseHandler = params.client.addCloseHandler((client) => {
    const active = state.monitors.get(client);
    if (active) {
      clearComputerUseHealthMonitor(client, active);
    }
  });
  state.monitors.set(params.client, monitor);
  return { started: true, intervalMs };
}

function buildComputerUseHealthMonitorFingerprint(config: ResolvedCodexComputerUseConfig): string {
  return JSON.stringify({
    autoRepair: config.autoRepair,
    healthCheckIntervalMinutes: config.healthCheckIntervalMinutes,
    liveTestTimeoutMs: config.liveTestTimeoutMs,
    mcpServerName: config.mcpServerName,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
  });
}

async function runCodexComputerUseHealthProbe(
  client: CodexAppServerClient,
  config: ResolvedCodexComputerUseConfig,
  monitor: ComputerUseHealthMonitor,
  options: {
    repairComputerUseMcpChildren?: () => Promise<CodexComputerUseRepairStatus>;
  },
): Promise<void> {
  if (monitor.running) {
    return;
  }
  monitor.running = true;
  try {
    const { liveTest, repair } = await runCodexComputerUseLiveTest({
      config,
      repairComputerUseMcpChildren: options.repairComputerUseMcpChildren,
      request: async <T>(
        method: string,
        requestParams?: unknown,
        requestOptions?: { timeoutMs?: number },
      ) =>
        await client.request<T>(method, requestParams, {
          timeoutMs: requestOptions?.timeoutMs ?? config.liveTestTimeoutMs,
        }),
    });
    if (!liveTest.ok) {
      embeddedAgentLog.warn("codex computer-use periodic health failed", {
        mcpServerName: config.mcpServerName,
        attempts: liveTest.attempts,
        timeoutMs: liveTest.timeoutMs,
        error: liveTest.error,
        repair,
      });
      return;
    }
    if (repair?.killedPids.length) {
      embeddedAgentLog.info("codex computer-use periodic health repaired stale children", {
        mcpServerName: config.mcpServerName,
        killedPids: repair.killedPids,
      });
    }
  } catch (error) {
    embeddedAgentLog.warn("codex computer-use periodic health probe crashed", {
      mcpServerName: config.mcpServerName,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    monitor.running = false;
  }
}

function clearComputerUseHealthMonitor(
  client: CodexAppServerClient,
  monitor: ComputerUseHealthMonitor,
): void {
  clearInterval(monitor.timer);
  monitor.disposeCloseHandler();
  getComputerUseHealthMonitorState().monitors.delete(client);
}

export const testing = {
  clearComputerUseHealthMonitor,
  getComputerUseHealthMonitorState,
};
