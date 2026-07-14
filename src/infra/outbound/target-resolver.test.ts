// Covers outbound target resolver id heuristics, directory cache/live fallback,
// ambiguity modes, display formatting, and plugin normalized fallbacks.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelDirectoryEntry } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
type TargetResolverModule = typeof import("./target-resolver.js");

let resetDirectoryCache: TargetResolverModule["resetDirectoryCache"];
let resolveMessagingTarget: TargetResolverModule["resolveChannelTarget"];
let formatTargetDisplay: TargetResolverModule["formatTargetDisplay"];

const mocks = vi.hoisted(() => ({
  listPeers: vi.fn(),
  listPeersLive: vi.fn(),
  listGroups: vi.fn(),
  listGroupsLive: vi.fn(),
  resolveTarget: vi.fn(),
  getChannelPlugin: vi.fn(),
  getLoadedChannelPlugin: vi.fn(),
  getActivePluginChannelRegistryVersion: vi.fn(() => 1),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: (...args: unknown[]) => mocks.getLoadedChannelPlugin(...args),
  getChannelPlugin: (...args: unknown[]) => mocks.getChannelPlugin(...args),
  normalizeChannelId: (value: string) => value,
}));

vi.mock("../../channels/plugins/registry-loaded.js", () => ({
  getLoadedChannelPluginForRead: (...args: unknown[]) => mocks.getLoadedChannelPlugin(...args),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginChannelRegistry: () => null,
  getActivePluginRegistry: () => null,
  getActivePluginChannelRegistryVersion: () => mocks.getActivePluginChannelRegistryVersion(),
}));

beforeAll(async () => {
  const targetResolver = await import("./target-resolver.js");
  resetDirectoryCache = targetResolver.resetDirectoryCache;
  resolveMessagingTarget = targetResolver.resolveChannelTarget;
  formatTargetDisplay = targetResolver.formatTargetDisplay;
});

