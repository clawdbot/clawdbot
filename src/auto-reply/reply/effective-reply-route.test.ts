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
