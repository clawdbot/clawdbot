import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  fetchDiscordApplicationId,
  fetchDiscordApplicationSummary,
  resolveDiscordPrivilegedIntentsFromFlags,
} from "./probe.js";
import { jsonResponse } from "./test-http-helpers.js";

describe("resolveDiscordPrivilegedIntentsFromFlags", () => {
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

    await expect(fetchDiscordApplicationId("unparseable.token", 1_000, fetcher)).resolves.toBe(
      "app-1",
    );
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
