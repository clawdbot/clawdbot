import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveConfiguredBindingRouteMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    resolveConfiguredBindingRoute: (...args: unknown[]) =>
      resolveConfiguredBindingRouteMock(...args),
  };
});

import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackRoutingContext, type SlackRoutingContextDeps } from "./prepare-routing.js";

function buildCtx(overrides?: {
  replyToMode?: "all" | "first" | "off" | "batched";
  dmScope?: "main" | "per-sender" | "per-channel-peer";
}) {
  const replyToMode = overrides?.replyToMode ?? "all";
  return {
    cfg: {
      session: { dmScope: overrides?.dmScope },
      channels: {
        slack: { enabled: true, replyToMode },
      },
    } as OpenClawConfig,
    teamId: "T1",
    threadInheritParent: false,
    threadHistoryScope: "thread",
  } satisfies SlackRoutingContextDeps;
}

function buildAccount(replyToMode: "all" | "first" | "off" | "batched"): ResolvedSlackAccount {
  return {
    accountId: "default",
    enabled: true,
    botTokenSource: "config",
    appTokenSource: "config",
    userTokenSource: "none",
    config: { replyToMode },
    replyToMode,
  };
}

function buildChannelMessage(overrides?: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    channel: "C123",
    channel_type: "channel",
    user: "U1",
    text: "hello",
    ts: "1770408518.451689",
    ...overrides,
  } as SlackMessageEvent;
}

