// Discord tests cover probe.intents plugin behavior.
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchDiscordApplicationId,
  fetchDiscordApplicationSummary,
  probeDiscord,
  resolveDiscordPrivilegedIntentsFromFlags,
} from "./probe.js";
import { jsonResponse } from "./test-http-helpers.js";

const DISCORD_PROBE_JSON_CAP_BYTES = 16 * 1024 * 1024;

function oversizedDiscordProbeJsonResponse(onCancel: () => void): Response {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(DISCORD_PROBE_JSON_CAP_BYTES + 1));
      },
      cancel() {
        onCancel();
      },
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
  Object.defineProperty(response, "json", {
    value: async () => {
      throw new Error("unbounded json reader was used");
    },
  });
  return response;
}

describe("resolveDiscordPrivilegedIntentsFromFlags", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports disabled when no bits set", () => {
    expect(resolveDiscordPrivilegedIntentsFromFlags(0)).toEqual({
      presence: "disabled",
      guildMembers: "disabled",
      messageContent: "disabled",
    });
  });

  it("reports enabled when full intent bits set", () => {
    const flags = (1 << 12) | (1 << 14) | (1 << 18);
    expect(resolveDiscordPrivilegedIntentsFromFlags(flags)).toEqual({
      presence: "enabled",
      guildMembers: "enabled",
      messageContent: "enabled",
    });
  });

  it("reports limited when limited intent bits set", () => {
    const flags = (1 << 13) | (1 << 15) | (1 << 19);
    expect(resolveDiscordPrivilegedIntentsFromFlags(flags)).toEqual({
      presence: "limited",
      guildMembers: "limited",
      messageContent: "limited",
    });
  });

  it("prefers enabled over limited when both set", () => {
    const flags = (1 << 12) | (1 << 13) | (1 << 14) | (1 << 15) | (1 << 18) | (1 << 19);
    expect(resolveDiscordPrivilegedIntentsFromFlags(flags)).toEqual({
      presence: "enabled",
      guildMembers: "enabled",
      messageContent: "enabled",
    });
  });

  it("retries Cloudflare HTML rate limits during application id lookup", async () => {
    let calls = 0;
    const fetcher = withFetchPreconnect(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("<html><title>Error 1015</title></html>", {
          status: 429,
          headers: { "content-type": "text/html", "retry-after": "0" },
        });
      }
      return jsonResponse({ id: "app-1" });
    });

    vi.useFakeTimers();
    const lookup = fetchDiscordApplicationId("unparseable.token", 1_000, fetcher);
    await vi.runAllTimersAsync();

    await expect(lookup).resolves.toBe("app-1");
    expect(calls).toBe(2);
  });

  it("does not retry Cloudflare HTML rate limits during application summary probes", async () => {
    let calls = 0;
    const fetcher = withFetchPreconnect(async () => {
      calls += 1;
      return new Response("<html><title>Error 1015</title></html>", {
        status: 429,
        headers: { "content-type": "text/html" },
      });
    });

    await expect(
      fetchDiscordApplicationSummary("unparseable.token", 1_000, fetcher),
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it("cancels failed getMe probe response bodies", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetcher = withFetchPreconnect(
      async () => ({ ok: false, status: 401, body: { cancel } }) as unknown as Response,
    );

    await expect(probeDiscord("MTIz.abc.def", 1_000, { fetcher })).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: "getMe failed (401)",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds oversized getMe probe JSON responses and cancels the stream", async () => {
    let cancelCount = 0;
    const fetcher = withFetchPreconnect(async () =>
      oversizedDiscordProbeJsonResponse(() => {
        cancelCount += 1;
      }),
    );

    await expect(probeDiscord("MTIz.abc.def", 1_000, { fetcher })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("discord.probe.getMe: JSON response exceeds 16777216 bytes"),
    });
    expect(cancelCount).toBe(1);
  });

  it("derives application id from parseable tokens before probing REST", async () => {
    let calls = 0;
    const fetcher = withFetchPreconnect(async () => {
      calls += 1;
      return new Response("<html><title>Error 1015</title></html>", {
        status: 429,
        headers: { "content-type": "text/html" },
      });
    });

    await expect(fetchDiscordApplicationId("MTIz.abc.def", 1_000, fetcher)).resolves.toBe("123");
    expect(calls).toBe(0);
  });
});
