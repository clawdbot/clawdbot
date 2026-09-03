import { TICK_INTERVAL_MS } from "./server-constants.js";

// A real host freeze loses at least 45s beyond the expected maintenance cadence;
// shorter gaps are ordinary event-loop load and must not churn channel sockets.
const HOST_THAW_MIN_FROZEN_MS = 45_000;

export type HostThawChannelRestartOutcome =
  | { status: "completed" }
  | {
      status: "retry";
      reason: "active-work" | "admission-closed" | "channel-restart-incomplete";
    };

type HostThawDeps = {
  nowMs: () => number;
  restartChannelsIfIdle: (
    mode: "new-thaw" | "deferred-retry",
  ) => Promise<HostThawChannelRestartOutcome>;
  refreshHealth: () => Promise<void>;
  refreshPresence: () => void;
  resetEventLoopHealth: () => void;
  isAdmissionClosed: () => boolean;
  logger: { info: (message: string) => void; error: (message: string) => void };
};

export function createHostThawRecovery(deps: HostThawDeps): { tick: () => Promise<void> } {
  let lastTickAtMs = deps.nowMs();
  let pendingFrozenMs: number | undefined;
  let pendingChannelRestart = false;
  let activeRecovery: Promise<void> | undefined;

  const runStep = async (label: string, step: () => void | Promise<void>) => {
    try {
      await step();
    } catch (error) {
      deps.logger.error(`host thaw ${label} failed: ${String(error)}`);
    }
  };

  const restartChannels = async (mode: "new-thaw" | "deferred-retry") => {
    try {
      const outcome = await deps.restartChannelsIfIdle(mode);
      pendingChannelRestart = outcome.status === "retry";
      if (outcome.status === "retry") {
        const detail =
          outcome.reason === "active-work"
            ? "gateway still has active work"
            : outcome.reason === "admission-closed"
              ? "gateway admission is closed"
              : "one or more channel accounts remain pending";
        deps.logger.info(`host thaw channel restart deferred: ${detail}`);
      }
    } catch (error) {
      pendingChannelRestart = true;
      deps.logger.error(`host thaw channel restart failed: ${String(error)}`);
    }
  };

  const recover = async (frozenMs: number) => {
    deps.logger.info(
      `host timing gap detected: process was frozen ~${Math.round(frozenMs)}ms; restarting channels when idle and refreshing health`,
    );
    const deferForAdmission = () => {
      if (deps.isAdmissionClosed()) {
        pendingFrozenMs = Math.max(pendingFrozenMs ?? 0, frozenMs);
        deps.logger.info("host thaw recovery deferred: gateway suspension began mid-recovery");
        return true;
      }
      return false;
    };
    if (deferForAdmission()) {
      return;
    }
    await runStep("event-loop reset", deps.resetEventLoopHealth);
    if (deferForAdmission()) {
      return;
    }
    await restartChannels("new-thaw");
    for (const [label, step] of [
      ["health refresh", deps.refreshHealth],
      ["presence refresh", deps.refreshPresence],
    ] as const) {
      if (deferForAdmission()) {
        return;
      }
      await runStep(label, step);
    }
  };

  return {
    tick: async () => {
      const nowMs = deps.nowMs();
      const gapMs = nowMs - lastTickAtMs;
      lastTickAtMs = nowMs;
      if (gapMs >= TICK_INTERVAL_MS + HOST_THAW_MIN_FROZEN_MS) {
        pendingFrozenMs = Math.max(pendingFrozenMs ?? 0, gapMs - TICK_INTERVAL_MS);
      }
      // Suspension/restart owns the closed period. Recovery must wait rather than
      // waking channels while the controller deliberately keeps the gateway quiet.
      if (
        (pendingFrozenMs === undefined && !pendingChannelRestart) ||
        deps.isAdmissionClosed() ||
        activeRecovery
      ) {
        return;
      }
      const frozenMs = pendingFrozenMs;
      pendingFrozenMs = undefined;
      activeRecovery =
        frozenMs === undefined ? restartChannels("deferred-retry") : recover(frozenMs);
      try {
        await activeRecovery;
      } finally {
        activeRecovery = undefined;
      }
    },
  };
}
