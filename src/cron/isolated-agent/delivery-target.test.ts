import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  forumMessagingForTest,
  parseTelegramTargetForTest,
  telegramMessagingForTest,
} from "../../infra/outbound/targets.test-helpers.js";
import { buildChannelOutboundSessionRoute } from "../../plugin-sdk/core.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";

const { extractDeliveryInfoMock } = vi.hoisted(() => ({
  extractDeliveryInfoMock: vi.fn(),
}));

vi.mock("../../config/sessions/main-session.js", () => ({
  canonicalizeMainSessionAlias: vi.fn(({ sessionKey }) => sessionKey),
  resolveAgentMainSessionKey: vi.fn().mockReturnValue("agent:test:main"),
}));

vi.mock("../../config/sessions/delivery-info.js", () => ({
  extractDeliveryInfo: extractDeliveryInfoMock,
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store.json"),
}));

vi.mock("../../config/sessions/store-load.js", () => ({
  loadSessionStore: vi.fn().mockReturnValue({}),
  readSessionEntry: vi.fn(),
}));

vi.mock("../../infra/outbound/channel-selection.runtime.js", () => ({
  resolveMessageChannelSelection: vi
    .fn()
    .mockResolvedValue({ channel: "alpha", configured: ["alpha"] }),
}));

vi.mock("../../infra/outbound/target-id-resolution.js", () => ({
  maybeResolveIdLikeTarget: vi.fn(),
}));

vi.mock("../../pairing/allow-from-store-read.js", () => ({
  readChannelAllowFromStoreEntriesSync: vi.fn(() => []),
}));

vi.mock("../../infra/outbound/targets.runtime.js", () => ({
  resolveOutboundTarget: vi.fn(),
}));
const mockedModuleIds = [
  "../../config/sessions/main-session.js",
  "../../config/sessions/delivery-info.js",
  "../../config/sessions/paths.js",
  "../../config/sessions/store-load.js",
  "../../infra/outbound/channel-selection.runtime.js",
  "../../infra/outbound/targets.runtime.js",
  "../../infra/outbound/target-id-resolution.js",
  "../../pairing/allow-from-store-read.js",
];

import { loadSessionStore, readSessionEntry } from "../../config/sessions/store-load.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.runtime.js";
import { maybeResolveIdLikeTarget } from "../../infra/outbound/target-id-resolution.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.runtime.js";
import { readChannelAllowFromStoreEntriesSync } from "../../pairing/allow-from-store-read.js";
import { resolveDeliveryTarget } from "./delivery-target.js";

afterAll(() => {
  for (const id of mockedModuleIds) {
    vi.doUnmock(id);
  }
  vi.resetModules();
});

function createStubOutbound(label: string): ChannelOutboundAdapter {
  return {
    deliveryMode: "gateway",
    resolveTarget: ({ to }) => {
      const trimmed = typeof to === "string" ? to.trim() : "";
      return trimmed
        ? { ok: true, to: trimmed }
        : { ok: false, error: new Error(`${label} requires target`) };
    },
  };
}

function createAllowlistAwareStubOutbound(label: string): ChannelOutboundAdapter {
  return {
    deliveryMode: "gateway",
    resolveTarget: ({ to, allowFrom }) => {
      const trimmed = typeof to === "string" ? to.trim() : "";
      if (!trimmed) {
        return { ok: false, error: new Error(`${label} requires target`) };
      }
      if (allowFrom && allowFrom.length > 0 && !allowFrom.includes(trimmed)) {
        return { ok: false, error: new Error(`${label} target blocked`) };
      }
      return { ok: true, to: trimmed };
    },
  };
}

