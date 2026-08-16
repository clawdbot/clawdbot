import { describe, expect, it } from "vitest";
import { buildBuzzTarget, normalizeBuzzTarget, parseBuzzTarget } from "./target.js";

const CHANNEL_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";

describe("Buzz targets", () => {
  it("accepts channel UUID targets", () => {
    expect(parseBuzzTarget(CHANNEL_ID)).toBe(CHANNEL_ID);
    expect(parseBuzzTarget(`buzz:${CHANNEL_ID}`)).toBe(CHANNEL_ID);
    expect(buildBuzzTarget(CHANNEL_ID)).toBe(`buzz:${CHANNEL_ID}`);
  });

  it("rejects non-channel targets", () => {
    expect(() => parseBuzzTarget("general")).toThrow("channel UUID");
  });

  it("normalizes channel prefixes", () => {
    expect(normalizeBuzzTarget(`channel:${CHANNEL_ID}`)).toBe(CHANNEL_ID);
  });
});
