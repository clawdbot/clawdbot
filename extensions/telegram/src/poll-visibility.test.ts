import { describe, expect, it } from "vitest";
import { resolveTelegramPollVisibility } from "./poll-visibility.js";

describe("telegram poll visibility", () => {
  it("resolves poll visibility aliases", () => {
    expect(resolveTelegramPollVisibility({ pollAnonymous: true })).toBe(true);
    expect(resolveTelegramPollVisibility({ pollPublic: true })).toBe(false);
    expect(resolveTelegramPollVisibility({})).toBeUndefined();
    expect(() => resolveTelegramPollVisibility({ pollAnonymous: true, pollPublic: true })).toThrow(
      /mutually exclusive/i,
    );
  });
});
