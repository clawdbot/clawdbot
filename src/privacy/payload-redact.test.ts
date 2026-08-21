import { describe, expect, it } from "vitest";
import {
  applyRuntimeLineMasking,
  redactContextFileContent,
  redactPii,
  redactPiiText,
} from "./payload-redact.js";
import type { PrivacyConfig } from "./types.js";

const ENABLED: PrivacyConfig = {
  enabled: true,
  pii: { enabled: true },
  systemPrompt: {},
};

describe("redactPii", () => {
  it("returns original text when privacy is disabled", () => {
    const text = "Contact: user@example.com or 555-123-4567";
    expect(redactPii(text, { enabled: false }).text).toBe(text);
    expect(redactPii(text, undefined).text).toBe(text);
  });

  it("redacts email addresses", () => {
    const text = "Send reports to alice@example.com and bob.smith+tag@corp.io please.";
    const result = redactPiiText(text, ENABLED);
    expect(result).not.toContain("alice@example.com");
    expect(result).not.toContain("bob.smith+tag@corp.io");
    expect(result).toContain("[EMAIL]");
  });

  it("redacts US phone numbers in various formats", () => {
    const phones = ["555-123-4567", "(555) 123-4567", "+1 555 123 4567", "5551234567"];
    for (const phone of phones) {
      const result = redactPiiText(`Call me at ${phone} anytime.`, ENABLED);
      expect(result).not.toContain(phone);
      expect(result).toContain("[PHONE]");
    }
  });

  it("redacts US SSNs", () => {
    // Note: SSNs starting with 9xx are technically invalid and excluded by the
    // pattern to reduce false-positives. Use valid area numbers in tests.
    const text = "SSN: 123-45-6789 or 456 78 9012";
    const result = redactPiiText(text, ENABLED);
    expect(result).not.toContain("123-45-6789");
    expect(result).not.toContain("456 78 9012");
    expect(result).toContain("[SSN]");
  });

  it("redacts credit card numbers", () => {
    const cards = [
      "4111 1111 1111 1111", // Visa
      "5500-0000-0000-0004", // Mastercard
      "371449635398431", // Amex
    ];
    for (const card of cards) {
      const result = redactPiiText(`Payment: ${card}`, ENABLED);
      expect(result).not.toContain(card.replace(/[-\s]/g, ""));
      expect(result).toContain("[CARD]");
    }
  });

  it("redacts IPv4 addresses", () => {
    const text = "Server is at 192.168.1.100 and backup at 10.0.0.55";
    const result = redactPiiText(text, ENABLED);
    expect(result).not.toContain("192.168.1.100");
    expect(result).not.toContain("10.0.0.55");
    expect(result).toContain("[IPv4]");
  });

  it("redacts UUIDs", () => {
    const text = "Session ID: 550e8400-e29b-41d4-a716-446655440000";
    const result = redactPiiText(text, ENABLED);
    expect(result).not.toContain("550e8400-e29b-41d4-a716-446655440000");
    expect(result).toContain("[UUID]");
  });

  it("allows per-category opt-out", () => {
    const config: PrivacyConfig = {
      enabled: true,
      pii: {
        enabled: true,
        categories: { email: { redact: false } },
      },
    };
    const text = "Contact: alice@example.com, SSN: 123-45-6789";
    const result = redactPiiText(text, config);
    expect(result).toContain("alice@example.com"); // preserved
    expect(result).not.toContain("123-45-6789"); // still redacted
  });

  it("allows custom placeholders", () => {
    const config: PrivacyConfig = {
      enabled: true,
      pii: {
        enabled: true,
        categories: { email: { placeholder: "<<EMAIL_REDACTED>>" } },
      },
    };
    const result = redactPiiText("user@example.com", config);
    expect(result).toBe("<<EMAIL_REDACTED>>");
  });

  it("returns stats with replacement counts", () => {
    const text = "a@b.com and c@d.com";
    const { stats } = redactPii(text, ENABLED);
    expect(stats.totalReplacements).toBe(2);
    expect(stats.byCategory["email"]).toBe(2);
  });
});

