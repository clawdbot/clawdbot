import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createLineNodeWebhookHandler, readLineWebhookRequestBody } from "./webhook-node.js";
import { createLineWebhookMiddleware } from "./webhook.js";

const sign = (body: string, secret: string) =>
  crypto.createHmac("SHA256", secret).update(body).digest("base64");

function createRes() {
  const headers: Record<string, string> = {};
  const resObj = {
    statusCode: 0,
    headersSent: false,
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    end: vi.fn((data?: unknown) => {
      resObj.headersSent = true;
      // Keep payload available for assertions
      resObj.body = data;
    }),
    body: undefined as unknown,
  };
  const res = resObj as unknown as ServerResponse & { body?: unknown };
  return { res, headers };
}

const SECRET = "secret";

type ParsedLineWebhookPayload = {
  events: unknown;
};

function firstMockCall(
  mock: { mock: { calls: Array<readonly unknown[]> } },
  label: string,
): readonly unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

function firstParsedPayload(
  mock: { mock: { calls: Array<readonly unknown[]> } },
  label: string,
): ParsedLineWebhookPayload {
  return firstMockCall(mock, label)[0] as ParsedLineWebhookPayload;
}

type RuntimeEnvMock = RuntimeEnv & {
  error: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  exit: ReturnType<typeof vi.fn<(code: number) => void>>;
  log: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
};

function createRuntimeMock(): RuntimeEnvMock {
  return {
    error: vi.fn<(...args: unknown[]) => void>(),
    exit: vi.fn<(code: number) => void>(),
    log: vi.fn<(...args: unknown[]) => void>(),
  };
}

function createMiddlewareRes() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    headersSent: false,
  } as any;
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

function createPostWebhookTestHarness(rawBody: string, secret = "secret") {
  const bot = { handleWebhook: vi.fn(async () => {}) };
  const runtime = createRuntimeMock();
  const handler = createLineNodeWebhookHandler({
    channelSecret: secret,
    bot,
    runtime,
    readBody: async () => rawBody,
  });
  return { bot, handler, secret };
}

const runSignedPost = async (params: {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  rawBody: string;
  secret: string;
  res: ServerResponse;
}) =>
  await params.handler(
    {
      method: "POST",
      headers: { "x-line-signature": sign(params.rawBody, params.secret) },
    } as unknown as IncomingMessage,
    params.res,
  );

async function invokeWebhook(params: {
  body: unknown;
  headers?: Record<string, string>;
  onEvents?: ReturnType<typeof vi.fn>;
  autoSign?: boolean;
  runtime?: RuntimeEnv;
}) {
  const onEventsMock = params.onEvents ?? vi.fn(async () => {});
  const middleware = createLineWebhookMiddleware({
    channelSecret: SECRET,
    onEvents: onEventsMock as never,
    runtime: params.runtime,
  });

  const headers = { ...params.headers };
  const autoSign = params.autoSign ?? true;
  if (autoSign && !headers["x-line-signature"]) {
    if (typeof params.body === "string") {
      headers["x-line-signature"] = sign(params.body, SECRET);
    } else if (Buffer.isBuffer(params.body)) {
      headers["x-line-signature"] = sign(params.body.toString("utf-8"), SECRET);
    }
  }

  const req = {
    headers,
    body: params.body,
  } as any;
  const res = createMiddlewareRes();
  await middleware(req, res, {} as any);
  return { res, onEvents: onEventsMock };
}

