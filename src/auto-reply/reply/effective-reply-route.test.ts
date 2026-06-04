// Tests effective reply route selection from context, session, and fallback state.
import { describe, expect, it } from "vitest";
import {
  isSystemEventProvider,
  resolveEffectiveReplyRoute,
  type EffectiveReplyRouteContext,
  type EffectiveReplyRouteEntry,
} from "./effective-reply-route.js";

const ctx = (params: EffectiveReplyRouteContext): EffectiveReplyRouteContext => params;
const entry = (params: EffectiveReplyRouteEntry): EffectiveReplyRouteEntry => params;

describe("resolveEffectiveReplyRoute", () => {
  it("uses live origin context for normal providers", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "slack",
          OriginatingChannel: "discord",
          OriginatingTo: "channel:live",
          AccountId: "live-account",
        }),
        entry: entry({
          deliveryContext: {
            channel: "telegram",
            to: "chat:persisted",
            accountId: "persisted-account",
          },
          lastChannel: "whatsapp",
          lastTo: "last-to",
          lastAccountId: "last-account",
        }),
      }),
    ).toEqual({
      channel: "discord",
      to: "channel:live",
      accountId: "live-account",
    });
  });

  it("does not use persisted fallbacks for normal providers", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({ Provider: "slack" }),
        entry: entry({
          deliveryContext: {
            channel: "telegram",
            to: "chat:persisted",
            accountId: "persisted-account",
          },
          lastChannel: "whatsapp",
          lastTo: "last-to",
          lastAccountId: "last-account",
        }),
      }),
    ).toEqual({
      channel: undefined,
      to: undefined,
      accountId: undefined,
    });
  });

  it("uses established external route for sessions_send internal webchat handoffs", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "webchat",
          Surface: "webchat",
          OriginatingChannel: "webchat",
          OriginatingTo: "session:dashboard",
          AccountId: "webchat-account",
          InputProvenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceChannel: "webchat",
          },
        }),
        entry: entry({
          deliveryContext: {
            channel: "feishu",
            to: "user:ou_123",
            accountId: "work",
            threadId: "thread:om_123",
          },
          lastChannel: "webchat",
          lastTo: "session:dashboard",
          lastAccountId: "webchat-account",
        }),
      }),
    ).toEqual({
      channel: "feishu",
      to: "user:ou_123",
      accountId: "work",
      inheritedExternalRoute: true,
    });
  });

  it("keeps trusted inherited thread ids from explicit route metadata", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "webchat",
          Surface: "webchat",
          InputProvenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
          },
        }),
        entry: entry({
          route: {
            channel: "feishu",
            accountId: "work",
            target: { to: "user:ou_123" },
            thread: { id: "thread:om_123", source: "explicit" },
          },
          deliveryContext: {
            channel: "feishu",
            to: "user:ou_123",
            accountId: "work",
            threadId: "thread:om_123",
          },
        }),
      }),
    ).toEqual({
      channel: "feishu",
      to: "user:ou_123",
      accountId: "work",
      threadId: "thread:om_123",
      inheritedExternalRoute: true,
    });
  });

  it("drops inherited thread ids from session-normalized route metadata", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "webchat",
          Surface: "webchat",
          InputProvenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
          },
        }),
        entry: entry({
          route: {
            channel: "feishu",
            accountId: "work",
            target: { to: "user:ou_123" },
            thread: { id: "thread:stale", source: "session" },
          },
          deliveryContext: {
            channel: "feishu",
            to: "user:ou_123",
            accountId: "work",
            threadId: "thread:stale",
          },
        }),
      }),
    ).toEqual({
      channel: "feishu",
      to: "user:ou_123",
      accountId: "work",
      inheritedExternalRoute: true,
    });
  });

  it("drops inherited thread ids from unmarked normalized route metadata", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "webchat",
          Surface: "webchat",
          InputProvenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
          },
        }),
        entry: entry({
          route: {
            channel: "feishu",
            accountId: "work",
            target: { to: "user:ou_123" },
            thread: { id: "thread:stale" },
          },
          deliveryContext: {
            channel: "feishu",
            to: "user:ou_123",
            accountId: "work",
            threadId: "thread:stale",
          },
        }),
      }),
    ).toEqual({
      channel: "feishu",
      to: "user:ou_123",
      accountId: "work",
      inheritedExternalRoute: true,
    });
  });

  it("keeps plugin-owned external routes for runtime routability checks", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "webchat",
          Surface: "webchat",
          OriginatingChannel: "webchat",
          OriginatingTo: "session:dashboard",
          InputProvenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
          },
        }),
        entry: entry({
          deliveryContext: {
            channel: "customer-chat",
            to: "conversation:123",
            accountId: "workspace-a",
          },
        }),
      }),
    ).toEqual({
      channel: "customer-chat",
      to: "conversation:123",
      accountId: "workspace-a",
      inheritedExternalRoute: true,
    });
  });

  it("keeps normal webchat turns on their live route", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "webchat",
          Surface: "webchat",
          OriginatingChannel: "webchat",
          OriginatingTo: "session:dashboard",
        }),
        entry: entry({
          deliveryContext: {
            channel: "feishu",
            to: "user:ou_123",
            accountId: "work",
          },
        }),
      }),
    ).toEqual({
      channel: "webchat",
      to: "session:dashboard",
      accountId: undefined,
    });
  });

  it("ignores persisted webchat routes for sessions_send handoffs", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "webchat",
          Surface: "webchat",
          OriginatingChannel: "webchat",
          OriginatingTo: "session:dashboard",
          InputProvenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
          },
        }),
        entry: entry({
          deliveryContext: {
            channel: "webchat",
            to: "session:old-dashboard",
          },
          lastChannel: "webchat",
          lastTo: "session:old-dashboard",
        }),
      }),
    ).toEqual({
      channel: "webchat",
      to: "session:dashboard",
      accountId: undefined,
    });
  });

  it("prefers live origin context for exec-event replies", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "exec-event",
          OriginatingChannel: "telegram",
          OriginatingTo: "chat:live",
          AccountId: "live-account",
        }),
        entry: entry({
          deliveryContext: {
            channel: "discord",
            to: "channel:persisted",
            accountId: "persisted-account",
          },
          lastChannel: "slack",
          lastTo: "last-to",
          lastAccountId: "last-account",
        }),
      }),
    ).toEqual({
      channel: "telegram",
      to: "chat:live",
      accountId: "live-account",
    });
  });

  it("falls back to deliveryContext for exec-event replies", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({ Provider: "exec-event" }),
        entry: entry({
          deliveryContext: {
            channel: "telegram",
            to: "chat:persisted",
            accountId: "persisted-account",
          },
          lastChannel: "slack",
          lastTo: "last-to",
          lastAccountId: "last-account",
        }),
      }),
    ).toEqual({
      channel: "telegram",
      to: "chat:persisted",
      accountId: "persisted-account",
    });
  });

  it("falls back to legacy last route fields for exec-event replies", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({ Provider: "exec-event" }),
        entry: entry({
          lastChannel: "slack",
          lastTo: "last-to",
          lastAccountId: "last-account",
        }),
      }),
    ).toEqual({
      channel: "slack",
      to: "last-to",
      accountId: "last-account",
    });
  });

  it("fills partial exec-event route from persisted context", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "exec-event",
          OriginatingChannel: "telegram",
          OriginatingTo: "chat:live",
        }),
        entry: entry({
          deliveryContext: {
            channel: "discord",
            to: "channel:persisted",
            accountId: "persisted-account",
          },
        }),
      }),
    ).toEqual({
      channel: "telegram",
      to: "chat:live",
      accountId: "persisted-account",
    });
  });
});

describe("isSystemEventProvider", () => {
  it("recognizes persisted-delivery event providers", () => {
    expect(isSystemEventProvider("heartbeat")).toBe(true);
    expect(isSystemEventProvider("cron-event")).toBe(true);
    expect(isSystemEventProvider("exec-event")).toBe(true);
    expect(isSystemEventProvider("slack")).toBe(false);
    expect(isSystemEventProvider(undefined)).toBe(false);
  });
});
