import { describe, expect, it } from "vitest";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { findMostRecentDirectSessionWithRoute } from "./recent-direct-session.js";
import type { SessionEntry } from "./types.js";

function directEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "operator-session",
    updatedAt: 1,
    lastInteractionAt: 10,
    delivery: normalizeSessionDeliveryState({
      context: { channel: "telegram", to: "123" },
      origin: { chatType: "direct" },
    }),
    ...overrides,
  };
}

describe("findMostRecentDirectSessionWithRoute", () => {
  it("orders real interactions newest first with stable key ties, ignoring background updates", () => {
    expect(
      findMostRecentDirectSessionWithRoute({
        "agent:main:telegram:direct:old": directEntry({ lastInteractionAt: 5, updatedAt: 1000 }),
        "agent:main:telegram:direct:b": directEntry(),
        "agent:main:telegram:direct:a": directEntry(),
      }),
    ).toBe("agent:main:telegram:direct:a");
  });

  it.each([
    "global",
    "unknown",
    "agent:main:cron:daily",
    "agent:main:acp:worker",
    "agent:main:subagent:worker",
  ])("excludes synthetic session key %s even with an inherited direct route", (key) => {
    expect(findMostRecentDirectSessionWithRoute({ [key]: directEntry() })).toBeUndefined();
  });

  it.each([
    ["spawnedBy", { spawnedBy: "agent:main:main" }],
    ["parentSessionKey", { parentSessionKey: "agent:main:main" }],
    ["heartbeat", { heartbeatIsolatedBaseSessionKey: "agent:main:main" }],
    ["collector", { swarmCollector: true }],
    ["archived", { archivedAt: 1 }],
    ["incognito", { incognito: true }],
  ] satisfies Array<[string, Partial<SessionEntry>]>)(
    "excludes %s session metadata",
    (_label, overrides) => {
      expect(
        findMostRecentDirectSessionWithRoute({
          "agent:main:telegram:direct:123": directEntry(overrides),
        }),
      ).toBeUndefined();
    },
  );

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "requires a finite positive lastInteractionAt (%s)",
    (lastInteractionAt) => {
      expect(
        findMostRecentDirectSessionWithRoute({
          "agent:main:telegram:direct:123": directEntry({ lastInteractionAt }),
        }),
      ).toBeUndefined();
    },
  );

  it.each([
    ["internal", { kind: "internal" }],
    ["none", { kind: "none" }],
    ["missing target", normalizeSessionDeliveryState({ context: { channel: "telegram" } })],
    [
      "unknown channel",
      normalizeSessionDeliveryState({ context: { channel: "not-deliverable", to: "123" } }),
    ],
    [
      "group origin",
      normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "123" },
        origin: { chatType: "group" },
      }),
    ],
  ] satisfies Array<[string, SessionEntry["delivery"]]>)(
    "rejects %s delivery",
    (_label, delivery) => {
      expect(
        findMostRecentDirectSessionWithRoute({
          "agent:main:telegram:direct:123": directEntry({ delivery, chatType: "direct" }),
        }),
      ).toBeUndefined();
    },
  );

  it("uses the entry chat type when the delivery origin has none", () => {
    expect(
      findMostRecentDirectSessionWithRoute({
        "agent:main:telegram:direct:123": directEntry({
          chatType: "direct",
          delivery: normalizeSessionDeliveryState({ context: { channel: "telegram", to: "123" } }),
        }),
      }),
    ).toBe("agent:main:telegram:direct:123");
  });
});
