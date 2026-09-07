import { describe, expect, it } from "vitest";
import {
  appendCallReplayKey,
  releaseRejectedProviderCall,
  rememberManagerReplayKey,
  reserveRejectedProviderCall,
  trimCallReplayKeys,
} from "./replay-keys.js";

describe("voice-call manager replay keys", () => {
  it("evicts the oldest unique manager key without refreshing duplicates", () => {
    const keys = new Set<string>();

    for (const key of ["a", "b", "c", "a", "d"]) {
      rememberManagerReplayKey(keys, key, 3);
    }

    expect([...keys]).toEqual(["b", "c", "d"]);
  });

  it("keeps the newest per-call replay keys in insertion order", () => {
    const keys = ["a", "b", "c", "d"];

    trimCallReplayKeys(keys, 3);
    appendCallReplayKey(keys, "e", 3);

    expect(keys).toEqual(["c", "d", "e"]);
  });

  it("does not let a stale failed rejection release a newer reservation", () => {
    const calls = new Map<string, symbol>();
    const firstReservation = reserveRejectedProviderCall(calls, "provider-a", 1);
    expect(firstReservation).toBeDefined();

    reserveRejectedProviderCall(calls, "provider-b", 1);
    const newerReservation = reserveRejectedProviderCall(calls, "provider-a", 1);
    expect(newerReservation).toBeDefined();

    releaseRejectedProviderCall(calls, "provider-a", firstReservation as symbol);

    expect(calls.get("provider-a")).toBe(newerReservation);
  });
});
