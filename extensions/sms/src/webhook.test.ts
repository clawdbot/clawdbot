// Sms tests cover webhook plugin behavior.
import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SmsChannelRuntime } from "./inbound.js";
import type { ResolvedSmsAccount } from "./types.js";
import { createSmsWebhookHandler } from "./webhook.js";

const dispatchSmsInboundEvent = vi.hoisted(() => vi.fn(async () => undefined));
const runDetachedWebhookWork = vi.hoisted(() => vi.fn((run: () => Promise<void>) => run()));

vi.mock("openclaw/plugin-sdk/webhook-request-guards", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/webhook-request-guards")>();
  return { ...actual, runDetachedWebhookWork };
});

vi.mock("./inbound.js", () => ({
  dispatchSmsInboundEvent,
}));

let testAccountSequence = 0;
let activeAccountId = "test-0";

function parseTestTwilioForm(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
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

function createAccount(overrides: Partial<ResolvedSmsAccount> = {}): ResolvedSmsAccount {
  return {
    accountId: activeAccountId,
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

function createSignedBody(params?: {
  account?: ResolvedSmsAccount;
  body?: string;
  messageSid?: string;
}): { body: string; signature: string } {
  const account = params?.account ?? createAccount();
  const body =
    params?.body ??
    `AccountSid=${encodeURIComponent(account.accountSid)}&From=%2B15551234567&To=%2B15557654321&Body=hello&MessageSid=${encodeURIComponent(params?.messageSid ?? "SM123")}`;
  return {
    body,
    signature: computeTestTwilioSignature({
      url: account.publicWebhookUrl,
      authToken: account.authToken,
      form: parseTestTwilioForm(body),
    }),
  };
}

function createRequest(
  body: string,
  signature: string,
  options?: { headers?: Record<string, string>; remoteAddress?: string },
): IncomingMessage {
  const req = Readable.from([body]) as IncomingMessage;
  req.method = "POST";
  req.headers = {
    "content-length": String(Buffer.byteLength(body)),
    "x-twilio-signature": signature,
    ...options?.headers,
  };
  Object.defineProperty(req, "socket", {
    value: { remoteAddress: options?.remoteAddress ?? "127.0.0.1" },
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

function createSignedSmsPayload(
  messageSid: string,
  overrides: { from?: string; to?: string } = {},
): { body: string; signature: string } {
  const body = new URLSearchParams({
    AccountSid: "AC123",
    From: overrides.from ?? "+15551234567",
    To: overrides.to ?? "+15557654321",
    Body: "hello",
    MessageSid: messageSid,
  }).toString();
  return {
    body,
    signature: computeTestTwilioSignature({
      url: "https://gateway.example.com/webhooks/sms",
      authToken: "secret",
      form: parseTestTwilioForm(body),
    }),
  };
}

function createMessageSid(index: number): string {
  return `SM${index.toString(16).padStart(32, "0")}`;
}

describe("createSmsWebhookHandler", () => {
  beforeEach(() => {
    dispatchSmsInboundEvent.mockClear();
    runDetachedWebhookWork.mockClear();
    activeAccountId = `test-${++testAccountSequence}`;
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
    expect(runDetachedWebhookWork).toHaveBeenCalledTimes(1);
  });

  it("validates the raw RCS form before canonicalizing its sender", async () => {
    const messageSid = createMessageSid(9);
    const { body, signature } = createSignedSmsPayload(messageSid, {
      from: "RcS:+1 (555) 123-4567",
      to: "rcs:example-agent",
    });
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      channelRuntime: {} as SmsChannelRuntime,
    });

    expect(parseTestTwilioForm(body).From).toBe("RcS:+1 (555) 123-4567");

    const res = createResponse();
    await handler(createRequest(body, signature), res);

    expect(res.statusCode).toBe(200);
    expect(dispatchSmsInboundEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: {
          accountSid: "AC123",
          from: "+15551234567",
          to: "rcs:example-agent",
          body: "hello",
          messageSid,
        },
      }),
    );
  });

  it("rejects signed webhooks for a different Twilio account", async () => {
    const body = `AccountSid=AC-other&From=%2B15551234567&To=%2B15557654321&Body=hello&SmsMessageSid=${createMessageSid(8)}`;
    const signature = computeTestTwilioSignature({
      url: "https://gateway.example.com/webhooks/sms",
      authToken: "secret",
      form: parseTestTwilioForm(body),
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

  it("does not let unsigned proxy traffic consume the same client's signed webhook rate limit", async () => {
    const account = createAccount();
    const handler = createSmsWebhookHandler({
      cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
      account,
      channelRuntime: {} as SmsChannelRuntime,
    });
    const unsignedBody =
      "AccountSid=AC123&From=%2B15550000000&To=%2B15557654321&Body=bad&MessageSid=SM-bad";
    for (let i = 0; i < 300; i += 1) {
      const rejected = createResponse();
      await handler(
        createRequest(unsignedBody, "not-a-valid-signature", {
          headers: { "x-forwarded-for": "203.0.113.10" },
        }),
        rejected,
      );
      expect(rejected.statusCode).toBe(403);
    }
    const throttled = createResponse();
    await handler(
      createRequest(unsignedBody, "not-a-valid-signature", {
        headers: { "x-forwarded-for": "203.0.113.10" },
      }),
      throttled,
    );
    expect(throttled.statusCode).toBe(429);

    const valid = createSignedBody({ account, messageSid: "SM-valid-after-invalid-burst" });
    const accepted = createResponse();
    await handler(
      createRequest(valid.body, valid.signature, {
        headers: { "x-forwarded-for": "203.0.113.10" },
      }),
      accepted,
    );

    expect(accepted.statusCode).toBe(200);
    expect(dispatchSmsInboundEvent).toHaveBeenCalledTimes(1);
  });

  it("scopes signed webhook rate limits to one SMS account and route", async () => {
    const supportAccount = createAccount({
      accountId: "support",
      accountSid: "AC-support",
      webhookPath: "/webhooks/sms/support",
      publicWebhookUrl: "https://gateway.example.com/webhooks/sms/support",
    });
    const defaultAccount = createAccount();
    const supportHandler = createSmsWebhookHandler({
      cfg: {},
      account: supportAccount,
      channelRuntime: {} as SmsChannelRuntime,
    });
    const defaultHandler = createSmsWebhookHandler({
      cfg: {},
      account: defaultAccount,
      channelRuntime: {} as SmsChannelRuntime,
    });

    for (let i = 0; i < 30; i += 1) {
      const valid = createSignedBody({
        account: supportAccount,
        messageSid: `SM-support-${i}`,
      });
      const res = createResponse();
      await supportHandler(createRequest(valid.body, valid.signature), res);
      expect(res.statusCode).toBe(200);
    }
    const rateLimited = createSignedBody({
      account: supportAccount,
      messageSid: "SM-support-rate-limited",
    });
    const rateLimitedRes = createResponse();
    await supportHandler(createRequest(rateLimited.body, rateLimited.signature), rateLimitedRes);
    expect(rateLimitedRes.statusCode).toBe(429);

    const defaultValid = createSignedBody({
      account: defaultAccount,
      messageSid: "SM-default-after-support-limit",
    });
    const defaultRes = createResponse();
    await defaultHandler(createRequest(defaultValid.body, defaultValid.signature), defaultRes);

    expect(defaultRes.statusCode).toBe(200);
  });

  it("keeps validation-disabled webhook dispatches on the stricter callback budget", async () => {
    const account = createAccount({ dangerouslyDisableSignatureValidation: true });
    const handler = createSmsWebhookHandler({
      cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
      account,
      channelRuntime: {} as SmsChannelRuntime,
    });

    for (let i = 0; i < 30; i += 1) {
      const valid = createSignedBody({
        account,
        messageSid: `SM-disabled-${i}`,
      });
      const res = createResponse();
      await handler(
        createRequest(valid.body, "unused-signature", {
          headers: { "x-forwarded-for": "203.0.113.20" },
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
    }

    const overBudget = createSignedBody({
      account,
      messageSid: "SM-disabled-over-budget",
    });
    const overBudgetRes = createResponse();
    await handler(
      createRequest(overBudget.body, "unused-signature", {
        headers: { "x-forwarded-for": "203.0.113.20" },
      }),
      overBudgetRes,
    );

    expect(overBudgetRes.statusCode).toBe(429);
    expect(dispatchSmsInboundEvent).toHaveBeenCalledTimes(30);
  });
});
