import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SmsDeliveryRecorder } from "./delivery-observations.js";
import type { ResolvedSmsAccount } from "./types.js";
import { createSmsWebhookHandler } from "./webhook.js";

type TestResponse = ServerResponse & {
  setHeaderMock: ReturnType<typeof vi.fn>;
};

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

function createSignedDeliveryPayload(params: { account: ResolvedSmsAccount; messageSid: string }): {
  body: string;
  signature: string;
} {
  const form = {
    AccountSid: params.account.accountSid,
    From: params.account.fromNumber,
    To: "+15551234567",
    MessageSid: params.messageSid,
    MessageStatus: "sent",
  };
  const body = new URLSearchParams(form).toString();
  const signatureInput =
    params.account.publicWebhookUrl +
    Object.keys(form)
      .toSorted()
      .map((key) => `${key}${form[key as keyof typeof form]}`)
      .join("");
  return {
    body,
    signature: createHmac("sha1", params.account.authToken).update(signatureInput).digest("base64"),
  };
}

function createRequest(body: string, signature: string): IncomingMessage {
  const req = Readable.from([body]) as IncomingMessage;
  req.method = "POST";
  req.headers = {
    "content-length": String(Buffer.byteLength(body)),
    "x-twilio-signature": signature,
  };
  Object.defineProperty(req, "socket", {
    value: { remoteAddress: "203.0.113.50" },
  });
  return req;
}

function createResponse(): TestResponse {
  const setHeaderMock = vi.fn();
  return {
    statusCode: 200,
    setHeader: setHeaderMock,
    setHeaderMock,
    end: vi.fn(),
  } as unknown as TestResponse;
}

function createDeliveryRecorder(): SmsDeliveryRecorder & {
  record: ReturnType<typeof vi.fn<SmsDeliveryRecorder["record"]>>;
} {
  const record = vi.fn<SmsDeliveryRecorder["record"]>(async ({ account, form }) => ({
    duplicate: false,
    record: {
      accountId: account.accountId,
      accountSidHash: "account-sid-hash",
      messageSid: form.MessageSid ?? "",
      status: form.MessageStatus ?? "",
      firstObservedAt: 1,
      lastObservedAt: 1,
      observations: [],
    },
  }));
  return { record };
}

function messageSid(index: number): string {
  return `SM${index.toString(16).padStart(32, "0")}`;
}

describe("SMS delivery callback admission", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds writes per account route and reopens after the window resets", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const account = createAccount();
    const delivery = createDeliveryRecorder();
    const warn = vi.fn();
    const handler = createSmsWebhookHandler({
      cfg: {},
      account,
      ingress: { enqueue: vi.fn() },
      delivery,
      log: { warn },
    });

    for (let i = 0; i < 3_000; i += 1) {
      const payload = createSignedDeliveryPayload({
        account,
        messageSid: messageSid(i),
      });
      const res = createResponse();
      await handler(createRequest(payload.body, payload.signature), res);
      expect(res.statusCode).toBe(200);
    }

    const rejectedPayload = createSignedDeliveryPayload({
      account,
      messageSid: messageSid(3_000),
    });
    const rejectedRes = createResponse();
    await handler(createRequest(rejectedPayload.body, rejectedPayload.signature), rejectedRes);

    expect(rejectedRes.statusCode).toBe(503);
    expect(rejectedRes.setHeaderMock).not.toHaveBeenCalledWith(
      "x-openclaw-delivery-accepted",
      "durable",
    );
    expect(delivery.record).toHaveBeenCalledTimes(3_000);
    expect(warn).toHaveBeenCalledWith("SMS delivery callback rate limit exceeded");

    const otherAccount = createAccount({
      accountId: "support",
      accountSid: "AC-support",
      webhookPath: "/webhooks/sms/support",
      publicWebhookUrl: "https://gateway.example.com/webhooks/sms/support",
    });
    const otherDelivery = createDeliveryRecorder();
    const otherHandler = createSmsWebhookHandler({
      cfg: {},
      account: otherAccount,
      ingress: { enqueue: vi.fn() },
      delivery: otherDelivery,
    });
    const otherPayload = createSignedDeliveryPayload({
      account: otherAccount,
      messageSid: messageSid(3_001),
    });
    const otherRes = createResponse();
    await otherHandler(createRequest(otherPayload.body, otherPayload.signature), otherRes);
    expect(otherRes.statusCode).toBe(200);
    expect(otherDelivery.record).toHaveBeenCalledOnce();

    vi.setSystemTime(Date.now() + 60_001);
    const reopenedRes = createResponse();
    await handler(createRequest(rejectedPayload.body, rejectedPayload.signature), reopenedRes);

    expect(reopenedRes.statusCode).toBe(200);
    expect(reopenedRes.setHeaderMock).toHaveBeenCalledWith(
      "x-openclaw-delivery-accepted",
      "durable",
    );
    expect(delivery.record).toHaveBeenCalledTimes(3_001);
  });
});
