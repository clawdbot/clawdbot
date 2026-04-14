import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDirectoryEntry } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
type TargetResolverModule = typeof import("./target-resolver.js");

let resetDirectoryCache: TargetResolverModule["resetDirectoryCache"];
let resolveMessagingTarget: TargetResolverModule["resolveMessagingTarget"];
let formatTargetDisplay: TargetResolverModule["formatTargetDisplay"];

const mocks = vi.hoisted(() => ({
  listPeers: vi.fn(),
  listPeersLive: vi.fn(),
  listGroups: vi.fn(),
  listGroupsLive: vi.fn(),
  resolveTarget: vi.fn(),
  getChannelPlugin: vi.fn(),
  getActivePluginChannelRegistryVersion: vi.fn(() => 1),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => mocks.getChannelPlugin(...args),
  normalizeChannelId: (value: string) => value,
}));

vi.mock("../../channels/plugins/registry-loaded-read.js", () => ({
  getLoadedChannelPluginForRead: (...args: unknown[]) => mocks.getChannelPlugin(...args),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginChannelRegistry: () => null,
  getActivePluginRegistry: () => null,
  getActivePluginChannelRegistryVersion: () => mocks.getActivePluginChannelRegistryVersion(),
}));

beforeAll(async () => {
  ({ resetDirectoryCache, resolveMessagingTarget, formatTargetDisplay } =
    await import("./target-resolver.js"));
});

beforeEach(() => {
  mocks.listPeers.mockReset();
  mocks.listPeersLive.mockReset();
  mocks.listGroups.mockReset();
  mocks.listGroupsLive.mockReset();
  mocks.resolveTarget.mockReset();
  mocks.getChannelPlugin.mockReset();
  mocks.getActivePluginChannelRegistryVersion.mockReset();
  mocks.getActivePluginChannelRegistryVersion.mockReturnValue(1);
  resetDirectoryCache();
});

async function expectOkResolution(
  params: Parameters<typeof resolveMessagingTarget>[0],
): Promise<Extract<Awaited<ReturnType<typeof resolveMessagingTarget>>, { ok: true }>> {
  const result = await resolveMessagingTarget(params);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected successful target resolution");
  }
  return result;
}

describe("resolveMessagingTarget (directory fallback)", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    resetDirectoryCache();
    mocks.getChannelPlugin.mockReturnValue({
      directory: {
        listPeers: mocks.listPeers,
        listPeersLive: mocks.listPeersLive,
        listGroups: mocks.listGroups,
        listGroupsLive: mocks.listGroupsLive,
      },
      messaging: {
        targetResolver: {
          resolveTarget: mocks.resolveTarget,
        },
      },
    });
  });

  it("uses live directory fallback and caches the result", async () => {
    const entry: ChannelDirectoryEntry = { kind: "group", id: "123456789", name: "support" };
    mocks.listGroups.mockResolvedValue([]);
    mocks.listGroupsLive.mockResolvedValue([entry]);

    const first = await expectOkResolution({
      cfg,
      channel: "discord",
      input: "support",
    });
    expect(first.target.source).toBe("directory");
    expect(first.target.to).toBe("123456789");
    expect(mocks.listGroups).toHaveBeenCalledTimes(1);
    expect(mocks.listGroupsLive).toHaveBeenCalledTimes(1);

    const second = await expectOkResolution({
      cfg,
      channel: "discord",
      input: "support",
    });
    expect(second.target.to).toBe("123456789");
    expect(mocks.listGroups).toHaveBeenCalledTimes(1);
    expect(mocks.listGroupsLive).toHaveBeenCalledTimes(1);
  });

  it("skips directory lookup for direct ids", async () => {
    const result = await expectOkResolution({
      cfg,
      channel: "discord",
      input: "123456789",
    });
    expect(result.target.source).toBe("normalized");
    expect(result.target.to).toBe("123456789");
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });

  it("lets plugins override id-like target resolution before falling back to raw ids", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      messaging: {
        targetResolver: {
          looksLikeId: () => true,
          resolveTarget: mocks.resolveTarget,
        },
      },
    });
    mocks.resolveTarget.mockResolvedValue({
      to: "user:dm-user-id",
      kind: "user",
      source: "directory",
    });

    const result = await expectOkResolution({
      cfg,
      channel: "mattermost",
      input: "dthcxgoxhifn3pwh65cut3ud3w",
    });
    expect(result.target).toEqual({
      to: "user:dm-user-id",
      kind: "user",
      source: "directory",
      display: undefined,
    });
    expect(mocks.resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "dthcxgoxhifn3pwh65cut3ud3w",
      }),
    );
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });

  it("uses plugin chat-type inference for directory lookups and plugin fallback on miss", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      directory: {
        listPeers: mocks.listPeers,
        listPeersLive: mocks.listPeersLive,
      },
      messaging: {
        inferTargetChatType: () => "direct",
        targetResolver: {
          looksLikeId: () => false,
          resolveTarget: mocks.resolveTarget,
        },
      },
    });
    mocks.listPeers.mockResolvedValue([]);
    mocks.listPeersLive.mockResolvedValue([]);
    mocks.resolveTarget.mockResolvedValue({
      to: "+15551234567",
      kind: "user",
      source: "normalized",
    });

    const result = await expectOkResolution({
      cfg,
      channel: "imessage",
      input: "+15551234567",
    });
    expect(result.target).toEqual({
      to: "+15551234567",
      kind: "user",
      source: "normalized",
      display: undefined,
    });
    expect(mocks.listPeers).toHaveBeenCalledTimes(1);
    expect(mocks.listPeersLive).toHaveBeenCalledTimes(1);
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "+15551234567",
      }),
    );
  });

  it("keeps plugin-owned id casing when resolver returns a normalized target", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      messaging: {
        targetResolver: {
          looksLikeId: () => true,
          resolveTarget: mocks.resolveTarget,
        },
      },
    });
    mocks.resolveTarget.mockResolvedValue({
      to: "channel:C123ABC",
      kind: "group",
      source: "normalized",
    });

    const result = await expectOkResolution({
      cfg,
      channel: "slack",
      input: "#C123ABC",
    });
    expect(result.target.to).toBe("channel:C123ABC");
    expect(result.target.display).toBeUndefined();
  });

  it("defers target display formatting to the plugin when available", () => {
    mocks.getChannelPlugin.mockReturnValue({
      messaging: {
        formatTargetDisplay: ({ target }: { target: string }) => target.replace(/^telegram:/i, ""),
      },
    });

    expect(formatTargetDisplay({ channel: "telegram", target: "telegram:12345" })).toBe("12345");
  });
});