beforeEach(() => {
  mocks.listPeers.mockReset();
  mocks.listPeersLive.mockReset();
  mocks.listGroups.mockReset();
  mocks.listGroupsLive.mockReset();
  mocks.resolveTarget.mockReset();
  mocks.getChannelPlugin.mockReset();
  mocks.getLoadedChannelPlugin.mockReset();
  mocks.getLoadedChannelPlugin.mockImplementation((...args: unknown[]) =>
    mocks.getChannelPlugin(...args),
  );
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

function firstMockArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error(`expected ${label} input to be an object`);
  }
  return arg as Record<string, unknown>;
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
      channel: "richchat",
      input: "support",
    });
    expect(first.target.source).toBe("directory");
    expect(first.target.to).toBe("123456789");
    expect(mocks.listGroups).toHaveBeenCalledTimes(1);
    expect(mocks.listGroupsLive).toHaveBeenCalledTimes(1);

    const second = await expectOkResolution({
      cfg,
      channel: "richchat",
      input: "support",
    });
    expect(second.target.to).toBe("123456789");
    expect(mocks.listGroups).toHaveBeenCalledTimes(1);
    expect(mocks.listGroupsLive).toHaveBeenCalledTimes(1);
  });

  it("does not reuse query-filtered directory misses for later target queries", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      directory: {
        listPeers: mocks.listPeers,
        listPeersLive: mocks.listPeersLive,
      },
      messaging: {
        inferTargetChatType: () => "direct",
        targetResolver: {
          resolveTarget: mocks.resolveTarget,
        },
      },
    });
    const listMatchingPeers = vi.fn(({ query }: { query?: string }) =>
      query === "dm" ? [{ kind: "user", id: "+15551234567", name: "ops-dm" }] : [],
    );
    mocks.listPeers.mockImplementation(listMatchingPeers);
    mocks.listPeersLive.mockImplementation(listMatchingPeers);
    mocks.resolveTarget.mockResolvedValue(null);

    const miss = await resolveMessagingTarget({
      cfg,
      channel: "richchat",
      input: "alpha",
    });
    expect(miss.ok).toBe(false);

    const hit = await expectOkResolution({
      cfg,
      channel: "richchat",
      input: "dm",
    });

    expect(hit.target).toEqual({
      to: "+15551234567",
      kind: "user",
      display: "ops-dm",
      source: "directory",
      resolutionSource: "directory",
    });
    expect(mocks.listPeers).toHaveBeenCalledTimes(2);
    expect(listMatchingPeers).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ query: "alpha" }),
    );
    expect(listMatchingPeers).toHaveBeenNthCalledWith(3, expect.objectContaining({ query: "dm" }));
  });

  it("does not fall back to plugin target resolution after directory errors", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      directory: {
        listPeers: mocks.listPeers,
      },
      messaging: {
        inferTargetChatType: () => "direct",
        targetResolver: {
          resolveTarget: mocks.resolveTarget,
        },
      },
    });
    mocks.listPeers.mockRejectedValue(new Error("Alias ops is invalid."));
    mocks.resolveTarget.mockResolvedValue({
      to: "+15551234567",
      kind: "user",
      source: "directory",
    });

    await expect(
      resolveMessagingTarget({
        cfg,
        channel: "richchat",
        input: "ops",
      }),
    ).rejects.toThrow("Alias ops is invalid.");
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
  });

  it("preserves configured directory entries before rejecting reserved literal targets", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      ...createChannelTestPluginBase({
        id: "telegram",
        label: "Telegram",
        capabilities: { chatTypes: ["direct", "group", "channel"] },
      }),
      directory: {
        listPeers: mocks.listPeers,
        listPeersLive: mocks.listPeersLive,
        listGroups: mocks.listGroups,
        listGroupsLive: mocks.listGroupsLive,
      },
      messaging: {
        targetResolver: {
          reservedLiterals: ["current", "self", "this", "me"],
          hint: "<chatId>",
          resolveTarget: mocks.resolveTarget,
        },
      },
    });
    mocks.listGroups.mockResolvedValue([
      {
        kind: "group",
        id: "-1002458651455",
        name: "Current x jerry Channel",
        handle: "@current",
      } satisfies ChannelDirectoryEntry,
    ]);

    const result = await resolveMessagingTarget({
      cfg,
      channel: "telegram",
      input: "current",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.to).toBe("-1002458651455");
      expect(result.target.source).toBe("directory");
    }
    expect(mocks.listGroups).toHaveBeenCalled();
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
  });

  it("keeps reserved literals on the directory path before id-like plugin normalization", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      ...createChannelTestPluginBase({
        id: "telegram",
        label: "Telegram",
        capabilities: { chatTypes: ["direct", "group", "channel"] },
      }),
      directory: {
        listPeers: mocks.listPeers,
        listPeersLive: mocks.listPeersLive,
        listGroups: mocks.listGroups,
        listGroupsLive: mocks.listGroupsLive,
      },
      messaging: {
        normalizeTarget: (raw: string) =>
          raw === "current" || raw === "telegram:current" ? "telegram:@current" : raw,
        targetResolver: {
          looksLikeId: (raw: string) => raw === "current" || raw === "telegram:current",
          reservedLiterals: ["current", "self", "this", "me"],
          hint: "<chatId>",
          resolveTarget: mocks.resolveTarget,
        },
      },
    });
    mocks.listGroups.mockResolvedValueOnce([
      { kind: "group", id: "room-1", name: "current" } satisfies ChannelDirectoryEntry,
    ]);

    const hit = await resolveMessagingTarget({
      cfg,
      channel: "telegram",
      input: "current",
    });

    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.target.to).toBe("room-1");
      expect(hit.target.source).toBe("directory");
    }
    expect(mocks.resolveTarget).not.toHaveBeenCalled();

    resetDirectoryCache();
    mocks.listGroups.mockResolvedValueOnce([
      { kind: "group", id: "room-1", name: "current" } satisfies ChannelDirectoryEntry,
    ]);

    const prefixedHit = await resolveMessagingTarget({
      cfg,
      channel: "telegram",
      input: "telegram:current",
    });

    expect(prefixedHit.ok).toBe(true);
    if (prefixedHit.ok) {
      expect(prefixedHit.target.to).toBe("room-1");
      expect(prefixedHit.target.source).toBe("directory");
    }

    resetDirectoryCache();
    mocks.listGroups.mockResolvedValueOnce([]);
    mocks.listGroupsLive.mockResolvedValueOnce([]);

    const miss = await resolveMessagingTarget({
      cfg,
      channel: "telegram",
      input: "current",
    });

    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      expect(miss.error.message).toContain('Reserved target "current"');
      expect(miss.error.message).toContain("Telegram");
    }
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
  });

  it("rejects reserved literal targets after directory miss", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      ...createChannelTestPluginBase({
        id: "telegram",
        label: "Telegram",
        capabilities: { chatTypes: ["direct", "group", "channel"] },
      }),
      directory: {
        listPeers: mocks.listPeers,
        listPeersLive: mocks.listPeersLive,
        listGroups: mocks.listGroups,
        listGroupsLive: mocks.listGroupsLive,
      },
      messaging: {
        targetResolver: {
          reservedLiterals: ["current", "self", "this", "me"],
          hint: "<chatId>",
          resolveTarget: mocks.resolveTarget,
        },
      },
    });
    mocks.listGroups.mockResolvedValue([]);
    mocks.listGroupsLive.mockResolvedValue([]);

    const result = await resolveMessagingTarget({
      cfg,
      channel: "telegram",
      input: "current",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Reserved target "current"');
      expect(result.error.message).toContain("Telegram");
    }
    expect(mocks.listGroups).toHaveBeenCalled();
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
  });

  it("requires exact directory matches before preserving reserved literal targets", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      ...createChannelTestPluginBase({
        id: "telegram",
        label: "Telegram",
        capabilities: { chatTypes: ["direct", "group", "channel"] },
      }),
      directory: {
        listPeers: mocks.listPeers,
        listPeersLive: mocks.listPeersLive,
        listGroups: mocks.listGroups,
        listGroupsLive: mocks.listGroupsLive,
      },
      messaging: {
        targetResolver: {
          reservedLiterals: ["current", "self", "this", "me"],
          hint: "<chatId>",
          resolveTarget: mocks.resolveTarget,
        },
      },
    });
    mocks.listGroups.mockResolvedValue([
      { kind: "group", id: "memes-room", name: "memes" } satisfies ChannelDirectoryEntry,
    ]);
    mocks.listGroupsLive.mockResolvedValue([]);

    const result = await resolveMessagingTarget({
      cfg,
      channel: "telegram",
      input: "me",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Reserved target "me"');
      expect(result.error.message).toContain("Telegram");
    }
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
  });

  it("does not reuse directory cache entries across prepared plugin runtimes", async () => {
    const firstListGroups = vi
      .fn()
      .mockResolvedValue([
        { kind: "group", id: "first-id", name: "support" } satisfies ChannelDirectoryEntry,
      ]);
    const replacementListGroups = vi
      .fn()
      .mockResolvedValue([
        { kind: "group", id: "replacement-id", name: "support" } satisfies ChannelDirectoryEntry,
      ]);
    const firstPlugin = {
      ...createChannelTestPluginBase({
        id: "richchat",
        capabilities: { chatTypes: ["group"] },
      }),
      directory: { listGroups: firstListGroups },
      messaging: { targetResolver: {} },
    } satisfies ChannelPlugin;
    const replacementPlugin = {
      ...createChannelTestPluginBase({
        id: "richchat",
        capabilities: { chatTypes: ["group"] },
      }),
      directory: { listGroups: replacementListGroups },
      messaging: { targetResolver: {} },
    } satisfies ChannelPlugin;

    const first = await expectOkResolution({
      cfg,
      channel: "richchat",
      input: "support",
      plugin: firstPlugin,
    });
    const replacement = await expectOkResolution({
      cfg,
      channel: "richchat",
      input: "support",
      plugin: replacementPlugin,
    });

    expect(first.target.to).toBe("first-id");
    expect(replacement.target.to).toBe("replacement-id");
    expect(firstListGroups).toHaveBeenCalledOnce();
    expect(replacementListGroups).toHaveBeenCalledOnce();
  });

  it("skips directory lookup for direct ids", async () => {
    const result = await expectOkResolution({
      cfg,
      channel: "richchat",
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
      channel: "workspace",
      input: "dthcxgoxhifn3pwh65cut3ud3w",
    });
    expect(result.target).toEqual({
      to: "user:dm-user-id",
      kind: "user",
      source: "directory",
      resolutionSource: "plugin",
      display: undefined,
    });
    expect(mocks.resolveTarget).toHaveBeenCalledOnce();
    expect(firstMockArg(mocks.resolveTarget, "target resolver").input).toBe(
      "dthcxgoxhifn3pwh65cut3ud3w",
    );
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });

  it("defaults bare id-like targets to user for direct-only channel plugins", async () => {
    const directOnlyPlugin = {
      ...createChannelTestPluginBase({
        id: "openclaw-weixin",
        capabilities: { chatTypes: ["direct"] },
      }),
      messaging: {
        targetResolver: {
          looksLikeId: (raw: string) => raw.endsWith("@im.wechat"),
        },
      },
    } satisfies ChannelPlugin;

    const result = await expectOkResolution({
      cfg,
      channel: "openclaw-weixin",
      input: "wxid_abc123@im.wechat",
      plugin: directOnlyPlugin,
    });

    expect(result.target).toEqual({
      to: "wxid_abc123@im.wechat",
      kind: "user",
      display: "wxid_abc123@im.wechat",
      source: "normalized",
      resolutionSource: "normalized",
    });
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });

  it("uses catalog plugin target grammar for unloaded numeric topic ids", async () => {
    mocks.getLoadedChannelPlugin.mockReturnValue(undefined);
    mocks.getChannelPlugin.mockReturnValue({
      messaging: {
        normalizeTarget: (raw: string) =>
          raw.trim() === "-1001234567890:topic:42"
            ? "telegram:-1001234567890:topic:42"
            : raw.trim() || undefined,
        inferTargetChatType: ({ to }: { to: string }) => (to.includes("-100") ? "group" : "direct"),
        targetResolver: {
          looksLikeId: (_raw: string, normalized?: string) =>
            normalized === "telegram:-1001234567890:topic:42",
          hint: "<chatId>",
        },
      },
    });

    const result = await expectOkResolution({
      cfg,
      channel: "telegram",
      input: "-1001234567890:topic:42",
    });

    expect(result.target).toEqual({
      to: "telegram:-1001234567890:topic:42",
      kind: "group",
      display: "telegram:-1001234567890:topic:42",
      source: "normalized",
      resolutionSource: "normalized",
    });
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
      channel: "localchat",
      input: "+15551234567",
    });
    expect(result.target).toEqual({
      to: "+15551234567",
      kind: "user",
      source: "normalized",
      resolutionSource: "plugin",
      display: undefined,
    });
    expect(mocks.listPeers).toHaveBeenCalledTimes(1);
    expect(mocks.listPeersLive).toHaveBeenCalledTimes(1);
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.resolveTarget).toHaveBeenCalledOnce();
    expect(firstMockArg(mocks.resolveTarget, "target resolver").input).toBe("+15551234567");
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
      channel: "workspace",
      input: "#C123ABC",
    });
    expect(result.target.to).toBe("channel:C123ABC");
    expect(result.target.display).toBeUndefined();
  });

  it("defers target display formatting to the plugin when available", () => {
    mocks.getChannelPlugin.mockReturnValue({
      messaging: {
        formatTargetDisplay: ({ target }: { target: string }) => target.replace(/^forum:/i, ""),
      },
    });

    expect(formatTargetDisplay({ channel: "forum", target: "forum:12345" })).toBe("12345");
  });
});
