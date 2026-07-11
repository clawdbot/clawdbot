// Sms tests cover twilio plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTwilioInboundMessage,
  computeTwilioSignature,
  listTwilioIncomingPhoneNumbers,
  listTwilioMessages,
  parseTwilioFormBody,
  resolveTwilioWebhookSignatureUrl,
  retrieveTwilioMessagingService,
  sendSmsViaTwilio,
  TwilioSmsApiError,
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

  it("parses Twilio form bodies and inbound messages", () => {
    const form = parseTwilioFormBody(
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
    const signature = computeTwilioSignature({
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
  });

  it("preserves signed form values before signature verification", () => {
    const form = parseTwilioFormBody(
      "From=%2B15551234567&To=%2B15557654321&Body=+hello+&MessageSid=SM123&WaId=",
    );
    const signature = computeTwilioSignature({
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
          publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
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

  it("exposes a typed Twilio SMS API error", () => {
    const error = new TwilioSmsApiError(
      429,
      JSON.stringify({ code: 20429, message: "Too many requests" }),
    );

    expect(error).toBeInstanceOf(TwilioSmsApiError);
    expect(error.message).toBe("Twilio SMS send failed (429): Too many requests");
    expect(error.httpStatus).toBe(429);
    expect(error.twilioCode).toBe(20429);
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
