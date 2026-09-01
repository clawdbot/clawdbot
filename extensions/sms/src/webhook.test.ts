// Sms tests cover webhook plugin behavior.
import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SmsDeliveryRecorder } from "./delivery-observations.js";
import type { ResolvedSmsAccount } from "./types.js";
import { createSmsWebhookHandler } from "./webhook.js";

const assertSmsCredentialOwnerAvailable = vi.hoisted(() => vi.fn());
const enqueueSmsIngress = vi.hoisted(() =>
  vi.fn(async () => ({ kind: "accepted" as const, duplicate: false })),
);

vi.mock("./credential-availability.js", () => ({ assertSmsCredentialOwnerAvailable }));

let testAccountSequence = 0;
let activeAccountId = "test-0";

function createIngress() {
  return {
    enqueue: enqueueSmsIngress,
  };
}

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

function configureRequest(req: IncomingMessage): IncomingMessage {
  req.method = "POST";
  req.headers = {};
  Object.defineProperty(req, "socket", {
    value: { remoteAddress: "127.0.0.1" },
  });
  return req;
}

function createFailingRequest(error?: Error): IncomingMessage {
  return configureRequest(
    new Readable({
      read() {
        this.destroy(error);
      },
    }) as IncomingMessage,
  );
}

function createPendingRequest(): IncomingMessage {
  return configureRequest(new Readable({ read() {} }) as IncomingMessage);
}

type TestResponse = ServerResponse & {
  body?: string;
  setHeaderMock: ReturnType<typeof vi.fn>;
  endMock: ReturnType<typeof vi.fn>;
};

