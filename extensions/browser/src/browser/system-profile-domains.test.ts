// Browser tests cover the system-profile import domain-filter parser.
import { describe, expect, it } from "vitest";
import { parseSystemProfileDomains } from "./system-profile-domains.js";

describe("parseSystemProfileDomains", () => {
  it("returns undefined for an absent filter", () => {
    expect(parseSystemProfileDomains(undefined)).toBeUndefined();
    expect(parseSystemProfileDomains(null)).toBeUndefined();
  });

  it("normalizes a valid array (trims, drops blanks)", () => {
    expect(parseSystemProfileDomains(["google.com", " youtube.com ", "", "  "])).toEqual([
      "google.com",
      "youtube.com",
    ]);
  });

  it.each([
    ["a bare string", "google.com"],
    ["an object", { google: true }],
    ["a number", 42],
  ])("fails closed for %s", (_label, raw) => {
    expect(() => parseSystemProfileDomains(raw)).toThrow(
      "domains must be an array of domain strings",
    );
  });

  it.each([
    ["an empty array", []],
    ["only blanks", ["   ", ""]],
    ["only non-strings", [1, true]],
  ])("fails closed for %s", (_label, raw) => {
    expect(() => parseSystemProfileDomains(raw)).toThrow(
      "domains must include at least one non-empty domain",
    );
  });
});
