import { describe, expect, it } from "vitest";
import { normalizeHttpWebhookUrl } from "./webhook-url.js";

function credentialWebhookUrl(username = "user", password = "password"): string {
  const url = new URL("https://example.invalid/hook");
  url.username = username;
  url.password = password;
  return url.href;
}

describe("normalizeHttpWebhookUrl", () => {
  it.each([
    ["https://example.invalid/hook", "https://example.invalid/hook"],
    ["  http://example.invalid/hook  ", "http://example.invalid/hook"],
    ["ftp://example.invalid/hook", null],
    ["not-a-url", null],
    ["", null],
  ])("normalizes %j", (value, expected) => {
    expect(normalizeHttpWebhookUrl(value)).toBe(expected);
  });

  it.each([
    credentialWebhookUrl("user", ""),
    credentialWebhookUrl(),
    credentialWebhookUrl("user@name"),
  ])("rejects URL-embedded credentials in %s", (value) => {
    expect(normalizeHttpWebhookUrl(value)).toBeNull();
  });
});
