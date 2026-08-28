// Sms tests cover twilio plugin behavior.
import { createHmac } from "node:crypto";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTwilioStatusCallbackUrl } from "./public-webhook-url.js";
import {
  buildTwilioInboundMessage,
  listTwilioIncomingPhoneNumbers,
  listTwilioMessages,
  readTwilioWebhookForm,
  resolveTwilioWebhookSignatureUrl,
  retrieveTwilioMessagingService,
  sendSmsViaTwilio,
  verifyTwilioSignature,
} from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

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

function readUrlEncodedRequestBody(init: RequestInit | undefined): URLSearchParams {
  if (typeof init?.body === "string") {
    return new URLSearchParams(init.body);
  }
  if (init?.body instanceof URLSearchParams) {
    return init.body;
  }
  throw new Error("Expected Twilio request body to be URL-encoded.");
}

function computeTestTwilioSignature(params: {
  url: string;
  authToken: string;
  form: Record<string, string>;
}): string {
  const data =
    params.url +
    Object.keys(params.form)
      .toSorted()
      .map((key) => `${key}${params.form[key] ?? ""}`)
      .join("");
  return createHmac("sha1", params.authToken).update(data).digest("base64");
}

async function readTestTwilioForm(body: string): Promise<Record<string, string>> {
  const req = createMockIncomingRequest([body]);
  req.headers = { "content-length": String(Buffer.byteLength(body)) };
  return await readTwilioWebhookForm(req);
}