const normalizeTelegramTargetForDeliveryTest = vi.fn((raw: string): string | undefined => {
  const target = parseTelegramTargetForTest(raw);
  if (!target.chatId) {
    return undefined;
  }
  const normalizedTo = target.chatId.toLowerCase();
  return target.messageThreadId == null
    ? `telegram:${normalizedTo}`
    : `telegram:${normalizedTo}:topic:${target.messageThreadId}`;
});

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  extractDeliveryInfoMock.mockReset();
  extractDeliveryInfoMock.mockReturnValue({ deliveryContext: undefined, threadId: undefined });
  normalizeTelegramTargetForDeliveryTest.mockClear();
  vi.mocked(readChannelAllowFromStoreEntriesSync).mockReset();
  vi.mocked(readChannelAllowFromStoreEntriesSync).mockReturnValue([]);
  vi.mocked(resolveOutboundTarget).mockReset();
  vi.mocked(loadSessionStore).mockReset().mockReturnValue({});
  vi.mocked(readSessionEntry).mockReset().mockReturnValue(undefined);
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "forum",
        plugin: createOutboundTestPlugin({
          id: "forum",
          outbound: createStubOutbound("Forum"),
          messaging: forumMessagingForTest,
        }),
        source: "test",
      },
      {
        pluginId: "telegram",
        plugin: createOutboundTestPlugin({
          id: "telegram",
          outbound: createStubOutbound("Telegram"),
          messaging: {
            ...telegramMessagingForTest,
            normalizeTarget: normalizeTelegramTargetForDeliveryTest,
          },
        }),
        source: "test",
      },
      {
        pluginId: "signal",
        plugin: createOutboundTestPlugin({
          id: "signal",
          outbound: createStubOutbound("Signal"),
          messaging: {
            targetPrefixes: ["signal"],
            inferTargetChatType: ({ to }) =>
              to
                .replace(/^signal:/i, "")
                .trim()
                .toLowerCase()
                .startsWith("group:")
                ? "group"
                : "direct",
            resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
              const stripped = target.replace(/^signal:/i, "").trim();
              const isGroup = stripped.toLowerCase().startsWith("group:");
              const peerId = isGroup ? stripped.slice("group:".length).trim() : stripped;
              return buildChannelOutboundSessionRoute({
                cfg,
                agentId,
                channel: "signal",
                accountId,
                peer: { kind: isGroup ? "group" : "direct", id: peerId },
                chatType: isGroup ? "group" : "direct",
                from: isGroup ? `group:${peerId}` : `signal:${peerId}`,
                to: isGroup ? `group:${peerId}` : `signal:${peerId}`,
              });
            },
          },
        }),
        source: "test",
      },
      {
        pluginId: "alpha",
        plugin: {
          ...createOutboundTestPlugin({
            id: "alpha",
            outbound: createAllowlistAwareStubOutbound("Alpha"),
          }),
          config: {
            listAccountIds: () => [],
            resolveAccount: () => ({}),
            resolveAllowFrom: ({ cfg }: { cfg: OpenClawConfig }) =>
              (cfg.channels?.alpha as { allowFrom?: string[] } | undefined)?.allowFrom,
          },
        },
        source: "test",
      },
    ]),
  );
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

function makeCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    bindings: [],
    channels: {},
    ...overrides,
  } as OpenClawConfig;
}

function makeForumBoundCfg(accountId = "account-b"): OpenClawConfig {
  return makeCfg({
    bindings: [
      {
        agentId: AGENT_ID,
        match: { channel: "forum", accountId },
      },
    ],
  });
}

const AGENT_ID = "agent-b";
const DEFAULT_TARGET = {
  channel: "forum" as const,
  to: "room:default",
};

type SessionStore = ReturnType<typeof loadSessionStore>;

function setSessionStore(store: SessionStore) {
  vi.mocked(loadSessionStore).mockReturnValue(store);
  vi.mocked(readSessionEntry).mockImplementation((_storePath, sessionKey) => store[sessionKey]);
}

function setMainSessionEntry(entry?: SessionStore[string]) {
  const store = entry ? ({ "agent:test:main": entry } as SessionStore) : ({} as SessionStore);
  setSessionStore(store);
}

function setLastSessionEntry(params: {
  sessionId: string;
  lastChannel: string;
  lastTo: string;
  lastThreadId?: string;
  lastAccountId?: string;
}) {
  setMainSessionEntry({
    sessionId: params.sessionId,
    updatedAt: 1000,
    lastChannel: params.lastChannel,
    lastTo: params.lastTo,
    ...(params.lastThreadId ? { lastThreadId: params.lastThreadId } : {}),
    ...(params.lastAccountId ? { lastAccountId: params.lastAccountId } : {}),
  });
}

function setStoredAlphaAllowFrom(allowFrom: string[]) {
  vi.mocked(readChannelAllowFromStoreEntriesSync).mockReturnValue(allowFrom);
}

async function resolveForAgent(params: {
  cfg: OpenClawConfig;
  target?: { channel?: "last" | "forum" | "alpha"; to?: string };
}) {
  const channel = params.target ? params.target.channel : DEFAULT_TARGET.channel;
  const to = params.target && "to" in params.target ? params.target.to : DEFAULT_TARGET.to;
  return resolveDeliveryTarget(params.cfg, AGENT_ID, {
    channel,
    to,
  });
}

