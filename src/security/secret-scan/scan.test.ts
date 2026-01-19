import { describe, expect, it, vi } from "vitest";

import { scanText } from "./scan.js";

describe("scanText", () => {
  it("returns early when mode is off", () => {
    const input = "OPENAI_API_KEY=sk-1234567890abcdef";
    const result = scanText(input, { config: { mode: "off" } });
    expect(result.blocked).toBe(false);
    expect(result.matches).toHaveLength(0);
    expect(result.redactedText).toBeUndefined();
  });

  it("blocks on detected secrets in block mode", () => {
    const input = "OPENAI_API_KEY=sk-1234567890abcdef";
    const result = scanText(input, { config: { mode: "block" } });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("match");
    expect(result.redactedText).toBe("OPENAI_API_KEY=sk-123…cdef");
  });

  it("redacts without blocking in redact mode", () => {
    const input = "TOKEN=abcdef1234567890ghij";
    const result = scanText(input, { config: { mode: "redact" } });
    expect(result.blocked).toBe(false);
    expect(result.redactedText).toBe("TOKEN=abcdef…ghij");
  });

  it("redacts overlapping keyword matches without leaking", () => {
    const input = 'password = "super secret value"';
    const result = scanText(input, { config: { mode: "redact" } });
    expect(result.blocked).toBe(false);
    expect(result.redactedText).toBeDefined();
    expect(result.redactedText).not.toContain("secret value");
    expect(result.redactedText).not.toContain("super secret value");
  });

  it("redacts repeated group values without masking the key", () => {
    const input = "password=password";
    const result = scanText(input, { config: { mode: "redact" } });
    expect(result.blocked).toBe(false);
    expect(result.redactedText).toBeDefined();
    expect(result.redactedText).not.toBe(input);
    expect(result.redactedText).toContain("password=");
    expect(result.redactedText).not.toContain("password=password");
  });

  it("redacts reversed keyword comparisons without masking identifiers", () => {
    const input = 'if ("password" == my_password) {';
    const result = scanText(input, { config: { mode: "redact" } });
    expect(result.blocked).toBe(false);
    expect(result.redactedText).toBeDefined();
    expect(result.redactedText).toContain("my_password");
    expect(result.redactedText).not.toContain("\"password\"");
  });

  it("blocks on overflow when overflow policy is block", () => {
    const input = "a".repeat(20);
    const result = scanText(input, {
      config: { mode: "block", maxChars: 10, overflow: "block" },
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("too_long");
  });

  it("truncates and warns when overflow policy is truncate", () => {
    const warn = vi.fn();
    const input = "TOKEN=abcdef1234567890ghij";
    const result = scanText(input, {
      config: { mode: "redact", maxChars: 10, overflow: "truncate" },
      warn,
    });
    expect(result.blocked).toBe(false);
    expect(result.truncated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]?.message).toContain("truncated");
    expect(result.redactedText).toBeDefined();
    expect(result.redactedText?.endsWith(input.slice(10))).toBe(true);
  });

  it("detects high-entropy hex strings", () => {
    const token = "0123456789abcdef".repeat(4);
    const input = `payload=${token}`;
    const result = scanText(input, { config: { mode: "block" } });
    expect(result.blocked).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.redactedText).toContain("payload=");
  });

  it("ignores low-entropy hex strings", () => {
    const token = "a".repeat(40);
    const input = `payload=${token}`;
    const result = scanText(input, { config: { mode: "redact" } });
    expect(result.matches.length).toBe(0);
    expect(result.blocked).toBe(false);
  });
});
