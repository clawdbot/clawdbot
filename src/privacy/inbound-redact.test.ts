/**
 * Integration-style unit tests for the three new privacy hook points:
 *   1. Tool output redaction (emitToolResultOutput path)
 *   2. User message redaction (commandBody path)
 *   3. TTS text redaction (maybeApplyTtsToPayload path)
 *
 * These tests exercise the redactPiiText() function as used by each hook,
 * confirming the correct conditional logic around privacy config flags.
 */
import { describe, expect, it } from "vitest";
import { redactPiiText } from "./payload-redact.js";
import type { PrivacyConfig } from "./types.js";

// ──────────────────────────────────────────────────────────────────────────────
// Helper: simulate the guard conditions used at each hook site
// ──────────────────────────────────────────────────────────────────────────────

function applyToolOutputRedaction(text: string, privacy?: PrivacyConfig): string {
  if (privacy?.enabled && privacy.pii?.enabled && privacy.pii.toolOutputs !== false) {
    return redactPiiText(text, privacy);
  }
  return text;
}

function applyUserMessageRedaction(text: string, privacy?: PrivacyConfig): string {
  if (privacy?.enabled && privacy.pii?.enabled && privacy.pii.userMessages === true) {
    return redactPiiText(text, privacy);
  }
  return text;
}

function applyTtsRedaction(text: string, privacy?: PrivacyConfig): string {
  if (privacy?.enabled && privacy.pii?.enabled) {
    return redactPiiText(text, privacy);
  }
  return text;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tool output redaction
// ──────────────────────────────────────────────────────────────────────────────

describe("tool output redaction", () => {
  const piiText = "Server: 192.168.1.100, contact: admin@corp.io";

  it("is skipped when privacy.enabled=false", () => {
    expect(applyToolOutputRedaction(piiText, { enabled: false, pii: { enabled: true } })).toBe(
      piiText,
    );
  });

  it("is skipped when pii.enabled=false", () => {
    expect(applyToolOutputRedaction(piiText, { enabled: true, pii: { enabled: false } })).toBe(
      piiText,
    );
  });

  it("is active by default (toolOutputs not set)", () => {
    const result = applyToolOutputRedaction(piiText, { enabled: true, pii: { enabled: true } });
    expect(result).not.toContain("192.168.1.100");
    expect(result).not.toContain("admin@corp.io");
  });

  it("can be disabled via pii.toolOutputs=false", () => {
    const result = applyToolOutputRedaction(piiText, {
      enabled: true,
      pii: { enabled: true, toolOutputs: false },
    });
    expect(result).toBe(piiText);
  });

  it("replaces all PII categories found in tool text", () => {
    const rich = "User SSN: 123-45-6789, card: 4111 1111 1111 1111, ip: 10.0.0.1";
    const result = applyToolOutputRedaction(rich, { enabled: true, pii: { enabled: true } });
    expect(result).toContain("[SSN]");
    expect(result).toContain("[CARD]");
    expect(result).toContain("[IPv4]");
    expect(result).not.toContain("123-45-6789");
    expect(result).not.toContain("4111");
    expect(result).not.toContain("10.0.0.1");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// User message (inbound) redaction
// ──────────────────────────────────────────────────────────────────────────────

describe("user message redaction", () => {
  const userMsg = "My email is user@example.com and my phone is 555-123-4567";

  it("is skipped by default even when pii.enabled=true (opt-in only)", () => {
    // userMessages is NOT set → should NOT redact
    const result = applyUserMessageRedaction(userMsg, { enabled: true, pii: { enabled: true } });
    expect(result).toBe(userMsg);
  });

  it("is skipped when pii.userMessages=false explicitly", () => {
    const result = applyUserMessageRedaction(userMsg, {
      enabled: true,
      pii: { enabled: true, userMessages: false },
    });
    expect(result).toBe(userMsg);
  });

  it("activates when pii.userMessages=true", () => {
    const result = applyUserMessageRedaction(userMsg, {
      enabled: true,
      pii: { enabled: true, userMessages: true },
    });
    expect(result).not.toContain("user@example.com");
    expect(result).not.toContain("555-123-4567");
    expect(result).toContain("[EMAIL]");
    expect(result).toContain("[PHONE]");
  });

  it("is skipped when master privacy.enabled=false", () => {
    const result = applyUserMessageRedaction(userMsg, {
      enabled: false,
      pii: { enabled: true, userMessages: true },
    });
    expect(result).toBe(userMsg);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// TTS text redaction
// ──────────────────────────────────────────────────────────────────────────────

describe("TTS text redaction", () => {
  const ttsText = "Your account number is 4111 1111 1111 1111 and email alice@bank.io";

  it("is skipped when privacy disabled", () => {
    expect(applyTtsRedaction(ttsText, { enabled: false, pii: { enabled: true } })).toBe(ttsText);
    expect(applyTtsRedaction(ttsText, undefined)).toBe(ttsText);
  });

  it("is skipped when pii.enabled=false", () => {
    expect(applyTtsRedaction(ttsText, { enabled: true, pii: { enabled: false } })).toBe(ttsText);
  });

  it("redacts PII from TTS text before sending to provider", () => {
    const result = applyTtsRedaction(ttsText, { enabled: true, pii: { enabled: true } });
    expect(result).not.toContain("4111 1111 1111 1111");
    expect(result).not.toContain("alice@bank.io");
    expect(result).toContain("[CARD]");
    expect(result).toContain("[EMAIL]");
  });

  it("preserves non-PII content", () => {
    const safe = "The weather in Mumbai today is 32°C with high humidity.";
    const result = applyTtsRedaction(safe, { enabled: true, pii: { enabled: true } });
    expect(result).toBe(safe);
  });
});
