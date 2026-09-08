import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayReloadPlan } from "./config-reload.js";
import { nextGatewayReloadGeneration } from "./server-reload-generation.js";
import { createGatewayRestartCoordinator } from "./server-reload-restart.js";

const zeroActiveCounts = {
  queueSize: 0,
  pendingReplies: 0,
  embeddedRuns: 0,
  backgroundExecSessions: 0,
  rootRequests: 0,
  activeTasks: 0,
  totalActive: 0,
};

const restartPlan = {
  changedPaths: ["gateway.port"],
  restartGateway: true,
  restartReasons: ["gateway.port"],
  hotReasons: [],
  reloadHooks: false,
  restartGmailWatcher: false,
  restartCron: false,
  restartHeartbeat: false,
  reloadPlugins: false,
  restartChannels: new Set(),
  disposeMcpRuntimes: false,
  noopPaths: [],
} satisfies GatewayReloadPlan;

afterEach(() => {
  vi.useRealTimers();
});

describe("gateway restart readiness preflight", () => {
  it("keeps the current lifecycle serving until successor state is restart-ready", async () => {
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const assertRestartReady = vi
      .fn<() => Promise<void> | void>()
      .mockRejectedValueOnce(new Error("state schema is noncanonical"))
      .mockResolvedValue(undefined);
    const prepareRuntimeConfig = vi.fn(async () => ({}) as OpenClawConfig);
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const params = { assertRestartReady, logReload, requestRecoveryRestart };
    const coordinator = createGatewayRestartCoordinator({
      params,
      myGeneration: nextGatewayReloadGeneration(),
      restartRecoveryAvailable: true,
      getActiveCounts: () => zeroActiveCounts,
      formatActiveDetails: () => [],
      formatDeferredWorkStatus: () => "no active work",
      formatTaskBlockers: () => null,
    });
    vi.useFakeTimers();

    try {
      expect(
        coordinator.requestGatewayRestart(restartPlan, {} as OpenClawConfig, {
          prepareRuntimeConfig,
        }).status,
      ).toBe("accepted");
      await vi.advanceTimersByTimeAsync(0);

      expect(assertRestartReady).toHaveBeenCalledOnce();
      expect(prepareRuntimeConfig).not.toHaveBeenCalled();
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
      expect(logReload.warn).toHaveBeenCalledWith(
        "gateway restart preflight failed: Error: state schema is noncanonical",
      );

      await vi.advanceTimersByTimeAsync(1_000);

      expect(assertRestartReady).toHaveBeenCalledTimes(2);
      expect(prepareRuntimeConfig).toHaveBeenCalledOnce();
      expect(requestRecoveryRestart).toHaveBeenCalledOnce();
    } finally {
      coordinator.stopRestartRetries();
    }
  });
});
