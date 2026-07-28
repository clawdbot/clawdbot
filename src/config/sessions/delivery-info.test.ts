// Session delivery info tests cover persisted delivery metadata.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { parseSessionThreadInfo } from "./thread-info.js";
import type { SessionEntry, SessionOrigin } from "./types.js";

type SessionEntryFixture = SessionEntry & {
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  origin?: SessionOrigin;
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

const storeState = vi.hoisted(() => {
  const state = {
    store: {} as Record<string, SessionEntryFixture>,
    stores: {} as Record<string, Record<string, SessionEntryFixture>>,
    // Mirrors the accessor view contract: raw exact-key get, enumeration only via entries().
    openSessionEntryReadView: vi.fn((scope: { storePath?: string }) => {
      const store = state.stores[scope.storePath ?? ""] ?? state.store;
      return {
        get: (sessionKey: string) =>
          Object.hasOwn(store, sessionKey)
            ? normalizeLegacySessionEntryDelivery(store[sessionKey] as SessionEntry)
            : undefined,
        entries: () =>
          Object.entries(store).map(([sessionKey, entry]) => ({
            sessionKey,
            entry: normalizeLegacySessionEntryDelivery(entry),
          })),
      };
    }),
  };
  return state;
});

vi.mock("../io.js", () => ({
  getRuntimeConfig: () => ({}),
}));

vi.mock("./paths.js", () => ({
  resolveStorePath: (_store?: string, opts?: { agentId?: string }) =>
    opts?.agentId === "worker" ? "/tmp/worker-sessions.json" : "/tmp/sessions.json",
}));

vi.mock("./session-accessor.js", () => ({
  openSessionEntryReadView: storeState.openSessionEntryReadView,
}));

vi.mock("./targets.js", () => ({
  resolveAllAgentSessionStoreTargetsSync: () => [
    { agentId: "main", storePath: "/tmp/sessions.json" },
    { agentId: "shadow", storePath: "/tmp/shadow-sessions.json" },
    { agentId: "worker", storePath: "/tmp/worker-sessions.json" },
  ],
}));

let extractDeliveryInfo: typeof import("./delivery-info.js").extractDeliveryInfo;

const buildEntry = (deliveryContext: DeliveryContext): SessionEntryFixture => ({
  sessionId: "session-1",
  updatedAt: Date.now(),
  deliveryContext,
});

beforeAll(async () => {
  ({ extractDeliveryInfo } = await import("./delivery-info.js"));
});

beforeEach(() => {
  setActivePluginRegistry(createSessionConversationTestRegistry());
  storeState.store = {};
  storeState.stores = {};
  storeState.openSessionEntryReadView.mockClear();
});

describe("extractDeliveryInfo", () => {
  it("parses base session and thread/topic ids", () => {
    expect(parseSessionThreadInfo("agent:main:telegram:group:1:topic:55")).toEqual({
      baseSessionKey: "agent:main:telegram:group:1",
      threadId: "55",
    });
    expect(parseSessionThreadInfo("agent:main:slack:channel:C1:thread:123.456")).toEqual({
      baseSessionKey: "agent:main:slack:channel:C1",
      threadId: "123.456",
    });
    expect(
      parseSessionThreadInfo(
        "agent:main:matrix:channel:!room:example.org:thread:$AbC123:example.org",
      ),
    ).toEqual({
      baseSessionKey: "agent:main:matrix:channel:!room:example.org",
      threadId: "$AbC123:example.org",
    });
    expect(
      parseSessionThreadInfo(
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      ),
    ).toEqual({
      baseSessionKey:
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      threadId: undefined,
    });
    expect(parseSessionThreadInfo("agent:main:telegram:dm:user-1")).toEqual({
      baseSessionKey: "agent:main:telegram:dm:user-1",
      threadId: undefined,
    });
    expect(parseSessionThreadInfo(undefined)).toEqual({
      baseSessionKey: undefined,
      threadId: undefined,
    });
  });

  it("reads borrowed accessor views for direct session keys", () => {
    const sessionKey = "agent:main:telegram:dm:user-123";
    storeState.store[sessionKey] = buildEntry({
      channel: "telegram",
      to: "telegram:user-123",
      accountId: "default",
    });

    const result = extractDeliveryInfo(sessionKey);

    expect(result.deliveryContext?.to).toBe("telegram:user-123");
    expect(storeState.openSessionEntryReadView).toHaveBeenCalledWith({
      storePath: "/tmp/sessions.json",
    });
  });

  it("does not enumerate the store when an exact routable key is present", () => {
    const sessionKey = "agent:main:telegram:dm:user-123";
    // Enumeration trap: the accessor-view mock lists rows via Object.entries, so
    // building the normalized fallback index on this cheap path throws here and
    // extractDeliveryInfo would return no delivery context.
    storeState.store = new Proxy(
      {
        [sessionKey]: buildEntry({
          channel: "telegram",
          to: "telegram:user-123",
          accountId: "default",
        }),
      },
      {
        ownKeys() {
          throw new Error("normalized index should not be built");
        },
      },
    );

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "telegram:user-123",
        accountId: "default",
      },
      threadId: undefined,
    });
  });

  it("returns deliveryContext for direct session keys", () => {
    const sessionKey = "agent:main:telegram:dm:user-123";
    storeState.store[sessionKey] = buildEntry({
      channel: "telegram",
      to: "telegram:user-123",
      accountId: "default",
    });

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "telegram:user-123",
        accountId: "default",
      },
      threadId: undefined,
    });
  });

  it("falls back to base sessions for :thread: keys", () => {
    const baseKey = "agent:main:slack:channel:C0123ABC";
    const threadKey = `${baseKey}:thread:1234567890.123456`;
    storeState.store[baseKey] = buildEntry({
      channel: "slack",
      to: "slack:C0123ABC",
      accountId: "workspace-1",
    });

    const result = extractDeliveryInfo(threadKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "slack",
        to: "slack:C0123ABC",
        accountId: "workspace-1",
      },
      threadId: "1234567890.123456",
    });
  });

  it("looks up deliveryContext in per-agent session stores", () => {
    const sessionKey = "agent:worker:telegram:dm:user-456";
    storeState.stores["/tmp/sessions.json"] = {};
    storeState.stores["/tmp/worker-sessions.json"] = {
      [sessionKey]: buildEntry({
        channel: "telegram",
        to: "telegram:user-456",
        accountId: "worker-account",
      }),
    };

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "telegram:user-456",
        accountId: "worker-account",
      },
      threadId: undefined,
    });
  });

  it("continues across per-agent stores until it finds a routable deliveryContext", () => {
    const sessionKey = "agent:shadow:telegram:dm:user-789";
    storeState.stores["/tmp/sessions.json"] = {
      [sessionKey]: {
        sessionId: "stale-shadow",
        updatedAt: Date.now() - 1000,
      },
    };
    storeState.stores["/tmp/shadow-sessions.json"] = {
      [sessionKey]: buildEntry({
        channel: "telegram",
        to: "telegram:user-789",
        accountId: "shadow-account",
      }),
    };

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "telegram:user-789",
        accountId: "shadow-account",
      },
      threadId: undefined,
    });
  });

  it("falls back to base sessions for :topic: keys", () => {
    const baseKey = "agent:main:telegram:group:98765";
    const topicKey = `${baseKey}:topic:55`;
    storeState.store[baseKey] = buildEntry({
      channel: "telegram",
      to: "group:98765",
      accountId: "main",
      threadId: "55",
    });

    const result = extractDeliveryInfo(topicKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "group:98765",
        accountId: "main",
        threadId: "55",
      },
      threadId: "55",
    });
  });

  it("falls back to session metadata thread ids when deliveryContext.threadId is missing", () => {
    const sessionKey = "agent:main:telegram:group:98765";
    storeState.store[sessionKey] = {
      ...buildEntry({
        channel: "telegram",
        to: "group:98765",
        accountId: "main",
      }),
      origin: { threadId: 77 },
    };

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "group:98765",
        accountId: "main",
        threadId: 77,
      },
      threadId: undefined,
    });
  });

  it("derives delivery info from stored last route metadata when deliveryContext is missing", () => {
    const sessionKey = "agent:main:matrix:channel:!MixedCase:example.org";
    const legacyKey = "agent:main:matrix:channel:!mixedcase:example.org";
    storeState.store[legacyKey] = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      origin: {
        provider: "matrix",
      },
      lastChannel: "matrix",
      lastTo: "room:!MixedCase:example.org",
    };

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:example.org",
        accountId: undefined,
      },
      threadId: undefined,
    });
  });

  it("continues candidate session keys until it finds the freshest routable entry", () => {
    const sessionKey = "agent:main:matrix:channel:!MixedCase:Example.Org";
    const canonicalKey = "agent:main:matrix:channel:!mixedcase:example.org";
    storeState.store[sessionKey] = {
      sessionId: "stale-session",
      updatedAt: Date.now() - 1000,
      origin: {
        provider: "matrix",
      },
    };
    storeState.store[canonicalKey] = {
      sessionId: "fresh-session",
      updatedAt: Date.now(),
      lastChannel: "matrix",
      lastTo: "room:!MixedCase:Example.Org",
    };

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:Example.Org",
        accountId: undefined,
      },
      threadId: undefined,
    });
  });

  it("prefers an older routable direct entry over a fresher normalized alias without a route", () => {
    const sessionKey = "agent:main:matrix:channel:!MixedCase:Example.Org";
    const canonicalKey = "agent:main:matrix:channel:!mixedcase:example.org";
    storeState.store[sessionKey] = {
      sessionId: "direct-routable-session",
      updatedAt: Date.now() - 1_000,
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:Example.Org",
        accountId: "matrix-account",
      },
    };
    storeState.store[canonicalKey] = {
      sessionId: "fresh-normalized-session",
      updatedAt: Date.now(),
      origin: {
        provider: "matrix",
      },
    };

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:Example.Org",
        accountId: "matrix-account",
      },
      threadId: undefined,
    });
  });

  it("prefers an older routable normalized alias over a fresher non-routable alias for non-opaque keys", () => {
    const queriedKey = "agent:main:telegram:group:MiXeDCase";
    const routableAlias = "agent:main:telegram:group:MixedCase";
    const canonicalKey = "agent:main:telegram:group:mixedcase";
    storeState.store[canonicalKey] = {
      sessionId: "fresh-normalized-session",
      updatedAt: Date.now(),
      origin: {
        provider: "telegram",
      },
    };
    storeState.store[routableAlias] = {
      sessionId: "older-routable-session",
      updatedAt: Date.now() - 1_000,
      deliveryContext: {
        channel: "telegram",
        to: "telegram:MixedCase",
        accountId: "telegram-account",
      },
    };

    const result = extractDeliveryInfo(queriedKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "telegram:MixedCase",
        accountId: "telegram-account",
      },
      threadId: undefined,
    });
  });

  it("keeps freshest routable alias ordering for non-opaque keys", () => {
    const queriedKey = "agent:main:telegram:group:MiXeDCase";
    const canonicalKey = "agent:main:telegram:group:mixedcase";
    const routableAlias = "agent:main:telegram:group:MixedCase";
    storeState.store[canonicalKey] = {
      sessionId: "older-canonical-session",
      updatedAt: Date.now() - 1_000,
      deliveryContext: {
        channel: "telegram",
        to: "telegram:old-route",
        accountId: "telegram-account",
      },
    };
    storeState.store[routableAlias] = {
      sessionId: "fresh-routable-session",
      updatedAt: Date.now(),
      deliveryContext: {
        channel: "telegram",
        to: "telegram:fresh-route",
        accountId: "telegram-account",
      },
    };

    const result = extractDeliveryInfo(queriedKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "telegram:fresh-route",
        accountId: "telegram-account",
      },
      threadId: undefined,
    });
  });

  it("finds legacy lowercase Signal group entries for mixed-case group keys", () => {
    const mixedGroupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
    const queriedKey = `agent:main:signal:group:${mixedGroupId}`;
    const legacyKey = queriedKey.toLowerCase();
    storeState.store[legacyKey] = buildEntry({
      channel: "signal",
      to: `signal:group:${mixedGroupId}`,
      accountId: "default",
    });

    const result = extractDeliveryInfo(queriedKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "signal",
        to: `signal:group:${mixedGroupId}`,
        accountId: "default",
      },
      threadId: undefined,
    });
  });

  it("prefers the exact mixed-case Matrix entry over a fresher folded legacy alias", () => {
    // Matrix room IDs are case-sensitive (openclaw#75670): the exact mixed-case
    // session is canonical and must win over a stale lowercased legacy alias even
    // when the alias is fresher. (Previously these collapsed to one lowercased key
    // and freshest won — that collapse was the bug.)
    const queriedKey = "agent:main:matrix:channel:!MixedCase:Example.Org";
    const legacyFoldedKey = "agent:main:matrix:channel:!mixedcase:example.org";
    storeState.store[queriedKey] = {
      sessionId: "exact-mixedcase-session",
      updatedAt: Date.now() - 1_000,
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:Example.Org",
        accountId: "matrix-account",
      },
    };
    storeState.store[legacyFoldedKey] = {
      sessionId: "fresher-legacy-folded-session",
      updatedAt: Date.now(),
      deliveryContext: {
        channel: "matrix",
        to: "room:!mixedcase:example.org",
        accountId: "matrix-account",
      },
    };

    const result = extractDeliveryInfo(queriedKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:Example.Org",
        accountId: "matrix-account",
      },
      threadId: undefined,
    });
  });

  it("finds Matrix thread entries with a legacy lowercased room and preserved event id", () => {
    const queriedKey =
      "agent:main:matrix:channel:!MixedCase:Example.Org:thread:$RootEvent:Example.Org";
    const legacyThreadKey =
      "agent:main:matrix:channel:!mixedcase:example.org:thread:$RootEvent:Example.Org";
    storeState.store[legacyThreadKey] = {
      sessionId: "legacy-thread-session",
      updatedAt: Date.now(),
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:Example.Org",
        accountId: "matrix-account",
        threadId: "$RootEvent:Example.Org",
      },
    };

    const result = extractDeliveryInfo(queriedKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:Example.Org",
        accountId: "matrix-account",
        threadId: "$RootEvent:Example.Org",
      },
      threadId: "$RootEvent:Example.Org",
    });
  });

  it("does not return a case-distinct lowercase Matrix sibling when the mixed-case key has no exact entry", () => {
    const queriedKey = "agent:main:matrix:channel:!MixedCase:Example.Org";
    const lowercaseSiblingKey = "agent:main:matrix:channel:!mixedcase:example.org";
    storeState.store[lowercaseSiblingKey] = buildEntry({
      channel: "matrix",
      to: "room:!mixedcase:example.org",
      accountId: "matrix-account",
    });

    const result = extractDeliveryInfo(queriedKey);

    expect(result).toEqual({
      deliveryContext: undefined,
      threadId: undefined,
    });
  });

  it("does not return a mixed-case Matrix sibling for a lowercase room query", () => {
    const queriedKey = "agent:main:matrix:channel:!mixedcase:example.org";
    const mixedSiblingKey = "agent:main:matrix:channel:!MixedCase:Example.Org";
    storeState.store[mixedSiblingKey] = buildEntry({
      channel: "matrix",
      to: "room:!MixedCase:Example.Org",
      accountId: "matrix-account",
    });

    const result = extractDeliveryInfo(queriedKey);

    expect(result).toEqual({
      deliveryContext: undefined,
      threadId: undefined,
    });
  });

  it("does not return an exact lowercase Matrix key with mixed-case delivery metadata", () => {
    const queriedKey = "agent:main:matrix:channel:!mixedcase:example.org";
    storeState.store[queriedKey] = buildEntry({
      channel: "matrix",
      to: "room:!MixedCase:Example.Org",
      accountId: "matrix-account",
    });

    const result = extractDeliveryInfo(queriedKey);

    expect(result).toEqual({
      deliveryContext: undefined,
      threadId: undefined,
    });
  });

  it("returns a confirmed lowercased Matrix legacy artifact for a mixed-case key", () => {
    const queriedKey = "agent:main:matrix:channel:!MixedCase:Example.Org";
    const legacyArtifactKey = "agent:main:matrix:channel:!mixedcase:example.org";
    storeState.store[legacyArtifactKey] = buildEntry({
      channel: "matrix",
      to: "room:!MixedCase:Example.Org",
      accountId: "matrix-account",
    });

    const result = extractDeliveryInfo(queriedKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:Example.Org",
        accountId: "matrix-account",
      },
      threadId: undefined,
    });
  });

  it("returns a confirmed lowercased Matrix room-alias artifact", () => {
    const queriedKey = "agent:main:matrix:channel:#MixedAlias:Example.Org";
    const legacyArtifactKey = "agent:main:matrix:channel:#mixedalias:example.org";
    storeState.store[legacyArtifactKey] = buildEntry({
      channel: "matrix",
      to: "room:#MixedAlias:Example.Org",
      accountId: "matrix-account",
    });

    const result = extractDeliveryInfo(queriedKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "matrix",
        to: "room:#MixedAlias:Example.Org",
        accountId: "matrix-account",
      },
      threadId: undefined,
    });
  });

  it("does not return a folded Matrix thread artifact when the stored thread id differs by case", () => {
    const queriedKey = "agent:main:matrix:channel:!MixedCase:Example.Org:thread:$ThreadRootAbC";
    const foldedThreadKey =
      "agent:main:matrix:channel:!mixedcase:example.org:thread:$threadrootabc";
    storeState.store[foldedThreadKey] = buildEntry({
      channel: "matrix",
      to: "room:!MixedCase:Example.Org",
      accountId: "matrix-account",
      threadId: "$threadrootabc",
    });

    const result = extractDeliveryInfo(queriedKey);

    expect(result).toEqual({
      deliveryContext: undefined,
      threadId: "$ThreadRootAbC",
    });
  });

  it("falls back to the base session when a thread entry only has partial route metadata", () => {
    const baseKey = "agent:main:matrix:channel:!MixedCase:example.org";
    const threadKey = `${baseKey}:thread:$thread-event`;
    storeState.store[threadKey] = {
      sessionId: "thread-session",
      updatedAt: Date.now(),
      origin: {
        provider: "matrix",
        threadId: "$thread-event",
      },
    };
    storeState.store[baseKey] = {
      sessionId: "base-session",
      updatedAt: Date.now(),
      lastChannel: "matrix",
      lastTo: "room:!MixedCase:example.org",
    };

    const result = extractDeliveryInfo(threadKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:example.org",
        accountId: undefined,
      },
      threadId: "$thread-event",
    });
  });
});
