import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SmsChannelRuntime } from "./inbound.js";
import { computeTwilioSignature, parseTwilioFormBody } from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";
import { createSmsWebhookHandler, resetSmsWebhookReplayCacheForTest } from "./webhook.js";

const dispatchSmsInboundEvent = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./inbound.js", () => ({
  dispatchSmsInboundEvent,
}));

function createAccount(): ResolvedSmsAccount {
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
  };
}

function createRequest(body: string, signature: string): IncomingMessage {
  const req = Readable.from([body]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "x-twilio-signature": signature };
  Object.defineProperty(req, "socket", {
    value: { remoteAddress: "127.0.0.1" },
  });
  return req;
}

function createResponse(): ServerResponse & { body?: string } {
  return {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(function (this: ServerResponse & { body?: string }, body?: string) {
      this.body = body;
      return this;
    }),
  } as unknown as ServerResponse & { body?: string };
}

describe("createSmsWebhookHandler", () => {
  beforeEach(() => {
    dispatchSmsInboundEvent.mockClear();
    resetSmsWebhookReplayCacheForTest();
  });

  it("dedupes replayed signed Twilio webhooks by message SID", async () => {
    const body =
      "AccountSid=AC123&From=%2B15551234567&To=%2B15557654321&Body=hello&MessageSid=SM123";
    const signature = computeTwilioSignature({
      url: "https://gateway.example.com/webhooks/sms",
      authToken: "secret",
      form: parseTwilioFormBody(body),
    });
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      channelRuntime: {} as SmsChannelRuntime,
    });

    const firstRes = createResponse();
    await handler(createRequest(body, signature), firstRes);
    const replayRes = createResponse();
    await handler(createRequest(body, signature), replayRes);

    expect(firstRes.statusCode).toBe(200);
    expect(replayRes.statusCode).toBe(200);
    expect(dispatchSmsInboundEvent).toHaveBeenCalledTimes(1);
  });

  it("rejects signed webhooks for a different Twilio account", async () => {
    const body =
      "AccountSid=AC-other&From=%2B15551234567&To=%2B15557654321&Body=hello&SmsMessageSid=SM123";
    const signature = computeTwilioSignature({
      url: "https://gateway.example.com/webhooks/sms",
      authToken: "secret",
      form: parseTwilioFormBody(body),
    });
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      channelRuntime: {} as SmsChannelRuntime,
    });

    const res = createResponse();
    await handler(createRequest(body, signature), res);

    expect(res.statusCode).toBe(403);
    expect(dispatchSmsInboundEvent).not.toHaveBeenCalled();
  });
});
