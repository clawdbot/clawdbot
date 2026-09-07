import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as restartModule from "../infra/restart.js";
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

  // ClawSweeper #118053: the timeout deliberately leaves the deferral polling so a forced
  // emission that rejects is retried, but onTimeout also nulled `restartDeferral` — so the
  // live poll was owned by nobody and neither supersession nor shutdown could reach cancel().
  // A direct probe confirms cancel() is load-bearing: on a timed-out deferral whose emission
  // keeps throwing, cancel() takes it from ~8 retries/window to 0.
  it("keeps the timed-out deferral cancellable so a later request can supersede it", async () => {
    const cancel = vi.fn();
    const deferSpy = vi.spyOn(restartModule, "deferGatewayRestartUntilIdle");
    let capturedHooks: { onTimeout?: (pending: number, elapsedMs: number) => void } | undefined;
    deferSpy.mockImplementation(
      (opts: Parameters<typeof restartModule.deferGatewayRestartUntilIdle>[0]) => {
        capturedHooks = opts.hooks;
        return { cancel };
      },
    );
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const activeCounts = { ...zeroActiveCounts, totalActive: 1, activeTasks: 1 };
    const coordinator = createGatewayRestartCoordinator({
      params: { assertRestartReady: vi.fn(), logReload, requestRecoveryRestart: vi.fn() },
      myGeneration: nextGatewayReloadGeneration(),
      restartRecoveryAvailable: true,
      getActiveCounts: () => activeCounts,
      formatActiveDetails: () => [],
      formatDeferredWorkStatus: () => "1 active task",
      formatTaskBlockers: () => null,
    });

    try {
      coordinator.requestGatewayRestart(restartPlan, {} as OpenClawConfig, {
        prepareRuntimeConfig: async () => ({}) as OpenClawConfig,
      });
      expect(deferSpy).toHaveBeenCalledOnce();

      // The deadline passes. The deferral is NOT finished — it keeps polling to retry a
      // rejected forced emission — so the coordinator must retain its handle.
      capturedHooks?.onTimeout?.(1, 300_000);

      // A later config change supersedes the timed-out request. If onTimeout dropped the
      // handle, this cancel never reaches the still-live poll.
      coordinator.requestGatewayRestart(restartPlan, {} as OpenClawConfig, {
        prepareRuntimeConfig: async () => ({}) as OpenClawConfig,
      });

      expect(cancel).toHaveBeenCalled();
    } finally {
      deferSpy.mockRestore();
      coordinator.stopRestartRetries();
    }
  });
});
