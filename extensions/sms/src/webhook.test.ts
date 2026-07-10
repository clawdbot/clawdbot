// Sms tests cover webhook plugin behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SmsChannelRuntime } from "./inbound.js";
import { computeTwilioSignature, parseTwilioFormBody } from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";
import {
  createSmsWebhookHandler,
  createSmsWebhookReplayGuard,
  resetSmsWebhookReplayGuardsForTest,
} from "./webhook.js";

const dispatchSmsInboundEvent = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./inbound.js", () => ({
  dispatchSmsInboundEvent,
}));

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

function createRequest(
  body: string,
  signature: string,
  remoteAddress = "127.0.0.1",
): IncomingMessage {
  const req = Readable.from([body]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "x-twilio-signature": signature };
  Object.defineProperty(req, "socket", {
    value: { remoteAddress },
  });
  return req;
}

type TestResponse = ServerResponse & {
  body?: string;
  setHeaderMock: ReturnType<typeof vi.fn>;
};

function createResponse(): TestResponse {
  const setHeaderMock = vi.fn();
  return {
    statusCode: 200,
    setHeader: setHeaderMock,
    setHeaderMock,
    end: vi.fn(function (this: ServerResponse & { body?: string }, body?: string) {
      this.body = body;
      return this;
    }),
  } as unknown as TestResponse;
}

function createSignedSmsPayload(messageSid: string): { body: string; signature: string } {
  const body = `AccountSid=AC123&From=%2B15551234567&To=%2B15557654321&Body=hello&MessageSid=${messageSid}`;
  return {
    body,
    signature: computeTwilioSignature({
      url: "https://gateway.example.com/webhooks/sms",
      authToken: "secret",
      form: parseTwilioFormBody(body),
    }),
  };
}

function createMessageSid(index: number): string {
  return `SM${index.toString(16).padStart(32, "0")}`;
}

describe("createSmsWebhookHandler", () => {
  beforeEach(() => {
    dispatchSmsInboundEvent.mockClear();
    resetSmsWebhookReplayGuardsForTest();
  });

  it("validates a fragmentless signature and preserves dedupe across handler reloads", async () => {
    const { body, signature } = createSignedSmsPayload(createMessageSid(1));
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount({
        publicWebhookUrl: "https://gateway.example.com/webhooks/sms#rp=4xx",
      }),
      channelRuntime: {} as SmsChannelRuntime,
    });

    const firstRes = createResponse();
    await handler(createRequest(body, signature), firstRes);
    const replayRes = createResponse();
    const reloadedHandler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount({
        publicWebhookUrl: "https://gateway.example.com/webhooks/sms#rp=4xx",
      }),
      channelRuntime: {} as SmsChannelRuntime,
    });
    await reloadedHandler(createRequest(body, signature), replayRes);

    expect(firstRes.statusCode).toBe(200);
    expect(replayRes.statusCode).toBe(200);
    expect(dispatchSmsInboundEvent).toHaveBeenCalledTimes(1);
  });

  it("prunes only the expired insertion prefix without refreshing replays", () => {
    let nowMs = 0;
    const replayGuard = createSmsWebhookReplayGuard({
      ttlMs: 10,
      maxKeys: 2,
      now: () => nowMs,
    });
    const first = createMessageSid(2);
    const second = createMessageSid(3);
    const overflow = createMessageSid(4);

    expect(replayGuard.remember(first)).toEqual({ kind: "accepted" });
    nowMs = 2;
    expect(replayGuard.remember(second)).toEqual({ kind: "accepted" });
    nowMs = 5;
    expect(replayGuard.remember(first)).toEqual({ kind: "replayed" });
    expect(replayGuard.remember(overflow)).toEqual({ kind: "saturated", retryAfterMs: 5 });

    nowMs = 10;
    expect(replayGuard.remember(overflow)).toEqual({ kind: "accepted" });
    expect(replayGuard.remember(second)).toEqual({ kind: "replayed" });
  });

  it("keeps live replay keys and fails closed until capacity expires", async () => {
    let nowMs = 1_000;
    const webhookReplayGuard = createSmsWebhookReplayGuard({
      ttlMs: 10_000,
      maxKeys: 2,
      now: () => nowMs,
    });
    const handler = createSmsWebhookHandler(
      {
        cfg: {},
        account: createAccount(),
        channelRuntime: {} as SmsChannelRuntime,
      },
      webhookReplayGuard,
    );
    const first = createSignedSmsPayload(createMessageSid(5));
    const second = createSignedSmsPayload(createMessageSid(6));
    const overflow = createSignedSmsPayload(createMessageSid(7));

    await handler(createRequest(first.body, first.signature), createResponse());
    await handler(createRequest(second.body, second.signature), createResponse());
    const overflowRes = createResponse();
    await handler(createRequest(overflow.body, overflow.signature), overflowRes);
    const repeatedOverflowRes = createResponse();
    await handler(createRequest(overflow.body, overflow.signature), repeatedOverflowRes);
    const firstReplayRes = createResponse();
    await handler(createRequest(first.body, first.signature), firstReplayRes);

    expect(overflowRes.statusCode).toBe(429);
    expect(repeatedOverflowRes.statusCode).toBe(429);
    expect(overflowRes.setHeaderMock).toHaveBeenCalledWith("Retry-After", "10");
    expect(firstReplayRes.statusCode).toBe(200);
    expect(dispatchSmsInboundEvent).toHaveBeenCalledTimes(2);

    nowMs += 10_000;
    const afterExpiryRes = createResponse();
    await handler(createRequest(overflow.body, overflow.signature), afterExpiryRes);

    expect(afterExpiryRes.statusCode).toBe(200);
    expect(dispatchSmsInboundEvent).toHaveBeenCalledTimes(3);
  });

  it("rejects signed webhooks for a different Twilio account", async () => {
    const body = `AccountSid=AC-other&From=%2B15551234567&To=%2B15557654321&Body=hello&SmsMessageSid=${createMessageSid(8)}`;
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
