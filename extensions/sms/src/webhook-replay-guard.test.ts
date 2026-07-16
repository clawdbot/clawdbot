import { describe, expect, it } from "vitest";
import { createSmsWebhookReplayGuard } from "./webhook-replay-guard.js";

describe("createSmsWebhookReplayGuard", () => {
  it("prunes only the expired insertion prefix without refreshing replays", () => {
    let nowMs = 0;
    const replayGuard = createSmsWebhookReplayGuard({
      ttlMs: 10,
      maxKeys: 2,
      now: () => nowMs,
    });

    expect(replayGuard.remember("first")).toEqual({ kind: "accepted" });
    nowMs = 2;
    expect(replayGuard.remember("second")).toEqual({ kind: "accepted" });
    nowMs = 5;
    expect(replayGuard.remember("first")).toEqual({ kind: "replayed" });
    expect(replayGuard.remember("overflow")).toEqual({
      kind: "saturated",
      retryAfterMs: 5,
    });

    nowMs = 10;
    expect(replayGuard.remember("overflow")).toEqual({ kind: "accepted" });
    expect(replayGuard.remember("second")).toEqual({ kind: "replayed" });
  });

  it("keeps live replay keys and fails closed until capacity expires", () => {
    let nowMs = 1_000;
    const replayGuard = createSmsWebhookReplayGuard({
      ttlMs: 10_000,
      maxKeys: 2,
      now: () => nowMs,
    });

    expect(replayGuard.remember("first")).toEqual({ kind: "accepted" });
    expect(replayGuard.remember("second")).toEqual({ kind: "accepted" });
    expect(replayGuard.remember("overflow")).toEqual({
      kind: "saturated",
      retryAfterMs: 10_000,
    });
    expect(replayGuard.remember("overflow")).toEqual({
      kind: "saturated",
      retryAfterMs: 10_000,
    });
    expect(replayGuard.remember("first")).toEqual({ kind: "replayed" });

    nowMs += 10_000;
    expect(replayGuard.remember("overflow")).toEqual({ kind: "accepted" });
  });
});
