// Tests for profile name validation and normalization helpers.
import { describe, expect, it } from "vitest";
import {
  isValidProfileName,
  normalizeProfileName,
  resolveProfileStateDir,
} from "./profile-utils.js";

describe("isValidProfileName", () => {
  it.each([
    { input: "", expected: false, reason: "empty string" },
    { input: "default", expected: true, reason: "reserved word 'default'" },
    { input: "work", expected: true, reason: "simple lowercase" },
    { input: "Work", expected: true, reason: "mixed case" },
    { input: "my-profile", expected: true, reason: "with hyphen" },
    { input: "my_profile", expected: true, reason: "with underscore" },
    { input: "a", expected: true, reason: "single char" },
    { input: "1profile", expected: true, reason: "starts with digit" },
    { input: "-profile", expected: false, reason: "starts with hyphen" },
    { input: "_profile", expected: false, reason: "starts with underscore" },
    { input: "my profile", expected: false, reason: "contains space" },
    { input: "my.profile", expected: false, reason: "contains dot" },
    { input: "my/profile", expected: false, reason: "contains slash" },
    {
      input: "a".repeat(64),
      expected: true,
      reason: "max length (64 chars)",
    },
    {
      input: "a".repeat(65),
      expected: false,
      reason: "exceeds max length (65 chars)",
    },
  ])("returns $expected for '$input' ($reason)", ({ input, expected }) => {
    expect(isValidProfileName(input)).toBe(expected);
  });
});

describe("normalizeProfileName", () => {
  it.each([
    { input: undefined, expected: null, reason: "undefined" },
    { input: null, expected: null, reason: "null" },
    { input: "", expected: null, reason: "empty string" },
    { input: "   ", expected: null, reason: "whitespace only" },
    { input: "default", expected: null, reason: "reserved word 'default'" },
    { input: "DEFAULT", expected: null, reason: "reserved word 'DEFAULT'" },
    { input: "work", expected: "work", reason: "simple lowercase" },
    { input: "  work  ", expected: "work", reason: "trimmed whitespace" },
    { input: "Work", expected: "Work", reason: "mixed case" },
    { input: "-invalid", expected: null, reason: "invalid name" },
    { input: "a".repeat(65), expected: null, reason: "too long" },
  ])("returns $expected for '$input' ($reason)", ({ input, expected }) => {
    expect(normalizeProfileName(input as string | undefined)).toBe(expected);
  });
});

describe("resolveProfileStateDir", () => {
  it("returns default path for 'default' profile", () => {
    const result = resolveProfileStateDir("default", {}, () => "/home/user");
    expect(result).toBe("/home/user/.openclaw");
  });

  it("returns suffixed path for non-default profile", () => {
    const result = resolveProfileStateDir("work", {}, () => "/home/user");
    expect(result).toBe("/home/user/.openclaw-work");
  });

  it("handles uppercase profile names", () => {
    const result = resolveProfileStateDir("WORK", {}, () => "/home/user");
    expect(result).toBe("/home/user/.openclaw-WORK");
  });

  it("throws for invalid profile name", () => {
    expect(() => resolveProfileStateDir("-invalid", {}, () => "/home/user")).toThrow(
      'Invalid profile name: "-invalid"',
    );
  });

  it("throws for empty profile name", () => {
    expect(() => resolveProfileStateDir("", {}, () => "/home/user")).toThrow(
      'Invalid profile name: ""',
    );
  });

  it("respects custom homedir function", () => {
    const result = resolveProfileStateDir("prod", {}, () => "/custom/home");
    expect(result).toBe("/custom/home/.openclaw-prod");
  });
});
