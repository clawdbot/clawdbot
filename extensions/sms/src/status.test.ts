// Sms tests cover status plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSmsProbeLines, probeSmsAccount } from "./status.js";
import type { ResolvedSmsAccount } from "./types.js";

function createAccount(overrides: Partial<ResolvedSmsAccount> = {}): ResolvedSmsAccount {
  return {
    accountId: "default",
    enabled: true,
    accountSid: "AC123",
    authToken: "secret",
    fromNumber: "+15557654321",
    messagingServiceSid: "",
    defaultTo: "",
    webhookPath: "/webhooks/sms",
    publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit: 1500,
    ...overrides,
  };
}

function createFetch(responses: Array<unknown>): typeof fetch {
  return vi.fn(async () => {
    const payload = responses.shift();
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SMS status probe", () => {
  it("reports a healthy Twilio SMS webhook", async () => {
    const fetchImpl = createFetch([
      {
        incoming_phone_numbers: [
          {
            phone_number: "+15557654321",
            sms_url: "https://gateway.example.com/webhooks/sms",
            sms_method: "POST",
            voice_url: "https://gateway.example.com/voice/webhook",
          },
        ],
      },
      {
        messages: [
          {
            sid: "SM123",
            direction: "inbound",
            status: "received",
            to: "+15557654321",
            from: "+15551234567",
          },
        ],
      },
    ]);

    await expect(
      probeSmsAccount({
        account: createAccount(),
        timeoutMs: 1000,
        options: { fetchImpl },
      }),
    ).resolves.toMatchObject({
      ok: true,
      webhook: {
        status: "matches",
        configuredUrl: "https://gateway.example.com/webhooks/sms",
        voiceUrl: "https://gateway.example.com/voice/webhook",
      },
      recentInbound: {
        sid: "SM123",
        status: "received",
      },
    });
    const result = await probeSmsAccount({
      account: createAccount(),
      timeoutMs: 1000,
      options: {
        fetchImpl: createFetch([
          {
            incoming_phone_numbers: [
              {
                phone_number: "+15557654321",
                sms_url: "https://gateway.example.com/webhooks/sms",
                sms_method: "POST",
              },
            ],
          },
          {
            messages: [
              {
                sid: "SM456",
                direction: "inbound",
                status: "received",
                to: "+15557654321",
                from: "+15551234567",
              },
            ],
          },
        ]),
      },
    });
    expect(result.recentInbound).not.toHaveProperty("from");
    expect(result.recentInbound).not.toHaveProperty("to");
  });

  it("detects a Twilio SMS webhook URL mismatch", async () => {
    const fetchImpl = createFetch([
      {
        incoming_phone_numbers: [
          {
            phone_number: "+15557654321",
            sms_url: "https://old.example.com/webhooks/sms",
            sms_method: "POST",
          },
        ],
      },
      { messages: [] },
    ]);

    await expect(
      probeSmsAccount({
        account: createAccount(),
        timeoutMs: 1000,
        options: { fetchImpl },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error:
        "Twilio number +15557654321 points SMS webhooks at https://old.example.com/webhooks/sms; expected https://gateway.example.com/webhooks/sms.",
      webhook: {
        status: "url-mismatch",
      },
    });
  });

  it("surfaces Twilio 11200 recent inbound failures and Funnel hints", async () => {
    const fetchImpl = createFetch([
      {
        incoming_phone_numbers: [
          {
            phone_number: "+15557654321",
            sms_url: "https://mac-studio.example.ts.net/webhooks/sms",
            sms_method: "POST",
          },
        ],
      },
      {
        messages: [
          {
            sid: "SM11200",
            direction: "inbound",
            status: "received",
            to: "+15557654321",
            from: "+15551234567",
            error_code: 11200,
          },
        ],
      },
    ]);

    const result = await probeSmsAccount({
      account: createAccount({
        publicWebhookUrl: "https://mac-studio.example.ts.net/webhooks/sms",
      }),
      timeoutMs: 1000,
      options: { fetchImpl },
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Recent inbound SMS SM11200 has Twilio error 11200.",
      recentInbound: {
        sid: "SM11200",
        errorCode: "11200",
      },
    });
    expect(result.hints).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Tailscale Funnel must expose the exact SMS path"),
        expect.stringContaining("Twilio error 11200 means Twilio could not reach"),
      ]),
    );
  });

  it("validates Twilio Messaging Service webhook settings", async () => {
    const fetchImpl = createFetch([
      {
        sid: "MG123",
        inbound_request_url: "https://gateway.example.com/webhooks/sms",
        inbound_method: "POST",
        use_inbound_webhook_on_number: false,
      },
    ]);

    await expect(
      probeSmsAccount({
        account: createAccount({
          fromNumber: "",
          messagingServiceSid: "MG123",
        }),
        timeoutMs: 1000,
        options: { fetchImpl },
      }),
    ).resolves.toMatchObject({
      ok: true,
      webhook: {
        status: "messaging-service-matches",
        serviceSid: "MG123",
        configuredUrl: "https://gateway.example.com/webhooks/sms",
      },
    });
  });

  it("does not report Messaging Service defer-to-number probes as healthy", async () => {
    const fetchImpl = createFetch([
      {
        sid: "MG123",
        inbound_request_url: "https://gateway.example.com/webhooks/sms",
        inbound_method: "POST",
        use_inbound_webhook_on_number: true,
      },
    ]);

    await expect(
      probeSmsAccount({
        account: createAccount({
          fromNumber: "",
          messagingServiceSid: "MG123",
        }),
        timeoutMs: 1000,
        options: { fetchImpl },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error:
        "Twilio Messaging Service defers inbound webhooks to sender phone numbers; configure fromNumber or disable defer-to-sender before probing.",
      webhook: {
        status: "unavailable",
      },
    });
  });

  it("formats probe details for channel capability output", () => {
    expect(
      formatSmsProbeLines({
        ok: false,
        error: "Recent inbound SMS SM11200 has Twilio error 11200.",
        webhook: { status: "matches", configuredUrl: "https://gateway.example.com/webhooks/sms" },
        recentInbound: { sid: "SM11200", status: "received", errorCode: "11200" },
        recentOutbound: {
          messageSid: "SM-outbound",
          status: "undelivered",
          errorCode: "30005",
          lastObservedAt: 1,
        },
        hints: ["Check the public route."],
      }),
    ).toEqual([
      {
        text: "Probe: failed (Recent inbound SMS SM11200 has Twilio error 11200.)",
        tone: "error",
      },
      { text: "Twilio SMS webhook: https://gateway.example.com/webhooks/sms" },
      { text: "Recent inbound: received error=11200", tone: "warn" },
      { text: "Recent outbound: undelivered error=30005", tone: "error" },
      { text: "Check the public route.", tone: "warn" },
    ]);
  });

  it("formats canceled outbound delivery as an error", () => {
    expect(
      formatSmsProbeLines({
        ok: true,
        recentOutbound: {
          messageSid: "SM-canceled",
          status: "canceled",
          lastObservedAt: 1,
        },
        hints: [],
      }),
    ).toContainEqual({
      text: "Recent outbound: canceled",
      tone: "error",
    });
  });

  it("projects recent durable delivery state without message addresses", async () => {
    const result = await probeSmsAccount({
      account: createAccount(),
      timeoutMs: 1000,
      options: {
        fetchImpl: createFetch([
          {
            incoming_phone_numbers: [
              {
                phone_number: "+15557654321",
                sms_url: "https://gateway.example.com/webhooks/sms",
                sms_method: "POST",
              },
            ],
          },
          { messages: [] },
        ]),
        deliveryRecords: [
          {
            accountId: "default",
            accountSidHash: "account-sid-hash",
            messageSid: "SM-delivered",
            status: "delivered",
            firstObservedAt: 1,
            lastObservedAt: 2,
            observations: [],
          },
        ],
      },
    });

    expect(result.recentOutbound).toEqual({
      messageSid: "SM-delivered",
      status: "delivered",
      lastObservedAt: 2,
    });
    expect(result.recentOutbound).not.toHaveProperty("accountId");
    expect(result.recentOutbound).not.toHaveProperty("observations");
  });

  it("preserves recent durable delivery state when Twilio probes fail", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("Twilio unavailable");
    });

    const result = await probeSmsAccount({
      account: createAccount(),
      timeoutMs: 1000,
      options: {
        fetchImpl,
        deliveryRecords: [
          {
            accountId: "default",
            accountSidHash: "account-sid-hash",
            messageSid: "SM-failed",
            status: "failed",
            errorCode: "30005",
            firstObservedAt: 1,
            lastObservedAt: 2,
            observations: [],
          },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Twilio unavailable"),
      webhook: { status: "unavailable" },
      recentOutbound: {
        messageSid: "SM-failed",
        status: "failed",
        errorCode: "30005",
        lastObservedAt: 2,
      },
    });
    expect(formatSmsProbeLines(result)).toContainEqual({
      text: "Recent outbound: failed error=30005",
      tone: "error",
    });
  });

  it("preserves inbound and outbound facts when the webhook lookup fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (fetchInputUrl(input).includes("IncomingPhoneNumbers.json")) {
        throw new Error("number lookup unavailable");
      }
      return new Response(
        JSON.stringify({
          messages: [
            {
              sid: "SM-inbound",
              direction: "inbound",
              status: "received",
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await probeSmsAccount({
      account: createAccount(),
      timeoutMs: 1000,
      options: {
        fetchImpl,
        deliveryRecords: [
          {
            accountId: "default",
            accountSidHash: "account-sid-hash",
            messageSid: "SM-delivered",
            status: "delivered",
            firstObservedAt: 1,
            lastObservedAt: 2,
            observations: [],
          },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("number lookup unavailable"),
      webhook: { status: "unavailable" },
      recentInbound: { sid: "SM-inbound", status: "received" },
      recentOutbound: { messageSid: "SM-delivered", status: "delivered" },
    });
  });

  it("preserves a successful webhook check and outbound facts when history fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (fetchInputUrl(input).includes("/Messages.json")) {
        throw new Error("message history unavailable");
      }
      return new Response(
        JSON.stringify({
          incoming_phone_numbers: [
            {
              phone_number: "+15557654321",
              sms_url: "https://gateway.example.com/webhooks/sms",
              sms_method: "POST",
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await probeSmsAccount({
      account: createAccount(),
      timeoutMs: 1000,
      options: {
        fetchImpl,
        deliveryRecords: [
          {
            accountId: "default",
            accountSidHash: "account-sid-hash",
            messageSid: "SM-undelivered",
            status: "undelivered",
            firstObservedAt: 1,
            lastObservedAt: 2,
            observations: [],
          },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("message history unavailable"),
      webhook: { status: "matches" },
      recentOutbound: { messageSid: "SM-undelivered", status: "undelivered" },
    });
  });

  it("returns durable delivery state before the outer probe deadline when Twilio hangs", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async () => await new Promise<Response>(() => {}));
    const probe = probeSmsAccount({
      account: createAccount(),
      timeoutMs: 1000,
      options: {
        fetchImpl,
        deliveryRecords: [
          {
            accountId: "default",
            accountSidHash: "account-sid-hash",
            messageSid: "SM-timeout",
            status: "delivered",
            firstObservedAt: 1,
            lastObservedAt: 2,
            observations: [],
          },
        ],
      },
    });

    await vi.advanceTimersByTimeAsync(900);

    await expect(probe).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("timed out after 900ms"),
      webhook: { status: "unavailable" },
      recentOutbound: {
        messageSid: "SM-timeout",
        status: "delivered",
        lastObservedAt: 2,
      },
    });
  });
});