function createResponse(): TestResponse {
  const setHeaderMock = vi.fn();
  const endMock = vi.fn(function (this: ServerResponse & { body?: string }, body?: string) {
    this.body = body;
    return this;
  });
  return {
    statusCode: 200,
    setHeader: setHeaderMock,
    setHeaderMock,
    end: endMock,
    endMock,
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

function createSignedDeliveryPayload(params: {
  messageSid: string;
  status: string;
  account?: ResolvedSmsAccount;
  accountSid?: string;
}): { body: string; signature: string; form: Record<string, string> } {
  const account = params.account ?? createAccount();
  const form = {
    AccountSid: params.accountSid ?? account.accountSid,
    From: account.fromNumber,
    To: "+15551234567",
    MessageSid: params.messageSid,
    MessageStatus: params.status,
  };
  const body = new URLSearchParams(form).toString();
  return {
    body,
    form,
    signature: computeTestTwilioSignature({
      url: account.publicWebhookUrl,
      authToken: account.authToken,
      form,
    }),
  };
}

function createDeliveryRecorder(
  record = vi.fn<SmsDeliveryRecorder["record"]>(async ({ account, form }) => ({
    duplicate: false,
    record: {
      accountId: account.accountId,
      accountSidHash: "account-sid-hash",
      messageSid: form.MessageSid ?? form.SmsSid ?? form.SmsMessageSid ?? "",
      status: form.MessageStatus ?? form.SmsStatus ?? "",
      firstObservedAt: 1,
      lastObservedAt: 1,
      observations: [],
    },
  })),
): SmsDeliveryRecorder & { record: typeof record } {
  return { record };
}

function createMessageSid(index: number): string {
  return `SM${index.toString(16).padStart(32, "0")}`;
}

describe("createSmsWebhookHandler", () => {
  beforeEach(() => {
    assertSmsCredentialOwnerAvailable.mockReset();
    enqueueSmsIngress.mockReset();
    enqueueSmsIngress.mockResolvedValue({ kind: "accepted", duplicate: false });
    activeAccountId = `test-${++testAccountSequence}`;
  });

  it("rechecks the owner after parsing and before authentication or durable admission", async () => {
    let bodyRead = false;
    assertSmsCredentialOwnerAvailable.mockImplementationOnce(() => {
      expect(bodyRead).toBe(true);
      throw new Error("SMS credential owner unavailable");
    });
    const { body, signature } = createSignedBody();
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: createIngress(),
    });
    const res = createResponse();
    const req = createPendingRequest();
    req.headers = {
      "content-length": String(Buffer.byteLength(body)),
      "x-twilio-signature": signature,
    };

    const pending = handler(req, res);
    req.push(body);
    bodyRead = true;
    req.push(null);

    await expect(pending).rejects.toThrow("SMS credential owner unavailable");
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
  });

  it("validates a fragmentless signature before enqueuing the raw Twilio form", async () => {
    const { body, signature } = createSignedSmsPayload(createMessageSid(1));
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount({
        publicWebhookUrl: "https://gateway.example.com/webhooks/sms#rp=4xx",
      }),
      ingress: createIngress(),
    });

    const res = createResponse();
    await handler(createRequest(body, signature), res);

    expect(res.statusCode).toBe(200);
    expect(res.setHeaderMock).toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
    expect(enqueueSmsIngress).toHaveBeenCalledWith(parseTestTwilioForm(body));
  });

  it("returns terminal HTTP 413 for an oversized callback body", async () => {
    const delivery = createDeliveryRecorder();
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: createIngress(),
      delivery,
    });
    const res = createResponse();

    await handler(
      createRequest("x", "unused", {
        headers: { "content-length": String(32 * 1024 + 1) },
      }),
      res,
    );

    expect(res.statusCode).toBe(413);
    expect(res.body).toBe("Payload too large");
    expect(delivery.record).not.toHaveBeenCalled();
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
  });

  it("rethrows request body timeouts for Gateway-owned retry responses", async () => {
    vi.useFakeTimers();
    try {
      const handler = createSmsWebhookHandler({
        cfg: {},
        account: createAccount(),
        ingress: createIngress(),
      });
      const res = createResponse();
      const handling = handler(createPendingRequest(), res);
      const expected = expect(handling).rejects.toMatchObject({
        code: "REQUEST_BODY_TIMEOUT",
      });

      await vi.advanceTimersByTimeAsync(5_000);
      await expected;

      expect(res.endMock).not.toHaveBeenCalled();
      expect(enqueueSmsIngress).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rethrows unexpected request read failures for Gateway-owned retry responses", async () => {
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: createIngress(),
    });
    const res = createResponse();

    await expect(handler(createFailingRequest(new Error("read failed")), res)).rejects.toThrow(
      "read failed",
    );
    expect(res.endMock).not.toHaveBeenCalled();
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
  });

  it("rethrows a closed request body for Gateway-owned retry responses", async () => {
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: createIngress(),
    });
    const res = createResponse();

    await expect(handler(createFailingRequest(), res)).rejects.toMatchObject({
      code: "CONNECTION_CLOSED",
    });
    expect(res.endMock).not.toHaveBeenCalled();
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
  });

  it("persists signed delivery callbacks without dispatching them as inbound messages", async () => {
    const payload = createSignedDeliveryPayload({
      messageSid: createMessageSid(20),
      status: "delivered",
    });
    const delivery = createDeliveryRecorder();
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: createIngress(),
      delivery,
    });
    const res = createResponse();

    await handler(createRequest(payload.body, payload.signature), res);

    expect(res.statusCode).toBe(200);
    expect(res.setHeaderMock).toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
    expect(delivery.record).toHaveBeenCalledWith({
      account: expect.objectContaining({ accountId: activeAccountId }),
      form: payload.form,
    });
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
  });

  it("accepts legacy SmsSid and SmsStatus delivery callbacks", async () => {
    const account = createAccount();
    const form = {
      AccountSid: account.accountSid,
      From: account.fromNumber,
      To: "+15551234567",
      SmsSid: createMessageSid(23),
      SmsStatus: "delivered",
    };
    const body = new URLSearchParams(form).toString();
    const signature = computeTestTwilioSignature({
      url: account.publicWebhookUrl,
      authToken: account.authToken,
      form,
    });
    const delivery = createDeliveryRecorder();
    const handler = createSmsWebhookHandler({
      cfg: {},
      account,
      ingress: createIngress(),
      delivery,
    });
    const res = createResponse();

    await handler(createRequest(body, signature), res);

    expect(res.statusCode).toBe(200);
    expect(delivery.record).toHaveBeenCalledWith({ account, form });
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
  });

  it.each(["receiving", "received"])(
    "keeps legacy inbound SmsStatus=%s on the durable ingress path",
    async (status) => {
      const account = createAccount();
      const form = {
        AccountSid: account.accountSid,
        From: "+15551234567",
        To: account.fromNumber,
        Body: "hello",
        SmsSid: createMessageSid(status === "receiving" ? 24 : 25),
        SmsStatus: status,
      };
      const body = new URLSearchParams(form).toString();
      const signature = computeTestTwilioSignature({
        url: account.publicWebhookUrl,
        authToken: account.authToken,
        form,
      });
      const delivery = createDeliveryRecorder();
      const handler = createSmsWebhookHandler({
        cfg: {},
        account,
        ingress: createIngress(),
        delivery,
      });
      const res = createResponse();

      await handler(createRequest(body, signature), res);

      expect(res.statusCode).toBe(200);
      expect(delivery.record).not.toHaveBeenCalled();
      expect(enqueueSmsIngress).toHaveBeenCalledWith(form);
    },
  );

  it("rejects an invalid signature before delivery persistence", async () => {
    const payload = createSignedDeliveryPayload({
      messageSid: createMessageSid(26),
      status: "delivered",
    });
    const delivery = createDeliveryRecorder();
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: createIngress(),
      delivery,
    });
    const res = createResponse();

    await handler(createRequest(payload.body, "invalid-signature"), res);

    expect(res.statusCode).toBe(403);
    expect(delivery.record).not.toHaveBeenCalled();
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
  });

  it("does not acknowledge a delivery callback until durable persistence succeeds", async () => {
    const payload = createSignedDeliveryPayload({
      messageSid: createMessageSid(21),
      status: "sent",
    });
    const delivery = createDeliveryRecorder(
      vi.fn<SmsDeliveryRecorder["record"]>(async () => {
        throw new Error("sqlite unavailable");
      }),
    );
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: createIngress(),
      delivery,
    });
    const res = createResponse();

    await expect(handler(createRequest(payload.body, payload.signature), res)).rejects.toThrow(
      "sqlite unavailable",
    );
    expect(res.endMock).not.toHaveBeenCalled();
    expect(res.setHeaderMock).not.toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
  });

  it("waits for the durable delivery commit before returning HTTP 200", async () => {
    const account = createAccount();
    const payload = createSignedDeliveryPayload({
      account,
      messageSid: createMessageSid(22),
      status: "sent",
    });
    let releaseCommit: (() => void) | undefined;
    const delivery = createDeliveryRecorder(
      vi.fn<SmsDeliveryRecorder["record"]>(async ({ form }) => {
        await new Promise<void>((resolve) => {
          releaseCommit = resolve;
        });
        return {
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
        };
      }),
    );
    const handler = createSmsWebhookHandler({
      cfg: {},
      account,
      ingress: createIngress(),
      delivery,
    });
    const res = createResponse();

    const pending = handler(createRequest(payload.body, payload.signature), res);
    await vi.waitFor(() => expect(delivery.record).toHaveBeenCalledOnce());
    expect(res.endMock).not.toHaveBeenCalled();
    expect(res.setHeaderMock).not.toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");

    if (!releaseCommit) {
      throw new Error("expected pending SMS delivery commit");
    }
    releaseCommit();
    await pending;

    expect(res.statusCode).toBe(200);
    expect(res.setHeaderMock).toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
    expect(res.endMock).toHaveBeenCalledOnce();
  });

  it("acknowledges but does not store a signed delivery callback for another account", async () => {
    const payload = createSignedDeliveryPayload({
      messageSid: createMessageSid(22),
      status: "failed",
      accountSid: "AC-other",
    });
    const delivery = createDeliveryRecorder();
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: createIngress(),
      delivery,
    });
    const res = createResponse();

    await handler(createRequest(payload.body, payload.signature), res);

    expect(res.statusCode).toBe(200);
    expect(delivery.record).not.toHaveBeenCalled();
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
    expect(res.setHeaderMock).not.toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["padded", " AC123 "],
  ])("acknowledges but does not store a delivery callback with %s AccountSid", async (_, sid) => {
    const account = createAccount();
    const form: Record<string, string> = {
      MessageSid: createMessageSid(27),
      MessageStatus: "failed",
    };
    if (sid !== undefined) {
      form.AccountSid = sid;
    }
    const body = new URLSearchParams(form).toString();
    const signature = computeTestTwilioSignature({
      url: account.publicWebhookUrl,
      authToken: account.authToken,
      form,
    });
    const delivery = createDeliveryRecorder();
    const handler = createSmsWebhookHandler({
      cfg: {},
      account,
      ingress: createIngress(),
      delivery,
    });
    const res = createResponse();

    await handler(createRequest(body, signature), res);

    expect(res.statusCode).toBe(200);
    expect(delivery.record).not.toHaveBeenCalled();
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
    expect(res.setHeaderMock).not.toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
  });

  it("does not acknowledge when the durable enqueue fails", async () => {
    const { body, signature } = createSignedSmsPayload(createMessageSid(2));
    enqueueSmsIngress.mockRejectedValueOnce(new Error("sqlite unavailable"));
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: createIngress(),
    });
    const res = createResponse();

    await expect(handler(createRequest(body, signature), res)).rejects.toThrow(
      "sqlite unavailable",
    );

    expect(res.endMock).not.toHaveBeenCalled();
    expect(res.setHeaderMock).not.toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
  });

  it("acknowledges only after the durable enqueue resolves", async () => {
    const { body, signature } = createSignedSmsPayload(createMessageSid(3));
    let releaseAdmission: (() => void) | undefined;
    enqueueSmsIngress.mockImplementationOnce(
      async () =>
        await new Promise<{ kind: "accepted"; duplicate: boolean }>((resolve) => {
          releaseAdmission = () => resolve({ kind: "accepted", duplicate: false });
        }),
    );
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: createIngress(),
    });
    const res = createResponse();

    const handling = handler(createRequest(body, signature), res);
    await vi.waitFor(() => expect(enqueueSmsIngress).toHaveBeenCalledTimes(1));
    expect(res.endMock).not.toHaveBeenCalled();
    if (!releaseAdmission) {
      throw new Error("expected pending SMS durable admission");
    }
    releaseAdmission();
    await handling;

    expect(res.statusCode).toBe(200);
    expect(res.setHeaderMock).toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
    expect(res.endMock).toHaveBeenCalledTimes(1);
  });

  it("still acks durable when the enqueue reports a replayed duplicate", async () => {
    const { body, signature } = createSignedSmsPayload(createMessageSid(4));
    enqueueSmsIngress.mockResolvedValueOnce({ kind: "accepted", duplicate: true });
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: createIngress(),
    });
    const res = createResponse();

    await handler(createRequest(body, signature), res);

    expect(res.statusCode).toBe(200);
    expect(res.setHeaderMock).toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
  });

  it("rejects a signed webhook without a stable MessageSid", async () => {
    const body = "AccountSid=AC123&From=%2B15551234567&To=%2B15557654321&Body=hello";
    const signature = computeTestTwilioSignature({
      url: "https://gateway.example.com/webhooks/sms",
      authToken: "secret",
      form: parseTestTwilioForm(body),
    });
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: createIngress(),
    });
    const res = createResponse();

    await handler(createRequest(body, signature), res);

    expect(res.statusCode).toBe(400);
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
  });

  it("accepts the legacy SmsMessageSid event id alias", async () => {
    const body =
      "AccountSid=AC123&From=%2B15551234567&To=%2B15557654321&Body=hello&SmsMessageSid=SM-alias";
    const signature = computeTestTwilioSignature({
      url: "https://gateway.example.com/webhooks/sms",
      authToken: "secret",
      form: parseTestTwilioForm(body),
    });
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: createIngress(),
    });
    const res = createResponse();

    await handler(createRequest(body, signature), res);

    expect(res.statusCode).toBe(200);
    expect(enqueueSmsIngress).toHaveBeenCalledWith(
      expect.objectContaining({ SmsMessageSid: "SM-alias" }),
    );
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
      ingress: createIngress(),
    });

    expect(parseTestTwilioForm(body).From).toBe("RcS:+1 (555) 123-4567");

    const res = createResponse();
    await handler(createRequest(body, signature), res);

    expect(res.statusCode).toBe(200);
    expect(enqueueSmsIngress).toHaveBeenCalledWith(
      expect.objectContaining({
        AccountSid: "AC123",
        From: "RcS:+1 (555) 123-4567",
        To: "rcs:example-agent",
        Body: "hello",
        MessageSid: messageSid,
      }),
    );
  });

  it("durably accepts a signed account mismatch for non-retryable drain classification", async () => {
    const body = `AccountSid=AC-other&From=%2B15551234567&To=%2B15557654321&Body=hello&MessageSid=${createMessageSid(8)}`;
    const signature = computeTestTwilioSignature({
      url: "https://gateway.example.com/webhooks/sms",
      authToken: "secret",
      form: parseTestTwilioForm(body),
    });
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: createIngress(),
    });

    const res = createResponse();
    await handler(createRequest(body, signature), res);

    expect(res.statusCode).toBe(200);
    expect(enqueueSmsIngress).toHaveBeenCalledWith(
      expect.objectContaining({ AccountSid: "AC-other" }),
    );
  });

  it("does not let unsigned proxy traffic consume the same client's signed webhook rate limit", async () => {
    const account = createAccount();
    const handler = createSmsWebhookHandler({
      cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
      account,
      ingress: createIngress(),
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
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(1);
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
      ingress: createIngress(),
    });
    const defaultHandler = createSmsWebhookHandler({
      cfg: {},
      account: defaultAccount,
      ingress: createIngress(),
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

  it("meters inbound dispatch per sender without throttling signed delivery callbacks", async () => {
    const warn = vi.fn();
    const account = createAccount();
    const delivery = createDeliveryRecorder();
    const handler = createSmsWebhookHandler({
      cfg: {},
      account,
      ingress: createIngress(),
      delivery,
      log: { warn },
    });

    for (let i = 0; i < 30; i += 1) {
      const { body, signature } = createSignedSmsPayload(createMessageSid(500 + i));
      const res = createResponse();
      await handler(createRequest(body, signature, { remoteAddress: "203.0.113.30" }), res);
      expect(res.statusCode).toBe(200);
    }
    // Equivalent Twilio RCS address syntax canonicalizes into the same sender bucket.
    const overQuota = createSignedSmsPayload(createMessageSid(530), {
      from: "RCS:+1 (555) 123-4567",
    });
    const overQuotaRes = createResponse();
    await handler(
      createRequest(overQuota.body, overQuota.signature, { remoteAddress: "203.0.113.30" }),
      overQuotaRes,
    );
    expect(overQuotaRes.statusCode).toBe(429);
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(30);
    expect(warn).toHaveBeenCalledWith("SMS webhook callback rate limit exceeded");
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("+15551234567"));

    // Same Twilio egress address, different validated sender: must still dispatch.
    const otherSender = createSignedSmsPayload(createMessageSid(531), { from: "+15559998888" });
    const otherSenderRes = createResponse();
    await handler(
      createRequest(otherSender.body, otherSender.signature, { remoteAddress: "203.0.113.30" }),
      otherSenderRes,
    );
    expect(otherSenderRes.statusCode).toBe(200);
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(31);

    // Changing Twilio egress addresses cannot widen the sender-scoped budget.
    const stillLimited = createSignedSmsPayload(createMessageSid(532));
    const stillLimitedRes = createResponse();
    await handler(
      createRequest(stillLimited.body, stillLimited.signature, { remoteAddress: "203.0.113.31" }),
      stillLimitedRes,
    );
    expect(stillLimitedRes.statusCode).toBe(429);
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(31);

    const status = createSignedDeliveryPayload({
      account,
      messageSid: createMessageSid(533),
      status: "delivered",
    });
    const statusRes = createResponse();
    await handler(createRequest(status.body, status.signature), statusRes);

    expect(statusRes.statusCode).toBe(200);
    expect(delivery.record).toHaveBeenCalledOnce();
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(31);
  });

  it("bounds aggregate inbound fan-out without throttling signed delivery callbacks", async () => {
    const account = createAccount();
    const delivery = createDeliveryRecorder();
    const handler = createSmsWebhookHandler({
      cfg: {},
      account,
      ingress: createIngress(),
      delivery,
    });

    for (let i = 0; i < 300; i += 1) {
      const distinctSender = `+1555${i.toString().padStart(7, "0")}`;
      const { body, signature } = createSignedSmsPayload(createMessageSid(900 + i), {
        from: distinctSender,
      });
      const res = createResponse();
      await handler(createRequest(body, signature), res);
      expect(res.statusCode).toBe(200);
    }

    const overAggregate = createSignedSmsPayload(createMessageSid(1_200), {
      from: "+15559999999",
    });
    const overAggregateRes = createResponse();
    await handler(createRequest(overAggregate.body, overAggregate.signature), overAggregateRes);

    expect(overAggregateRes.statusCode).toBe(429);
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(300);

    const status = createSignedDeliveryPayload({
      account,
      messageSid: createMessageSid(1_201),
      status: "delivered",
    });
    const statusRes = createResponse();
    await handler(createRequest(status.body, status.signature), statusRes);

    expect(statusRes.statusCode).toBe(200);
    expect(delivery.record).toHaveBeenCalledOnce();
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(300);
  });

  it("restores a rate limited sender after the fixed dispatch window expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const handler = createSmsWebhookHandler({
        cfg: {},
        account: createAccount(),
        ingress: createIngress(),
      });

      for (let i = 0; i < 30; i += 1) {
        const { body, signature } = createSignedSmsPayload(createMessageSid(600 + i));
        await handler(createRequest(body, signature), createResponse());
      }
      const throttled = createSignedSmsPayload(createMessageSid(630));
      const throttledRes = createResponse();
      await handler(createRequest(throttled.body, throttled.signature), throttledRes);
      expect(throttledRes.statusCode).toBe(429);

      vi.setSystemTime(Date.now() + 60_001);
      const recovered = createSignedSmsPayload(createMessageSid(631));
      const recoveredRes = createResponse();
      await handler(createRequest(recovered.body, recovered.signature), recoveredRes);

      expect(recoveredRes.statusCode).toBe(200);
      expect(enqueueSmsIngress).toHaveBeenCalledTimes(31);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one quota for invalid signed senders without throttling a valid sender", async () => {
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: createIngress(),
    });

    for (let i = 0; i < 30; i += 1) {
      const invalidSender = createSignedSmsPayload(createMessageSid(800 + i), {
        from: "not-a-phone",
      });
      const res = createResponse();
      await handler(createRequest(invalidSender.body, invalidSender.signature), res);
      expect(res.statusCode).toBe(200);
    }

    const invalidOverQuota = createSignedSmsPayload(createMessageSid(830), {
      from: "still-not-a-phone",
    });
    const invalidOverQuotaRes = createResponse();
    await handler(
      createRequest(invalidOverQuota.body, invalidOverQuota.signature),
      invalidOverQuotaRes,
    );
    expect(invalidOverQuotaRes.statusCode).toBe(429);

    const validSender = createSignedSmsPayload(createMessageSid(831));
    const validSenderRes = createResponse();
    await handler(createRequest(validSender.body, validSender.signature), validSenderRes);
    expect(validSenderRes.statusCode).toBe(200);
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(31);
  });

  it("keeps validation-disabled webhook dispatches on the stricter callback budget", async () => {
    const account = createAccount({ dangerouslyDisableSignatureValidation: true });
    const handler = createSmsWebhookHandler({
      cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
      account,
      ingress: createIngress(),
    });

    for (let i = 0; i < 30; i += 1) {
      // Rotate From: without signature validation it is unauthenticated input and
      // must not widen the address-keyed budget.
      const { body } = createSignedSmsPayload(createMessageSid(700 + i), {
        from: `+1555000${1000 + i}`,
      });
      const res = createResponse();
      await handler(
        createRequest(body, "unused-signature", {
          headers: { "x-forwarded-for": "203.0.113.20" },
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
    }

    const overBudget = createSignedSmsPayload(createMessageSid(760), { from: "+15550009999" });
    const overBudgetRes = createResponse();
    await handler(
      createRequest(overBudget.body, "unused-signature", {
        headers: { "x-forwarded-for": "203.0.113.20" },
      }),
      overBudgetRes,
    );

    expect(overBudgetRes.statusCode).toBe(429);
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(30);
  });

  it("rate limits unsigned delivery callbacks by client address before persistence", async () => {
    const account = createAccount({ dangerouslyDisableSignatureValidation: true });
    const delivery = createDeliveryRecorder();
    const handler = createSmsWebhookHandler({
      cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
      account,
      ingress: createIngress(),
      delivery,
    });

    for (let i = 0; i < 30; i += 1) {
      const payload = createSignedDeliveryPayload({
        account,
        messageSid: createMessageSid(1_300 + i),
        status: "sent",
      });
      const res = createResponse();
      await handler(
        createRequest(payload.body, "unused-signature", {
          headers: { "x-forwarded-for": "203.0.113.40" },
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
    }

    const overBudget = createSignedDeliveryPayload({
      account,
      messageSid: createMessageSid(1_330),
      status: "delivered",
    });
    const overBudgetRes = createResponse();
    await handler(
      createRequest(overBudget.body, "unused-signature", {
        headers: { "x-forwarded-for": "203.0.113.40" },
      }),
      overBudgetRes,
    );
    expect(overBudgetRes.statusCode).toBe(429);
    expect(delivery.record).toHaveBeenCalledTimes(30);

    const otherAddress = createSignedDeliveryPayload({
      account,
      messageSid: createMessageSid(1_331),
      status: "delivered",
    });
    const otherAddressRes = createResponse();
    await handler(
      createRequest(otherAddress.body, "unused-signature", {
        headers: { "x-forwarded-for": "203.0.113.41" },
      }),
      otherAddressRes,
    );
    expect(otherAddressRes.statusCode).toBe(200);
    expect(delivery.record).toHaveBeenCalledTimes(31);
  });
});
