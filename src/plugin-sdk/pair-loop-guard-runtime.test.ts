/**
 * Tests pairing loop guard runtime helpers for channel setup flows.
 */
import { describe, expect, it } from "vitest";
import {
  createPairLoopGuard,
  DEFAULT_PAIR_LOOP_GUARD_SETTINGS,
  mergePairLoopGuardConfig,
  resolvePairLoopGuardSettings,
  type PairLoopGuardSettings,
} from "./pair-loop-guard-runtime.js";

const settings: PairLoopGuardSettings = {
  enabled: true,
  maxEventsPerWindow: 3,
  windowMs: 60_000,
  cooldownMs: 5_000,
};

describe("createPairLoopGuard", () => {
  it("suppresses either direction once a participant pair exceeds the window budget", () => {
    const guard = createPairLoopGuard();
    const base = { scopeId: "scope-1", conversationId: "conversation-1", settings };

    expect(
      guard.recordAndCheck({
        ...base,
        senderId: "participant-a",
        receiverId: "participant-b",
        nowMs: 1_000,
      }),
    ).toEqual({ suppressed: false });
    expect(
      guard.recordAndCheck({
        ...base,
        senderId: "participant-b",
        receiverId: "participant-a",
        nowMs: 1_010,
      }),
    ).toEqual({ suppressed: false });
    expect(
      guard.recordAndCheck({
        ...base,
        senderId: "participant-a",
        receiverId: "participant-b",
        nowMs: 1_020,
      }),
    ).toEqual({ suppressed: false });

    const result = guard.recordAndCheck({
      ...base,
      senderId: "participant-b",
      receiverId: "participant-a",
      nowMs: 1_030,
    });

    expect(result).toEqual({ suppressed: true, cooldownUntilMs: 1_030 + settings.cooldownMs });
  });

  it("keeps scopes and conversations independent", () => {
    const guard = createPairLoopGuard();
    const base = {
      scopeId: "scope-1",
      conversationId: "conversation-1",
      senderId: "participant-a",
      receiverId: "participant-b",
      settings,
    };

    for (let index = 0; index < settings.maxEventsPerWindow + 1; index += 1) {
      guard.recordAndCheck({ ...base, nowMs: 1_000 + index });
    }

    expect(guard.recordAndCheck({ ...base, conversationId: "conversation-2" })).toEqual({
      suppressed: false,
    });
    expect(guard.recordAndCheck({ ...base, scopeId: "scope-2" })).toEqual({ suppressed: false });
  });

  it("does not consume another budget slot when the same event is retried", () => {
    const guard = createPairLoopGuard();
    const strictSettings = { ...settings, maxEventsPerWindow: 1 };
    const base = {
      scopeId: "scope-1",
      conversationId: "conversation-1",
      senderId: "participant-a",
      receiverId: "participant-b",
      settings: strictSettings,
    };

    expect(guard.recordAndCheck({ ...base, eventId: "event-1", nowMs: 1_000 })).toEqual({
      suppressed: false,
    });
    expect(guard.recordAndCheck({ ...base, eventId: "event-1", nowMs: 1_000 })).toEqual({
      suppressed: false,
    });
    const second = guard.recordAndCheck({ ...base, eventId: "event-2", nowMs: 1_001 });
    expect(second).toEqual({
      suppressed: true,
      cooldownUntilMs: 1_001 + strictSettings.cooldownMs,
    });
    expect(guard.recordAndCheck({ ...base, eventId: "event-2", nowMs: 1_001 })).toEqual(second);
  });

  it("does not retain distinct suppressed event identities during cooldown", () => {
    const guard = createPairLoopGuard();
    const strictSettings = { ...settings, maxEventsPerWindow: 1 };
    const base = {
      scopeId: "scope-cooldown",
      conversationId: "conversation-cooldown",
      senderId: "participant-a",
      receiverId: "participant-b",
      settings: strictSettings,
    };

    expect(guard.recordAndCheck({ ...base, eventId: "event-1", nowMs: 1_000 })).toEqual({
      suppressed: false,
    });
    expect(guard.recordAndCheck({ ...base, eventId: "event-2", nowMs: 1_001 }).suppressed).toBe(
      true,
    );
    for (let index = 0; index < 1_000; index += 1) {
      expect(
        guard.recordAndCheck({
          ...base,
          eventId: `suppressed-${index}`,
          nowMs: 1_002 + index,
        }).suppressed,
      ).toBe(true);
    }

    expect(guard.snapshot()).toEqual([
      expect.objectContaining({
        recentCount: 0,
        cooldownUntilMs: 1_001 + strictSettings.cooldownMs,
      }),
    ]);
  });

  it("prunes inactive pair entries opportunistically", () => {
    const guard = createPairLoopGuard();
    const base = { scopeId: "scope-1", conversationId: "conversation-1", settings };

    guard.recordAndCheck({
      ...base,
      senderId: "participant-a",
      receiverId: "participant-b",
      nowMs: 1_000,
    });
    expect(guard.snapshot()).toHaveLength(1);

    guard.recordAndCheck({
      ...base,
      senderId: "participant-c",
      receiverId: "participant-d",
      nowMs: 61_001,
    });

    const trackedPairs = guard.snapshot();
    expect(trackedPairs).toHaveLength(1);
    expect(trackedPairs[0]?.key).toContain("participant-c");
    expect(trackedPairs[0]?.key).toContain("participant-d");
  });

  it("uses each tracked pair's own window when pruning inactive entries", () => {
    const guard = createPairLoopGuard();
    const longWindowSettings = { ...settings, windowMs: 120_000 };

    guard.recordAndCheck({
      scopeId: "scope-1",
      conversationId: "conversation-1",
      senderId: "participant-a",
      receiverId: "participant-b",
      settings: longWindowSettings,
      nowMs: 1_000,
    });
    guard.recordAndCheck({
      scopeId: "scope-1",
      conversationId: "conversation-1",
      senderId: "participant-c",
      receiverId: "participant-d",
      settings,
      nowMs: 61_001,
    });

    expect(guard.snapshot()).toHaveLength(2);
  });

  it("does not count future event timestamps against older reordered events", () => {
    const guard = createPairLoopGuard();
    const strictSettings = { ...settings, maxEventsPerWindow: 1 };
    const base = {
      scopeId: "scope-1",
      conversationId: "conversation-1",
      senderId: "participant-a",
      receiverId: "participant-b",
      settings: strictSettings,
    };

    expect(guard.recordAndCheck({ ...base, nowMs: 120_000 })).toEqual({ suppressed: false });
    expect(guard.recordAndCheck({ ...base, nowMs: 0 })).toEqual({ suppressed: false });
    expect(guard.recordAndCheck({ ...base, nowMs: 120_500 })).toEqual({
      suppressed: true,
      cooldownUntilMs: 120_500 + strictSettings.cooldownMs,
    });
  });

  it("does not apply a future cooldown to an older reordered event", () => {
    const guard = createPairLoopGuard();
    const strictSettings = { ...settings, maxEventsPerWindow: 1 };
    const base = {
      scopeId: "scope-1",
      conversationId: "conversation-1",
      senderId: "participant-a",
      receiverId: "participant-b",
      settings: strictSettings,
    };

    expect(guard.recordAndCheck({ ...base, nowMs: 120_000 })).toEqual({ suppressed: false });
    expect(guard.recordAndCheck({ ...base, nowMs: 120_500 })).toEqual({
      suppressed: true,
      cooldownUntilMs: 120_500 + strictSettings.cooldownMs,
    });
    expect(guard.recordAndCheck({ ...base, nowMs: 0 })).toEqual({ suppressed: false });
  });

  it("does not track disabled, invalid, or self-pair events", () => {
    const guard = createPairLoopGuard();
    const base = {
      scopeId: "scope-1",
      conversationId: "conversation-1",
      senderId: "participant-a",
      receiverId: "participant-b",
      settings,
    };

    expect(guard.recordAndCheck({ ...base, settings: { ...settings, enabled: false } })).toEqual({
      suppressed: false,
    });
    expect(guard.recordAndCheck({ ...base, conversationId: "" })).toEqual({ suppressed: false });
    expect(guard.recordAndCheck({ ...base, receiverId: "participant-a" })).toEqual({
      suppressed: false,
    });
    expect(guard.snapshot()).toEqual([]);
  });
});

