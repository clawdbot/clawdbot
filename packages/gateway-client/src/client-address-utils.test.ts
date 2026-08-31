import { describe, expect, it } from "vitest";
import { normalizeTlsFingerprint } from "./client-address-utils.js";

const CANONICAL_FINGERPRINT = "ab".repeat(32);
const COLON_FINGERPRINT = CANONICAL_FINGERPRINT.match(/.{2}/gu)?.join(":") ?? "";

describe("TLS fingerprint normalization", () => {
  it.each([
    `sha256:${CANONICAL_FINGERPRINT.toUpperCase()}`,
    CANONICAL_FINGERPRINT.toUpperCase(),
    COLON_FINGERPRINT,
    `ShA256:${COLON_FINGERPRINT.toUpperCase()}`,
  ])("canonicalizes %s", (fingerprint) => {
    expect(normalizeTlsFingerprint(fingerprint)).toBe(CANONICAL_FINGERPRINT);
  });

  it.each([
    "",
    "abc123",
    "sha256:abc123",
    "g".repeat(64),
    `${CANONICAL_FINGERPRINT}:`,
    `sha256:${CANONICAL_FINGERPRINT}-junk`,
    `sha256:${CANONICAL_FINGERPRINT.slice(2)}`,
  ])("rejects invalid fingerprint %s", (fingerprint) => {
    expect(normalizeTlsFingerprint(fingerprint)).toBe("");
  });
});
