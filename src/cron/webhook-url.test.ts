import { describe, expect, it } from "vitest";
import {
  isCronWebhookTokenHostAllowed,
  isCronWebhookTokenHostEntry,
  normalizeHttpWebhookUrl,
} from "./webhook-url.js";

describe("normalizeHttpWebhookUrl", () => {
  it("accepts http and https URLs and rejects everything else", () => {
    expect(normalizeHttpWebhookUrl(" https://example.invalid/cron ")).toBe(
      "https://example.invalid/cron",
    );
    expect(normalizeHttpWebhookUrl("http://example.invalid/cron")).toBe(
      "http://example.invalid/cron",
    );
    expect(normalizeHttpWebhookUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeHttpWebhookUrl("")).toBeNull();
    expect(normalizeHttpWebhookUrl(42)).toBeNull();
  });
});

describe("isCronWebhookTokenHostAllowed", () => {
  it("denies every host when no allowlist is configured", () => {
    expect(isCronWebhookTokenHostAllowed("https://example.invalid/cron", undefined)).toBe(false);
    expect(isCronWebhookTokenHostAllowed("https://example.invalid/cron", [])).toBe(false);
    expect(isCronWebhookTokenHostAllowed("https://example.invalid/cron", ["  ", ""])).toBe(false);
  });

  it("matches configured hosts case-insensitively and ignores port and path", () => {
    expect(
      isCronWebhookTokenHostAllowed("https://Receiver.example.invalid:8443/cron?x=1", [
        "receiver.EXAMPLE.invalid",
      ]),
    ).toBe(true);
  });

  it("denies hosts that are not configured, including subdomains of configured hosts", () => {
    expect(
      isCronWebhookTokenHostAllowed("https://attacker.example.invalid/collect", [
        "receiver.example.invalid",
      ]),
    ).toBe(false);
    expect(
      isCronWebhookTokenHostAllowed("https://evil.receiver.example.invalid/collect", [
        "receiver.example.invalid",
      ]),
    ).toBe(false);
  });

  it("allows every host under a wildcard entry", () => {
    expect(isCronWebhookTokenHostAllowed("https://attacker.example.invalid/collect", ["*"])).toBe(
      true,
    );
  });

  it("rejects malformed URLs and non-string allowlist entries", () => {
    expect(isCronWebhookTokenHostAllowed("not a url", ["receiver.example.invalid"])).toBe(false);
    expect(isCronWebhookTokenHostAllowed("https://receiver.example.invalid/cron", [42])).toBe(
      false,
    );
  });

  it("tolerates trailing dots in configured hosts", () => {
    expect(
      isCronWebhookTokenHostAllowed("https://receiver.example.invalid/cron", [
        "receiver.example.invalid.",
      ]),
    ).toBe(true);
  });

  it("tolerates a DNS trailing dot in the destination URL", () => {
    expect(
      isCronWebhookTokenHostAllowed("https://receiver.example.invalid./cron", [
        "receiver.example.invalid",
      ]),
    ).toBe(true);
    expect(
      isCronWebhookTokenHostAllowed("https://receiver.example.invalid./cron", [
        "receiver.example.invalid.",
      ]),
    ).toBe(true);
    expect(
      isCronWebhookTokenHostAllowed("https://attacker.example.invalid./collect", [
        "receiver.example.invalid",
      ]),
    ).toBe(false);
  });
});

describe("isCronWebhookTokenHostEntry", () => {
  it("accepts bare hostnames, IP literals, and the wildcard", () => {
    for (const entry of [
      "hooks.example.com",
      "Hooks.Example.COM",
      "hooks.example.com.",
      "localhost",
      "my-host",
      "203.0.113.10",
      "[2001:db8::1]",
      "*",
    ]) {
      expect(isCronWebhookTokenHostEntry(entry), entry).toBe(true);
    }
  });

  it("rejects values that would never match a destination hostname", () => {
    for (const entry of [
      "https://hooks.example.com",
      "hooks.example.com/cron",
      "hooks.example.com:8443",
      "*.example.com",
      "user@hooks.example.com",
      "-hooks.example.com",
      "hooks..example.com",
      "hooks example.com",
      "",
      "   ",
    ]) {
      expect(isCronWebhookTokenHostEntry(entry), entry).toBe(false);
    }
  });
});
