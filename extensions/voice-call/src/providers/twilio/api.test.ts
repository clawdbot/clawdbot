import { afterEach, describe, expect, it, vi } from "vitest";
import { twilioApiRequest } from "./api.js";

const originalFetch = globalThis.fetch;

describe("twilioApiRequest", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts form bodies with basic auth and parses json", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ sid: "CA123" }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      twilioApiRequest({
        baseUrl: "https://api.twilio.com",
        accountSid: "AC123",
        authToken: "secret",
        endpoint: "/Calls.json",
        body: {
          To: "+14155550123",
          StatusCallbackEvent: ["initiated", "completed"],
        },
      }),
    ).resolves.toEqual({ sid: "CA123" });

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    expect(url).toBe("https://api.twilio.com/Calls.json");
    expect(init).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from("AC123:secret").toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }),
    );
    const requestBody = init?.body;
    if (!(requestBody instanceof URLSearchParams)) {
      throw new Error("expected URLSearchParams request body");
    }
    expect(requestBody.toString()).toBe(
      "To=%2B14155550123&StatusCallbackEvent=initiated&StatusCallbackEvent=completed",
    );
  });

  it("passes through URLSearchParams, allows 404s, and returns undefined for empty bodies", async () => {
    const responses = [
      new Response(null, { status: 204 }),
      new Response("missing", { status: 404 }),
    ];
    globalThis.fetch = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;

    await expect(
      twilioApiRequest({
        baseUrl: "https://api.twilio.com",
        accountSid: "AC123",
        authToken: "secret",
        endpoint: "/Calls.json",
        body: new URLSearchParams({ To: "+14155550123" }),
      }),
    ).resolves.toBeUndefined();

    await expect(
      twilioApiRequest({
        baseUrl: "https://api.twilio.com",
        accountSid: "AC123",
        authToken: "secret",
        endpoint: "/Calls/missing.json",
        body: {},
        allowNotFound: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("throws twilio api errors for non-ok responses", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("bad request", { status: 400 }),
    ) as unknown as typeof fetch;

    await expect(
      twilioApiRequest({
        baseUrl: "https://api.twilio.com",
        accountSid: "AC123",
        authToken: "secret",
        endpoint: "/Calls.json",
        body: {},
      }),
    ).rejects.toThrow("Twilio API error: 400 bad request");
  });
});