describe("conversation burst budget", () => {
  // Pair budget stays permissive in these tests so only the burst can trip.
  const burstSettings: PairLoopGuardSettings = {
    enabled: true,
    maxEventsPerWindow: 1_000,
    windowMs: 60_000,
    cooldownMs: 5_000,
    maxConversationBotEvents: 10,
  };
  const base = {
    scopeId: "scope-1",
    conversationId: "conversation-1",
    receiverId: "self",
    settings: burstSettings,
  };

  it("stays disabled unless a conversation limit is explicitly configured", () => {
    const guard = createPairLoopGuard();
    const pairOnly = {
      ...base,
      settings: { ...burstSettings, maxConversationBotEvents: undefined },
    };
    for (let index = 0; index < 20; index += 1) {
      expect(
        guard.recordAndCheck({
          ...pairOnly,
          senderId: `bot-${index % 2}`,
          nowMs: index * 1_000,
        }).suppressed,
      ).toBe(false);
    }
  });

  it("suppresses a three-party storm the pair budget cannot see", () => {
    const guard = createPairLoopGuard();
    // Two peer senders alternating every 15s: each pair stays far below its
    // own window budget while the conversation as a whole runs away.
    for (let index = 0; index < 10; index += 1) {
      expect(
        guard.recordAndCheck({
          ...base,
          senderId: `bot-${index % 2}`,
          nowMs: index * 15_000,
        }),
      ).toEqual({ suppressed: false });
    }
    const tripped = guard.recordAndCheck({ ...base, senderId: "bot-0", nowMs: 150_000 });
    expect(tripped).toEqual({ suppressed: true, cooldownUntilMs: 155_000 });
    // A sustained storm stays suppressed past cooldown expiry because tripped
    // events stay in the window and immediately re-trip.
    expect(guard.recordAndCheck({ ...base, senderId: "bot-1", nowMs: 161_000 }).suppressed).toBe(
      true,
    );
  });

  it("never trips two-party traffic, even with one-off posts from stray bots", () => {
    const guard = createPairLoopGuard();
    guard.recordAndCheck({ ...base, senderId: "stray-ci", nowMs: 0 });
    guard.recordAndCheck({ ...base, senderId: "stray-alerts", nowMs: 1_000 });
    // A rapid two-party exchange with strays in the window: only one sender is
    // actively posting, so the burst budget leaves it to the pair budget.
    for (let index = 0; index < 20; index += 1) {
      expect(
        guard.recordAndCheck({
          ...base,
          senderId: "peer-bot",
          nowMs: 2_000 + index * 10_000,
        }).suppressed,
      ).toBe(false);
    }
  });

  it("does not consume conversation budget when an event is replayed", () => {
    const guard = createPairLoopGuard();
    for (let index = 0; index < 10; index += 1) {
      expect(
        guard.recordAndCheck({
          ...base,
          senderId: `bot-${index % 2}`,
          eventId: `event-${index}`,
          nowMs: index * 1_000,
        }).suppressed,
      ).toBe(false);
    }
    expect(
      guard.recordAndCheck({
        ...base,
        senderId: "bot-1",
        eventId: "event-9",
        nowMs: 10_000,
      }).suppressed,
    ).toBe(false);
    expect(
      guard.recordAndCheck({
        ...base,
        senderId: "bot-0",
        eventId: "event-10",
        nowMs: 11_000,
      }).suppressed,
    ).toBe(true);
  });

  it("keeps an active conversation cooldown when an earlier pair event is replayed", () => {
    const guard = createPairLoopGuard();
    for (let index = 0; index <= 10; index += 1) {
      guard.recordAndCheck({
        ...base,
        senderId: `bot-${index % 2}`,
        eventId: `event-${index}`,
        nowMs: index * 1_000,
      });
    }

    expect(
      guard.recordAndCheck({
        ...base,
        senderId: "bot-0",
        eventId: "event-0",
        nowMs: 10_001,
      }),
    ).toEqual({ suppressed: true, cooldownUntilMs: 15_000 });
  });

  it("deduplicates a replay even when its first delivery was pair-suppressed", () => {
    const guard = createPairLoopGuard();
    const strictSettings = {
      ...burstSettings,
      maxEventsPerWindow: 1,
      cooldownMs: 1_000,
      maxConversationBotEvents: 4,
    };
    const strictBase = { ...base, settings: strictSettings };

    expect(
      guard.recordAndCheck({ ...strictBase, senderId: "bot-0", eventId: "a", nowMs: 0 }),
    ).toEqual({ suppressed: false });
    expect(
      guard.recordAndCheck({ ...strictBase, senderId: "bot-0", eventId: "b", nowMs: 1 }),
    ).toEqual({ suppressed: true, cooldownUntilMs: 1_001 });
    expect(
      guard.recordAndCheck({ ...strictBase, senderId: "bot-1", eventId: "c", nowMs: 2 }),
    ).toEqual({ suppressed: false });
    expect(
      guard.recordAndCheck({ ...strictBase, senderId: "bot-1", eventId: "d", nowMs: 3 }),
    ).toEqual({ suppressed: true, cooldownUntilMs: 1_003 });

    // The retry remains pair-suppressed, but must not consume a fifth burst slot.
    expect(
      guard.recordAndCheck({ ...strictBase, senderId: "bot-1", eventId: "d", nowMs: 4 }),
    ).toEqual({ suppressed: true, cooldownUntilMs: 1_003 });

    // At the pair cooldown boundary, the next distinct event starts the burst
    // cooldown now. A duplicate burst record above would have started it at t=4.
    expect(
      guard.recordAndCheck({ ...strictBase, senderId: "bot-2", eventId: "e", nowMs: 1_003 }),
    ).toEqual({ suppressed: true, cooldownUntilMs: 2_003 });
  });

  it("lets slow multi-bot traffic drain out of the window", () => {
    const guard = createPairLoopGuard();
    // Three senders posting round-robin every 4 minutes: the 10-minute window
    // never holds more than the budget, so nothing ever accumulates.
    for (let index = 0; index < 15; index += 1) {
      expect(
        guard.recordAndCheck({
          ...base,
          senderId: `bot-${index % 3}`,
          nowMs: index * 240_000,
        }).suppressed,
      ).toBe(false);
    }
  });

  it("re-arms once the conversation actually goes quiet", () => {
    const guard = createPairLoopGuard();
    for (let index = 0; index < 12; index += 1) {
      guard.recordAndCheck({ ...base, senderId: `bot-${index % 2}`, nowMs: index * 15_000 });
    }
    // 11 minutes of silence drains the window; the next event is clean.
    expect(
      guard.recordAndCheck({ ...base, senderId: "bot-0", nowMs: 180_000 + 11 * 60_000 }).suppressed,
    ).toBe(false);
  });

  it("still trips when an operator raises the limit past the retention cap", () => {
    const guard = createPairLoopGuard();
    const lenient = { ...base, settings: { ...burstSettings, maxConversationBotEvents: 500 } };
    // The fixed retention cap holds the configured maximum plus the event
    // needed to cross it.
    for (let index = 0; index < 500; index += 1) {
      expect(
        guard.recordAndCheck({ ...lenient, senderId: `bot-${index % 3}`, nowMs: index * 1_000 })
          .suppressed,
      ).toBe(false);
    }
    expect(guard.recordAndCheck({ ...lenient, senderId: "bot-0", nowMs: 500_000 }).suppressed).toBe(
      true,
    );
  });

  it("catches a storm rotating across many senders", () => {
    const guard = createPairLoopGuard();
    // 10 senders round-robin at 5s: no sender is prolific, but once two of
    // them have posted twice the burst over the limit is suppressed.
    const results: boolean[] = [];
    for (let index = 0; index < 20; index += 1) {
      results.push(
        guard.recordAndCheck({ ...base, senderId: `bot-${index % 10}`, nowMs: index * 5_000 })
          .suppressed,
      );
    }
    expect(results[11]).toBe(true);
  });

  it("tracks each receiving bot independently", () => {
    const guard = createPairLoopGuard();
    for (let index = 0; index < 11; index += 1) {
      guard.recordAndCheck({ ...base, senderId: `bot-${index % 2}`, nowMs: index * 1_000 });
    }
    expect(
      guard.recordAndCheck({
        ...base,
        receiverId: "other-agent",
        senderId: "bot-0",
        nowMs: 12_000,
      }).suppressed,
    ).toBe(false);
  });
});