function cancelTrackedTextResponse(
  text: string,
  init?: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

describe("Twilio SMS helpers", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("parses Twilio form bodies and inbound messages", async () => {
    const form = await readTestTwilioForm(
      "From=%2B15551234567&To=%2B15557654321&Body=hello+there&MessageSid=SM123",
    );

    expect(form).toEqual({
      From: "+15551234567",
      To: "+15557654321",
      Body: "hello there",
      MessageSid: "SM123",
    });
    expect(buildTwilioInboundMessage(form)).toEqual({
      from: "+15551234567",
      to: "+15557654321",
      body: "hello there",
      messageSid: "SM123",
      accountSid: "",
      media: [],
    });
  });

  it("parses media-only Twilio MMS callbacks in provider order", async () => {
    const form = await readTestTwilioForm(
      [
        "From=%2B15551234567",
        "To=%2B15557654321",
        "Body=",
        "MessageSid=MM123",
        "NumMedia=2",
        "MediaUrl0=https%3A%2F%2Fapi.twilio.com%2Fmedia%2Ffirst",
        "MediaContentType0=image%2Fjpeg",
        "MediaUrl1=https%3A%2F%2Fapi.twilio.com%2Fmedia%2Fsecond",
        "MediaContentType1=video%2Fmp4",
      ].join("&"),
    );

    expect(buildTwilioInboundMessage(form)).toEqual({
      from: "+15551234567",
      to: "+15557654321",
      body: "",
      messageSid: "MM123",
      accountSid: "",
      media: [
        { url: "https://api.twilio.com/media/first", contentType: "image/jpeg" },
        { url: "https://api.twilio.com/media/second", contentType: "video/mp4" },
      ],
    });
  });

  it("preserves the signed Messaging Service identity on inbound messages", () => {
    expect(
      buildTwilioInboundMessage({
        AccountSid: "AC123",
        MessagingServiceSid: "MG123",
        From: "+15551234567",
        To: "+15557654321",
        Body: "hello",
        MessageSid: "SM123",
      }),
    ).toMatchObject({
      accountSid: "AC123",
      messagingServiceSid: "MG123",
      messageSid: "SM123",
    });
  });

  it("rejects malformed counts and marks missing Twilio MMS media as unavailable", () => {
    const base = {
      From: "+15551234567",
      To: "+15557654321",
      Body: "",
      MessageSid: "MM123",
      MediaUrl0: "https://api.twilio.com/media/first",
    };
    expect(buildTwilioInboundMessage({ ...base, NumMedia: "not-a-number" })).toBeNull();
    expect(buildTwilioInboundMessage({ ...base, NumMedia: "1", MediaUrl0: "" })).toMatchObject({
      media: [],
      unavailableMediaCount: 1,
    });
  });

  it("bounds inbound downloads without discarding a signed message with more media", () => {
    const mediaFields = Object.fromEntries(
      Array.from({ length: 11 }, (_value, index) => [
        `MediaUrl${index}`,
        `https://api.twilio.com/media/${index}`,
      ]),
    );

    expect(
      buildTwilioInboundMessage({
        From: "+15551234567",
        To: "+15557654321",
        Body: "",
        MessageSid: "MM123",
        NumMedia: "11",
        ...mediaFields,
      }),
    ).toMatchObject({
      media: Array.from({ length: 10 }, (_value, index) => ({
        url: `https://api.twilio.com/media/${index}`,
      })),
      unavailableMediaCount: 1,
    });
  });

  it.each([
    ["+1 (555) 123-4567", "+15551234567"],
    ["RcS:+1 (555) 123-4567", "+15551234567"],
    ["whatsapp:+15551234567", null],
    ["signal:+15551234567", null],
  ] as const)("accepts only supported Twilio inbound From address %s", (from, expected) => {
    const msg = buildTwilioInboundMessage({
      From: from,
      To: "+15557654321",
      Body: "hello",
      MessageSid: "SM123",
    });

    expect(msg?.from ?? null).toBe(expected);
  });

  it("verifies Twilio signatures over sorted form fields", () => {
    const form = {
      Body: "hello",
      From: "+15551234567",
      MessageSid: "SM123",
      To: "+15557654321",
    };
    const signature = computeTestTwilioSignature({
      url: "https://gateway.example.com/webhooks/sms",
      authToken: "secret",
      form,
    });

    expect(
      verifyTwilioSignature({
        signature,
        url: "https://gateway.example.com/webhooks/sms",
        authToken: "secret",
        form,
      }),
    ).toBe(true);
    expect(
      verifyTwilioSignature({
        signature,
        url: "https://gateway.example.com/webhooks/sms/other",
        authToken: "secret",
        form,
      }),
    ).toBe(false);
    expect(
      verifyTwilioSignature({
        signature: signature.slice(0, -1),
        url: "https://gateway.example.com/webhooks/sms",
        authToken: "secret",
        form,
      }),
    ).toBe(false);
  });

  it("preserves signed form values before signature verification", async () => {
    const form = await readTestTwilioForm(
      "From=%2B15551234567&To=%2B15557654321&Body=+hello+&MessageSid=SM123&WaId=",
    );
    const signature = computeTestTwilioSignature({
      url: "https://gateway.example.com/webhooks/sms",
      authToken: "secret",
      form,
    });

    expect(form.Body).toBe(" hello ");
    expect(form.WaId).toBe("");
    expect(
      verifyTwilioSignature({
        signature,
        url: "https://gateway.example.com/webhooks/sms",
        authToken: "secret",
        form,
      }),
    ).toBe(true);
    expect(buildTwilioInboundMessage(form)?.body).toBe(" hello ");
  });

  it("sends SMS through Twilio's Messages API", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            sid: "SM456",
            to: "+15551234567",
            from: "+15557654321",
            status: "queued",
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    await expect(
      sendSmsViaTwilio({
        account: {
          accountId: "default",
          enabled: true,
          accountSid: "AC123",
          authToken: "secret",
          fromNumber: "+15557654321",
          messagingServiceSid: "",
          defaultTo: "",
          webhookPath: "/webhooks/sms",
          publicWebhookUrl: "https://gateway.example.com/webhooks/sms#rp=4xx",
          dangerouslyDisableSignatureValidation: false,
          dmPolicy: "pairing",
          allowFrom: [],
          textChunkLimit: 1500,
        },
        to: "+15551234567",
        text: "hello",
        fetchImpl,
      }),
    ).resolves.toEqual({
      sid: "SM456",
      to: "+15551234567",
      from: "+15557654321",
      status: "queued",
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("AC123:secret").toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    });
    const body = readUrlEncodedRequestBody(init);
    expect(body.get("From")).toBe("+15557654321");
    expect(body.get("To")).toBe("+15551234567");
    expect(body.get("Body")).toBe("hello");
    expect(body.get("StatusCallback")).toBe(
      "https://gateway.example.com/webhooks/sms#rp=4xx,ct,rt,5xx&rt=5000&rc=1",
    );
  });

  it("opts delivery commits into bounded connection, timeout, and 5xx retries", () => {
    const callbackUrl = resolveTwilioStatusCallbackUrl("https://gateway.example.com/webhooks/sms");
    const overrides = new URLSearchParams(callbackUrl.split("#")[1]);

    expect(overrides.get("rp")?.split(",")).toEqual(["ct", "rt", "5xx"]);
    expect(overrides.get("rp")?.split(",")).not.toContain("4xx");
    expect(overrides.get("rt")).toBe("5000");
    expect(overrides.get("rc")).toBe("1");
  });

  it.each([
    [
      "accepts an absolute HTTP callback URL",
      "http://gateway.example.com/webhooks/sms",
      "http://gateway.example.com/webhooks/sms#rp=ct,rt,5xx&rt=5000&rc=1",
    ],
    [
      "preserves the query and existing retry policy",
      "https://gateway.example.com/webhooks/sms?tenant=support#rp=4xx",
      "https://gateway.example.com/webhooks/sms?tenant=support#rp=4xx,ct,rt,5xx&rt=5000&rc=1",
    ],
    [
      "preserves an all-failures policy and configured retry count",
      "https://gateway.example.com/webhooks/sms#rt=5000&rp=all&rc=3",
      "https://gateway.example.com/webhooks/sms#rt=5000&rp=all&rc=3",
    ],
    [
      "preserves a configured read timeout",
      "https://gateway.example.com/webhooks/sms#rt=1200&rp=ct",
      "https://gateway.example.com/webhooks/sms#rt=1200&rp=ct,rt,5xx&rc=1",
    ],
    [
      "repairs an invalid read timeout",
      "https://gateway.example.com/webhooks/sms#rt=16000",
      "https://gateway.example.com/webhooks/sms#rt=5000&rp=ct,rt,5xx&rc=1",
    ],
    [
      "repairs a disabled retry count without replacing other overrides",
      "https://gateway.example.com/webhooks/sms#e=singapore&rc=0",
      "https://gateway.example.com/webhooks/sms#e=singapore&rc=1&rp=ct,rt,5xx&rt=5000",
    ],
  ])("%s", (_name, publicWebhookUrl, expected) => {
    expect(resolveTwilioStatusCallbackUrl(publicWebhookUrl)).toBe(expected);
  });

  it("omits the delivery callback when no public webhook URL is configured", () => {
    expect(resolveTwilioStatusCallbackUrl("   ")).toBe("");
  });

  it("enforces OpenClaw's defensive 4,000-character status callback cap", () => {
    const prefix = "https://gateway.example.com/webhooks/sms?x=";
    const suffix = "#rp=ct,rt,5xx&rt=5000&rc=1";
    const paddingLength = 4_000 - prefix.length - suffix.length;
    const atLimit = `${prefix}${"a".repeat(paddingLength)}`;

    expect(resolveTwilioStatusCallbackUrl(atLimit)).toHaveLength(4_000);
    expect(resolveTwilioStatusCallbackUrl(`${atLimit}a`)).toBe("");
  });

  it.each([
    ["relative", "placeholder"],
    ["malformed", "https://"],
    ["missing authority slashes", "https:gateway.example.com/webhooks/sms"],
    ["single authority slash", "https:/gateway.example.com/webhooks/sms"],
    ["backslash", String.raw`https://gateway.example.com\webhooks\sms`],
    ["invalid percent escape", "https://gateway.example.com/webhooks/sms?x=%ZZ"],
    ["raw query pipe", "https://gateway.example.com/webhooks/sms?x=|"],
    ["raw query caret", "https://gateway.example.com/webhooks/sms?x=^"],
    ["raw query backtick", "https://gateway.example.com/webhooks/sms?x=`"],
    ["raw query braces", "https://gateway.example.com/webhooks/sms?x={}"],
    ["percent-encoded hostname", "https://%65xample.com/webhooks/sms"],
    ["invalid hostname", "https://sms_gateway.example.com/webhooks/sms"],
    ["single-label hostname", "http://gateway/webhooks/sms"],
    ["localhost", "http://localhost/webhooks/sms"],
    ["IPv4 loopback", "http://127.0.0.1/webhooks/sms"],
    ["legacy numeric IPv4 loopback", "http://2130706433/webhooks/sms"],
    ["unspecified IPv4", "http://0.0.0.0/webhooks/sms"],
    ["private IPv4", "http://10.0.0.1/webhooks/sms"],
    ["carrier-grade NAT IPv4", "http://100.64.0.1/webhooks/sms"],
    ["link-local IPv4", "http://169.254.169.254/webhooks/sms"],
    ["IPv6 loopback", "http://[::1]/webhooks/sms"],
    ["private IPv6", "http://[fd00::1]/webhooks/sms"],
  ])(
    "keeps text sending available with a %s public webhook URL",
    async (_name, publicWebhookUrl) => {
      const fetchImpl = vi.fn<typeof fetch>(
        async () => new Response(JSON.stringify({ sid: "SM-no-callback" }), { status: 201 }),
      );

      await expect(
        sendSmsViaTwilio({
          account: createAccount({ publicWebhookUrl }),
          to: "+15551234567",
          text: "hello",
          fetchImpl,
        }),
      ).resolves.toMatchObject({ sid: "SM-no-callback" });

      const body = readUrlEncodedRequestBody(fetchImpl.mock.calls[0]?.[1]);
      expect(body.has("StatusCallback")).toBe(false);
    },
  );

  it("marks dispatch immediately before the Twilio POST", async () => {
    const events: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      events.push("post");
      return new Response(JSON.stringify({ sid: "SM-dispatched" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    const onPlatformSendDispatch = vi.fn(async () => {
      events.push("dispatch");
    });

    await sendSmsViaTwilio({
      account: createAccount(),
      to: "+15551234567",
      text: "hello",
      onPlatformSendDispatch,
      fetchImpl,
    });

    expect(events).toEqual(["dispatch", "post"]);
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
  });

  it("does not mark dispatch for an invalid Twilio send", async () => {
    const onPlatformSendDispatch = vi.fn(async () => {});

    await expect(
      sendSmsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        onPlatformSendDispatch,
      }),
    ).rejects.toThrow("Twilio SMS/MMS send requires text or media.");

    expect(onPlatformSendDispatch).not.toHaveBeenCalled();
  });

  it("sends MMS with repeated MediaUrl fields and no required text body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ sid: "MM456" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );

    await sendSmsViaTwilio({
      account: createAccount(),
      to: "+15551234567",
      mediaUrls: [
        "https://gateway.example.com/media/first",
        "https://gateway.example.com/media/second",
      ],
      fetchImpl,
    });

    const body = readUrlEncodedRequestBody(fetchImpl.mock.calls[0]?.[1]);
    expect(body.get("Body")).toBeNull();
    expect(body.getAll("MediaUrl")).toEqual([
      "https://gateway.example.com/media/first",
      "https://gateway.example.com/media/second",
    ]);
  });

  it("rejects outbound MMS requests above Twilio's media count limit", async () => {
    await expect(
      sendSmsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        mediaUrls: Array.from({ length: 11 }, (_, index) => `https://example.com/${index}.jpg`),
      }),
    ).rejects.toThrow("Twilio MMS send supports at most 10 media URLs");
  });

  it("enforces Twilio's provider-owned Message Body limit", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ sid: "SM1600" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      sendSmsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        text: "x".repeat(1600),
        fetchImpl,
      }),
    ).resolves.toMatchObject({ sid: "SM1600" });
    await expect(
      sendSmsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        text: "x".repeat(1601),
        fetchImpl,
      }),
    ).rejects.toThrow("Twilio SMS/MMS Body supports at most 1600 characters");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("lists Twilio phone-number webhook settings", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            incoming_phone_numbers: [
              {
                sid: "PN123",
                phone_number: "+15557654321",
                sms_url: "https://gateway.example.com/webhooks/sms",
                sms_method: "POST",
                voice_url: "https://gateway.example.com/voice/webhook",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    await expect(
      listTwilioIncomingPhoneNumbers({
        account: createAccount(),
        phoneNumber: "+15557654321",
        fetchImpl,
      }),
    ).resolves.toEqual([
      {
        sid: "PN123",
        phoneNumber: "+15557654321",
        smsUrl: "https://gateway.example.com/webhooks/sms",
        smsMethod: "POST",
        voiceUrl: "https://gateway.example.com/voice/webhook",
      },
    ]);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json?PhoneNumber=%2B15557654321",
    );
    expect(init?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("AC123:secret").toString("base64")}`,
    });
  });

  it("lists recent Twilio messages for diagnostics", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            messages: [
              {
                sid: "SM123",
                direction: "inbound",
                status: "received",
                to: "+15557654321",
                from: "+15551234567",
                error_code: 11200,
                body: "hello",
                date_created: "Sun, 31 May 2026 10:00:00 +0000",
                date_sent: null,
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    await expect(
      listTwilioMessages({
        account: createAccount(),
        to: "+15557654321",
        pageSize: 3,
        fetchImpl,
      }),
    ).resolves.toEqual([
      {
        sid: "SM123",
        direction: "inbound",
        status: "received",
        to: "+15557654321",
        from: "+15551234567",
        errorCode: "11200",
        body: "hello",
        dateCreated: "Sun, 31 May 2026 10:00:00 +0000",
        dateSent: "",
      },
    ]);

    const [url] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json?To=%2B15557654321&PageSize=3",
    );
  });

  it("retrieves Twilio Messaging Service webhook settings", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            sid: "MG123",
            inbound_request_url: "https://gateway.example.com/webhooks/sms",
            inbound_method: "POST",
            use_inbound_webhook_on_number: false,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    await expect(
      retrieveTwilioMessagingService({
        account: createAccount({ messagingServiceSid: "MG123", fromNumber: "" }),
        serviceSid: "MG123",
        fetchImpl,
      }),
    ).resolves.toEqual({
      sid: "MG123",
      inboundRequestUrl: "https://gateway.example.com/webhooks/sms",
      inboundMethod: "POST",
      useInboundWebhookOnNumber: false,
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://messaging.twilio.com/v1/Services/MG123");
    expect(init?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("AC123:secret").toString("base64")}`,
    });
  });

  it("can send through a Twilio Messaging Service SID", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ sid: "SM789" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );

    await sendSmsViaTwilio({
      account: {
        accountId: "default",
        enabled: true,
        accountSid: "AC123",
        authToken: "secret",
        fromNumber: "",
        messagingServiceSid: "MG123",
        defaultTo: "",
        webhookPath: "/webhooks/sms",
        publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
        dangerouslyDisableSignatureValidation: false,
        dmPolicy: "pairing",
        allowFrom: [],
        textChunkLimit: 1500,
      },
      to: "+15551234567",
      text: "hello",
      fetchImpl,
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = readUrlEncodedRequestBody(init);
    expect(body.get("MessagingServiceSid")).toBe("MG123");
    expect(body.get("To")).toBe("+15551234567");
    expect(body.get("Body")).toBe("hello");
    expect(body.get("StatusCallback")).toBe(
      "https://gateway.example.com/webhooks/sms#rp=ct,rt,5xx&rt=5000&rc=1",
    );
  });

  it("prefers an explicit from number when both sender options are resolved", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ sid: "SM999" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );

    await sendSmsViaTwilio({
      account: {
        accountId: "default",
        enabled: true,
        accountSid: "AC123",
        authToken: "secret",
        fromNumber: "+15557654321",
        messagingServiceSid: "MG123",
        defaultTo: "",
        webhookPath: "/webhooks/sms",
        publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
        dangerouslyDisableSignatureValidation: false,
        dmPolicy: "pairing",
        allowFrom: [],
        textChunkLimit: 1500,
      },
      to: "+15551234567",
      text: "hello",
      fetchImpl,
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = readUrlEncodedRequestBody(init);
    expect(body.get("From")).toBe("+15557654321");
    expect(body.get("MessagingServiceSid")).toBeNull();
  });

  it("throws structured Twilio errors from JSON error bodies", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            code: 21610,
            message: "The message From/To pair violates a blacklist rule.",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );

    await expect(
      sendSmsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        text: "hello",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "TwilioSmsApiError",
      message: "Twilio SMS send failed (400): The message From/To pair violates a blacklist rule.",
      httpStatus: 400,
      twilioCode: 21610,
      responseText: JSON.stringify({
        code: 21610,
        message: "The message From/To pair violates a blacklist rule.",
      }),
    });
  });

  it("includes non-JSON Twilio error text in send failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("upstream unavailable", { status: 503 }),
    );

    await expect(
      sendSmsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        text: "hello",
        fetchImpl,
      }),
    ).rejects.toThrow("Twilio SMS send failed (503): upstream unavailable");
  });

  it("releases guarded Twilio egress on failed send responses", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("upstream unavailable", { status: 503 }),
      release,
    });

    await expect(
      sendSmsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        text: "hello",
      }),
    ).rejects.toThrow("Twilio SMS send failed (503): upstream unavailable");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        auditContext: "sms-twilio-api",
        policy: { allowedHostnames: ["api.twilio.com"] },
        requireHttps: true,
        timeoutMs: 30_000,
        url: "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json",
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds guarded Twilio errors on complete UTF-8 characters and cancels overflow", async () => {
    const release = vi.fn(async () => {});
    const tracked = cancelTrackedTextResponse(`${"x".repeat(8 * 1024 - 2)}😀tail`, {
      status: 503,
    });
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: tracked.response,
      release,
    });

    let caught: Error | undefined;
    try {
      await sendSmsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        text: "hello",
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toContain("Twilio SMS send failed (503): ");
    expect(caught?.message).toContain("... [truncated]");
    expect(caught?.message).not.toContain("�");
    expect(caught?.message).not.toContain("tail");
    expect(caught?.message.length).toBeLessThan(8_300);
    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed JSON from successful Twilio sends", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("not json", { status: 201 }));

    await expect(
      sendSmsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        text: "hello",
        fetchImpl,
      }),
    ).rejects.toThrow("Twilio SMS send returned malformed JSON.");
  });

  it("releases guarded Twilio egress on malformed successful send responses", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("not json", { status: 201 }),
      release,
    });

    await expect(
      sendSmsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        text: "hello",
      }),
    ).rejects.toThrow("Twilio SMS send returned malformed JSON.");

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed JSON from Twilio Messaging Service lookup", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("NOT JSON {{{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      retrieveTwilioMessagingService({
        account: createAccount({ messagingServiceSid: "MG123", fromNumber: "" }),
        serviceSid: "MG123",
        fetchImpl,
      }),
    ).rejects.toThrow("Twilio Messaging Service lookup returned malformed JSON.");
  });

  it("returns empty list on malformed JSON from Twilio incoming phone number list", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("NOT JSON {{{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await listTwilioIncomingPhoneNumbers({
      account: createAccount(),
      fetchImpl,
    });

    expect(result).toEqual([]);
  });

  it("bounds and cancels oversized guarded Twilio success bodies", async () => {
    const release = vi.fn(async () => {});
    const tracked = cancelTrackedTextResponse("x".repeat(1024 * 1024 + 1), { status: 201 });
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: tracked.response,
      release,
    });

    await expect(
      sendSmsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        text: "hello",
      }),
    ).rejects.toThrow(
      "Twilio SMS API response body too large: 1048577 bytes (limit: 1048576 bytes)",
    );

    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("requires successful Twilio sends to include a Message SID", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ status: "queued" }), { status: 201 }),
    );

    await expect(
      sendSmsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        text: "hello",
        fetchImpl,
      }),
    ).rejects.toThrow("Twilio SMS send response did not include a Message SID.");
  });

  it("excludes a connection override fragment when adding a request query", () => {
    expect(
      resolveTwilioWebhookSignatureUrl({
        req: { url: "/webhooks/sms?foo=bar" } as never,
        publicWebhookUrl: "https://gateway.example.com/base#rp=4xx",
      }),
    ).toBe("https://gateway.example.com/base?foo=bar");
  });

  it("keeps an explicit configured query but excludes its connection override fragment", () => {
    expect(
      resolveTwilioWebhookSignatureUrl({
        req: { url: "/webhooks/sms?foo=request" } as never,
        publicWebhookUrl: "https://gateway.example.com/base?foo=configured#rp=all",
      }),
    ).toBe("https://gateway.example.com/base?foo=configured");
  });

  it("strips a connection override fragment without reserializing the configured URL", () => {
    expect(
      resolveTwilioWebhookSignatureUrl({
        req: { url: "/webhooks/sms" } as never,
        publicWebhookUrl: "https://gateway.example.com:443/webhooks/sms#rp=4xx",
      }),
    ).toBe("https://gateway.example.com:443/webhooks/sms");
  });
});
