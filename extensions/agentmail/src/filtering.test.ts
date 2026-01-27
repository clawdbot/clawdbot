import { describe, expect, it } from "vitest";

import { checkSenderAllowed, matchesList } from "./filtering.js";

describe("matchesList", () => {
  it("returns false for empty list", () => {
    expect(matchesList("user@example.com", [])).toBe(false);
  });

  it("matches exact email", () => {
    expect(matchesList("user@example.com", ["user@example.com"])).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(matchesList("User@Example.COM", ["user@example.com"])).toBe(true);
  });

  it("matches domain", () => {
    expect(matchesList("anyone@example.com", ["example.com"])).toBe(true);
  });

  it("does not match different domain", () => {
    expect(matchesList("user@other.com", ["example.com"])).toBe(false);
  });

  it("does not match partial email", () => {
    expect(matchesList("user@example.com", ["other@example.com"])).toBe(false);
  });

  it("matches subdomain via domain suffix", () => {
    expect(matchesList("user@sub.example.com", ["sub.example.com"])).toBe(true);
  });
});

describe("checkSenderAllowed", () => {
  it("allows sender on allowFrom", () => {
    const result = checkSenderAllowed("friend@good.com", {
      allowFrom: ["good.com"],
    });
    expect(result).toBe(true);
  });

  it("allows all in open mode (empty allowFrom)", () => {
    const result = checkSenderAllowed("anyone@anywhere.com", {
      allowFrom: [],
    });
    expect(result).toBe(true);
  });

  it("rejects sender not on non-empty allowFrom", () => {
    const result = checkSenderAllowed("stranger@unknown.com", {
      allowFrom: ["trusted.com"],
    });
    expect(result).toBe(false);
  });

  it("matches exact email in allowFrom", () => {
    const result = checkSenderAllowed("user@example.com", {
      allowFrom: ["user@example.com"],
    });
    expect(result).toBe(true);
  });
});
