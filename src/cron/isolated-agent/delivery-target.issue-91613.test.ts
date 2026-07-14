// Issue #91613 regression: an implicit/keyless isolated cron must NOT inherit its delivery target
// from the SHARED agent-main session bucket's last recipient (a cross-conversation, last-writer-wins
// value that drains replies to the wrong room and replays there after a restart). It must refuse;
// crons carrying an explicit target / their own delivery context are unaffected.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  forumMessagingForTest,
  parseTelegramTargetForTest,
  telegramMessagingForTest,
} from "../../infra/outbound/targets.test-helpers.js";
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

vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: vi.fn(),
}));

vi.mock("../../infra/outbound/channel-selection.runtime.js", () => ({
  resolveMessageChannelSelection: vi
    .fn()
    .mockResolvedValue({ channel: "alpha", configured: ["alpha"] }),
}));

vi.mock("../../infra/outbound/target-id-resolution.js", () => ({
  maybeResolveIdLikeTarget: vi.fn(),
}));

vi.mock("../../infra/outbound/targets.runtime.js", () => ({
  resolveOutboundTarget: vi.fn(),
}));
const mockedModuleIds = [
  "../../config/sessions/main-session.js",
  "../../config/sessions/delivery-info.js",
  "../../config/sessions/paths.js",
  "../../config/sessions/session-accessor.js",
  "../../infra/outbound/channel-selection.runtime.js",
  "../../infra/outbound/targets.runtime.js",
  "../../infra/outbound/target-id-resolution.js",
];

import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.runtime.js";
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
  vi.mocked(resolveOutboundTarget).mockReset();
  vi.mocked(loadSessionEntry).mockReset().mockReturnValue(undefined);
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

const AGENT_ID = "agent-b";

type SessionStore = Record<string, SessionEntry>;

function setSessionStore(store: SessionStore) {
  vi.mocked(loadSessionEntry).mockImplementation(({ sessionKey }) => store[sessionKey]);
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

async function resolveLastTarget(cfg: OpenClawConfig) {
  // Implicit/keyless cron: delivery.channel="last", no per-job target, no sessionKey.
  return resolveDeliveryTarget(cfg, AGENT_ID, { channel: "last", to: undefined });
}

describe("resolveDeliveryTarget — issue #91613 cross-room drain fix", () => {
  it("REFUSES implicit/keyless isolated-cron delivery inherited from the SHARED agent-main bucket's last recipient", async () => {
    // A DIFFERENT conversation last wrote the single shared agent-main bucket, leaving its room
    // as lastTo — a cross-conversation, last-writer-wins value.
    setLastSessionEntry({
      sessionId: "sess-other-conversation",
      lastChannel: "alpha",
      lastTo: "room:other-peer-dm",
    });

    const result = await resolveLastTarget(makeCfg({ channels: { alpha: {} } }));

    // The resolver returns ok:false so EVERY consumer (delivery dispatch, failure notification,
    // delivery preview) refuses uniformly — the inherited cross-conversation target is never
    // delivered, and (because nothing is enqueued) never replayed after a restart.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("shared");
      expect(result.error.message).toContain("wrong room");
    }
    expect(loadSessionEntry).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      sessionKey: "agent:test:main",
      storePath: "/tmp/test-store.json",
    });
  });

  it("REFUSES a channel-only keyless cron whose `to` is still inherited from the shared bucket", async () => {
    // Scope decision (needs-product-decision surface): pinning delivery.channel but NOT delivery.to
    // still leaves the ROOM inherited from the shared bucket — same cross-conversation drain — so it
    // is refused too. The operator must also pin delivery.to.
    setLastSessionEntry({
      sessionId: "sess-other-conversation",
      lastChannel: "alpha",
      lastTo: "room:other-peer-dm",
    });

    const result = await resolveDeliveryTarget(makeCfg({ channels: { alpha: {} } }), AGENT_ID, {
      channel: "alpha",
      to: undefined,
    });

    expect(result.ok).toBe(false);
  });

  it("control: an isolated cron carrying its OWN explicit target is delivered, not refused", async () => {
    // Same poisoned shared bucket...
    setLastSessionEntry({
      sessionId: "sess-other-conversation",
      lastChannel: "alpha",
      lastTo: "room:other-peer-dm",
    });

    // ...but this cron supplies its own explicit channel+target.
    const result = await resolveDeliveryTarget(makeCfg({ channels: { alpha: {} } }), AGENT_ID, {
      channel: "alpha",
      to: "room:cron-own",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.to).toBe("room:cron-own");
    }
  });

  it("negative: a KEYED cron (its own sessionKey) is NOT refused even when it falls back to the main entry", async () => {
    // Same poisoned shared bucket, but this cron carries its own session key. `!rawSessionKey` is
    // false, so the refusal never applies — keyed crons resolve via their own session identity and
    // are out of scope for the keyless-inherited refusal.
    setLastSessionEntry({
      sessionId: "sess-other-conversation",
      lastChannel: "alpha",
      lastTo: "room:keyed-fallback",
    });

    const result = await resolveDeliveryTarget(makeCfg({ channels: { alpha: {} } }), AGENT_ID, {
      channel: "last",
      to: undefined,
      sessionKey: "agent:test:thread:missing",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.to).toBe("room:keyed-fallback");
    }
  });

  it("negative: a keyless cron rerouted by allowFrom to an allowed peer is delivered, not refused", async () => {
    // The shared bucket's stale lastTo ("room:denied") is OUTSIDE the channel allowFrom policy, so
    // the resolver reroutes delivery to the configured allowed peer. Because the final target
    // (`toCandidate`) is no longer the inherited lastTo, the cron delivers to the operator-allowed
    // peer rather than being refused.
    setLastSessionEntry({
      sessionId: "sess-other-conversation",
      lastChannel: "alpha",
      lastTo: "room:denied",
    });

    const result = await resolveDeliveryTarget(
      makeCfg({ channels: { alpha: { allowFrom: ["room:allowed"] } } }),
      AGENT_ID,
      { channel: "last", to: undefined },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.to).toBe("room:allowed");
    }
  });
});