describe("applyRuntimeLineMasking", () => {
  const runtimeLine =
    "Runtime: agent=main | host=Partha's MacBook Pro | repo=/home/partha/.openclaw/workspace | os=Darwin 25.3.0 (arm64) | node=v24.0.0 | model=claude-sonnet | shell=zsh | thinking=low";

  it("passes through unchanged when privacy disabled", () => {
    expect(applyRuntimeLineMasking(runtimeLine, { enabled: false })).toBe(runtimeLine);
    expect(applyRuntimeLineMasking(runtimeLine, undefined)).toBe(runtimeLine);
  });

  it("masks hostname", () => {
    const config: PrivacyConfig = { enabled: true, systemPrompt: { maskHostname: true } };
    const result = applyRuntimeLineMasking(runtimeLine, config);
    expect(result).not.toContain("Partha's MacBook Pro");
    expect(result).not.toContain("host=");
  });

  it("masks OS info", () => {
    const config: PrivacyConfig = { enabled: true, systemPrompt: { maskOs: true } };
    const result = applyRuntimeLineMasking(runtimeLine, config);
    expect(result).not.toContain("Darwin");
    expect(result).not.toContain("os=");
  });

  it("masks shell", () => {
    const config: PrivacyConfig = { enabled: true, systemPrompt: { maskShell: true } };
    const result = applyRuntimeLineMasking(runtimeLine, config);
    expect(result).not.toContain("shell=zsh");
  });

  it("masks repo path to basename only", () => {
    const config: PrivacyConfig = { enabled: true, systemPrompt: { maskRepoPath: true } };
    const result = applyRuntimeLineMasking(runtimeLine, config);
    expect(result).not.toContain("/home/partha");
    expect(result).toContain("repo=workspace");
  });

  it("applies multiple masks simultaneously", () => {
    const config: PrivacyConfig = {
      enabled: true,
      systemPrompt: { maskHostname: true, maskOs: true, maskShell: true, maskRepoPath: true },
    };
    const result = applyRuntimeLineMasking(runtimeLine, config);
    expect(result).not.toContain("host=");
    expect(result).not.toContain("os=");
    expect(result).not.toContain("shell=");
    expect(result).not.toContain("/home/partha");
    // Non-masked fields should survive
    expect(result).toContain("agent=main");
    expect(result).toContain("node=v24.0.0");
  });
});

describe("redactContextFileContent", () => {
  it("returns content unchanged when privacy disabled", () => {
    const content = "Name: Alice, SSN: 123-45-6789";
    expect(redactContextFileContent("USER.md", content, { enabled: false })).toBe(content);
    expect(redactContextFileContent("USER.md", content, undefined)).toBe(content);
  });

  it("returns empty string when suppressContextFiles=true", () => {
    const config: PrivacyConfig = {
      enabled: true,
      systemPrompt: { suppressContextFiles: true },
    };
    expect(redactContextFileContent("SOUL.md", "some content", config)).toBe("");
  });

  it("redacts PII in context files when pii.systemPrompt=true", () => {
    const config: PrivacyConfig = {
      enabled: true,
      pii: { enabled: true, systemPrompt: true },
    };
    const content = "My email is alice@example.com and my IP is 192.168.1.1";
    const result = redactContextFileContent("USER.md", content, config);
    expect(result).not.toContain("alice@example.com");
    expect(result).not.toContain("192.168.1.1");
  });

  it("skips PII redaction in context files when pii.systemPrompt=false", () => {
    const config: PrivacyConfig = {
      enabled: true,
      pii: { enabled: true, systemPrompt: false },
    };
    const content = "Contact: alice@example.com";
    const result = redactContextFileContent("USER.md", content, config);
    expect(result).toContain("alice@example.com");
  });
});
