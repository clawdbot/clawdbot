// Verifies outbound channel resolution fast paths, active-registry reads,
// bootstrap fallback, and runtime facade projection.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveDefaultAgentIdMock = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDirMock = vi.hoisted(() => vi.fn());
const getLoadedChannelPluginMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const applyPluginAutoEnableMock = vi.hoisted(() => vi.fn());
const resolveRuntimePluginRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryVersionMock = vi.hoisted(() => vi.fn());
const getActivePluginChannelRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginChannelRegistryVersionMock = vi.hoisted(() => vi.fn());
const normalizeMessageChannelMock = vi.hoisted(() => vi.fn());
const isDeliverableMessageChannelMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: (...args: unknown[]) => resolveDefaultAgentIdMock(...args),
  resolveAgentWorkspaceDir: (...args: unknown[]) => resolveAgentWorkspaceDirMock(...args),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: (...args: unknown[]) => getLoadedChannelPluginMock(...args),
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

vi.mock("../../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: (...args: unknown[]) => resolveRuntimePluginRegistryMock(...args),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: (...args: unknown[]) => getActivePluginRegistryMock(...args),
  getActivePluginRegistryVersion: (...args: unknown[]) =>
    getActivePluginRegistryVersionMock(...args),
  getActivePluginChannelRegistry: (...args: unknown[]) =>
    getActivePluginChannelRegistryMock(...args),
  getActivePluginChannelRegistryVersion: (...args: unknown[]) =>
    getActivePluginChannelRegistryVersionMock(...args),
}));

vi.mock("../../utils/message-channel.js", () => ({
  normalizeMessageChannel: (...args: unknown[]) => normalizeMessageChannelMock(...args),
  isDeliverableMessageChannel: (...args: unknown[]) => isDeliverableMessageChannelMock(...args),
}));

import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";

async function importChannelResolution(scope: string) {
  return await importFreshModule<typeof import("./channel-resolution.js")>(
    import.meta.url,
    `./channel-resolution.js?scope=${scope}`,
  );
}

function firstMockArg(mock: { mock: { calls: readonly unknown[][] } }): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected mock call");
  }
  const [arg] = call;
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error("expected mock call arg to be an object");
  }
  return arg as Record<string, unknown>;
}

