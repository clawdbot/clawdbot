import { describe, expect, it } from "vitest";
import { DEFAULT_TAGLINE, pickTagline } from "./tagline.js";

describe("pickTagline", () => {
  it("returns empty string when mode is off", () => {
    expect(pickTagline({ mode: "off" })).toBe("");
  });

  it("returns default tagline when mode is default", () => {
    expect(pickTagline({ mode: "default" })).toBe(DEFAULT_TAGLINE);
  });

  it("keeps OPENCLAW_TAGLINE_INDEX behavior in random mode", () => {
    const value = pickTagline({
      mode: "random",
      env: { OPENCLAW_TAGLINE_INDEX: "0" } as NodeJS.ProcessEnv,
    });
    expect(value).toBe(
      "Your terminal just grew claws\u2014type something and let the bot pinch the busywork.",
    );
    expect(value).not.toBe(DEFAULT_TAGLINE);
  });
});
