import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import {
  createPluginRegistryOwner,
  requireActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { ChannelKind } from "./config-reload-plan.js";
import { createChannelManager, type ChannelManager } from "./server-channels.js";
import { restartGatewayChannels } from "./server-reload-channel-restart.js";

async function reloadChannels(
  owner: ChannelManager,
  getPluginRegistry: typeof requireActivePluginChannelRegistry,
  channels: Set<ChannelKind>,
  logChannels: Parameters<typeof restartGatewayChannels>[0]["params"]["logChannels"],
  scheduleRecoveryRestart: Parameters<typeof restartGatewayChannels>[0]["scheduleRecoveryRestart"],
) {
  await restartGatewayChannels({
    params: {
      startChannel: owner.startChannel,
      stopChannel: owner.stopChannel,
      getPluginRegistry,
      releaseChannelRouteHandoffs: owner.releaseChannelRouteHandoffs,
      logChannels,
    },
    nextConfig: {},
    channelsToRestart: channels,
    restartChannelAccounts: new Map(),
    activePluginChannelsAfterReload: null,
    shouldSkipChannelRestart: false,
    skipChannelRestartLogMessage: "",
    isLifecycleReloadAborted: () => false,
    getChannelAutostartSuppression: () => null,
    channelReloadTargets: () => channels,
    logSuppressedChannelRestart: vi.fn(),
    scheduleRecoveryRestart,
  });
}

let manager: ChannelManager | undefined;
afterEach(async () => {
  await manager?.stopChannel("discord");
  manager = undefined;
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
});

it("retries failed teardown before admitting a replacement", async () => {
  const startAccount = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
    await new Promise<void>((resolve) => {
      abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  const stopAccount = vi
    .fn()
    .mockResolvedValue(undefined)
    .mockRejectedValueOnce(new Error("teardown failed"));
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: "discord",
      config: {
        listAccountIds: () => ["running"],
        resolveAccount: (_cfg, accountId) => ({ accountId }),
      },
    }),
    gateway: {
      startAccount,
      stopAccount,
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", plugin, source: "test" }]));
  manager = createChannelManager({
    getRuntimeConfig: () => ({}),
    getPluginRegistry: requireActivePluginChannelRegistry,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
  await manager.startChannel("discord");
  await expect(manager.stopChannel("discord", undefined, { manual: false })).rejects.toThrow(
    "teardown failed",
  );

  const channels = new Set<ChannelKind>(["discord"]);
  const logChannels = { info: vi.fn(), error: vi.fn() };
  const scheduleRecoveryRestart = vi.fn();
  await reloadChannels(
    manager,
    requireActivePluginChannelRegistry,
    channels,
    logChannels,
    scheduleRecoveryRestart,
  );
  expect(stopAccount).toHaveBeenCalledTimes(2);
  expect(startAccount).toHaveBeenCalledTimes(2);
  expect(scheduleRecoveryRestart).not.toHaveBeenCalled();
  expect(logChannels.error).not.toHaveBeenCalled();
});

it.each(
  (["channel", "accounts"] as const).flatMap((scope) =>
    (["idle", "stopped", "racing"] as const).map((state) => ({ scope, state })),
  ),
)(
  "$scope config reload preserves $state manual stops while explicit starts resume",
  async ({ scope, state }) => {
    const starts: string[] = [];
    const configuring = createDeferred();
    const releaseConfiguration = createDeferred();
    let blockConfiguration = state === "racing";
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "discord",
        config: {
          listAccountIds: () => ["manual", "running"],
          resolveAccount: (_cfg, accountId) => ({ accountId }),
          isConfigured: async (account) => {
            if (blockConfiguration && account.accountId === "manual") {
              configuring.resolve();
              await releaseConfiguration.promise;
            }
            return true;
          },
        },
      }),
      gateway: {
        startAccount: async ({ accountId, abortSignal }) => {
          starts.push(accountId);
          await new Promise<void>((resolve) => {
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", plugin, source: "test" }]));
    manager = createChannelManager({
      getRuntimeConfig: () => ({}),
      getPluginRegistry: requireActivePluginChannelRegistry,
      channelLogs: {},
      channelRuntimeEnvs: {},
    });
    if (state === "stopped") {
      await manager.startChannel("discord", "manual");
      expect(starts).toEqual(["manual"]);
    }
    if (state !== "racing") {
      await manager.stopChannel("discord", "manual");
    }
    const channels = new Set<ChannelKind>(scope === "channel" ? ["discord"] : []);
    const accounts = new Map<ChannelKind, Set<string>>(
      scope === "accounts" ? [["discord", new Set(["manual", "running"])]] : [],
    );
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const scheduleRecoveryRestart = vi.fn();
    const reload = restartGatewayChannels({
      params: {
        startChannel: manager.startChannel,
        stopChannel: manager.stopChannel,
        getPluginRegistry: requireActivePluginChannelRegistry,
        releaseChannelRouteHandoffs: manager.releaseChannelRouteHandoffs,
        logChannels,
      },
      nextConfig: {},
      channelsToRestart: channels,
      restartChannelAccounts: accounts,
      activePluginChannelsAfterReload: null,
      shouldSkipChannelRestart: false,
      skipChannelRestartLogMessage: "",
      isLifecycleReloadAborted: () => false,
      getChannelAutostartSuppression: () => null,
      channelReloadTargets: () => channels,
      logSuppressedChannelRestart: vi.fn(),
      scheduleRecoveryRestart,
    });
    if (state === "racing") {
      await configuring.promise;
      await manager.stopChannel("discord", "manual");
      blockConfiguration = false;
      releaseConfiguration.resolve();
    }
    await reload;
    expect(scheduleRecoveryRestart).not.toHaveBeenCalled();
    expect(logChannels.error).not.toHaveBeenCalled();
    expect(manager.isManuallyStopped("discord", "manual")).toBe(true);
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.manual?.running).toBe(false);
    expect(starts).toEqual(state === "stopped" ? ["manual", "running"] : ["running"]);

    await manager.startChannel("discord", "manual", { manual: true });
    expect(manager.isManuallyStopped("discord", "manual")).toBe(false);
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.manual?.running).toBe(true);
    expect(starts.at(-1)).toBe("manual");
  },
);
it("channel rollback uses the attached registry while another Gateway is active", async () => {
  const monitors: Array<{
    owner: string;
    channelId: ChannelKind;
    abortSignal: AbortSignal;
    joined: boolean;
  }> = [];
  const stopOwners: string[] = [];
  const createRegistry = (owner: string, channelIds: ChannelKind[]) =>
    createTestRegistry(
      channelIds.map((id) => {
        const plugin: ChannelPlugin = {
          ...createChannelTestPluginBase({ id }),
          gateway: {
            startAccount: async ({ abortSignal }) => {
              const monitor = { owner, channelId: id, abortSignal, joined: false };
              monitors.push(monitor);
              await new Promise<void>((resolve) => {
                abortSignal.addEventListener("abort", () => resolve(), { once: true });
              });
              monitor.joined = true;
            },
            stopAccount: async () => {
              stopOwners.push(owner);
            },
          },
        };
        return { pluginId: id, plugin, source: "test" };
      }),
    );
  const ownedIds: ChannelKind[] = ["collision", "owner-only"];
  let attached = createRegistry("A-original", ownedIds);
  const current = createRegistry("A-current", ownedIds);
  const foreign = createRegistry("B", ["collision", "foreign-only"]);
  const registryOwnerA = createPluginRegistryOwner(attached);
  const registryOwnerB = createPluginRegistryOwner(foreign);
  const ownerA = createChannelManager({
    getRuntimeConfig: () => ({}),
    getPluginRegistry: () => attached,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
  const ownerB = createChannelManager({
    getRuntimeConfig: () => ({}),
    getPluginRegistry: () => foreign,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
  const stopOwnedChannels = async () => {
    for (const id of ownedIds) {
      await ownerA.stopChannel(id, undefined, { manual: false });
    }
  };
  try {
    setActivePluginRegistry(attached);
    await ownerA.startChannels();
    expect(monitors.map(({ owner }) => owner)).toEqual(["A-original", "A-original"]);
    await stopOwnedChannels();
    expect(monitors.every(({ abortSignal, joined }) => abortSignal.aborted && joined)).toBe(true);

    attached = current;
    setActivePluginRegistry(current);
    registryOwnerA.publish(current);
    await ownerA.startChannels();
    expect(monitors.slice(2).map(({ owner }) => owner)).toEqual(["A-current", "A-current"]);
    // Rollback must resume this generation, not the manager's original registry.
    await stopOwnedChannels();
    expect(monitors.every(({ abortSignal, joined }) => abortSignal.aborted && joined)).toBe(true);

    setActivePluginRegistry(foreign);
    await ownerB.startChannels();
    const foreignMonitors = monitors.filter(({ owner }) => owner === "B");
    expect(foreignMonitors).toHaveLength(2);
    const beforeRollback = monitors.length;
    const channels = new Set<ChannelKind>(ownedIds);
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const scheduleRecoveryRestart = vi.fn();
    await reloadChannels(ownerA, () => attached, channels, logChannels, scheduleRecoveryRestart);
    expect(scheduleRecoveryRestart).not.toHaveBeenCalled();
    expect(logChannels.error).not.toHaveBeenCalled();
    const resumed = monitors
      .slice(beforeRollback)
      .map(({ owner, channelId }) => `${owner}:${channelId}`)
      .toSorted();
    const bInterrupted = foreignMonitors.some(
      ({ abortSignal, joined }) => abortSignal.aborted || joined,
    );
    expect(
      {
        resumed,
        aChannels: Object.keys(ownerA.getRuntimeSnapshot().channelAccounts).toSorted(),
        bChannels: Object.keys(ownerB.getRuntimeSnapshot().channelAccounts).toSorted(),
        bStopped: stopOwners.includes("B"),
        bInterrupted,
      },
      "rollback borrowed a foreign or constructor-time channel registry",
    ).toEqual({
      resumed: ["A-current:collision", "A-current:owner-only"],
      aChannels: ["collision", "owner-only"],
      bChannels: ["collision", "foreign-only"],
      bStopped: false,
      bInterrupted: false,
    });
  } finally {
    for (const owner of [ownerA, ownerB]) {
      for (const id of ["collision", "owner-only", "foreign-only"]) {
        await owner.stopChannel(id);
      }
    }
    await registryOwnerA.close();
    await registryOwnerB.close();
    expect(monitors.every(({ abortSignal, joined }) => abortSignal.aborted && joined)).toBe(true);
  }
});
