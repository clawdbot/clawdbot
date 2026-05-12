import { describe, expect, it } from "vitest";
import { REDACTED_SENTINEL } from "./redact-snapshot.js";
import { replaceSensitiveValuesInRaw } from "./redact-snapshot.raw.js";

describe("replaceSensitiveValuesInRaw", () => {
  it("ignores empty string replacement tokens", () => {
    const raw = '{ "gateway": { "auth": { "token": "" } }, "other": "" }';

    const result = replaceSensitiveValuesInRaw({
      raw,
      sensitiveValues: [""],
      redactedSentinel: REDACTED_SENTINEL,
    });

    expect(result).toBe(raw);
  });

  it("redacts non-empty values while preserving blank strings", () => {
    const raw = '{ "token": "", "secret": "abc123", "other": "" }';

    const result = replaceSensitiveValuesInRaw({
      raw,
      sensitiveValues: ["", "abc123"],
      redactedSentinel: REDACTED_SENTINEL,
    });

    expect(result).toBe(`{ "token": "", "secret": "${REDACTED_SENTINEL}", "other": "" }`);
  });

  it("replaces longest values first for overlapping matches", () => {
    const raw = '{ "token": "abcd", "prefix": "ab" }';

    const result = replaceSensitiveValuesInRaw({
      raw,
      sensitiveValues: ["ab", "abcd", "abcd"],
      redactedSentinel: REDACTED_SENTINEL,
    });

    expect(result).toBe(`{ "token": "${REDACTED_SENTINEL}", "prefix": "${REDACTED_SENTINEL}" }`);
  });
});
