import { describe, expect, it, vi } from "vitest";
import {
  buildTwilioInboundMessage,
  computeTwilioSignature,
  parseTwilioFormBody,
  resolveTwilioWebhookSignatureUrl,
  sendSmsViaTwilio,
  TwilioSmsApiError,
  verifyTwilioSignature,
} from "./twilio.js";
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

function readUrlEncodedRequestBody(init: RequestInit | undefined): URLSearchParams {
  if (typeof init?.body === "string") {
    return new URLSearchParams(init.body);
  }
  if (init?.body instanceof URLSearchParams) {
    return init.body;
  }
  throw new Error("Expected Twilio request body to be URL-encoded.");
}

describe("Twilio SMS helpers", () => {
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
    const fetchImpl = vi.fn(
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
    const fetchImpl = vi.fn(async () => new Response("upstream unavailable", { status: 503 }));

    await expect(
      sendSmsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        text: "hello",
        fetchImpl,
      }),
    ).rejects.toThrow("Twilio SMS send failed (503): upstream unavailable");
  });

  it("rejects malformed JSON from successful Twilio sends", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 201 }));

    await expect(
      sendSmsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        text: "hello",
        fetchImpl,
      }),
    ).rejects.toThrow("Twilio SMS send returned malformed JSON.");
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
    const fetchImpl = vi.fn(
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

  it("preserves the configured public webhook path when adding a request query", () => {
    expect(
      resolveTwilioWebhookSignatureUrl({
        req: { url: "/webhooks/sms?foo=bar" } as never,
        publicWebhookUrl: "https://gateway.example.com/base",
      }),
    ).toBe("https://gateway.example.com/base?foo=bar");
  });

  it("keeps an explicit configured public webhook query", () => {
    expect(
      resolveTwilioWebhookSignatureUrl({
        req: { url: "/webhooks/sms?foo=request" } as never,
        publicWebhookUrl: "https://gateway.example.com/base?foo=configured",
      }),
    ).toBe("https://gateway.example.com/base?foo=configured");
  });

  it("does not reserialize the configured public webhook URL", () => {
    expect(
      resolveTwilioWebhookSignatureUrl({
        req: { url: "/webhooks/sms" } as never,
        publicWebhookUrl: "https://gateway.example.com:443/webhooks/sms",
      }),
    ).toBe("https://gateway.example.com:443/webhooks/sms");
  });
});
