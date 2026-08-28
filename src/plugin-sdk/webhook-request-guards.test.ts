/**
 * Tests webhook request guard body parsing and rejection behavior.
 */
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { createMockServerResponse } from "../test-utils/mock-http-response.js";
import { postRawWebhook } from "./test-helpers/raw-http-request.js";
import { createFixedWindowRateLimiter } from "./webhook-memory-guards.js";
import {
  applyBasicWebhookRequestGuards,
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  isJsonContentType,
  readWebhookBodyOrReject,
  readJsonWebhookBodyOrReject,
  runDetachedWebhookWork,
} from "./webhook-request-guards.js";

type MockIncomingMessage = IncomingMessage & {
  destroyed?: boolean;
  destroy: () => MockIncomingMessage;
  pause: () => MockIncomingMessage;
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
  req.pause = (() => req) as MockIncomingMessage["pause"];

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

describe("readWebhookBodyOrReject over a real socket", () => {
  it("delivers the 413 and closes when a sender uploads the whole over-limit body at once", async () => {
    // A mocked response records status(413) even when the socket died first, so the
    // delivered-and-released contract only shows up on the wire. Single-write uploads are
    // the case that regressed: tearing the request down races the response flush.
    const server = createServer((req, res) => {
      void readWebhookBodyOrReject({ req, res, profile: "pre-auth" }).then((body) => {
        // The helper answers rejections itself; accepted reads still need a reply so the
        // within-cap control observes a real status instead of a hung socket.
        if (body.ok) {
          res.statusCode = 200;
          res.end("ok");
        }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected webhook guard test server to have a TCP address");
      }

      const result = await postRawWebhook({
        url: `http://127.0.0.1:${address.port}/hook`,
        body: "x".repeat(70 * 1024),
        headers: { "content-type": "application/json" },
      });

      expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
      expect(result.closedByServer).toBe(true);

      // Chunked, so there is no declared length to reject on: the cap can only be hit by
      // counting bytes as they arrive, mid-upload.
      const streamed = await postRawWebhook({
        url: `http://127.0.0.1:${address.port}/hook`,
        body: "y".repeat(70 * 1024),
        headers: { "content-type": "application/json" },
        chunkedEncoding: true,
        chunk: { bytes: 8 * 1024, intervalMs: 5 },
      });
      expect(streamed.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
      expect(streamed.closedByServer).toBe(true);

      // Control: the same chunked shape under the cap is accepted, so the rejection above
      // is attributable to the byte count and not merely to chunked framing.
      const withinCap = await postRawWebhook({
        url: `http://127.0.0.1:${address.port}/hook`,
        body: "y".repeat(32 * 1024),
        headers: { "content-type": "application/json" },
        chunkedEncoding: true,
        chunk: { bytes: 8 * 1024, intervalMs: 5 },
      });
      expect(withinCap.statusLine).toBe("HTTP/1.1 200 OK");
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    }
  });

  it("delivers the 408 and closes when the sender stalls mid-upload", async () => {
    const server = createServer((req, res) => {
      void readWebhookBodyOrReject({ req, res, maxBytes: 1024 * 1024, timeoutMs: 250 });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected webhook guard test server to have a TCP address");
      }

      // Promise more than is ever sent, so the read deadline fires with the request open.
      const result = await postRawWebhook({
        url: `http://127.0.0.1:${address.port}/hook`,
        body: "z".repeat(64),
        contentLength: 64 * 1024,
        headers: { "content-type": "application/json" },
      });

      expect(result.statusLine).toBe("HTTP/1.1 408 Request Timeout");
      expect(result.closedByServer).toBe(true);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    }
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

describe("runDetachedWebhookWork", () => {
  it("defers the callback until the request handler can acknowledge", async () => {
    const { runWithGatewayHttpWorkAdmission } =
      await import("../gateway/server/http-work-admission.js");
    const order: string[] = [];
    const detached: Promise<void>[] = [];

    await runWithGatewayHttpWorkAdmission(createMockServerResponse(), async () => {
      detached.push(
        runDetachedWebhookWork(async () => {
          order.push("work");
        }),
      );
      order.push("ack");
      expect(order).toEqual(["ack"]);
      return true;
    });

    await Promise.all(detached);
    expect(order).toEqual(["ack", "work"]);
  });

  it("keeps post-ack processing admitted after the request admission is released", async () => {
    const { runWithGatewayHttpWorkAdmission } =
      await import("../gateway/server/http-work-admission.js");
    const { enqueueCommandInLane } = await import("../process/command-queue.js");

    let detached: Promise<number> | null = null;
    await runWithGatewayHttpWorkAdmission(createMockServerResponse(), async () => {
      // Ack-first shape: dispatch continues after the handler (and its
      // admission) completes; the queue enqueue happens well past release.
      detached = runDetachedWebhookWork(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
        return await enqueueCommandInLane("detached-webhook-work-test", async () => 42);
      });
      return true;
    });

    await expect(detached).resolves.toBe(42);
  });

  it("refuses the same post-ack processing when it merely inherits the request admission", async () => {
    const { runWithGatewayHttpWorkAdmission } =
      await import("../gateway/server/http-work-admission.js");
    const { enqueueCommandInLane } = await import("../process/command-queue.js");

    let inherited: Promise<number> | null = null;
    await runWithGatewayHttpWorkAdmission(createMockServerResponse(), async () => {
      inherited = (async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
        return await enqueueCommandInLane("inherited-webhook-work-test", async () => 42);
      })();
      inherited.catch(() => {});
      return true;
    });

    await expect(inherited).rejects.toThrow("Gateway is draining");
  });
});