describe("thread-level session keys", () => {
  beforeEach(() => {
    resolveConfiguredBindingRouteMock.mockReset();
    resolveConfiguredBindingRouteMock.mockImplementation(({ route }) => ({
      bindingResolution: null,
      route,
    }));
  });

  it("routes configured ACP bindings for top-level Slack channels", () => {
    const ctx = buildCtx({ replyToMode: "off" });
    const account = buildAccount("off");
    const targetSessionKey = "agent:codex:acp:binding:slack:default:c123";
    resolveConfiguredBindingRouteMock.mockImplementation(({ route, conversation }) => ({
      bindingResolution: {
        conversation,
        record: {
          bindingId: "config:acp:slack:default:c123",
          targetSessionKey,
          targetKind: "session",
          conversation: {
            channel: "slack",
            accountId: "default",
            conversationId: "c123",
          },
          status: "active",
          boundAt: 0,
          metadata: {
            source: "config",
            mode: "persistent",
            agentId: "codex",
          },
        },
      },
      boundSessionKey: targetSessionKey,
      boundAgentId: "codex",
      route: {
        ...route,
        agentId: "codex",
        sessionKey: targetSessionKey,
        mainSessionKey: "agent:codex:main",
        matchedBy: "binding.channel",
        lastRoutePolicy: "session",
      },
    }));

    const routing = resolveSlackRoutingContext({
      ctx,
      account,
      message: buildChannelMessage({ channel: "C123" }),
      isDirectMessage: false,
      isGroupDm: false,
      isRoom: true,
      isRoomish: true,
    });

    expect(resolveConfiguredBindingRouteMock).toHaveBeenCalledTimes(1);
    const [bindingRouteRequest] = resolveConfiguredBindingRouteMock.mock.calls[0];
    expect(bindingRouteRequest).toEqual({
      cfg: ctx.cfg,
      route: {
        agentId: "main",
        channel: "slack",
        accountId: "default",
        sessionKey: "agent:main:slack:channel:c123",
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "session",
        matchedBy: "default",
      },
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "C123",
      },
    });
    expect(routing.route.agentId).toBe("codex");
    expect(routing.sessionKey).toBe(targetSessionKey);
    expect(routing.configuredBindingSessionKey).toBe(targetSessionKey);
    expect(routing.runtimeBinding).toBeNull();
  });

  it("does not append Slack thread suffixes to configured ACP binding sessions", () => {
    const ctx = buildCtx({ replyToMode: "all" });
    const account = buildAccount("all");
    const targetSessionKey = "agent:codex:acp:binding:slack:default:c123";
    resolveConfiguredBindingRouteMock.mockImplementation(({ route, conversation }) => ({
      bindingResolution: {
        conversation,
        record: {
          bindingId: "config:acp:slack:default:c123",
          targetSessionKey,
          targetKind: "session",
          conversation: {
            channel: "slack",
            accountId: "default",
            conversationId: "c123",
          },
          status: "active",
          boundAt: 0,
          metadata: {
            source: "config",
            mode: "persistent",
            agentId: "codex",
          },
        },
      },
      boundSessionKey: targetSessionKey,
      boundAgentId: "codex",
      route: {
        ...route,
        agentId: "codex",
        sessionKey: targetSessionKey,
        mainSessionKey: "agent:codex:main",
        matchedBy: "binding.channel",
        lastRoutePolicy: "session",
      },
    }));

    const routing = resolveSlackRoutingContext({
      ctx,
      account,
      message: buildChannelMessage({
        channel: "C123",
        ts: "1770408522.168859",
        thread_ts: "1770408518.451689",
      }),
      isDirectMessage: false,
      isGroupDm: false,
      isRoom: true,
      isRoomish: true,
    });

    expect(routing.sessionKey).toBe(targetSessionKey);
    expect(routing.sessionKey).not.toContain(":thread:");
  });

  it("keeps top-level channel turns in one session when replyToMode=off", () => {
    const ctx = buildCtx({ replyToMode: "off" });
    const account = buildAccount("off");

    const first = resolveSlackRoutingContext({
      ctx,
      account,
      message: buildChannelMessage({ ts: "1770408518.451689" }),
      isDirectMessage: false,
      isGroupDm: false,
      isRoom: true,
      isRoomish: true,
    });
    const second = resolveSlackRoutingContext({
      ctx,
      account,
      message: buildChannelMessage({ ts: "1770408520.000001" }),
      isDirectMessage: false,
      isGroupDm: false,
      isRoom: true,
      isRoomish: true,
    });

    const firstSessionKey = first.sessionKey;
    const secondSessionKey = second.sessionKey;
    expect(firstSessionKey).toBe(secondSessionKey);
    expect(firstSessionKey).not.toContain(":thread:");
  });

  it("uses parent thread_ts for thread replies even when replyToMode=off", () => {
    const ctx = buildCtx({ replyToMode: "off" });
    const account = buildAccount("off");

    const message = buildChannelMessage({
      user: "U2",
      text: "reply",
      ts: "1770408522.168859",
      thread_ts: "1770408518.451689",
    });

    const routing = resolveSlackRoutingContext({
      ctx,
      account,
      message,
      isDirectMessage: false,
      isGroupDm: false,
      isRoom: true,
      isRoomish: true,
    });

    const sessionKey = routing.sessionKey;
    expect(sessionKey).toContain(":thread:1770408518.451689");
    expect(sessionKey).not.toContain("1770408522.168859");
  });

  it("routes actual Slack thread replies by parent thread_ts, not the child message ts", () => {
    const ctx = buildCtx({ replyToMode: "all" });
    const account = buildAccount("all");
    const rootTs = "1777244748.777299";
    const childTs = "1777245202.803289";

    // Slack prepare routing receives Slack's native thread_ts. The persisted
    // reply_to_id/topic_id names are derived runtime metadata, not inbound
    // fields used by this routing layer.
    const routing = resolveSlackRoutingContext({
      ctx,
      account,
      message: buildChannelMessage({
        channel: "C0AHZFCAS1K",
        user: "U_BEK",
        text: "<@B1> ?",
        ts: childTs,
        thread_ts: rootTs,
        parent_user_id: "U_ROOT",
      }),
      isDirectMessage: false,
      isGroupDm: false,
      isRoom: true,
      isRoomish: true,
    });

    const expectedSessionKey = "agent:main:slack:channel:c0ahzfcas1k:thread:1777244748.777299";
    const childTsSessionKey = "agent:main:slack:channel:c0ahzfcas1k:thread:1777245202.803289";
    expect(routing.sessionKey).toBe(expectedSessionKey);
    expect(routing.sessionKey).not.toBe(childTsSessionKey);
    expect(routing.threadContext.replyToId).toBe(rootTs);
    expect(routing.threadContext.messageThreadId).toBe(rootTs);
  });

  it("keeps top-level channel messages on the per-channel session regardless of replyToMode", () => {
    for (const mode of ["all", "first", "off", "batched"] as const) {
      const ctx = buildCtx({ replyToMode: mode });
      const account = buildAccount(mode);

      const first = resolveSlackRoutingContext({
        ctx,
        account,
        message: buildChannelMessage({ ts: "1770408530.000000" }),
        isDirectMessage: false,
        isGroupDm: false,
        isRoom: true,
        isRoomish: true,
      });
      const second = resolveSlackRoutingContext({
        ctx,
        account,
        message: buildChannelMessage({ ts: "1770408531.000000" }),
        isDirectMessage: false,
        isGroupDm: false,
        isRoom: true,
        isRoomish: true,
      });

      const firstKey = first.sessionKey;
      const secondKey = second.sessionKey;
      expect(firstKey).toBe(secondKey);
      expect(firstKey).not.toContain(":thread:");
    }
  });

  it("keeps unseeded top-level room messages with self thread_ts on the channel session", () => {
    const ctx = buildCtx({ replyToMode: "off" });
    const account = buildAccount("off");

    const routing = resolveSlackRoutingContext({
      ctx,
      account,
      message: buildChannelMessage({
        ts: "1777244692.409919",
        thread_ts: "1777244692.409919",
      }),
      isDirectMessage: false,
      isGroupDm: false,
      isRoom: true,
      isRoomish: true,
    });

    expect(routing.sessionKey).toBe("agent:main:slack:channel:c123");
  });

  it("does not seed top-level group DM mentions into thread sessions", () => {
    const ctx = buildCtx({ replyToMode: "all" });
    const account = buildAccount("all");

    const routing = resolveSlackRoutingContext({
      ctx,
      account,
      message: buildChannelMessage({
        channel: "G123",
        channel_type: "mpim",
        text: "<@B1> send a subagent",
        ts: "1777244692.409919",
      }),
      isDirectMessage: false,
      isGroupDm: true,
      isRoom: false,
      isRoomish: true,
      seedTopLevelRoomThread: true,
    });

    expect(routing.sessionKey).toBe("agent:main:slack:group:g123");
    expect(routing.sessionKey).not.toContain(":thread:");
  });

  it("routes a seeded thread root and replies with the same Slack thread_ts to one parent session", () => {
    const ctx = buildCtx({ replyToMode: "all" });
    const account = buildAccount("all");
    const rootTs = "1777244692.409919";

    const root = resolveSlackRoutingContext({
      ctx,
      account,
      message: buildChannelMessage({
        channel: "C0AHZFCAS1K",
        text: "<@B1> send a subagent to review issue #50621",
        ts: rootTs,
        thread_ts: rootTs,
      }),
      isDirectMessage: false,
      isGroupDm: false,
      isRoom: true,
      isRoomish: true,
      seedTopLevelRoomThread: true,
    });
    const followUp = resolveSlackRoutingContext({
      ctx,
      account,
      message: buildChannelMessage({
        channel: "C0AHZFCAS1K",
        text: "https://github.com/openclaw/openclaw/issues/50621",
        ts: "1777244714.000100",
        thread_ts: rootTs,
        parent_user_id: "U1",
      }),
      isDirectMessage: false,
      isGroupDm: false,
      isRoom: true,
      isRoomish: true,
    });

    const expectedSessionKey = "agent:main:slack:channel:c0ahzfcas1k:thread:1777244692.409919";
    expect(root.sessionKey).toBe(expectedSessionKey);
    expect(followUp.sessionKey).toBe(expectedSessionKey);
    expect(root.historyKey).toBe("C0AHZFCAS1K");
    expect(followUp.historyKey).toBe(expectedSessionKey);
    expect(new Set([root.sessionKey, followUp.sessionKey]).size).toBe(1);
  });

  it("seeds top-level app mentions into the same parent session used by later thread replies", () => {
    const ctx = buildCtx({ replyToMode: "all" });
    const account = buildAccount("all");
    const rootTs = "1777244692.409919";

    const rootMention = resolveSlackRoutingContext({
      ctx,
      account,
      message: buildChannelMessage({
        channel: "C0AHZFCAS1K",
        text: "<@B1> send a subagent to review issue #50621",
        ts: rootTs,
      }),
      isDirectMessage: false,
      isGroupDm: false,
      isRoom: true,
      isRoomish: true,
      seedTopLevelRoomThread: true,
    });
    const urlFollowUp = resolveSlackRoutingContext({
      ctx,
      account,
      message: buildChannelMessage({
        channel: "C0AHZFCAS1K",
        text: "https://github.com/openclaw/openclaw/issues/50621",
        ts: "1777244714.000100",
        thread_ts: rootTs,
      }),
      isDirectMessage: false,
      isGroupDm: false,
      isRoom: true,
      isRoomish: true,
    });

    const parentSessions = [rootMention.sessionKey, urlFollowUp.sessionKey];
    const spawnedSubagentsByParent = new Set(parentSessions);

    expect(rootMention.sessionKey).toBe(urlFollowUp.sessionKey);
    expect(rootMention.sessionKey).toBe(
      "agent:main:slack:channel:c0ahzfcas1k:thread:1777244692.409919",
    );
    expect(rootMention.historyKey).toBe("C0AHZFCAS1K");
    expect(urlFollowUp.historyKey).toBe(rootMention.sessionKey);
    expect(spawnedSubagentsByParent.size).toBe(1);
  });

  it("does not add thread suffix for DMs when replyToMode=off", () => {
    const ctx = buildCtx({ replyToMode: "off" });
    const account = buildAccount("off");

    const message: SlackMessageEvent = {
      channel: "D456",
      channel_type: "im",
      user: "U3",
      text: "dm message",
      ts: "1770408530.000000",
    } as SlackMessageEvent;

    const routing = resolveSlackRoutingContext({
      ctx,
      account,
      message,
      isDirectMessage: true,
      isGroupDm: false,
      isRoom: false,
      isRoomish: false,
    });

    const sessionKey = routing.sessionKey;
    expect(sessionKey).not.toContain(":thread:");
  });

  it("keeps top-level DMs on the direct session when replyToMode=all", () => {
    const ctx = buildCtx({ replyToMode: "all", dmScope: "per-channel-peer" });
    const account = buildAccount("all");

    const routing = resolveSlackRoutingContext({
      ctx,
      account,
      message: {
        channel: "D456",
        channel_type: "im",
        user: "U3",
        text: "dm message",
        ts: "1770408530.000000",
      } as SlackMessageEvent,
      isDirectMessage: true,
      isGroupDm: false,
      isRoom: false,
      isRoomish: false,
    });

    expect(routing.sessionKey).toBe("agent:main:slack:direct:u3");
    expect(routing.threadContext.messageThreadId).toBe("1770408530.000000");
  });
});
