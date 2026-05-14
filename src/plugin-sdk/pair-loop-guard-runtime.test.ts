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