const parseResponseBody = (body: unknown) => {
  if (typeof body !== "string") {
    return body;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
};

type WebhookPostResult = {
  body: unknown;
  contentType?: string;
  dispatched: ReturnType<typeof vi.fn>;
  runtimeError: ReturnType<typeof vi.fn>;
  status: number | undefined;
};

type WebhookPostInvoker = (params: {
  failWith?: Error;
  rawBody: string;
  signed: boolean;
}) => Promise<WebhookPostResult>;

async function invokeNodePostContract(params: {
  failWith?: Error;
  rawBody: string;
  signed: boolean;
}) {
  const dispatched = vi.fn(async () => {
    if (params.failWith) {
      throw params.failWith;
    }
  });
  const runtime = createRuntimeMock();
  const handler = createLineNodeWebhookHandler({
    channelSecret: SECRET,
    bot: { handleWebhook: dispatched },
    runtime,
    readBody: async () => params.rawBody,
  });
  const { res, headers } = createRes();
  await handler(
    {
      method: "POST",
      headers: params.signed ? { "x-line-signature": sign(params.rawBody, SECRET) } : {},
    } as unknown as IncomingMessage,
    res,
  );
  return {
    body: parseResponseBody(res.body),
    contentType: headers["content-type"],
    dispatched,
    runtimeError: runtime.error,
    status: res.statusCode,
  };
}

async function invokeMiddlewarePostContract(params: {
  failWith?: Error;
  rawBody: string;
  signed: boolean;
}) {
  const runtime = createRuntimeMock();
  const onEvents = vi.fn(async () => {
    if (params.failWith) {
      throw params.failWith;
    }
  });
  const { res, onEvents: dispatched } = await invokeWebhook({
    body: params.rawBody,
    headers: params.signed ? undefined : {},
    autoSign: params.signed,
    onEvents,
    runtime,
  });
  return {
    body: res.json.mock.calls.at(-1)?.[0],
    contentType: undefined,
    dispatched,
    runtimeError: runtime.error,
    status: res.status.mock.calls.at(-1)?.[0],
  };
}

const sharedWebhookPostContractCases = [
  { name: "node handler", invoke: invokeNodePostContract },
  { name: "middleware", invoke: invokeMiddlewarePostContract },
] satisfies Array<{
  name: string;
  invoke: WebhookPostInvoker;
}>;

async function expectSignedRawBodyWins(params: { rawBody: string | Buffer; signedUserId: string }) {
  const onEvents = vi.fn(async () => {});
  const reqBody = {
    events: [{ type: "message", source: { userId: "tampered-user" } }],
  };
  const middleware = createLineWebhookMiddleware({
    channelSecret: SECRET,
    onEvents,
  });
  const rawBodyText =
    typeof params.rawBody === "string" ? params.rawBody : params.rawBody.toString("utf-8");
  const req = {
    headers: { "x-line-signature": sign(rawBodyText, SECRET) },
    rawBody: params.rawBody,
    body: reqBody,
  } as any;
  const res = createMiddlewareRes();

  await middleware(req, res, {} as any);

  expect(res.status).toHaveBeenCalledWith(200);
  expect(onEvents).toHaveBeenCalledTimes(1);
  const processedBody = firstMockCall(onEvents, "LINE webhook events")[0] as {
    events?: Array<{ source?: { userId?: string } }>;
  };
  expect(processedBody?.events?.[0]?.source?.userId).toBe(params.signedUserId);
  expect(processedBody?.events?.[0]?.source?.userId).not.toBe("tampered-user");
}

describe("LINE webhook shared POST contract", () => {
  it.each(sharedWebhookPostContractCases)(
    "$name rejects verification-shaped requests without a signature",
    async ({ invoke }) => {
      const result = await invoke({ rawBody: JSON.stringify({ events: [] }), signed: false });

      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: "Missing X-Line-Signature header" });
      if (result.contentType) {
        expect(result.contentType).toBe("application/json");
      }
      expect(result.dispatched).not.toHaveBeenCalled();
    },
  );

  it.each(sharedWebhookPostContractCases)(
    "$name accepts signed verification-shaped requests without dispatching events",
    async ({ invoke }) => {
      const result = await invoke({ rawBody: JSON.stringify({ events: [] }), signed: true });

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ status: "ok" });
      if (result.contentType) {
        expect(result.contentType).toBe("application/json");
      }
      expect(result.dispatched).not.toHaveBeenCalled();
    },
  );

  it.each(sharedWebhookPostContractCases)(
    "$name rejects missing signature when events are non-empty",
    async ({ invoke }) => {
      const result = await invoke({
        rawBody: JSON.stringify({ events: [{ type: "message" }] }),
        signed: false,
      });

      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: "Missing X-Line-Signature header" });
      expect(result.dispatched).not.toHaveBeenCalled();
    },
  );

  it.each(sharedWebhookPostContractCases)(
    "$name returns 500 when event processing fails and does not acknowledge with 200",
    async ({ invoke }) => {
      const result = await invoke({
        failWith: new Error("transient failure"),
        rawBody: JSON.stringify({ events: [{ type: "message" }] }),
        signed: true,
      });

      expect(result.status).toBe(500);
      expect(result.body).toEqual({ error: "Internal server error" });
      expect(result.dispatched).toHaveBeenCalledTimes(1);
      expect(result.runtimeError).toHaveBeenCalledTimes(1);
    },
  );
});

