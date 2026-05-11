import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChannelId, type ChannelPlugin } from "../channels/plugins/types.js";
import {
  createSubsystemLogger,
  runtimeForLogger,
  type SubsystemLogger,
} from "../logging/subsystem.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createRuntimeChannel } from "../plugins/runtime/runtime-channel.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";

const hoisted = vi.hoisted(() => ({
  startChannelApprovalHandlerBootstrap: vi.fn(async () => async () => {}),
}));

vi.mock("../infra/approval-handler-bootstrap.js", () => ({
  startChannelApprovalHandlerBootstrap: hoisted.startChannelApprovalHandlerBootstrap,
}));

function createDeferred() {
  let resolvePromise = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function createTestPlugin(params: {
  startAccount: NonNullable<NonNullable<ChannelPlugin["gateway"]>["startAccount"]>;
}): ChannelPlugin {
  return {
    id: "discord",
    meta: {
      id: "discord",
      label: "Discord",
      selectionLabel: "Discord",
      docsPath: "/channels/discord",
      blurb: "test stub",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [DEFAULT_ACCOUNT_ID],
      resolveAccount: () => ({ enabled: true, configured: true }),
      isEnabled: () => true,
      describeAccount: () => ({
        accountId: DEFAULT_ACCOUNT_ID,
        enabled: true,
        configured: true,
      }),
    },
    approvalCapability: {
      nativeRuntime: {
        availability: {
          isConfigured: vi.fn().mockReturnValue(true),
          shouldHandle: vi.fn().mockReturnValue(true),
        },
        presentation: {
          buildPendingPayload: vi.fn(),
          buildResolvedResult: vi.fn(),
          buildExpiredResult: vi.fn(),
        },
        transport: {
          prepareTarget: vi.fn(),
          deliverPending: vi.fn(),
        },
      },
    },
    gateway: {
      startAccount: params.startAccount,
    },
  };
}

function installTestRegistry(plugin: ChannelPlugin) {
  const registry = createEmptyPluginRegistry();
  registry.channels.push({
    pluginId: plugin.id,
    source: "test",
    plugin,
  });
  setActivePluginRegistry(registry);
}

function createManager(
  createChannelManager: typeof import("./server-channels.js").createChannelManager,
  options?: {
    channelRuntime?: PluginRuntime["channel"];
  },
) {
  const log = createSubsystemLogger("gateway/server-channels-approval-bootstrap-test");
  const channelLogs = { discord: log } as Record<ChannelId, SubsystemLogger>;
  const runtime = runtimeForLogger(log);
  const channelRuntimeEnvs = { discord: runtime } as unknown as Record<ChannelId, RuntimeEnv>;
  return createChannelManager({
    getRuntimeConfig: () => ({}),
    channelLogs,
    channelRuntimeEnvs,
    ...(options?.channelRuntime ? { channelRuntime: options.channelRuntime } : {}),
  });
}

describe("server-channels approval bootstrap", () => {
  let previousRegistry: PluginRegistry | null = null;
  let createChannelManager: typeof import("./server-channels.js").createChannelManager;

  beforeAll(async () => {
    ({ createChannelManager } = await import("./server-channels.js"));
  });

  beforeEach(() => {
    previousRegistry = getActivePluginRegistry();
    hoisted.startChannelApprovalHandlerBootstrap.mockReset();
  });

  afterEach(() => {
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
  });

  it("starts and stops the shared approval bootstrap with the channel lifecycle", async () => {
    const channelRuntime = createRuntimeChannel();
    const stopApprovalBootstrap = vi.fn(async () => {});
    hoisted.startChannelApprovalHandlerBootstrap.mockResolvedValue(stopApprovalBootstrap);

    const started = createDeferred();
    const stopped = createDeferred();
    const startAccount = vi.fn(
      async ({
        abortSignal,
        channelRuntime,
      }: Parameters<NonNullable<NonNullable<ChannelPlugin["gateway"]>["startAccount"]>>[0]) => {
        channelRuntime?.runtimeContexts.register({
          channelId: "discord",
          accountId: DEFAULT_ACCOUNT_ID,
          capability: "approval.native",
          context: { token: "tracked" },
        });
        started.resolve();
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener(
            "abort",
            () => {
              stopped.resolve();
              resolve();
            },
            { once: true },
          );
        });
      },
    );

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager(createChannelManager, { channelRuntime });

    await manager.startChannels();
    await started.promise;

    const approvalBootstrapCalls = hoisted.startChannelApprovalHandlerBootstrap.mock
      .calls as unknown as Array<
      [
        {
          plugin: ChannelPlugin;
          cfg: unknown;
          accountId?: string;
          channelRuntime?: PluginRuntime["channel"];
        },
      ]
    >;
    const approvalBootstrapArg = approvalBootstrapCalls.at(-1)?.[0];
    expect(approvalBootstrapArg?.plugin.id).toBe("discord");
    expect(approvalBootstrapArg?.cfg).toEqual({});
    expect(approvalBootstrapArg?.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(typeof approvalBootstrapArg?.channelRuntime?.runtimeContexts.register).toBe("function");
    expect(typeof approvalBootstrapArg?.channelRuntime?.runtimeContexts.get).toBe("function");
    expect(typeof approvalBootstrapArg?.channelRuntime?.runtimeContexts.watch).toBe("function");
    expect(
      channelRuntime.runtimeContexts.get({
        channelId: "discord",
        accountId: DEFAULT_ACCOUNT_ID,
        capability: "approval.native",
      }),
    ).toEqual({ token: "tracked" });

    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await stopped.promise;

    expect(stopApprovalBootstrap).toHaveBeenCalledTimes(1);
    expect(
      channelRuntime.runtimeContexts.get({
        channelId: "discord",
        accountId: DEFAULT_ACCOUNT_ID,
        capability: "approval.native",
      }),
    ).toBeUndefined();
  });

  it("continues account startup when approval bootstrap startup fails", async () => {
    const channelRuntime = createRuntimeChannel();
    const stopped = createDeferred();
    const startAccount = vi.fn(
      async ({
        abortSignal,
      }: Parameters<NonNullable<NonNullable<ChannelPlugin["gateway"]>["startAccount"]>>[0]) => {
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener(
            "abort",
            () => {
              stopped.resolve();
              resolve();
            },
            { once: true },
          );
        });
      },
    );
    hoisted.startChannelApprovalHandlerBootstrap.mockRejectedValue(new Error("boom"));

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager(createChannelManager, { channelRuntime });

    await manager.startChannels();

    expect(startAccount).toHaveBeenCalledTimes(1);
    const accountSnapshot =
      manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(accountSnapshot?.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(accountSnapshot?.running).toBe(true);
    expect(accountSnapshot?.restartPending).toBe(false);
    expect(accountSnapshot?.lastError).toBeNull();

    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await stopped.promise;
  });
});
