import { describe, expect, it } from "vitest";
import { resolveMatrixMonitorAccessState } from "./access-state.js";

describe("resolveMatrixMonitorAccessState", () => {
  it("normalizes effective allowlists once and exposes reusable matches", () => {
    const state = resolveMatrixMonitorAccessState({
      allowFrom: ["matrix:@Alice:Example.org"],
      storeAllowFrom: ["user:@bob:example.org"],
      groupAllowFrom: ["@Carol:Example.org"],
      roomUsers: ["user:@Dana:Example.org"],
      senderId: "@dana:example.org",
      isRoom: true,
    });

    expect(state.effectiveAllowFrom).toEqual([
      "matrix:@alice:example.org",
      "user:@bob:example.org",
    ]);
    expect(state.effectiveGroupAllowFrom).toEqual(["@carol:example.org"]);
    expect(state.effectiveRoomUsers).toEqual(["user:@dana:example.org"]);
    expect(state.directAllowMatch.allowed).toBe(false);
    expect(state.roomUserMatch?.allowed).toBe(true);
    expect(state.groupAllowMatch?.allowed).toBe(false);
    expect(state.commandAuthorizers).toEqual([
      { configured: true, allowed: false },
      { configured: true, allowed: true },
      { configured: true, allowed: false },
    ]);
  });

  it("does not let DM pairing-store entries authorize room control commands", () => {
    const state = resolveMatrixMonitorAccessState({
      allowFrom: [],
      storeAllowFrom: ["@attacker:example.org"],
      groupAllowFrom: [],
      roomUsers: [],
      senderId: "@attacker:example.org",
      isRoom: true,
    });

    expect(state.effectiveAllowFrom).toEqual(["@attacker:example.org"]);
    expect(state.directAllowMatch.allowed).toBe(true);
    expect(state.commandAuthorizers).toEqual([
      { configured: false, allowed: false },
      { configured: false, allowed: false },
      { configured: false, allowed: false },
    ]);
  });

  it("keeps room-user matching disabled for dm traffic", () => {
    const state = resolveMatrixMonitorAccessState({
      allowFrom: [],
      storeAllowFrom: [],
      groupAllowFrom: ["@carol:example.org"],
      roomUsers: ["@dana:example.org"],
      senderId: "@dana:example.org",
      isRoom: false,
    });

    expect(state.roomUserMatch).toBeNull();
    expect(state.commandAuthorizers[1]).toEqual({ configured: true, allowed: false });
    expect(state.commandAuthorizers[2]).toEqual({ configured: true, allowed: false });
  });
});