async function resolveLastTarget(cfg: OpenClawConfig) {
  return resolveForAgent({
    cfg,
    target: { channel: "last", to: undefined },
  });
}

describe("resolveDeliveryTarget", () => {
  it("uses session-entry snapshot reads for implicit last delivery lookup", async () => {
    setLastSessionEntry({
      sessionId: "sess-w1",
      lastChannel: "alpha",
      lastTo: "room-allowed",
    });

    const result = await resolveLastTarget(makeCfg({ channels: { alpha: { allowFrom: [] } } }));

    expect(result.channel).toBe("alpha");
    expect(result.to).toBe("room-allowed");
    expect(readSessionEntry).toHaveBeenCalledWith("/tmp/test-store.json", "agent:test:main");
    expect(loadSessionStore).not.toHaveBeenCalled();
  });

  it("reroutes implicit delivery to an authorized allowFrom recipient", async () => {
    setLastSessionEntry({
      sessionId: "sess-w1",
      lastChannel: "alpha",
      lastTo: "room-denied",
    });

    const cfg = makeCfg({ bindings: [], channels: { alpha: { allowFrom: ["room-allowed"] } } });
    const result = await resolveLastTarget(cfg);

    expect(result.channel).toBe("alpha");
    expect(result.to).toBe("room-allowed");
  });

  it("applies allowFrom rerouting to dry-run delivery previews", async () => {
    setLastSessionEntry({
      sessionId: "sess-preview",
      lastChannel: "alpha",
      lastTo: "room-denied",
    });

    const cfg = makeCfg({ bindings: [], channels: { alpha: { allowFrom: ["room-allowed"] } } });
    const result = await resolveDeliveryTarget(
      cfg,
      AGENT_ID,
      {
        channel: "last",
        to: undefined,
      },
      { dryRun: true },
    );

    expect(result.channel).toBe("alpha");
    expect(result.to).toBe("room-allowed");
  });

  it("keeps explicit delivery target unchanged", async () => {
    setLastSessionEntry({
      sessionId: "sess-w2",
      lastChannel: "alpha",
      lastTo: "room-denied",
    });
    setStoredAlphaAllowFrom(["room-allowed"]);

    const cfg = makeCfg({ bindings: [], channels: { alpha: { allowFrom: [] } } });
    const result = await resolveDeliveryTarget(cfg, AGENT_ID, {
      channel: "alpha",
      to: "room-denied",
    });

    expect(result.to).toBe("room-denied");
  });

  it("does not use pairing-store entries as implicit automation recipients", async () => {
    setMainSessionEntry(undefined);
    setStoredAlphaAllowFrom(["room-paired"]);

    const cfg = makeCfg({ bindings: [], channels: { alpha: { allowFrom: [] } } });
    const result = await resolveLastTarget(cfg);

    expect(result.ok).toBe(false);
    expect(result.channel).toBe("alpha");
    expect(result.to).toBeUndefined();
    expect(readChannelAllowFromStoreEntriesSync).not.toHaveBeenCalled();
  });

  it("falls back to bound accountId when session has no lastAccountId", async () => {
    setMainSessionEntry(undefined);
    const cfg = makeForumBoundCfg();
    const result = await resolveForAgent({ cfg });

    expect(result.accountId).toBe("account-b");
  });

  it("preserves binding order when peerless delivery falls back to a bound accountId", async () => {
    setMainSessionEntry(undefined);
    const cfg = makeCfg({
      bindings: [
        {
          agentId: AGENT_ID,
          match: {
            channel: "forum",
            peer: { kind: "channel", id: "room:default" },
            accountId: "peer-first",
          },
        },
        {
          agentId: AGENT_ID,
          match: { channel: "forum", accountId: "channel-second" },
        },
      ],
    });

    const result = await resolveForAgent({ cfg });

    expect(result.accountId).toBe("peer-first");
  });

  it("does not infer scoped bound accountId for peerless cron delivery", async () => {
    setMainSessionEntry(undefined);
    const cfg = makeCfg({
      bindings: [
        {
          agentId: AGENT_ID,
          match: {
            channel: "forum",
            guildId: "guild-1",
            accountId: "tenant-account",
          },
        },
      ],
    });

    const result = await resolveForAgent({ cfg });

    expect(result.accountId).toBeUndefined();
  });

  it("preserves session lastAccountId when present", async () => {
    setMainSessionEntry({
      sessionId: "sess-1",
      updatedAt: 1000,
      lastChannel: "forum",
      lastTo: "room:default",
      lastAccountId: "session-account",
    });

    const cfg = makeForumBoundCfg();
    const result = await resolveForAgent({ cfg });

    // Session-derived accountId should take precedence over binding
    expect(result.accountId).toBe("session-account");
  });

  it("returns undefined accountId when no binding and no session", async () => {
    setMainSessionEntry(undefined);

    const cfg = makeCfg({ bindings: [] });

    const result = await resolveForAgent({ cfg });

    expect(result.accountId).toBeUndefined();
  });

  it("applies id-like target normalization before returning delivery targets", async () => {
    setMainSessionEntry(undefined);
    vi.mocked(maybeResolveIdLikeTarget).mockClear();
    vi.mocked(maybeResolveIdLikeTarget).mockResolvedValueOnce({
      to: "user:123456789",
      kind: "user",
      source: "directory",
    });

    const cfg = makeCfg({ bindings: [] });
    const result = await resolveDeliveryTarget(cfg, AGENT_ID, {
      channel: "forum",
      to: "123456789",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("user:123456789");
    expect(maybeResolveIdLikeTarget).toHaveBeenCalledWith({
      cfg,
      channel: "forum",
      input: "123456789",
      accountId: undefined,
    });
  });

  it("fails ambiguous directory targets instead of picking a best match", async () => {
    setMainSessionEntry(undefined);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "alpha",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({
              id: "alpha",
              outbound: createStubOutbound("Alpha"),
              messaging: { targetPrefixes: ["alpha"] },
            }),
            directory: {
              listGroups: async () => [
                { id: "channel:ops-a", name: "ops", rank: 1 },
                { id: "channel:ops-b", name: "ops", rank: 2 },
              ],
            },
          },
        },
      ]),
    );

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "alpha",
      to: "ops",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected ambiguous target error");
    }
    expect(result.error.message).toContain("Ambiguous");
  });

  it("surfaces target resolver exceptions instead of treating raw names as resolved", async () => {
    setMainSessionEntry(undefined);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "alpha",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({
              id: "alpha",
              outbound: createStubOutbound("Alpha"),
              messaging: { targetPrefixes: ["alpha"] },
            }),
            directory: {
              listGroups: async () => {
                throw new Error("directory auth failed");
              },
            },
          },
        },
      ]),
    );

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "alpha",
      to: "ops",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected target resolver error");
    }
    expect(result.error.message).toContain("directory auth failed");
  });

  it("keeps parser-derived explicit thread ids for parser-only cron targets", async () => {
    setMainSessionEntry(undefined);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "alpha",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "alpha",
            outbound: createStubOutbound("Alpha"),
            messaging: {
              targetPrefixes: ["alpha"],
              parseExplicitTarget: ({ raw }) =>
                raw === "alpha:room-a:topic:77"
                  ? { to: "room-a", threadId: 77, chatType: "group" as const }
                  : null,
            },
          }),
        },
      ]),
    );

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "alpha",
      to: "alpha:room-a:topic:77",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("room-a");
    expect(result.threadId).toBe(77);
  });

  it("does not treat parser-only target normalization as a parser thread id", async () => {
    setLastSessionEntry({
      sessionId: "sess-parser-stale-thread",
      lastChannel: "alpha",
      lastTo: "room-a",
      lastThreadId: "stale-thread",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "alpha",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "alpha",
            outbound: createStubOutbound("Alpha"),
            messaging: {
              targetPrefixes: ["alpha"],
              parseExplicitTarget: ({ raw }) =>
                raw === "alpha:room-b" ? { to: "room-b", chatType: "group" as const } : null,
            },
          }),
        },
      ]),
    );

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "alpha",
      to: "alpha:room-b",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("room-b");
    expect(result.threadId).toBeUndefined();
  });

  it("uses canonical route targets even when the route has no thread", async () => {
    setMainSessionEntry(undefined);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "alpha",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "alpha",
            outbound: createStubOutbound("Alpha"),
            messaging: {
              targetPrefixes: ["alpha"],
              inferTargetChatType: ({ to }) => (to.startsWith("group:") ? "group" : "direct"),
              resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
                const stripped = target.replace(/^alpha:/i, "");
                return buildChannelOutboundSessionRoute({
                  cfg,
                  agentId,
                  channel: "alpha",
                  accountId,
                  peer: { kind: "group", id: stripped.replace(/^group:/i, "") },
                  chatType: "group",
                  from: `alpha:${stripped}`,
                  to: stripped.replace(/^group:/i, ""),
                });
              },
            },
          }),
        },
      ]),
    );

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "alpha",
      to: "alpha:group:room-a",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("room-a");
    expect(result.threadId).toBeUndefined();
  });

  it("keeps provider-qualified normalized targets for provider route parsing", async () => {
    setMainSessionEntry(undefined);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: createStubOutbound("Telegram"),
            messaging: {
              targetPrefixes: ["telegram"],
              normalizeTarget: () => "telegram:group:-100200300:topic:77",
              resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
                const match = /^telegram:group:(-?\d+):topic:(\d+)$/i.exec(target);
                const chatId = match?.[1] ?? target;
                const threadId = match?.[2] ? Number.parseInt(match[2], 10) : undefined;
                return buildChannelOutboundSessionRoute({
                  cfg,
                  agentId,
                  channel: "telegram",
                  accountId,
                  peer: { kind: "group", id: chatId },
                  chatType: "group",
                  from: `telegram:group:${chatId}`,
                  to: chatId,
                  ...(threadId != null ? { threadId } : {}),
                });
              },
            },
          }),
        },
      ]),
    );

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "telegram",
      to: "telegram:group:-100200300:topic:77",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("-100200300");
    expect(result.threadId).toBe(77);
  });

  it("ignores stale previous-route parse failures for explicit cron targets", async () => {
    setLastSessionEntry({
      sessionId: "sess-stale-route",
      lastChannel: "alpha",
      lastTo: "bad:stored:target",
      lastThreadId: "old-thread",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "alpha",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "alpha",
            outbound: createStubOutbound("Alpha"),
            messaging: {
              targetPrefixes: ["alpha"],
              resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
                if (target === "bad:stored:target") {
                  throw new Error("stale route parse failed");
                }
                const stripped = target.replace(/^alpha:/i, "");
                return buildChannelOutboundSessionRoute({
                  cfg,
                  agentId,
                  channel: "alpha",
                  accountId,
                  peer: { kind: "group", id: stripped },
                  chatType: "group",
                  from: `alpha:group:${stripped}`,
                  to: stripped,
                });
              },
            },
          }),
        },
      ]),
    );

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "alpha",
      to: "alpha:room-a",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("room-a");
    expect(result.threadId).toBeUndefined();
  });

  it("keeps cron route canonicalization best-effort when explicit route resolution fails", async () => {
    setMainSessionEntry(undefined);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "alpha",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "alpha",
            outbound: createStubOutbound("Alpha"),
            messaging: {
              targetPrefixes: ["alpha"],
              inferTargetChatType: () => "group",
              resolveOutboundSessionRoute: () => {
                throw new Error("route lookup failed");
              },
            },
          }),
        },
      ]),
    );

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "alpha",
      to: "room-a",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("room-a");
    expect(result.threadId).toBeUndefined();
  });

  it("uses target resolution for dry-run delivery previews", async () => {
    setMainSessionEntry(undefined);
    vi.mocked(maybeResolveIdLikeTarget).mockClear();

    const result = await resolveDeliveryTarget(
      makeCfg({ bindings: [] }),
      AGENT_ID,
      {
        channel: "forum",
        to: "123456789",
      },
      { dryRun: true },
    );

    expect(result.ok).toBe(true);
    expect(result.to).toBe("123456789");
    expect(maybeResolveIdLikeTarget).toHaveBeenCalledWith({
      cfg: makeCfg({ bindings: [] }),
      channel: "forum",
      input: "123456789",
      accountId: undefined,
    });
  });

  it("falls back to the runtime target resolver when the channel plugin is not already loaded", async () => {
    setMainSessionEntry(undefined);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "alpha",
          plugin: createOutboundTestPlugin({
            id: "alpha",
            outbound: createStubOutbound("Alpha"),
          }),
          source: "test",
        },
      ]),
    );
    vi.mocked(resolveOutboundTarget).mockReturnValueOnce({ ok: true, to: "room:default" });

    const cfg = makeCfg({ bindings: [] });
    const result = await resolveDeliveryTarget(cfg, AGENT_ID, {
      channel: "forum",
      to: "room:default",
    });

    expect(result).toEqual({
      ok: true,
      channel: "forum",
      to: "room:default",
      accountId: undefined,
      threadId: undefined,
      mode: "explicit",
    });
    expect(resolveOutboundTarget).toHaveBeenCalledWith({
      channel: "forum",
      to: "room:default",
      cfg,
      accountId: undefined,
      mode: "explicit",
      allowFrom: undefined,
      allowBootstrap: true,
    });
  });

  it("returns an unresolved target when loaded target resolution throws", async () => {
    setMainSessionEntry(undefined);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "alpha",
          plugin: createOutboundTestPlugin({
            id: "alpha",
            outbound: {
              deliveryMode: "gateway",
              resolveTarget: () => {
                throw new Error("target normalizer exploded");
              },
            },
          }),
          source: "test",
        },
      ]),
    );

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "alpha",
      to: "room:default",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected invalid delivery target");
    }
    expect(result.error.message).toContain("Invalid delivery target: target normalizer exploded");
  });

  it("returns an unresolved target when the shared prefix guard rejects the explicit target", async () => {
    setMainSessionEntry(undefined);
    const resolveTarget = vi.fn(() => ({ ok: true as const, to: "telegram:1234567890" }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "alpha",
          plugin: createOutboundTestPlugin({
            id: "alpha",
            outbound: {
              deliveryMode: "gateway",
              resolveTarget,
            },
          }),
          source: "test",
        },
        {
          pluginId: "telegram",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: createStubOutbound("Telegram"),
            messaging: telegramMessagingForTest,
          }),
          source: "test",
        },
      ]),
    );

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "alpha",
      to: "telegram:1234567890",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected invalid delivery target");
    }
    expect(result.error.message).toContain("belongs to telegram, not alpha");
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it("selects correct binding when multiple agents have bindings", async () => {
    setMainSessionEntry(undefined);

    const cfg = makeCfg({
      bindings: [
        {
          agentId: "agent-a",
          match: { channel: "forum", accountId: "account-a" },
        },
        {
          agentId: "agent-b",
          match: { channel: "forum", accountId: "account-b" },
        },
      ],
    });

    const result = await resolveForAgent({ cfg });

    expect(result.accountId).toBe("account-b");
  });

  it("ignores bindings for different channels", async () => {
    setMainSessionEntry(undefined);

    const cfg = makeCfg({
      bindings: [
        {
          agentId: "agent-b",
          match: { channel: "alpha", accountId: "alpha-account" },
        },
      ],
    });

    const result = await resolveForAgent({ cfg });

    expect(result.accountId).toBeUndefined();
  });

  it("drops session threadId when destination does not match the previous recipient", async () => {
    setLastSessionEntry({
      sessionId: "sess-2",
      lastChannel: "forum",
      lastTo: "room:other",
      lastThreadId: "thread-1",
    });

    const result = await resolveForAgent({ cfg: makeCfg({ bindings: [] }) });
    expect(result.threadId).toBeUndefined();
  });

  it("keeps session threadId when destination matches the previous recipient", async () => {
    setLastSessionEntry({
      sessionId: "sess-3",
      lastChannel: "forum",
      lastTo: "room:default",
      lastThreadId: "thread-2",
    });

    const result = await resolveForAgent({ cfg: makeCfg({ bindings: [] }) });
    expect(result.threadId).toBe("thread-2");
  });

  it("does not carry a Telegram topic threadId to a bare explicit group target", async () => {
    setLastSessionEntry({
      sessionId: "sess-telegram-topic",
      lastChannel: "telegram",
      lastTo: "-100200300:topic:77",
      lastThreadId: "77",
    });
    normalizeTelegramTargetForDeliveryTest.mockClear();

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "telegram",
      to: "-100200300",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("-100200300");
    expect(result.threadId).toBeUndefined();
    expect(normalizeTelegramTargetForDeliveryTest).toHaveBeenCalledWith("-100200300");
  });

  it("surfaces target normalization failures instead of using a raw fallback", async () => {
    setLastSessionEntry({
      sessionId: "sess-telegram-topic-invalid",
      lastChannel: "telegram",
      lastTo: "-100200300:topic:77",
      lastThreadId: "77",
    });
    normalizeTelegramTargetForDeliveryTest.mockImplementationOnce(() => {
      throw new Error("target normalizer exploded");
    });

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "telegram",
      to: "-100200300",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected target normalization error");
    }
    expect(result.error.message).toContain("target normalizer exploded");
  });

  it("drops a session Telegram topic threadId when a bare explicit target names a different chat", async () => {
    setLastSessionEntry({
      sessionId: "sess-telegram-topic-stale",
      lastChannel: "telegram",
      lastTo: "-100200300:topic:77",
      lastThreadId: "77",
    });

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "telegram",
      to: "-100999999",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("-100999999");
    expect(result.threadId).toBeUndefined();
  });

  it("uses single configured channel when neither explicit nor session channel exists", async () => {
    setMainSessionEntry(undefined);

    const result = await resolveLastTarget(makeCfg({ bindings: [] }));
    expect(result.channel).toBe("alpha");
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected unresolved delivery target");
    }
    // resolveOutboundTarget provides the standard missing-target error when
    // no explicit target, no session lastTo, and no plugin resolveDefaultTo.
    expect(result.error.message).toContain("requires target");
  });

  it("uses provider-prefixed explicit target instead of fallback channel for delivery.channel=last", async () => {
    setMainSessionEntry(undefined);
    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "last",
      to: "telegram:1234567890",
    });

    expect(result.ok).toBe(true);
    expect(result.channel).toBe("telegram");
    expect(result.to).toBe("1234567890");
  });

  it("rejects provider-prefixed explicit targets without a recipient", async () => {
    setMainSessionEntry(undefined);
    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "last",
      to: "telegram:",
    });

    expect(result.ok).toBe(false);
    expect(result.channel).toBe("telegram");
    expect(result.to).toBeUndefined();
    if (result.ok) {
      throw new Error("expected missing target error");
    }
    expect(result.error.message).toContain("Target is required");
  });

  it("returns an error when channel selection is ambiguous", async () => {
    setMainSessionEntry(undefined);
    vi.mocked(resolveMessageChannelSelection).mockRejectedValueOnce(
      new Error("Channel is required when multiple channels are configured: alpha, forum"),
    );

    const result = await resolveLastTarget(makeCfg({ bindings: [] }));
    expect(result.channel).toBeUndefined();
    expect(result.to).toBeUndefined();
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected ambiguous channel selection error");
    }
    expect(result.error.message).toContain("Channel is required");
  });

  it("uses sessionKey thread entry before main session entry", async () => {
    setSessionStore({
      "agent:test:main": {
        sessionId: "main-session",
        updatedAt: 1000,
        lastChannel: "forum",
        lastTo: "main-chat",
      },
      "agent:test:thread:42": {
        sessionId: "thread-session",
        updatedAt: 2000,
        lastChannel: "forum",
        lastTo: "thread-chat",
        lastThreadId: 42,
      },
    } as SessionStore);

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "last",
      sessionKey: "agent:test:thread:42",
      to: undefined,
    });

    expect(result.channel).toBe("forum");
    expect(result.to).toBe("thread-chat");
    expect(result.threadId).toBe(42);
  });

  it("prefers stored deliveryContext lookup over exact session-store entries", async () => {
    extractDeliveryInfoMock.mockReturnValueOnce({
      deliveryContext: {
        channel: "alpha",
        to: "RoomMixedCase",
        accountId: "primary",
        threadId: "thread-old-stored",
      },
      threadId: "thread-stored",
    });
    setSessionStore({
      "agent:test:thread:42": {
        sessionId: "thread-session",
        updatedAt: 2000,
        lastChannel: "alpha",
        lastTo: "room-lowercase",
        lastThreadId: "thread-old",
      },
    } as SessionStore);

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "last",
      sessionKey: "agent:test:thread:42",
      to: undefined,
    });

    expect(result).toMatchObject({
      ok: true,
      channel: "alpha",
      to: "RoomMixedCase",
      accountId: "primary",
      threadId: "thread-stored",
    });
  });

  it("scopes unqualified stored delivery lookups to the job agent", async () => {
    extractDeliveryInfoMock.mockImplementation((sessionKey: string) =>
      sessionKey === "agent:agent-b:main"
        ? {
            deliveryContext: {
              channel: "alpha",
              to: "ops-room",
            },
            threadId: undefined,
          }
        : {
            deliveryContext: {
              channel: "alpha",
              to: "default-room",
            },
            threadId: undefined,
          },
    );

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "last",
      sessionKey: "main",
      to: undefined,
    });

    expect(extractDeliveryInfoMock).toHaveBeenCalledWith("agent:agent-b:main", {
      cfg: expect.any(Object),
    });
    expect(result).toMatchObject({
      ok: true,
      channel: "alpha",
      to: "ops-room",
    });
  });

  it("falls back to the main session entry when the requested sessionKey is missing", async () => {
    setSessionStore({
      "agent:test:main": {
        sessionId: "main-session",
        updatedAt: 1000,
        lastChannel: "forum",
        lastTo: "main-chat",
      },
    } as SessionStore);

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "last",
      sessionKey: "agent:test:thread:missing",
      to: undefined,
    });

    expect(result.channel).toBe("forum");
    expect(result.to).toBe("main-chat");
  });

  it("uses main session channel when channel=last and session route exists", async () => {
    setLastSessionEntry({
      sessionId: "sess-4",
      lastChannel: "forum",
      lastTo: "room:default",
    });

    const result = await resolveLastTarget(makeCfg({ bindings: [] }));

    expect(result.channel).toBe("forum");
    expect(result.to).toBe("room:default");
    expect(result.ok).toBe(true);
  });

  it("parses explicit plugin topic targets into delivery threadId", async () => {
    setMainSessionEntry(undefined);

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "forum",
      to: "room:ops:topic:1008013",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("room:ops");
    expect(result.threadId).toBe(1008013);
  });

  it("keeps semantic group prefixes for provider route resolution", async () => {
    setMainSessionEntry(undefined);

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "signal",
      to: "signal:group:ops",
    });

    expect(result.ok).toBe(true);
    expect(result.channel).toBe("signal");
    expect(result.to).toBe("group:ops");
    expect(result.threadId).toBeUndefined();
  });

  it("keeps explicit delivery threadId on first run without session history", async () => {
    setMainSessionEntry(undefined);

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "forum",
      to: "room:ops",
      threadId: "1008013",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("room:ops");
    expect(result.threadId).toBe("1008013");
  });

  it("explicit delivery.accountId overrides session-derived accountId", async () => {
    setLastSessionEntry({
      sessionId: "sess-5",
      lastChannel: "forum",
      lastTo: "room:ops",
      lastAccountId: "default",
    });

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "forum",
      to: "room:ops",
      accountId: "bot-b",
    });

    expect(result.ok).toBe(true);
    expect(result.accountId).toBe("bot-b");
  });

  it("strips :topic: suffix from telegram targets when threadId is resolved", async () => {
    setMainSessionEntry(undefined);

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "telegram",
      to: "63448508:topic:1008013",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("63448508");
    expect(result.threadId).toBe(1008013);
  });

  it("parses plugin-owned numeric topic shorthand into delivery threadId", async () => {
    setMainSessionEntry(undefined);

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "telegram",
      to: "-100200300:77",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("-100200300");
    expect(result.threadId).toBe(77);
  });

  it("resolves plugin default targets through the modern target route", async () => {
    setMainSessionEntry(undefined);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: {
            ...createOutboundTestPlugin({
              id: "telegram",
              outbound: createStubOutbound("Telegram"),
              messaging: {
                ...telegramMessagingForTest,
                normalizeTarget: normalizeTelegramTargetForDeliveryTest,
              },
            }),
            config: {
              listAccountIds: () => [],
              resolveAccount: () => ({}),
              resolveDefaultTo: () => "-100200300:77",
            },
          },
          source: "test",
        },
      ]),
    );

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "telegram",
      to: undefined,
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("-100200300");
    expect(result.threadId).toBe(77);
  });

  it("prefers explicit telegram :topic: targets over session-derived threadId", async () => {
    setLastSessionEntry({
      sessionId: "sess-telegram-topic",
      lastChannel: "telegram",
      lastTo: "63448508:topic:1008013",
      lastThreadId: "stale-thread",
    });

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "telegram",
      to: "63448508:topic:1008013",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("63448508");
    expect(result.threadId).toBe(1008013);
  });

  it("keeps explicit delivery threadId when stripping telegram :topic: targets", async () => {
    setMainSessionEntry(undefined);

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "telegram",
      to: "63448508:topic:1008013",
      threadId: "42",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("63448508");
    expect(result.threadId).toBe("42");
  });

  it("explicit delivery.accountId overrides bindings-derived accountId", async () => {
    setMainSessionEntry(undefined);
    const cfg = makeCfg({
      bindings: [{ agentId: AGENT_ID, match: { channel: "forum", accountId: "bound" } }],
    });

    const result = await resolveDeliveryTarget(cfg, AGENT_ID, {
      channel: "forum",
      to: "room:ops",
      accountId: "explicit",
    });

    expect(result.ok).toBe(true);
    expect(result.accountId).toBe("explicit");
  });
});
