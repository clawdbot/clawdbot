import { Buffer } from "node:buffer";
import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/core", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/core")>(
    "openclaw/plugin-sdk/core",
  );
  return {
    ...actual,
    generateSecureUuid: () => "test-id",
  };
});

let signalCheck: typeof import("./client.js").signalCheck;
let signalRpcRequest: typeof import("./client.js").signalRpcRequest;
let streamSignalEvents: typeof import("./client.js").streamSignalEvents;

const servers: http.Server[] = [];

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function withSignalServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = http.createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error: unknown) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing test server address");
  }
  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  ({ signalCheck, signalRpcRequest, streamSignalEvents } = await import("./client.js"));
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    ),
  );
});

describe("signalRpcRequest", () => {
  it("returns parsed RPC result", async () => {
    const baseUrl = await withSignalServer(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/v1/rpc");
      expect(req.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(await readRequestBody(req))).toEqual({
        jsonrpc: "2.0",
        method: "version",
        id: "test-id",
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", result: { version: "0.13.22" }, id: "test-id" }));
    });

    const result = await signalRpcRequest<{ version: string }>("version", undefined, {
      baseUrl,
    });

    expect(result).toEqual({ version: "0.13.22" });
  });

  it("throws a wrapped error when RPC response JSON is malformed", async () => {
    const baseUrl = await withSignalServer((_req, res) => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("not-json");
    });

    let thrown: unknown;
    try {
      await signalRpcRequest("version", undefined, {
        baseUrl,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("expected malformed JSON request to throw an Error");
    }
    expect(thrown.message).toBe("Signal RPC returned malformed JSON (status 502)");
    expect(thrown.cause).toBeInstanceOf(SyntaxError);
  });

  it("throws when RPC response envelope has neither result nor error", async () => {
    const baseUrl = await withSignalServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: "test-id" }));
    });

    await expect(
      signalRpcRequest("version", undefined, {
        baseUrl,
      }),
    ).rejects.toThrow("Signal RPC returned invalid response envelope (status 200)");
  });

  it("rejects credentialed base URLs", async () => {
    await expect(
      signalRpcRequest("version", undefined, {
        baseUrl: "http://user:pass@127.0.0.1:8080",
      }),
    ).rejects.toThrow("Signal base URL must not include credentials");
  });

  it("rejects oversized RPC responses", async () => {
    const baseUrl = await withSignalServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("x".repeat(1_048_577));
    });

    await expect(
      signalRpcRequest("version", undefined, {
        baseUrl,
      }),
    ).rejects.toThrow("Signal HTTP response exceeded size limit");
  });

  it("accepts RPC responses larger than the default cap when maxResponseBytes is raised", async () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      result: { data: "y".repeat(1_200_000) },
      id: "test-id",
    });
    const baseUrl = await withSignalServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(payload);
    });

    const result = await signalRpcRequest<{ data: string }>("getAttachment", undefined, {
      baseUrl,
      maxResponseBytes: 4_000_000,
    });

    expect(result.data.length).toBe(1_200_000);
  });

  it("rejects RPC responses that exceed a custom maxResponseBytes cap", async () => {
    const baseUrl = await withSignalServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("x".repeat(8_193));
    });

    await expect(
      signalRpcRequest("getAttachment", undefined, {
        baseUrl,
        maxResponseBytes: 8_192,
      }),
    ).rejects.toThrow("Signal HTTP response exceeded size limit");
  });

  it("falls back to the default cap when maxResponseBytes is zero or non-finite", async () => {
    const baseUrl = await withSignalServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("x".repeat(1_048_577));
    });

    await expect(
      signalRpcRequest("version", undefined, {
        baseUrl,
        maxResponseBytes: 0,
      }),
    ).rejects.toThrow("Signal HTTP response exceeded size limit");

    const baseUrl2 = await withSignalServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("x".repeat(1_048_577));
    });

    await expect(
      signalRpcRequest("version", undefined, {
        baseUrl: baseUrl2,
        maxResponseBytes: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow("Signal HTTP response exceeded size limit");
  });

  it("uses an absolute deadline for slow-drip RPC responses", async () => {
    const baseUrl = await withSignalServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const interval = setInterval(() => {
        res.write(" ");
      }, 5);
      res.on("close", () => clearInterval(interval));
    });

    await expect(
      signalRpcRequest("version", undefined, {
        baseUrl,
        timeoutMs: 25,
      }),
    ).rejects.toThrow("Signal HTTP exceeded deadline after 25ms");
  });
});

