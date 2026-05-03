import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveDefaultAgentIdMock = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDirMock = vi.hoisted(() => vi.fn());
const getLoadedChannelPluginMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const applyPluginAutoEnableMock = vi.hoisted(() => vi.fn());
const resolveRuntimePluginRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryMock = vi.hoisted(() => vi.fn());
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

describe("outbound channel resolution", () => {
  beforeEach(async () => {
    resolveDefaultAgentIdMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    getLoadedChannelPluginMock.mockReset();
    getChannelPluginMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    resolveRuntimePluginRegistryMock.mockReset();
    getActivePluginRegistryMock.mockReset();
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
    const plugin = { id: "alpha" };
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

  it("does not load registries while resolving outbound plugins", async () => {
    const plugin = { id: "alpha" };
    getLoadedChannelPluginMock.mockReturnValueOnce(undefined).mockReturnValueOnce(plugin);
    const channelResolution = await importChannelResolution("no-bootstrap");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
      }),
    ).toBe(plugin);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();

    getChannelPluginMock.mockReturnValue(undefined);
    channelResolution.resolveOutboundChannelPlugin({
      channel: "alpha",
      cfg: { channels: {} } as never,
    });
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("does not load when the active registry has other channels but not the requested one", async () => {
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
      }),
    ).toBeUndefined();
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("does not retry registry loads after a missing outbound plugin", async () => {
    getChannelPluginMock.mockReturnValue(undefined);
    resolveRuntimePluginRegistryMock.mockImplementationOnce(() => {
      throw new Error("transient");
    });
    const channelResolution = await importChannelResolution("bootstrap-retry");

    expect(
      channelResolution.resolveOutboundChannelPlugin({
        channel: "alpha",
        cfg: { channels: {} } as never,
      }),
    ).toBeUndefined();

    channelResolution.resolveOutboundChannelPlugin({
      channel: "alpha",
      cfg: { channels: {} } as never,
    });
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("does not load when the pinned channel registry version changes", async () => {
    getChannelPluginMock.mockReturnValue(undefined);
    const channelResolution = await importChannelResolution("channel-version-change");

    channelResolution.resolveOutboundChannelPlugin({
      channel: "alpha",
      cfg: { channels: {} } as never,
    });
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();

    getActivePluginChannelRegistryVersionMock.mockReturnValue(2);
    channelResolution.resolveOutboundChannelPlugin({
      channel: "alpha",
      cfg: { channels: {} } as never,
    });
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });
});
