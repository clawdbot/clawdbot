import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  forumMessagingForTest,
  telegramMessagingForTest,
} from "../../infra/outbound/targets.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";

vi.mock("../../config/sessions/main-session.js", () => ({
  resolveAgentMainSessionKey: vi.fn().mockReturnValue("agent:test:main"),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store.json"),
}));

vi.mock("../../config/sessions/store-load.js", () => ({
  loadSessionStore: vi.fn().mockReturnValue({}),
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
  "../../config/sessions/paths.js",
  "../../config/sessions/store-load.js",
  "../../infra/outbound/channel-selection.runtime.js",
  "../../infra/outbound/targets.runtime.js",
  "../../infra/outbound/target-id-resolution.js",
  "../../pairing/allow-from-store-read.js",
];

import { loadSessionStore } from "../../config/sessions/store-load.js";
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
  const target = telegramMessagingForTest.parseExplicitTarget?.({ raw });
  if (!target?.to) {
    return undefined;
  }
  const normalizedTo = target.to.toLowerCase();
  return target.threadId == null
    ? `telegram:${normalizedTo}`
    : `telegram:${normalizedTo}:topic:${target.threadId}`;
});

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  normalizeTelegramTargetForDeliveryTest.mockClear();
  vi.mocked(readChannelAllowFromStoreEntriesSync).mockReset();
  vi.mocked(readChannelAllowFromStoreEntriesSync).mockReturnValue([]);
  vi.mocked(resolveOutboundTarget).mockReset();
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

  it("skips id-like target normalization for dry-run delivery previews", async () => {
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
    expect(maybeResolveIdLikeTarget).not.toHaveBeenCalled();
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

  it("keeps a session Telegram topic threadId when a bare explicit target matches the topic route", async () => {
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
    expect(result.threadId).toBe(77);
    expect(normalizeTelegramTargetForDeliveryTest).toHaveBeenCalledWith("-100200300");
    expect(normalizeTelegramTargetForDeliveryTest).toHaveBeenCalledWith("-100200300:topic:77");
  });

  it("drops carried threadId instead of throwing when target normalization fails", async () => {
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

    expect(result.ok).toBe(true);
    expect(result.to).toBe("-100200300");
    expect(result.threadId).toBeUndefined();
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