describe("mergePairLoopGuardConfig", () => {
  it("layers partial child config over parent config field-by-field", () => {
    expect(
      mergePairLoopGuardConfig(
        { enabled: true, maxEventsPerWindow: 8, windowSeconds: 120, cooldownSeconds: 30 },
        { maxEventsPerWindow: 2 },
      ),
    ).toEqual({
      enabled: true,
      maxEventsPerWindow: 2,
      windowSeconds: 120,
      cooldownSeconds: 30,
    });
  });

  it("preserves explicit false and ignores undefined override fields", () => {
    expect(mergePairLoopGuardConfig({ enabled: false }, { windowSeconds: undefined })).toEqual({
      enabled: false,
    });
    expect(mergePairLoopGuardConfig(undefined, undefined)).toBeUndefined();
  });
});

describe("resolvePairLoopGuardSettings", () => {
  it("uses built-in channel loop guard defaults when no config is set", () => {
    expect(resolvePairLoopGuardSettings({ defaultEnabled: true })).toEqual(
      DEFAULT_PAIR_LOOP_GUARD_SETTINGS,
    );
  });

  it("keeps the guard disabled when the channel has no bot-to-bot path", () => {
    expect(resolvePairLoopGuardSettings({ defaultEnabled: false }).enabled).toBe(false);
  });

  it("lets channel config override shared channel defaults field-by-field", () => {
    const resolved = resolvePairLoopGuardSettings({
      config: { maxEventsPerWindow: 4, windowSeconds: 10 },
      defaultsConfig: { maxEventsPerWindow: 8, windowSeconds: 120, cooldownSeconds: 30 },
      defaultEnabled: true,
    });

    expect(resolved).toEqual({
      enabled: true,
      maxEventsPerWindow: 4,
      windowMs: 10_000,
      cooldownMs: 30_000,
    });
  });

  it("enables the conversation budget only for an explicit bounded limit", () => {
    expect(
      resolvePairLoopGuardSettings({
        config: { maxConversationBotEvents: 10 },
        defaultEnabled: true,
      }).maxConversationBotEvents,
    ).toBe(10);
    expect(
      resolvePairLoopGuardSettings({
        config: { maxConversationBotEvents: 501 },
        defaultEnabled: true,
      }).maxConversationBotEvents,
    ).toBeUndefined();
  });

  it("honors enabled=false from either channel or shared defaults", () => {
    expect(
      resolvePairLoopGuardSettings({
        config: { enabled: false },
        defaultsConfig: { enabled: true },
        defaultEnabled: true,
      }).enabled,
    ).toBe(false);
    expect(
      resolvePairLoopGuardSettings({
        defaultsConfig: { enabled: false },
        defaultEnabled: true,
      }).enabled,
    ).toBe(false);
  });

  it("falls back to built-in defaults for invalid numeric config", () => {
    expect(
      resolvePairLoopGuardSettings({
        config: { maxEventsPerWindow: 0, windowSeconds: -1, cooldownSeconds: -5 },
        defaultEnabled: true,
      }),
    ).toEqual(DEFAULT_PAIR_LOOP_GUARD_SETTINGS);
  });
});
