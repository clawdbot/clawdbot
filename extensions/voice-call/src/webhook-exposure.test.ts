import { describe, expect, it } from "vitest";
import { isLocalOnlyWebhookHost, isProviderUnreachableWebhookUrl } from "./webhook-exposure.js";

describe("webhook exposure host classification", () => {
  it.each([
    "http://[::]:3334/voice/webhook",
    "http://[::1]:3334/voice/webhook",
    "http://[fc00::1]/voice/webhook",
    "http://[fd00::1]/voice/webhook",
    "http://[::ffff:127.0.0.1]/voice/webhook",
    "http://[::ffff:10.0.0.1]/voice/webhook",
    "http://[::ffff:192.168.0.1]/voice/webhook",
    "http://[::ffff:172.16.0.1]/voice/webhook",
    "http://[fe80::1]/voice/webhook",
  ])("treats local/private webhook URL %s as provider-unreachable", (url) => {
    expect(isProviderUnreachableWebhookUrl(url)).toBe(true);
  });

  it.each([
    "http://[::ffff:8.8.8.8]/voice/webhook",
    "https://voice.example.com/voice/webhook",
    "https://fcloud.example/voice/webhook",
  ])("does not reject public webhook URL %s", (url) => {
    expect(isProviderUnreachableWebhookUrl(url)).toBe(false);
  });

  it.each(["[::1]", "[fc00::1]", "[fd00::1]", "::ffff:7f00:1", "::ffff:a00:1", "[fe80::1]"])(
    "normalizes local/private URL hostnames like %s",
    (host) => {
      expect(isLocalOnlyWebhookHost(host)).toBe(true);
    },
  );
});
