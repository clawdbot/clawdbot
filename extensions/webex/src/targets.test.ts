/**
 * Webex targets tests
 */

import { describe, expect, it } from "vitest";
import {
  formatAllowFromEntry,
  formatWebexTarget,
  getWebexTargetHints,
  getWebexTargetType,
  isEmail,
  isWebexId,
  normalizeAllowFromEntry,
  normalizeWebexTarget,
} from "./targets.js";

describe("normalizeWebexTarget", () => {
  it("should strip webex: prefix", () => {
    expect(normalizeWebexTarget("webex:Y2lzY29")).toBe("Y2lzY29");
  });

  it("should strip user: prefix", () => {
    expect(normalizeWebexTarget("user:Y2lzY29")).toBe("Y2lzY29");
  });

  it("should strip room: prefix", () => {
    expect(normalizeWebexTarget("room:Y2lzY29")).toBe("Y2lzY29");
  });

  it("should strip person: prefix", () => {
    expect(normalizeWebexTarget("person:Y2lzY29")).toBe("Y2lzY29");
  });

  it("should strip email: prefix", () => {
    expect(normalizeWebexTarget("email:user@example.com")).toBe("user@example.com");
  });

  it("should handle case-insensitive prefixes", () => {
    expect(normalizeWebexTarget("WEBEX:Y2lzY29")).toBe("Y2lzY29");
    expect(normalizeWebexTarget("User:Y2lzY29")).toBe("Y2lzY29");
  });

  it("should handle bare values", () => {
    expect(normalizeWebexTarget("Y2lzY29")).toBe("Y2lzY29");
  });

  it("should return undefined for empty values", () => {
    expect(normalizeWebexTarget("")).toBeUndefined();
    expect(normalizeWebexTarget(null)).toBeUndefined();
    expect(normalizeWebexTarget(undefined)).toBeUndefined();
  });

  it("should return undefined for whitespace-only values", () => {
    expect(normalizeWebexTarget("   ")).toBeUndefined();
  });

  it("should trim whitespace", () => {
    expect(normalizeWebexTarget("  Y2lzY29  ")).toBe("Y2lzY29");
    expect(normalizeWebexTarget("  webex:Y2lzY29  ")).toBe("Y2lzY29");
  });

  it("should handle prefix with extra spaces", () => {
    expect(normalizeWebexTarget("webex:  Y2lzY29")).toBe("Y2lzY29");
  });
});

describe("isWebexId", () => {
  it("should recognize Webex IDs starting with Y2lz", () => {
    // Typical Webex ID is base64-encoded and starts with "Y2lz" (decoded: "cis")
    const webexId = "Y2lzY29zcGFyazovL3VzL1BFT1BMRS9hYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejEyMzQ1Ng";
    expect(isWebexId(webexId)).toBe(true);
  });

  it("should reject short strings", () => {
    expect(isWebexId("Y2lz")).toBe(false);
    expect(isWebexId("Y2lzY29")).toBe(false);
    expect(isWebexId("a".repeat(39))).toBe(false);
  });

  it("should accept strings of 40+ chars starting with Y2lz", () => {
    expect(isWebexId("Y2lz" + "a".repeat(36))).toBe(true);
  });

  it("should reject strings not starting with Y2lz", () => {
    expect(isWebexId("abcdefghijklmnopqrstuvwxyz1234567890abcdefghij")).toBe(false);
    expect(isWebexId("a".repeat(50))).toBe(false);
  });

  it("should reject strings with invalid base64 characters", () => {
    expect(isWebexId("Y2lz!@#$%^&*()")).toBe(false);
    expect(isWebexId("Y2lz" + " ".repeat(36))).toBe(false);
  });

  it("should accept valid base64 characters including URL-safe variants", () => {
    expect(isWebexId("Y2lz" + "abcABC012+/=_-".repeat(3))).toBe(true);
  });
});

describe("isEmail", () => {
  it("should recognize valid emails", () => {
    expect(isEmail("user@example.com")).toBe(true);
    expect(isEmail("user.name@example.co.uk")).toBe(true);
    expect(isEmail("user+tag@example.com")).toBe(true);
    expect(isEmail("a@b.co")).toBe(true);
  });

  it("should reject invalid emails", () => {
    expect(isEmail("not-an-email")).toBe(false);
    expect(isEmail("@example.com")).toBe(false);
    expect(isEmail("user@")).toBe(false);
    expect(isEmail("user@example")).toBe(false);
    expect(isEmail("user @example.com")).toBe(false);
    expect(isEmail("")).toBe(false);
  });

  it("should reject emails with spaces", () => {
    expect(isEmail("user name@example.com")).toBe(false);
    expect(isEmail("user@example .com")).toBe(false);
  });
});

