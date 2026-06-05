// Discord tests cover gateway metadata plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  fetchDiscordGatewayInfo,
  resolveDiscordGatewayInfoTimeoutMs,
  resolveGatewayInfoWithFallback,
} from "./gateway-metadata.js";

describe("Discord gateway metadata", () => {
  it("resolves gateway info timeouts from strict integer config and env values", () => {
    expect(resolveDiscordGatewayInfoTimeoutMs({ configuredTimeoutMs: 45_000 })).toBe(45_000);
    expect(
      resolveDiscordGatewayInfoTimeoutMs({
        env: { OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS: "90000" },
      }),
    ).toBe(90_000);
    expect(resolveDiscordGatewayInfoTimeoutMs({ configuredTimeoutMs: 150_000 })).toBe(120_000);
    expect(
      resolveDiscordGatewayInfoTimeoutMs({
        configuredTimeoutMs: 1.5,
        env: { OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS: "0x1000" },
      }),
    ).toBe(30_000);
    expect(
      resolveDiscordGatewayInfoTimeoutMs({
        env: { OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS: "1e3" },
      }),
    ).toBe(30_000);
  });

  it("falls back on Cloudflare HTML rate limits without logging raw HTML", async () => {
    const error = await fetchDiscordGatewayInfo({
      token: "test",
      fetchImpl: async () =>
        new Response("<html><title>Error 1015</title><body>rate limited</body></html>", {
          status: 429,
          headers: { "content-type": "text/html" },
        }),
    }).catch((err: unknown) => err);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const resolved = resolveGatewayInfoWithFallback({ runtime, error });

    expect(resolved.usedFallback).toBe(true);
    expect(resolved.info.url).toBe("wss://gateway.discord.gg/");
    const logs = runtime.log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toBe(
      "discord: gateway metadata lookup failed transiently; using default gateway url (Failed to get gateway information from Discord: fetch failed | Discord API /gateway/bot failed (429): Error 1015 rate limited)",
    );
  });
});
