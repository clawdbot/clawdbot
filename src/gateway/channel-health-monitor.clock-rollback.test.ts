import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import type { ChannelManager } from "./server-channels.js";

const STARTED_AT = 1_000_000;
const CHECK_INTERVAL_MS = 1_000;

function createChannelManager(running: boolean) {
  const account: ChannelAccountSnapshot = {
    accountId: "default",
    running,
    connected: running,
    enabled: true,
    configured: true,
  };
  const snapshot = {
    channels: { discord: account },
    channelAccounts: { discord: { default: account } },
  };
  const manager: ChannelManager = {
    getRuntimeSnapshot: vi.fn(() => snapshot),
    getPluginCommandCatalogAccounts: vi.fn(() => new Map()),
    startChannels: vi.fn(async () => {}),
    startChannel: vi.fn(async () => new Map()),
    stopChannel: vi.fn(async () => {}),
    setAutostartSuppression: vi.fn(),
    getAutostartSuppression: vi.fn(() => null),
    recoverAutostartSuppression: vi.fn(async () => false),
    setAmbientAutostartSuppressedChannelIds: vi.fn(),
    isAmbientAutostartSuppressed: vi.fn(() => false),
    markChannelLoggedOut: vi.fn(),
    isHealthMonitorEnabled: vi.fn(() => true),
    isManuallyStopped: vi.fn(() => false),
    isAutoRestartScheduled: vi.fn(() => false),
    resetRestartAttempts: vi.fn(),
  };
  return { account, manager };
}

describe("channel-health-monitor clock rollback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(STARTED_AT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not trap an existing monitor in startup grace after clock rollback", async () => {
    const { manager } = createChannelManager(false);
    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: CHECK_INTERVAL_MS,
      timing: { monitorStartupGraceMs: CHECK_INTERVAL_MS },
    });

    vi.setSystemTime(STARTED_AT - 60_000);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(manager.startChannel).toHaveBeenCalledWith("discord", "default");
    monitor.stop();
  });

  it.each([
    { name: "restart cooldown", maxRestartsPerHour: 10 },
    { name: "hourly restart budget", maxRestartsPerHour: 1 },
  ])("discards future $name from an existing monitor", async ({ maxRestartsPerHour }) => {
    const { account, manager } = createChannelManager(true);
    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: CHECK_INTERVAL_MS,
      cooldownCycles: 0,
      maxRestartsPerHour,
      timing: { monitorStartupGraceMs: 0 },
    });

    await vi.advanceTimersByTimeAsync(5 * CHECK_INTERVAL_MS);
    account.running = false;
    account.connected = false;
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);

    vi.setSystemTime(STARTED_AT + 3 * CHECK_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(manager.startChannel).toHaveBeenCalledTimes(2);
    monitor.stop();
  });
});
