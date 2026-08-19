// Matrix tests cover target-id shape predicates.
import { describe, expect, it } from "vitest";
import { isMatrixRoomId } from "./target-ids.js";

describe("isMatrixRoomId", () => {
  it("accepts a room version 12 room ID with no :server suffix", () => {
    expect(isMatrixRoomId("!UIZ0YzC99dC1AyEM6mGl0_XNP8u8xeCCt_Zk8Uhkp70")).toBe(true);
  });

  it("accepts a pre-v12 room ID that still has a :server suffix", () => {
    expect(isMatrixRoomId("!ops:example.org")).toBe(true);
  });

  it("rejects a user ID", () => {
    expect(isMatrixRoomId("@bob:example.org")).toBe(false);
  });

  it("rejects an alias", () => {
    expect(isMatrixRoomId("#general:example.org")).toBe(false);
  });

  it("rejects an unresolved name query", () => {
    expect(isMatrixRoomId("General")).toBe(false);
  });

  it.each(["!", " !  "])("rejects an empty room identifier: %j", (roomId) => {
    expect(isMatrixRoomId(roomId)).toBe(false);
  });
});
