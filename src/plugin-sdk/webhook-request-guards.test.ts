import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { createMockServerResponse } from "../test-utils/mock-http-response.js";
import { createFixedWindowRateLimiter } from "./webhook-memory-guards.js";
import {
  applyBasicWebhookRequestGuards,
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  isJsonContentType,
  readWebhookBodyOrReject,
  readJsonWebhookBodyOrReject,
} from "./webhook-request-guards.js";

type MockIncomingMessage = IncomingMessage & {
  destroyed?: boolean;
  destroy: () => MockIncomingMessage;
};

function createMockRequest(params: {
  method?: string;
  headers?: Record<string, string>;
  chunks?: string[];
  emitEnd?: boolean;
}): MockIncomingMessage {
  const req = new EventEmitter() as MockIncomingMessage;
  req.method = params.method ?? "POST";
  req.headers = params.headers ?? {};
  req.destroyed = false;
  req.destroy = (() => {
    req.destroyed = true;
    return req;
  }) as MockIncomingMessage["destroy"];

  if (params.chunks) {
    void Promise.resolve().then(() => {
      for (const chunk of params.chunks ?? []) {
        req.emit("data", Buffer.from(chunk, "utf-8"));
      }
      if (params.emitEnd !== false) {
        req.emit("end");
      }
    });
  }

  return req;
}

async function readJsonBody(chunks: string[], emptyObjectOnEmpty = false) {
  const req = createMockRequest({ chunks });
  const res = createMockServerResponse();
  return {
    result: await readJsonWebhookBodyOrReject({
      req,
      res,
      maxBytes: 1024,
      emptyObjectOnEmpty,
    }),
    res,
  };
}

async function readRawBody(params: Parameters<typeof createMockRequest>[0], profile?: "pre-auth") {
  const req = createMockRequest(params);
  const res = createMockServerResponse();
  return {
    result: await readWebhookBodyOrReject({
      req,
      res,
      profile,
    }),
    res,
  };
}

describe("isJsonContentType", () => {
  it.each([
    { name: "accepts application/json", input: "application/json", expected: true },
    {
      name: "accepts +json suffixes",
      input: "application/cloudevents+json; charset=utf-8",
      expected: true,
    },
    { name: "rejects non-json media types", input: "text/plain", expected: false },
    { name: "rejects missing media types", input: undefined, expected: false },
  ])("$name", ({ input, expected }) => {
    expect(isJsonContentType(input)).toBe(expected);
  });
});

describe("applyBasicWebhookRequestGuards", () => {
  it("rejects disallowed HTTP methods", () => {
    const req = createMockRequest({ method: "GET" });
    const res = createMockServerResponse();
    const ok = applyBasicWebhookRequestGuards({
      req,
      res,
      allowMethods: ["POST"],
    });
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(405);
    expect(res.getHeader("allow")).toBe("POST");
  });

  it("enforces rate limits", () => {
    const limiter = createFixedWindowRateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      maxTrackedKeys: 10,
    });
    const req1 = createMockRequest({ method: "POST" });
    const res1 = createMockServerResponse();
    const req2 = createMockRequest({ method: "POST" });
    const res2 = createMockServerResponse();
    expect(
      applyBasicWebhookRequestGuards({
        req: req1,
        res: res1,
        rateLimiter: limiter,
        rateLimitKey: "k",
        nowMs: 1_000,
      }),
    ).toBe(true);
    expect(
      applyBasicWebhookRequestGuards({
        req: req2,
        res: res2,
        rateLimiter: limiter,
        rateLimitKey: "k",
        nowMs: 1_001,
      }),
    ).toBe(false);
    expect(res2.statusCode).toBe(429);
  });

  it.each([
    {
      name: "allows matching JSON requests",
      req: createMockRequest({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
      expectedOk: true,
      expectedStatusCode: 200,
    },
    {
      name: "rejects non-json requests when required",
      req: createMockRequest({
        method: "POST",
        headers: { "content-type": "text/plain" },
      }),
      expectedOk: false,
      expectedStatusCode: 415,
    },
  ])("$name", ({ req, expectedOk, expectedStatusCode }) => {
    const res = createMockServerResponse();
    const ok = applyBasicWebhookRequestGuards({
      req,
      res,
      requireJsonContentType: true,
    });
    expect(ok).toBe(expectedOk);
    expect(res.statusCode).toBe(expectedStatusCode);
  });
});