describe("outbound channel resolution", () => {
  beforeEach(async () => {
    resolveDefaultAgentIdMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    getLoadedChannelPluginMock.mockReset();
    getChannelPluginMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    resolveRuntimePluginRegistryMock.mockReset();
    getActivePluginRegistryMock.mockReset();
    getActivePluginRegistryVersionMock.mockReset();
    getActivePluginChannelRegistryMock.mockReset();
    getActivePluginChannelRegistryVersionMock.mockReset();
    normalizeMessageChannelMock.mockReset();
    isDeliverableMessageChannelMock.mockReset();

    normalizeMessageChannelMock.mockImplementation((value?: string | null) =>
      typeof value === "string" ? value.trim().toLowerCase() : undefined,
    );
    isDeliverableMessageChannelMock.mockImplementation((value?: string) =>
      ["alpha", "beta", "gamma"].includes(String(value)),
    );
    getActivePluginRegistryMock.mockReturnValue({ channels: [] });
    getActivePluginRegistryVersionMock.mockReturnValue(1);
    getActivePluginChannelRegistryMock.mockReturnValue({ channels: [] });
    getActivePluginChannelRegistryVersionMock.mockReturnValue(1);
    applyPluginAutoEnableMock.mockReturnValue({
      config: { autoEnabled: true },
      autoEnabledReasons: {},
    });
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");

    const channelResolution = await importChannelResolution("reset");
    channelResolution.resetOutboundChannelResolutionStateForTest();
  });

  it.each([
    { input: " Alpha ", expected: "alpha" },
    { input: "unknown", expected: undefined },
    { input: null, expected: undefined },
  ])("normalizes deliverable outbound channel for %j", async ({ input, expected }) => {
    const channelResolution = await importChannelResolution("normalize");
    expect(channelResolution.normalizeDeliverableOutboundChannel(input)).toBe(expected);
  });

  it("returns the already-registered plugin without bootstrapping", async () => {
    const plugin = { id: "alpha", outbound: { sendText: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValueOnce(plugin);
    const channelResolution = await importChannelResolution("existing-plugin");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: {} as never,
      }),
    ).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("returns a bundled plugin without bootstrapping", async () => {
    const plugin = { id: "alpha", outbound: { sendText: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValue(undefined);
    getChannelPluginMock.mockReturnValue(plugin);
    const channelResolution = await importChannelResolution("bundled-plugin");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: {} as never,
        allowBootstrap: true,
      }),
    ).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("falls back to the active registry when getChannelPlugin misses", async () => {
    const plugin = { id: "alpha" };
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin }],
    });
    const channelResolution = await importChannelResolution("direct-registry");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: {} as never,
      }),
    ).toBe(plugin);
  });

  it("resolves message adapters from the pinned channel registry after active registry replacement", async () => {
    const message = { send: { text: vi.fn() } };
    const plugin = { id: "alpha", message };
    getLoadedChannelPluginMock.mockReturnValue(undefined);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin }],
    });
    getActivePluginRegistryMock.mockReturnValue({ channels: [] });
    const channelResolution = await importChannelResolution("pinned-message-registry");

    expect(
      channelResolution.resolveOutboundChannelMessageAdapter({
        channel: "alpha",
        cfg: {} as never,
      }),
    ).toBe(message);
  });

  it("skips metadata-only loaded message shells for active send-capable message adapters", async () => {
    const setupMessage = { receive: { defaultAckPolicy: "manual" } };
    const runtimeMessage = { send: { text: vi.fn() } };
    const setupPlugin = { id: "alpha", message: setupMessage };
    const runtimePlugin = { id: "alpha", message: runtimeMessage };
    getLoadedChannelPluginMock.mockReturnValue(setupPlugin);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: setupPlugin }],
    });
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: runtimePlugin }],
    });
    const channelResolution = await importChannelResolution("message-metadata-shell");

    expect(
      channelResolution.resolveOutboundChannelMessageAdapter({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(runtimeMessage);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("bootstraps configured channel plugins when the active registry is missing the target", async () => {
    const plugin = { id: "alpha", outbound: { sendText: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValueOnce(undefined).mockReturnValueOnce(plugin);
    const channelResolution = await importChannelResolution("bootstrap-missing-target");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(plugin);
    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({ config: { channels: {} } });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledOnce();
    const registryOptions = firstMockArg(resolveRuntimePluginRegistryMock);
    expect(registryOptions.config).toEqual({ autoEnabled: true });
    expect(registryOptions.activationSourceConfig).toEqual({ channels: {} });
    expect(registryOptions.autoEnabledReasons).toEqual({});
    expect(registryOptions.workspaceDir).toBe("/tmp/workspace");
    expect(registryOptions.runtimeOptions).toEqual({
      allowGatewaySubagentBinding: true,
    });
  });

  it("bootstraps instead of returning a pinned setup shell as the outbound plugin", async () => {
    const setupPlugin = { id: "alpha" };
    const runtimePlugin = { id: "alpha", outbound: { sendText: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValueOnce(setupPlugin).mockReturnValueOnce(runtimePlugin);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockReturnValue({ channels: [] });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: setupPlugin }],
    });
    const channelResolution = await importChannelResolution("bootstrap-setup-shell");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(runtimePlugin);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("does not return a setup shell when bootstrap does not produce a runtime plugin", async () => {
    const setupPlugin = { id: "alpha" };
    getLoadedChannelPluginMock.mockReturnValue(setupPlugin);
    getChannelPluginMock.mockReturnValue(setupPlugin);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: setupPlugin }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: setupPlugin }],
    });
    const channelResolution = await importChannelResolution("bootstrap-still-setup-shell");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBeUndefined();
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("does not treat an actions-only plugin as send-capable after bootstrap", async () => {
    const actionsOnlyPlugin = { id: "alpha", actions: { handleAction: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValue(actionsOnlyPlugin);
    getChannelPluginMock.mockReturnValue(actionsOnlyPlugin);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: actionsOnlyPlugin }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: actionsOnlyPlugin }],
    });
    const channelResolution = await importChannelResolution("actions-only-plugin");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBeUndefined();
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("prefers an active runtime plugin over a loaded setup shell", async () => {
    const setupPlugin = { id: "alpha" };
    const runtimePlugin = { id: "alpha", outbound: { sendText: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValue(setupPlugin);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: runtimePlugin }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: setupPlugin }],
    });
    const channelResolution = await importChannelResolution("active-runtime-over-setup");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(runtimePlugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("resolves outbound plugins from the selected runtime channel registry", async () => {
    const setupPlugin = { id: "alpha" };
    const runtimePlugin = { id: "alpha", outbound: { sendText: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValue(undefined);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: setupPlugin }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: runtimePlugin }],
    });
    const channelResolution = await importChannelResolution("selected-runtime-registry");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(runtimePlugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("resolves runtime outbound adapters that do not send text directly", async () => {
    const setupPlugin = { id: "alpha" };
    const runtimePlugin = { id: "alpha", outbound: { deliveryMode: "gateway" } };
    getLoadedChannelPluginMock.mockReturnValue(setupPlugin);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: runtimePlugin }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: setupPlugin }],
    });
    const channelResolution = await importChannelResolution("runtime-outbound-adapter");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(runtimePlugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("keeps setup shells visible for read-only channel lookup", async () => {
    const setupPlugin = { id: "alpha" };
    const runtimePlugin = { id: "alpha", outbound: { sendText: vi.fn() } };
    getLoadedChannelPluginMock.mockReturnValue(setupPlugin);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: runtimePlugin }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: setupPlugin }],
    });
    const channelResolution = await importChannelResolution("read-setup-shell");

    expect(
      channelResolution.resolveOutboundChannelPluginForRead({
        channel: "alpha",
      }),
    ).toBe(setupPlugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("attempts activation when the active registry has other channels but not the requested one", async () => {
    getLoadedChannelPluginMock.mockReturnValue(undefined);
    getChannelPluginMock.mockReturnValue(undefined);
    getActivePluginRegistryMock.mockReturnValue({
      channels: [{ plugin: { id: "beta" } }],
    });
    getActivePluginChannelRegistryMock.mockReturnValue({
      channels: [{ plugin: { id: "beta" } }],
    });
    const channelResolution = await importChannelResolution("bootstrap-missing-target");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBeUndefined();
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("retries registry loads after bootstrap does not make the channel send-capable", async () => {
    getChannelPluginMock.mockReturnValue(undefined);
    const channelResolution = await importChannelResolution("bootstrap-retry");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBeUndefined();

    channelResolution.resolveOutboundChannelPlugin({
      channel: "alpha",
      cfg: { channels: {} } as never,
      allowBootstrap: true,
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(2);
  });

  it("allows another activation attempt when the pinned channel registry version changes", async () => {
    getChannelPluginMock.mockReturnValue(undefined);
    const channelResolution = await importChannelResolution("channel-version-change");

    channelResolution.resolveOutboundChannelPlugin({
      channel: "alpha",
      cfg: { channels: {} } as never,
      allowBootstrap: true,
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);

    getActivePluginChannelRegistryVersionMock.mockReturnValue(2);
    channelResolution.resolveOutboundChannelPlugin({
      channel: "alpha",
      cfg: { channels: {} } as never,
      allowBootstrap: true,
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(2);
  });

  it("resolves message adapters through the activation-aware channel plugin path", async () => {
    const message = { send: { text: vi.fn() } };
    const plugin = { id: "alpha", message };
    getLoadedChannelPluginMock.mockReturnValueOnce(undefined).mockReturnValueOnce(plugin);
    const channelResolution = await importChannelResolution("message-adapter-bootstrap");

    expect(
      channelResolution.resolveOutboundChannelMessageAdapter({
        channel: "alpha",
        cfg: { channels: {} } as never,
        allowBootstrap: true,
      }),
    ).toBe(message);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("does not bootstrap by default for outbound hot-path resolution", async () => {
    const plugin = { id: "alpha" };
    getLoadedChannelPluginMock.mockReturnValue(undefined);
    getChannelPluginMock.mockReturnValue(plugin);
    const channelResolution = await importChannelResolution("no-bootstrap-default");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
      }),
    ).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });
});
