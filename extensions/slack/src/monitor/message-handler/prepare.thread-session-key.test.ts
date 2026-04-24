import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackRoutingContext, type SlackRoutingContextDeps } from "./prepare-routing.js";

function buildCtx(overrides?: { replyToMode?: "all" | "first" | "off" }) {
  const replyToMode = overrides?.replyToMode ?? "all";
  return {
    cfg: {
      channels: {
        slack: { enabled: true, replyToMode },
      },
    } as OpenClawConfig,
    teamId: "T1",
    threadInheritParent: false,
    threadHistoryScope: "thread",
  } satisfies SlackRoutingContextDeps;
}

function buildAccount(replyToMode: "all" | "first" | "off"): ResolvedSlackAccount {
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

  it("keeps top-level channel messages on the per-channel session regardless of replyToMode", () => {
    for (const mode of ["all", "first", "off"] as const) {
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
});