describe("readJsonWebhookBodyOrReject", () => {
  it.each([
    {
      name: "returns parsed JSON body",
      chunks: ['{"ok":true}'],
      expected: { ok: true, value: { ok: true } },
      expectedStatusCode: 200,
      expectedBody: undefined,
    },
    {
      name: "preserves valid JSON null payload",
      chunks: ["null"],
      expected: { ok: true, value: null },
      expectedStatusCode: 200,
      expectedBody: undefined,
    },
    {
      name: "writes 400 on invalid JSON payload",
      chunks: ["{bad json"],
      expected: { ok: false },
      expectedStatusCode: 400,
      expectedBody: "Bad Request",
    },
  ])("$name", async ({ chunks, expected, expectedStatusCode, expectedBody }) => {
    const { result, res } = await readJsonBody(chunks);
    expect(result).toEqual(expected);
    expect(res.statusCode).toBe(expectedStatusCode);
    expect(res.body).toBe(expectedBody);
  });
});

describe("readWebhookBodyOrReject", () => {
  it("returns raw body contents", async () => {
    const { result } = await readRawBody({ chunks: ["plain text"] });
    expect(result).toEqual({ ok: true, value: "plain text" });
  });

  it("enforces strict pre-auth default body limits", async () => {
    const { result, res } = await readRawBody(
      {
        headers: { "content-length": String(70 * 1024) },
      },
      "pre-auth",
    );
    expect(result).toEqual({ ok: false });
    expect(res.statusCode).toBe(413);
  });
});

describe("beginWebhookRequestPipelineOrReject", () => {
  it("falls back for non-finite in-flight limiter options", () => {
    const limiter = createWebhookInFlightLimiter({
      maxInFlightPerKey: Number.NaN,
      maxTrackedKeys: Number.NaN,
    });
    const releases: Array<() => void> = [];
    try {
      for (let index = 0; index < 8; index += 1) {
        const result = beginWebhookRequestPipelineOrReject({
          req: createMockRequest({ method: "POST" }),
          res: createMockServerResponse(),
          allowMethods: ["POST"],
          inFlightLimiter: limiter,
          inFlightKey: "ip:127.0.0.1",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          releases.push(result.release);
        }
      }

      const overflowRes = createMockServerResponse();
      const overflow = beginWebhookRequestPipelineOrReject({
        req: createMockRequest({ method: "POST" }),
        res: overflowRes,
        allowMethods: ["POST"],
        inFlightLimiter: limiter,
        inFlightKey: "ip:127.0.0.1",
      });

      expect(overflow.ok).toBe(false);
      expect(overflowRes.statusCode).toBe(429);
    } finally {
      for (const release of releases) {
        release();
      }
    }
  });

  it("enforces in-flight request limits and releases slots", () => {
    const limiter = createWebhookInFlightLimiter({
      maxInFlightPerKey: 1,
      maxTrackedKeys: 10,
    });

    const first = beginWebhookRequestPipelineOrReject({
      req: createMockRequest({ method: "POST" }),
      res: createMockServerResponse(),
      allowMethods: ["POST"],
      inFlightLimiter: limiter,
      inFlightKey: "ip:127.0.0.1",
    });
    expect(first.ok).toBe(true);

    const secondRes = createMockServerResponse();
    const second = beginWebhookRequestPipelineOrReject({
      req: createMockRequest({ method: "POST" }),
      res: secondRes,
      allowMethods: ["POST"],
      inFlightLimiter: limiter,
      inFlightKey: "ip:127.0.0.1",
    });
    expect(second.ok).toBe(false);
    expect(secondRes.statusCode).toBe(429);

    if (first.ok) {
      first.release();
    }

    const third = beginWebhookRequestPipelineOrReject({
      req: createMockRequest({ method: "POST" }),
      res: createMockServerResponse(),
      allowMethods: ["POST"],
      inFlightLimiter: limiter,
      inFlightKey: "ip:127.0.0.1",
    });
    expect(third.ok).toBe(true);
    if (third.ok) {
      third.release();
    }
  });
});
