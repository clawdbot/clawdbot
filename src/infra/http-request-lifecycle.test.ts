import { once } from "node:events";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { runWithGatewayHttpWorkAdmission } from "../gateway/server/http-work-admission.js";
import {
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  readJsonWebhookBodyOrReject,
  readWebhookBodyOrReject,
} from "../plugin-sdk/webhook-request-guards.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { installRequestBodyLimitGuard } from "./http-body.js";
import {
  runHttpConnectionRequest,
  sendHttpRequestRejection,
  waitForHttpRequestRejection,
} from "./http-request-lifecycle.js";

const maxBytes = 256 * 1024;
const chunks = ['{"text":"', "x".repeat(1024 * 1024 + 1), '"}'];
const oversizedChunkedBody =
  chunks.map((chunk) => `${Buffer.byteLength(chunk).toString(16)}\r\n${chunk}\r\n`).join("") +
  "0\r\n\r\n";

function postHeaders(framing = "Transfer-Encoding: chunked") {
  return `POST /rejected HTTP/1.1\r\nHost: localhost\r\n${framing}\r\nConnection: keep-alive\r\n\r\n`;
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  run: (port: number) => Promise<void>,
  waitForResponse: boolean | "standalone" = true,
) {
  const tasks: Promise<void>[] = [];
  const errors: unknown[] = [];
  const server = createServer((req, res) => {
    const task =
      waitForResponse === "standalone"
        ? handler(req, res)
        : runHttpConnectionRequest(req, () => handler(req, res), waitForResponse ? res : undefined);
    tasks.push(
      task.catch((error: unknown) => {
        errors.push(error);
        req.socket.destroy();
      }),
    );
  });
  server.on("upgrade", (req) => {
    tasks.push(
      runHttpConnectionRequest(req, async () => {
        errors.push(new Error("unexpected upgrade dispatch"));
        req.socket.destroy();
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing TCP listener");
  }
  try {
    await run(address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await Promise.all(tasks);
  }
  expect(errors).toEqual([]);
}

async function rawRequest(port: number, wire: string, afterResponse?: string) {
  const socket = connect({ host: "127.0.0.1", port });
  const received: Buffer[] = [];
  const errors: string[] = [];
  const deadline = setTimeout(() => {
    errors.push("client deadline");
    socket.destroy();
  }, 3000);
  socket.on("error", (error: NodeJS.ErrnoException) => errors.push(error.code ?? error.message));
  socket.on("data", (chunk: Buffer) => received.push(chunk));
  if (afterResponse) {
    socket.once("data", () => socket.write(afterResponse));
  }
  const closed = new Promise<void>((resolve) => {
    socket.once("close", resolve);
  });
  socket.once("connect", () => socket.write(wire));
  await closed;
  clearTimeout(deadline);
  return { wire: Buffer.concat(received).toString(), errors };
}

async function nodeRequest(port: number) {
  const received: Buffer[] = [];
  const errors: string[] = [];
  let statusCode: number | undefined;
  let connection: string | undefined;
  let complete = false;
  const req = request({ host: "127.0.0.1", port, method: "POST", path: "/rejected" }, (res) => {
    statusCode = res.statusCode;
    connection = res.headers.connection;
    res.on("data", (chunk: Buffer) => received.push(chunk));
    res.on("end", () => {
      complete = res.complete;
    });
    res.on("error", (error) => errors.push(error.message));
  });
  req.on("error", (error: NodeJS.ErrnoException) => errors.push(error.code ?? error.message));
  const closed = new Promise<void>((resolve) => {
    req.once("socket", (socket) => socket.once("close", resolve));
  });
  const deadline = setTimeout(() => {
    errors.push("client deadline");
    req.destroy();
  }, 3000);
  req.write(chunks[0]);
  req.write(chunks[1]);
  req.end(chunks[2]);
  await closed;
  clearTimeout(deadline);
  return { statusCode, connection, complete, body: Buffer.concat(received).toString(), errors };
}

describe("bounded HTTP rejection transport", () => {
  it.each(["raw SDK", "JSON SDK", "installed guard"])(
    "delivers an exact 413 and closes during a large Node upload: %s",
    async (surface) => {
      await withServer(
        async (req, res) => {
          if (surface === "installed guard") {
            installRequestBodyLimitGuard(req, res, { maxBytes });
          } else {
            const read =
              surface === "raw SDK" ? readWebhookBodyOrReject : readJsonWebhookBodyOrReject;
            expect(await read({ req, res, maxBytes })).toEqual({ ok: false });
          }
        },
        async (port) => {
          expect(await nodeRequest(port)).toEqual({
            statusCode: 413,
            connection: "close",
            complete: true,
            body:
              surface === "installed guard" ? '{"error":"Payload too large"}' : "Payload too large",
            errors: [],
          });
        },
      );
    },
  );

  it.each(["request", "upgrade"])(
    "does not dispatch a pipelined %s after rejection",
    async (next) => {
      const dispatched: string[] = [];
      await withServer(
        async (req, res) => {
          dispatched.push(req.url!);
          await readWebhookBodyOrReject({ req, res, maxBytes });
        },
        async (port) => {
          const nextHeaders =
            next === "upgrade" ? "Connection: upgrade\r\nUpgrade: websocket\r\n" : "";
          const result = await rawRequest(
            port,
            postHeaders() +
              oversizedChunkedBody +
              `GET /second HTTP/1.1\r\nHost: localhost\r\n${nextHeaders}\r\n`,
          );
          expect(result.errors).toEqual([]);
          expect(result.wire).toMatch(/^HTTP\/1\.1 413 /);
          expect(result.wire.split("\r\n\r\n")[1]).toBe("Payload too large");
          expect(dispatched).toEqual(["/rejected"]);
        },
      );
    },
  );

  it.each([
    { limit: 1, text: "Payload too large" },
    { limit: Number.NaN, text: "Too much" },
  ])(
    "keeps guard text customization and invalid limit clamping ($limit)",
    async ({ limit, text }) => {
      await withServer(
        async (req, res) => {
          const guard = installRequestBodyLimitGuard(req, res, {
            maxBytes: limit,
            responseFormat: "text",
            responseText: { PAYLOAD_TOO_LARGE: text },
          });
          expect(guard.isTripped()).toBe(true);
          expect(guard.code()).toBe("PAYLOAD_TOO_LARGE");
          await waitForHttpRequestRejection(req);
        },
        async (port) => {
          const result = await rawRequest(port, postHeaders("Content-Length: 2") + "ab");
          expect(result.errors).toEqual([]);
          expect(result.wire).toMatch(/^HTTP\/1\.1 413 /);
          expect(result.wire).toContain("Content-Type: text/plain; charset=utf-8");
          expect(result.wire.split("\r\n\r\n")[1]).toBe(text);
        },
      );
    },
  );

  it("enforces the stricter SDK pre-auth body profile", async () => {
    await withServer(
      async (req, res) => {
        expect(await readWebhookBodyOrReject({ req, res, profile: "pre-auth" })).toEqual({
          ok: false,
        });
      },
      async (port) => {
        const result = await rawRequest(port, postHeaders(`Content-Length: ${70 * 1024}`));
        expect(result.errors).toEqual([]);
        expect(result.wire).toMatch(/^HTTP\/1\.1 413 /);
        expect(result.wire.split("\r\n\r\n")[1]).toBe("Payload too large");
      },
    );
  });

  it.each(["declared size", "timeout"])(
    "closes an unfinished upload after %s rejection",
    async (reason) => {
      await withServer(
        async (req, res) => {
          await readWebhookBodyOrReject({ req, res, maxBytes, timeoutMs: 20 });
        },
        async (port) => {
          const length = reason === "declared size" ? maxBytes + 1 : 20;
          const result = await rawRequest(port, postHeaders(`Content-Length: ${length}`) + "{");
          expect(result.errors).toEqual([]);
          expect(result.wire).toMatch(
            reason === "declared size" ? /^HTTP\/1\.1 413 / : /^HTTP\/1\.1 408 /,
          );
          expect(result.wire.split("\r\n\r\n")[1]).toBe(
            reason === "declared size" ? "Payload too large" : "Request body timeout",
          );
        },
      );
    },
  );

  it.each(["POST", "HEAD"])(
    "keeps a queued %s rejection ordered behind an earlier response and fences new dispatch",
    async (method) => {
      let earlier: ServerResponse;
      const selected = createDeferredCore();
      const dispatched: string[] = [];
      await withServer(
        async (req, res) => {
          dispatched.push(req.url!);
          if (req.url === "/first") {
            earlier = res;
            return;
          }
          const sent = sendHttpRequestRejection(req, res, 413, "rejected");
          selected.resolve();
          await sent;
        },
        async (port) => {
          const response = rawRequest(
            port,
            "GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n" +
              postHeaders("Content-Length: 1").replace("POST", method) +
              "x" +
              "GET /second HTTP/1.1\r\nHost: localhost\r\n\r\n",
          );
          await selected.promise;
          earlier!.end("first");
          const result = await response;
          expect(result.errors).toEqual([]);
          expect(result.wire).toMatch(/^HTTP\/1\.1 200 /);
          expect(result.wire).toContain("firstHTTP/1.1 413");
          expect(result.wire.endsWith(method === "HEAD" ? "\r\n\r\n" : "\r\n\r\nrejected")).toBe(
            true,
          );
          expect(dispatched).toEqual(["/first", "/rejected"]);
        },
        false,
      );
    },
  );

  it.each([32, 2048])(
    "drains a finite pipeline of %i ordinary requests in order",
    async (count) => {
      const dispatched: string[] = [];
      await withServer(
        async (req, res) => {
          dispatched.push(req.url!);
          res.end(req.url);
        },
        async (port) => {
          const paths = Array.from({ length: count }, (_, i) => `/request-${i}`);
          const result = await rawRequest(
            port,
            paths
              .map(
                (path, i) =>
                  `GET ${path} HTTP/1.1\r\nHost: localhost\r\n${i === count - 1 ? "Connection: close\r\n" : ""}\r\n`,
              )
              .join(""),
          );
          expect(result.errors).toEqual([]);
          expect(dispatched).toEqual(paths);
          expect(result.wire.match(/HTTP\/1\.1 200 /g)).toHaveLength(count);
          expect(result.wire.split(/HTTP\/1\.1 200 [^]*?\r\n\r\n/).slice(1)).toEqual(paths);
        },
      );
    },
  );

  it("bounds a rejection stuck behind an earlier response", async () => {
    const dispatched: string[] = [];
    await withServer(
      async (req, res) => {
        dispatched.push(req.url!);
        if (req.url !== "/first") {
          await sendHttpRequestRejection(req, res, 413, "rejected");
        }
      },
      async (port) => {
        const result = await rawRequest(
          port,
          "GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n" + postHeaders("Content-Length: 0"),
        );
        expect(result.errors).toEqual([]);
        expect(result.wire).toBe("");
        expect(dispatched).toEqual(["/first", "/rejected"]);
      },
      false,
    );
  });

  it("retains the SDK limiter until a peer ignoring the half-close is retired", async () => {
    const limiter = createWebhookInFlightLimiter({ maxInFlightPerKey: 1 });
    const retired = createDeferredCore();
    let socket: Socket | undefined;
    await withServer(
      async (req, res) => {
        const pipeline = beginWebhookRequestPipelineOrReject({
          req,
          res,
          inFlightLimiter: limiter,
          inFlightKey: "test",
        });
        expect(pipeline.ok).toBe(true);
        installRequestBodyLimitGuard(req, res, { maxBytes });
        if (pipeline.ok) {
          pipeline.release();
        }
        await waitForHttpRequestRejection(req);
        retired.resolve();
      },
      async (port) => {
        socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
        socket.on("data", () => {});
        const closed = once(socket, "close");
        socket.write(postHeaders(`Content-Length: ${maxBytes + 1}`));
        await once(socket, "end");
        expect(limiter.tryAcquire("test")).toBe(false);
        await retired.promise;
        expect(limiter.tryAcquire("test")).toBe(true);
        limiter.release("test");
        socket.end();
        await closed;
      },
    ).finally(() => socket?.destroy());
  });

  it("does not reframe or complete an already committed partial response", async () => {
    await withServer(
      async (req, res) => {
        res.write("partial");
        await sendHttpRequestRejection(req, res, 413, "rejected");
      },
      async (port) => {
        const result = await rawRequest(port, postHeaders("Content-Length: 0"));
        expect(result.wire).not.toContain("413");
        expect(result.wire).not.toContain("rejected");
        expect(result.wire).not.toContain("0\r\n\r\n");
      },
    );
  });

  it("retains a Gateway admission while an installed guard completes bounded cleanup", async () => {
    const retired = createDeferredCore();
    await withServer(
      async (req, res) => {
        await runWithGatewayHttpWorkAdmission(res, async () => {
          installRequestBodyLimitGuard(req, res, { maxBytes });
          return true;
        });
        retired.resolve();
      },
      async (port) => {
        const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
        const closed = once(socket, "close");
        socket.on("data", () => {});
        try {
          socket.write(postHeaders(`Content-Length: ${maxBytes + 1}`));
          await once(socket, "end");
          expect(getActiveGatewayRootWorkCount()).toBe(1);
          await retired.promise;
          expect(getActiveGatewayRootWorkCount()).toBe(0);
        } finally {
          socket.end();
          await closed;
        }
      },
    );
  });

  it.each(["async handler", "unfinished response"])(
    "waits for an earlier %s before admitting a pipeline",
    async (mode) => {
      const started = createDeferredCore();
      const release = createDeferredCore();
      const dispatched: string[] = [];
      let earlier: ServerResponse;
      await withServer(
        async (req, res) => {
          dispatched.push(req.url!);
          if (req.url === "/first") {
            earlier = res;
            started.resolve();
            if (mode === "async handler") {
              await release.promise;
              res.end("first");
            }
            return;
          }
          await readWebhookBodyOrReject({ req, res, maxBytes });
        },
        async (port) => {
          const response = rawRequest(
            port,
            "GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n" +
              postHeaders(`Content-Length: ${maxBytes + 1}`),
          );
          await started.promise;
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(dispatched).toEqual(["/first"]);
          if (mode === "async handler") {
            release.resolve();
          } else {
            earlier!.end("first");
          }
          const result = await response;
          expect(result.errors).toEqual([]);
          expect(result.wire).toContain("firstHTTP/1.1 413");
          expect(dispatched).toEqual(["/first", "/rejected"]);
        },
      );
    },
  );

  it("pauses queued input while an earlier response is unfinished, then drains it", async () => {
    const paused = createDeferredCore();
    let earlier: ServerResponse;
    let transport: Socket;
    let dispatched = 0;
    await withServer(
      async (req, res) => {
        dispatched++;
        if (dispatched === 1) {
          earlier = res;
          transport = req.socket;
          transport.once("pause", () => setImmediate(paused.resolve));
        } else {
          res.end("next");
        }
      },
      async (port) => {
        const response = rawRequest(
          port,
          "GET /queued HTTP/1.1\r\nHost: localhost\r\n\r\n".repeat(32) +
            "GET /last HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        );
        await paused.promise;
        expect(transport!.destroyed).toBe(false);
        expect(transport!.isPaused()).toBe(true);
        expect(dispatched).toBe(1);
        earlier!.end("first");
        const result = await response;
        expect(result.errors).toEqual([]);
        expect(dispatched).toBe(33);
        expect(result.wire.match(/HTTP\/1\.1 200 /g)).toHaveLength(33);
      },
    );
  });

  it.each(["request error", "response error", "sync write failure", "peer close"])(
    "retires rejected transport on %s",
    async (edge) => {
      const selected = createDeferredCore();
      let completed = false;
      await withServer(
        async (req, res) => {
          const closed = sendHttpRequestRejection(
            req,
            res,
            edge === "sync write failure" ? 0 : 413,
            "rejected",
          );
          if (edge === "request error") {
            req.emit("error", new Error("synthetic read failure"));
          }
          if (edge === "response error") {
            res.emit("error", new Error("synthetic write failure"));
          }
          selected.resolve();
          await closed;
          completed = true;
        },
        async (port) => {
          if (edge === "peer close") {
            const socket = connect({ host: "127.0.0.1", port });
            const closed = once(socket, "close");
            socket.write(postHeaders(`Content-Length: ${maxBytes + 1}`));
            await selected.promise;
            socket.destroy();
            await closed;
          } else {
            const result = await rawRequest(port, postHeaders("Content-Length: 0"));
            expect(result.errors).not.toContain("client deadline");
          }
        },
      );
      expect(completed).toBe(true);
    },
  );

  it("lets Node reject malformed chunking without hanging body ownership", async () => {
    let completed = false;
    await withServer(
      async (req, res) => {
        expect(await readWebhookBodyOrReject({ req, res, maxBytes })).toEqual({ ok: false });
        completed = true;
      },
      async (port) => {
        const result = await rawRequest(port, postHeaders() + "invalid-chunk-size\r\n");
        expect(result.errors).not.toContain("client deadline");
      },
    );
    expect(completed).toBe(true);
  });

  it("does not let a concurrent reader accept a body after an installed guard rejects it", async () => {
    await withServer(
      async (req, res) => {
        installRequestBodyLimitGuard(req, res, { maxBytes: 1 });
        expect(await readWebhookBodyOrReject({ req, res, maxBytes: 1024 })).toEqual({ ok: false });
      },
      async (port) => {
        const result = await rawRequest(port, postHeaders() + "2\r\nab\r\n0\r\n\r\n");
        expect(result.errors).toEqual([]);
        expect(result.wire).toMatch(/^HTTP\/1\.1 413 /);
        expect(result.wire.split("\r\n\r\n")[1]).toBe('{"error":"Payload too large"}');
      },
    );
  });

  it("keeps application body consumers paused while Node bounds residual upload buffering", async () => {
    let delivered = 0;
    let buffered = 0;
    let bufferLimit = 0;
    await withServer(
      async (req, res) => {
        req.on("data", (chunk: Buffer) => {
          delivered += chunk.length;
        });
        await sendHttpRequestRejection(req, res, 413, "rejected");
        buffered = req.readableLength;
        bufferLimit = req.readableHighWaterMark + req.socket.readableHighWaterMark;
      },
      async (port) => {
        const result = await rawRequest(
          port,
          postHeaders("Content-Length: 10000000") + "x".repeat(3 * 1024 * 1024),
        );
        expect(result.errors).not.toContain("client deadline");
      },
    );
    expect(delivered).toBe(0);
    expect(buffered).toBeLessThanOrEqual(bufferLimit);
  });

  it.each(["before rejection", "after the response"])(
    "bounds subsequent pipelined input when the rejected request completes %s",
    async (completion) => {
      let read = 0;
      let readLimit = 0;
      await withServer(
        async (req, res) => {
          await sendHttpRequestRejection(req, res, 413, "rejected");
          read = req.socket.bytesRead;
          readLimit = 2 * req.socket.readableHighWaterMark;
        },
        async (port) => {
          const pipeline = "GET /next HTTP/1.1\r\nHost: localhost\r\n\r\n".repeat(10000);
          const result =
            completion === "before rejection"
              ? await rawRequest(port, "GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n" + pipeline)
              : await rawRequest(port, postHeaders("Content-Length: 1"), "x" + pipeline);
          expect(result.errors).toEqual([]);
          expect(result.wire).toMatch(/^HTTP\/1\.1 413 /);
          expect(result.wire.split("\r\n\r\n")[1]).toBe("rejected");
        },
        "standalone",
      );
      expect(read).toBeLessThanOrEqual(readLimit);
    },
  );

  it("delivers bodyless HEAD rejection headers before closing", async () => {
    await withServer(
      async (req, res) => {
        await sendHttpRequestRejection(req, res, 413, "rejected");
      },
      async (port) => {
        const result = await rawRequest(port, "HEAD / HTTP/1.1\r\nHost: localhost\r\n\r\n");
        expect(result.errors).toEqual([]);
        expect(result.wire).toMatch(/^HTTP\/1\.1 413 /);
        expect(result.wire).toContain("Content-Length: 8");
        expect(result.wire.split("\r\n\r\n")[1]).toBe("");
      },
    );
  });

  it.each(["SDK reader", "installed guard"])(
    "half-closes a standalone queued HEAD after both earlier responses: %s",
    async (surface) => {
      const earlier: ServerResponse[] = [];
      const selected = createDeferredCore();
      let retired = false;
      let transport: Socket;
      await withServer(
        async (req, res) => {
          if (req.method !== "HEAD") {
            earlier.push(res);
            return;
          }
          transport = req.socket;
          const sent =
            surface === "SDK reader"
              ? readWebhookBodyOrReject({ req, res, maxBytes: 1 })
              : (installRequestBodyLimitGuard(req, res, { maxBytes: 1 }),
                waitForHttpRequestRejection(req));
          selected.resolve();
          await sent;
          retired = true;
        },
        async (port) => {
          const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
          const received: Buffer[] = [];
          socket.on("data", (chunk: Buffer) => received.push(chunk));
          const ended = once(socket, "end");
          const closed = new Promise<void>((resolve) => {
            socket.once("close", resolve);
          });
          const deadline = setTimeout(() => socket.destroy(new Error("client deadline")), 3000);
          try {
            socket.write(
              "GET /one HTTP/1.1\r\nHost: localhost\r\n\r\nGET /two HTTP/1.1\r\nHost: localhost\r\n\r\nHEAD /head HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n",
            );
            await selected.promise;
            expectDefined(earlier[1], "second queued response").end("two");
            expectDefined(earlier[0], "first queued response").end("one");
            await ended;
            // FIN must precede the bounded disposal deadline, not be caused by it.
            expect(retired).toBe(false);
            expect(transport!.destroyed).toBe(false);
            expect(transport!.writableEnded).toBe(true);
            const wire = Buffer.concat(received).toString();
            expect(wire.match(/HTTP\/1\.1 \d{3}/g)).toEqual([
              "HTTP/1.1 200",
              "HTTP/1.1 200",
              "HTTP/1.1 413",
            ]);
            expect(wire).toContain("oneHTTP/1.1 200");
            expect(wire).toContain("twoHTTP/1.1 413");
            expect(wire.endsWith("\r\n\r\n")).toBe(true);
            expect(wire).not.toContain("Payload too large");
          } finally {
            clearTimeout(deadline);
            socket.destroy();
            await closed;
          }
        },
        "standalone",
      );
      expect(retired).toBe(true);
    },
  );
});