describe("createLineNodeWebhookHandler", () => {
  it("returns 200 for GET", async () => {
    const bot = { handleWebhook: vi.fn(async () => {}) };
    const runtime = createRuntimeMock();
    const handler = createLineNodeWebhookHandler({
      channelSecret: "secret",
      bot,
      runtime,
      readBody: async () => "",
    });

    const { res } = createRes();
    await handler({ method: "GET", headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("OK");
  });

  it("returns 204 for HEAD", async () => {
    const bot = { handleWebhook: vi.fn(async () => {}) };
    const runtime = createRuntimeMock();
    const handler = createLineNodeWebhookHandler({
      channelSecret: "secret",
      bot,
      runtime,
      readBody: async () => "",
    });

    const { res } = createRes();
    await handler({ method: "HEAD", headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(204);
    expect(res.body).toBeUndefined();
  });

  it("returns 405 for non-GET/HEAD/POST methods", async () => {
    const { bot, handler } = createPostWebhookTestHarness(JSON.stringify({ events: [] }));

    const { res, headers } = createRes();
    await handler({ method: "PUT", headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(405);
    expect(headers.allow).toBe("GET, HEAD, POST");
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("rejects unsigned POST requests before reading the body", async () => {
    const bot = { handleWebhook: vi.fn(async () => {}) };
    const runtime = createRuntimeMock();
    const readBody = vi.fn(async () => JSON.stringify({ events: [{ type: "message" }] }));
    const handler = createLineNodeWebhookHandler({
      channelSecret: "secret",
      bot,
      runtime,
      readBody,
    });

    const { res } = createRes();
    await handler({ method: "POST", headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(400);
    expect(readBody).not.toHaveBeenCalled();
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("uses strict pre-auth limits for signed POST requests", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const bot = { handleWebhook: vi.fn(async () => {}) };
    const runtime = createRuntimeMock();
    const readBody = vi.fn(async (_req: IncomingMessage, maxBytes: number, timeoutMs?: number) => {
      expect(maxBytes).toBe(64 * 1024);
      expect(timeoutMs).toBe(5_000);
      return rawBody;
    });
    const handler = createLineNodeWebhookHandler({
      channelSecret: "secret",
      bot,
      runtime,
      readBody,
      maxBodyBytes: 1024 * 1024,
    });

    const { res } = createRes();
    await runSignedPost({ handler, rawBody, secret: "secret", res });

    expect(res.statusCode).toBe(200);
    expect(readBody).toHaveBeenCalledTimes(1);
    expect(bot.handleWebhook).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid signature", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const { bot, handler } = createPostWebhookTestHarness(rawBody);

    const { res } = createRes();
    await handler(
      { method: "POST", headers: { "x-line-signature": "bad" } } as unknown as IncomingMessage,
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("accepts valid signature and dispatches events", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const { bot, handler, secret } = createPostWebhookTestHarness(rawBody);

    const { res } = createRes();
    await runSignedPost({ handler, rawBody, secret, res });

    expect(res.statusCode).toBe(200);
    expect(bot.handleWebhook).toHaveBeenCalledTimes(1);
    const payload = firstParsedPayload(bot.handleWebhook, "LINE node webhook payload");
    expect(payload.events).toEqual([{ type: "message" }]);
  });

  it("releases authenticated requests before event processing completes", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    let releaseAuthenticated: (() => void) | undefined;
    const bot = {
      handleWebhook: vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            releaseAuthenticated = resolve;
          }),
      ),
    };
    const onRequestAuthenticated = vi.fn();
    const runtime = createRuntimeMock();
    const handler = createLineNodeWebhookHandler({
      channelSecret: SECRET,
      bot,
      runtime,
      readBody: async () => rawBody,
      onRequestAuthenticated,
    });

    const { res } = createRes();
    const request = runSignedPost({ handler, rawBody, secret: SECRET, res });

    await vi.waitFor(() => {
      expect(onRequestAuthenticated).toHaveBeenCalledTimes(1);
      expect(bot.handleWebhook).toHaveBeenCalledTimes(1);
    });

    expect(res.headersSent).toBe(false);
    if (!releaseAuthenticated) {
      throw new Error("Expected LINE authenticated request release callback to be initialized");
    }
    releaseAuthenticated();
    await request;

    expect(res.statusCode).toBe(200);
  });

  it("returns 400 for invalid JSON payload even when signature is valid", async () => {
    const rawBody = "not json";
    const { bot, handler, secret } = createPostWebhookTestHarness(rawBody);

    const { res } = createRes();
    await runSignedPost({ handler, rawBody, secret, res });

    expect(res.statusCode).toBe(400);
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });
});

describe("readLineWebhookRequestBody", () => {
  it("reads body within limit", async () => {
    const req = createMockIncomingRequest(['{"events":[{"type":"message"}]}']);
    const body = await readLineWebhookRequestBody(req, 1024);
    expect(body).toContain('"events"');
  });

  it("rejects oversized body", async () => {
    const req = createMockIncomingRequest(["x".repeat(2048)]);
    await expect(readLineWebhookRequestBody(req, 128)).rejects.toThrow("PayloadTooLarge");
  });
});

describe("createLineWebhookMiddleware", () => {
  it.each([
    ["raw string body", JSON.stringify({ events: [{ type: "message" }] }), [{ type: "message" }]],
    [
      "raw buffer body",
      Buffer.from(JSON.stringify({ events: [{ type: "follow" }] }), "utf-8"),
      [{ type: "follow" }],
    ],
  ])("parses JSON from %s", async (_label, body, expectedEvents) => {
    const { res, onEvents } = await invokeWebhook({ body });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(onEvents).toHaveBeenCalledTimes(1);
    const payload = firstParsedPayload(onEvents, "LINE middleware payload");
    expect(payload.events).toEqual(expectedEvents);
  });

  it("rejects invalid JSON payloads", async () => {
    const { res, onEvents } = await invokeWebhook({ body: "not json" });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects webhooks with invalid signatures", async () => {
    const { res, onEvents } = await invokeWebhook({
      body: JSON.stringify({ events: [{ type: "message" }] }),
      headers: { "x-line-signature": "invalid-signature" },
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects oversized signed payloads before JSON parsing", async () => {
    const largeBody = JSON.stringify({ events: [], payload: "x".repeat(70 * 1024) });
    const { res, onEvents } = await invokeWebhook({ body: largeBody });
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({ error: "Payload too large" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects signed requests when raw body is missing", async () => {
    const { res, onEvents } = await invokeWebhook({
      body: { events: [{ type: "message" }] },
      headers: { "x-line-signature": "signed" },
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Missing raw request body for signature verification",
    });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("uses the signed raw body instead of a pre-parsed req.body object", async () => {
    await expectSignedRawBodyWins({
      rawBody: JSON.stringify({
        events: [{ type: "message", source: { userId: "signed-user" } }],
      }),
      signedUserId: "signed-user",
    });
  });

  it("uses signed raw buffer body instead of a pre-parsed req.body object", async () => {
    await expectSignedRawBodyWins({
      rawBody: Buffer.from(
        JSON.stringify({
          events: [{ type: "message", source: { userId: "signed-buffer-user" } }],
        }),
        "utf-8",
      ),
      signedUserId: "signed-buffer-user",
    });
  });

  it("rejects invalid signed raw JSON even when req.body is a valid object", async () => {
    const onEvents = vi.fn(async () => {});
    const rawBody = "not-json";
    const middleware = createLineWebhookMiddleware({
      channelSecret: SECRET,
      onEvents,
    });

    const req = {
      headers: { "x-line-signature": sign(rawBody, SECRET) },
      rawBody,
      body: { events: [{ type: "message" }] },
    } as any;
    const res = createMiddlewareRes();

    await middleware(req, res, {} as any);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid webhook payload" });
    expect(onEvents).not.toHaveBeenCalled();
  });
});
