// Discord tests cover auto presence plugin behavior.
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it, vi } from "vitest";
import { createDiscordAutoPresenceController } from "./auto-presence.js";

function createStore(params?: {
  cooldownUntil?: number;
  failureCounts?: Record<string, number>;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "sk-test",
      },
    },
    usageStats: {
      "openai:default": {
        ...(typeof params?.cooldownUntil === "number"
          ? { cooldownUntil: params.cooldownUntil }
          : {}),
        ...(params?.failureCounts ? { failureCounts: params.failureCounts } : {}),
      },
    },
  };
}

describe("discord auto presence", () => {
  it.each(["rate_limit", "overloaded"])("maps %s cooldown to dnd", (reason) => {
    const now = Date.now();
    const updatePresence = vi.fn();
    const controller = createDiscordAutoPresenceController({
      accountId: "default",
      discordConfig: {
        autoPresence: {
          enabled: true,
        },
      },
      gateway: { isConnected: true, updatePresence },
      loadAuthStore: () =>
        createStore({ cooldownUntil: now + 60_000, failureCounts: { [reason]: 2 } }),
      now: () => now,
    });
    controller.runNow();

    expect(updatePresence).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "dnd",
        activities: [expect.objectContaining({ state: "token exhausted" })],
      }),
    );
  });

  it("reports degraded availability when no auth profiles exist", () => {
    const updatePresence = vi.fn();
    const controller = createDiscordAutoPresenceController({
      accountId: "default",
      discordConfig: { autoPresence: { enabled: true } },
      gateway: { isConnected: true, updatePresence },
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });
    controller.runNow();
    expect(updatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [{ name: "Custom Status", type: 4, state: "runtime degraded" }],
      status: "idle",
      afk: false,
    });
  });

  it("clears expired cooldowns without sending presence while disconnected", () => {
    const now = Date.now();
    const store = createStore({ cooldownUntil: now - 1, failureCounts: { rate_limit: 1 } });
    const updatePresence = vi.fn();
    const controller = createDiscordAutoPresenceController({
      accountId: "default",
      discordConfig: { autoPresence: { enabled: true } },
      gateway: { isConnected: false, updatePresence },
      loadAuthStore: () => store,
      now: () => now,
    });
    controller.runNow();
    expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBeUndefined();
    expect(updatePresence).not.toHaveBeenCalled();
  });

  it("recovers from exhausted to online once a profile becomes usable", () => {
    let now = Date.now();
    let store = createStore({ cooldownUntil: now + 60_000, failureCounts: { rate_limit: 1 } });
    const updatePresence = vi.fn();
    const controller = createDiscordAutoPresenceController({
      accountId: "default",
      discordConfig: {
        activity: "working",
        activityType: 0,
        autoPresence: {
          enabled: true,
          intervalMs: 5_000,
          minUpdateIntervalMs: 1_000,
        },
      },
      gateway: {
        isConnected: true,
        updatePresence,
      },
      loadAuthStore: () => store,
      now: () => now,
    });

    controller.runNow();

    now += 2_000;
    store = createStore();
    controller.runNow();

    expect(updatePresence).toHaveBeenCalledTimes(2);
    expect(updatePresence.mock.calls).toEqual([
      [
        {
          since: null,
          activities: [{ name: "Custom Status", type: 4, state: "token exhausted" }],
          status: "dnd",
          afk: false,
        },
      ],
      [
        {
          since: null,
          activities: [{ name: "working", type: 0 }],
          status: "online",
          afk: false,
        },
      ],
    ]);
  });

  it("re-applies presence on refresh even when signature is unchanged", () => {
    let now = Date.now();
    const store = createStore();
    const updatePresence = vi.fn();

    const controller = createDiscordAutoPresenceController({
      accountId: "default",
      discordConfig: {
        autoPresence: {
          enabled: true,
          intervalMs: 60_000,
          minUpdateIntervalMs: 60_000,
        },
      },
      gateway: {
        isConnected: true,
        updatePresence,
      },
      loadAuthStore: () => store,
      now: () => now,
    });

    controller.runNow();
    now += 1_000;
    controller.runNow();
    controller.refresh();

    expect(updatePresence).toHaveBeenCalledTimes(2);
    expect(updatePresence.mock.calls).toEqual([
      [
        {
          since: null,
          activities: [],
          status: "online",
          afk: false,
        },
      ],
      [
        {
          since: null,
          activities: [],
          status: "online",
          afk: false,
        },
      ],
    ]);
  });

  it("does nothing when auto presence is disabled", () => {
    const updatePresence = vi.fn();
    const controller = createDiscordAutoPresenceController({
      accountId: "default",
      discordConfig: {
        autoPresence: {
          enabled: false,
        },
      },
      gateway: {
        isConnected: true,
        updatePresence,
      },
      loadAuthStore: () => createStore(),
    });

    controller.runNow();
    controller.start();
    controller.refresh();
    controller.stop();

    expect(controller.enabled).toBe(false);
    expect(updatePresence).not.toHaveBeenCalled();
  });
});
