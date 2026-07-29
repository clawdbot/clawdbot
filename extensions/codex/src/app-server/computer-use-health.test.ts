// Codex tests cover periodic Computer Use health monitoring.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { startCodexComputerUseHealthMonitor } from "./computer-use-health.js";
import type { ResolvedCodexComputerUseConfig } from "./config.js";

describe("Codex Computer Use periodic health", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the live list_apps probe on the configured cadence and clears on client close", async () => {
    vi.useFakeTimers();
    const client = createClient();

    const result = startCodexComputerUseHealthMonitor({
      client: client.client,
      config: computerUseConfig({ healthCheckEnabled: true, healthCheckIntervalMinutes: 30 }),
    });

    expect(result).toEqual({ started: true, intervalMs: 30 * 60_000 });
    expect(client.request).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(client.request).toHaveBeenCalledWith(
      "mcpServer/tool/call",
      {
        threadId: "health-probe-thread-1",
        server: "computer-use",
        tool: "list_apps",
        arguments: {},
      },
      { timeoutMs: 60_000 },
    );

    client.close();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(
      client.request.mock.calls.filter(([method]) => method === "mcpServer/tool/call"),
    ).toHaveLength(1);
  });

  it("repairs stale CUA children and retries once after a failed probe", async () => {
    vi.useFakeTimers();
    const client = createClient({ liveTestFailures: 1 });
    const repairComputerUseMcpChildren = vi.fn(async () => ({
      attempted: true,
      killedPids: [1234],
      warnings: [],
      message: "Terminated 1 stale Computer Use MCP child process.",
    }));

    startCodexComputerUseHealthMonitor({
      client: client.client,
      config: computerUseConfig({
        autoRepair: true,
        healthCheckEnabled: true,
        healthCheckIntervalMinutes: 30,
      }),
      repairComputerUseMcpChildren,
    });

    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(
      client.request.mock.calls.filter(([method]) => method === "mcpServer/tool/call"),
    ).toHaveLength(2);
    expect(repairComputerUseMcpChildren).toHaveBeenCalledTimes(1);
  });

  it("stops an existing monitor when health checks are disabled", async () => {
    vi.useFakeTimers();
    const client = createClient();

    startCodexComputerUseHealthMonitor({
      client: client.client,
      config: computerUseConfig({ healthCheckEnabled: true, healthCheckIntervalMinutes: 30 }),
    });
    expect(
      startCodexComputerUseHealthMonitor({
        client: client.client,
        config: computerUseConfig({ healthCheckEnabled: false }),
      }),
    ).toEqual({ started: false, reason: "health_disabled" });

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("stops an existing monitor when Computer Use is disabled", async () => {
    vi.useFakeTimers();
    const client = createClient();

    startCodexComputerUseHealthMonitor({
      client: client.client,
      config: computerUseConfig({ healthCheckEnabled: true, healthCheckIntervalMinutes: 30 }),
    });
    expect(
      startCodexComputerUseHealthMonitor({
        client: client.client,
        config: computerUseConfig({ enabled: false, healthCheckEnabled: true }),
      }),
    ).toEqual({ started: false, reason: "disabled" });

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("replaces a same-interval monitor when probe configuration changes", async () => {
    vi.useFakeTimers();
    const client = createClient();

    startCodexComputerUseHealthMonitor({
      client: client.client,
      config: computerUseConfig({ healthCheckEnabled: true, healthCheckIntervalMinutes: 30 }),
    });
    expect(
      startCodexComputerUseHealthMonitor({
        client: client.client,
        config: computerUseConfig({
          healthCheckEnabled: true,
          healthCheckIntervalMinutes: 30,
          mcpServerName: "replacement-computer-use",
          toolCallTimeoutMs: 45_000,
        }),
      }),
    ).toEqual({ started: true, intervalMs: 30 * 60_000 });

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(client.request).toHaveBeenCalledWith(
      "mcpServer/tool/call",
      {
        threadId: "health-probe-thread-1",
        server: "replacement-computer-use",
        tool: "list_apps",
        arguments: {},
      },
      { timeoutMs: 45_000 },
    );
    expect(
      client.request.mock.calls.filter(([method]) => method === "mcpServer/tool/call"),
    ).toHaveLength(1);
  });

  it("does not start when Computer Use is disabled", () => {
    const client = createClient();

    expect(
      startCodexComputerUseHealthMonitor({
        client: client.client,
        config: computerUseConfig({ enabled: false }),
      }),
    ).toEqual({ started: false, reason: "disabled" });
    expect(client.addCloseHandler).not.toHaveBeenCalled();
  });

  it("does not start periodic health checks unless explicitly enabled", () => {
    const client = createClient();

    expect(
      startCodexComputerUseHealthMonitor({
        client: client.client,
        config: computerUseConfig(),
      }),
    ).toEqual({ started: false, reason: "health_disabled" });
    expect(client.addCloseHandler).not.toHaveBeenCalled();
  });
});

function createClient(options: { liveTestFailures?: number } = {}) {
  const closeHandlers = new Set<(client: CodexAppServerClient) => void>();
  let threadStarts = 0;
  let liveTestFailures = options.liveTestFailures ?? 0;
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "thread/start") {
      threadStarts += 1;
      return {
        thread: { id: `health-probe-thread-${threadStarts}` },
        model: "gpt-5.1",
        modelProvider: "openai",
      };
    }
    if (method === "mcpServer/tool/call") {
      if (liveTestFailures > 0) {
        liveTestFailures -= 1;
        throw new Error("hung");
      }
      return { content: [{ type: "text", text: "[]" }] };
    }
    if (method === "thread/unsubscribe" || method === "thread/archive") {
      expect(params).toEqual({ threadId: `health-probe-thread-${threadStarts}` });
      return undefined;
    }
    throw new Error(`unexpected request ${method}`);
  });
  const addCloseHandler = vi.fn((handler: (client: CodexAppServerClient) => void) => {
    closeHandlers.add(handler);
    return () => closeHandlers.delete(handler);
  });
  const client = {
    request,
    addCloseHandler,
  } as unknown as CodexAppServerClient;
  return {
    client,
    request,
    addCloseHandler,
    close: () => {
      for (const handler of closeHandlers) {
        handler(client);
      }
    },
  };
}

function computerUseConfig(
  overrides: Partial<ResolvedCodexComputerUseConfig> = {},
): ResolvedCodexComputerUseConfig {
  return {
    enabled: true,
    autoInstall: true,
    marketplaceDiscoveryTimeoutMs: 60_000,
    liveTestTimeoutMs: 60_000,
    toolCallTimeoutMs: 60_000,
    healthCheckEnabled: false,
    healthCheckIntervalMinutes: 60,
    pluginCacheMode: "shared",
    strictReadiness: false,
    autoRepair: false,
    pluginName: "computer-use",
    mcpServerName: "computer-use",
    ...overrides,
  };
}