describe("signalCheck", () => {
  it("returns ok for a healthy signal-cli check", async () => {
    const baseUrl = await withSignalServer((req, res) => {
      expect(req.method).toBe("GET");
      expect(req.url).toBe("/api/v1/check");
      res.writeHead(204);
      res.end();
    });

    await expect(signalCheck(baseUrl)).resolves.toEqual({ ok: true, status: 204, error: null });
  });

  it("returns an HTTP status failure for unhealthy checks", async () => {
    const baseUrl = await withSignalServer((_req, res) => {
      res.writeHead(503);
      res.end("down");
    });

    await expect(signalCheck(baseUrl)).resolves.toEqual({
      ok: false,
      status: 503,
      error: "HTTP 503",
    });
  });
});

describe("streamSignalEvents", () => {
  it("streams events through node http instead of fetch", async () => {
    const events: Array<import("./client.js").SignalSseEvent> = [];
    const baseUrl = await withSignalServer((req, res) => {
      expect(req.url).toBe("/api/v1/events?account=%2B15555550123");
      expect(req.headers.accept).toBe("text/event-stream");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('id: 42\nevent: message\ndata: {"group":true}\n\n');
    });

    await streamSignalEvents({
      baseUrl,
      account: "+15555550123",
      onEvent: (event) => events.push(event),
    });

    expect(events).toEqual([{ id: "42", event: "message", data: '{"group":true}' }]);
  });

  it("reports HTTP status failures from the event stream", async () => {
    const baseUrl = await withSignalServer((_req, res) => {
      res.writeHead(503, "Unavailable");
      res.end("down");
    });

    await expect(
      streamSignalEvents({
        baseUrl,
        onEvent: () => {},
      }),
    ).rejects.toThrow("Signal SSE failed (503 Unavailable)");
  });

  it("rejects event streams that do not send headers before the deadline", async () => {
    const baseUrl = await withSignalServer(() => {
      // Leave the request open without response headers.
    });

    await expect(
      streamSignalEvents({
        baseUrl,
        timeoutMs: 25,
        onEvent: () => {},
      }),
    ).rejects.toThrow("Signal SSE connection timed out after 25ms");
  });

  it("allows idle event streams to wait for abort when the deadline is disabled", async () => {
    const baseUrl = await withSignalServer(() => {
      // Leave the request open without response headers, matching signal-cli 0.14.3 before
      // its first keepalive flush.
    });
    const abortController = new AbortController();
    const abortTimer = setTimeout(() => abortController.abort(), 25);
    abortTimer.unref?.();

    await expect(
      streamSignalEvents({
        baseUrl,
        timeoutMs: 0,
        abortSignal: abortController.signal,
        onEvent: () => {},
      }),
    ).rejects.toMatchObject({ name: "AbortError", message: "Signal SSE aborted" });
  });

  it("rejects oversized SSE line buffers by byte size", async () => {
    const baseUrl = await withSignalServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${"🙂".repeat(262_145)}`);
    });

    await expect(
      streamSignalEvents({
        baseUrl,
        onEvent: () => {},
      }),
    ).rejects.toThrow("Signal SSE buffer exceeded size limit");
  });

  it("rejects oversized SSE events split across smaller data lines", async () => {
    const baseUrl = await withSignalServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const line = `data: ${"x".repeat(4096)}\n`;
      for (let index = 0; index < 260; index += 1) {
        res.write(line);
      }
      res.end();
    });

    await expect(
      streamSignalEvents({
        baseUrl,
        onEvent: () => {},
      }),
    ).rejects.toThrow("Signal SSE event data exceeded size limit");
  });
});