describe("getWebexTargetType", () => {
  it("should detect email addresses", () => {
    expect(getWebexTargetType("user@example.com")).toBe("email");
    expect(getWebexTargetType("email:user@example.com")).toBe("email");
  });

  it("should detect Webex person IDs", () => {
    // Person ID with PEOPLE in decoded content
    const personId = Buffer.from("ciscospark://us/PEOPLE/abc123").toString("base64");
    expect(getWebexTargetType(personId)).toBe("personId");
  });

  it("should detect Webex room IDs", () => {
    // Room ID with ROOM in decoded content
    const roomId = Buffer.from("ciscospark://us/ROOM/abc123def456").toString("base64");
    expect(getWebexTargetType(roomId)).toBe("roomId");
  });

  it("should return personId for unknown Webex IDs", () => {
    // Generic ID starting with Y2lz but no type info
    const genericId = "Y2lz" + "a".repeat(50);
    expect(getWebexTargetType(genericId)).toBe("personId");
  });

  it("should return unknown for unrecognized formats", () => {
    expect(getWebexTargetType("short")).toBe("unknown");
    expect(getWebexTargetType("not-a-valid-id")).toBe("unknown");
  });

  it("should return unknown for empty strings", () => {
    expect(getWebexTargetType("")).toBe("unknown");
  });
});

describe("formatWebexTarget", () => {
  it("should lowercase email addresses", () => {
    expect(formatWebexTarget("User@Example.COM")).toBe("user@example.com");
    expect(formatWebexTarget("email:User@Example.COM")).toBe("user@example.com");
  });

  it("should truncate long IDs", () => {
    const longId = "a".repeat(50);
    const formatted = formatWebexTarget(longId);
    expect(formatted).toBe("aaaaaaaa...aaaaaaaa");
    expect(formatted.length).toBe(19); // 8 + 3 + 8
  });

  it("should preserve short IDs", () => {
    expect(formatWebexTarget("shortid")).toBe("shortid");
    expect(formatWebexTarget("a".repeat(20))).toBe("a".repeat(20));
  });

  it("should handle prefixed values", () => {
    expect(formatWebexTarget("webex:user@example.com")).toBe("user@example.com");
  });

  it("should return original for invalid input", () => {
    expect(formatWebexTarget("")).toBe("");
  });
});

describe("normalizeAllowFromEntry", () => {
  it("should normalize email to lowercase", () => {
    expect(normalizeAllowFromEntry("User@Example.COM")).toBe("user@example.com");
  });

  it("should strip prefixes and lowercase email", () => {
    expect(normalizeAllowFromEntry("webex:user@example.com")).toBe("user@example.com");
    expect(normalizeAllowFromEntry("email:User@Example.COM")).toBe("user@example.com");
  });

  it("should preserve Webex ID case", () => {
    const webexId = "Y2lzY29zcGFyazovL3VzL1BFT1BMRS9hYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejEyMzQ1Ng";
    expect(normalizeAllowFromEntry(webexId)).toBe(webexId);
  });

  it("should strip user: prefix from IDs", () => {
    expect(normalizeAllowFromEntry("user:Y2lzY29")).toBe("Y2lzY29");
  });

  it("should handle empty string", () => {
    expect(normalizeAllowFromEntry("")).toBe("");
  });

  it("should preserve unknown format case (not email)", () => {
    // Unknown formats are treated as potential Webex IDs, which are case-sensitive
    expect(normalizeAllowFromEntry("UNKNOWN")).toBe("UNKNOWN");
  });
});

describe("formatAllowFromEntry", () => {
  it("should format email to lowercase", () => {
    expect(formatAllowFromEntry("User@Example.COM")).toBe("user@example.com");
  });

  it("should preserve Webex ID case", () => {
    expect(formatAllowFromEntry("Y2lzY29")).toBe("Y2lzY29");
  });

  it("should strip prefixes", () => {
    expect(formatAllowFromEntry("webex:Y2lzY29")).toBe("Y2lzY29");
    expect(formatAllowFromEntry("email:user@example.com")).toBe("user@example.com");
  });

  it("should trim whitespace", () => {
    expect(formatAllowFromEntry("  user@example.com  ")).toBe("user@example.com");
  });
});

describe("getWebexTargetHints", () => {
  it("should return target hint string", () => {
    const hints = getWebexTargetHints();
    expect(hints).toBe("<personId|roomId|email@example.com>");
  });
});
