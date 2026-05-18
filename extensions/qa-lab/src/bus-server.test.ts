import { Agent, createServer, request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { closeQaHttpServer, handleQaBusRequest, startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import type { QaBusPollResult } from "./runtime-api.js";

async function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected server to bind a TCP port");
  }
  return address.port;
}

async function requestOnce(params: { port: number; agent: Agent }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: params.port,
        path: "/",
        agent: params.agent,
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function pollQaBus(params: {
  baseUrl: string;
  accountId: string;
  cursor: number;
  timeoutMs: number;
}): Promise<QaBusPollResult> {
  const response = await fetch(`${params.baseUrl}/v1/poll`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      accountId: params.accountId,
      cursor: params.cursor,
      timeoutMs: params.timeoutMs,
    }),
  });
  if (!response.ok) {
    throw new Error(`qa-bus request failed: ${response.status}`);
  }
  return (await response.json()) as QaBusPollResult;
}

describe("closeQaHttpServer", () => {
  it("closes idle keep-alive sockets so suite processes can exit", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/plain",
        connection: "keep-alive",
      });
      res.end("ok");
    });
    const agent = new Agent({ keepAlive: true });
    const port = await listenOnLoopback(server);

    try {
      await requestOnce({ port, agent });
      const startedAt = Date.now();
      await closeQaHttpServer(server);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      agent.destroy();
      server.closeAllConnections?.();
    }
  });
});

describe("qa-bus server", () => {
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  it("wakes stale-cursor long polls as soon as matching account traffic arrives", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    stops.push(bus.stop);

    const pending = pollQaBus({
      baseUrl: bus.baseUrl,
      accountId: "acct-a",
      cursor: 999,
      timeoutMs: 500,
    });

    setTimeout(() => {
      state.addInboundMessage({
        accountId: "acct-a",
        conversation: { id: "target", kind: "direct" },
        senderId: "acct-a-user",
        text: "fresh event",
      });
    }, 20);

    const result = await Promise.race([
      pending,
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 150);
      }),
    ]);

    expect(result).not.toBe("timed-out");
    if (result === "timed-out") {
      throw new Error("stale-cursor long poll did not wake before timeout window");
    }
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      accountId: "acct-a",
      cursor: 1,
      kind: "inbound-message",
    });
  });
});

describe("handleQaBusRequest", () => {
  it("returns a controlled error when a v1 POST body exceeds the limit", async () => {
    const req = {
      method: "POST",
      url: "/v1/reset",
      headers: { "content-length": String(1024 * 1024 + 1) },
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    };
    const res = {
      statusCode: 0,
      body: "",
      writeHead(statusCode: number) {
        this.statusCode = statusCode;
      },
      end(payload: string) {
        this.body = payload;
      },
    };

    const handled = await handleQaBusRequest({
      req: req as never,
      res: res as never,
      state: createQaBusState(),
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "Payload too large" });
  });
});
