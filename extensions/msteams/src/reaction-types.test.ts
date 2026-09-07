// Msteams tests cover reaction type normalization.
import { describe, expect, it } from "vitest";
import { getMSTeamsReactionEmoji, resolveMSTeamsReactionEmoji } from "./reaction-types.js";

describe("MSTeams reaction type lookup", () => {
  it.each([
    { input: "like", get: "\u{1F44D}", resolve: "\u{1F44D}" },
    { input: " LIKE ", get: "\u{1F44D}", resolve: "\u{1F44D}" },
    { input: "unknown_custom", get: undefined, resolve: "unknown_custom" },
    // Names that collide with Object.prototype keys are still just names.
    { input: "constructor", get: undefined, resolve: "constructor" },
    { input: "__proto__", get: undefined, resolve: "__proto__" },
    { input: "toString", get: undefined, resolve: "toString" },
  ])("maps $input without inherited Object.prototype values", ({ input, get, resolve }) => {
    expect(getMSTeamsReactionEmoji(input)).toBe(get);
    expect(typeof resolveMSTeamsReactionEmoji(input)).toBe("string");
    expect(resolveMSTeamsReactionEmoji(input)).toBe(resolve);
  });
});
