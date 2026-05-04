import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { buildQaTarget, getQaBusState, parseQaTarget, pollQaBus } from "./bus-client.js";

async function startJsonServer(
  handler: (req: { url?: string | undefined }) => { statusCode?: number; body: string },
) {
  const server = createServer((req, res) => {
    const response = handler({ url: req.url });
    res.writeHead(response.statusCode ?? 200, {
      "content-type": "application/json; charset=utf-8",
    });
    res.end(response.body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server failed to bind");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("qa-bus client", () => {
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  it("roundtrips explicit group targets", () => {
    expect(parseQaTarget("group:ops-room")).toEqual({
      chatType: "group",
      conversationId: "ops-room",
    });
    expect(
      buildQaTarget({
        chatType: "group",
        conversationId: "ops-room",
      }),
    ).toBe("group:ops-room");
  });

  it("rejects malformed JSON responses instead of throwing from the stream callback", async () => {
    const server = await startJsonServer(() => ({
      body: '{"cursor":1,"events":[',
    }));
    stops.push(server.stop);

    await expect(
      pollQaBus({
        baseUrl: server.baseUrl,
        accountId: "acct-a",
        cursor: 0,
        timeoutMs: 0,
      }),
    ).rejects.toThrow(SyntaxError);
  });

  it("rejects immediately when a poll request is aborted", async () => {
    const server = createServer((_req, _res) => {
      // Keep the request open so the client abort path owns the outcome.
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server failed to bind");
    }

    stops.push(async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });

    const abort = new AbortController();
    const request = pollQaBus({
      baseUrl: `http://127.0.0.1:${address.port}`,
      accountId: "acct-a",
      cursor: 0,
      timeoutMs: 30_000,
      signal: abort.signal,
    });
    abort.abort();

    await expect(
      Promise.race([
        request,
        sleep(500).then(() => {
          throw new Error("poll abort did not settle");
        }),
      ]),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("preserves baseUrl path prefixes when composing bus URLs", async () => {
    const server = await startJsonServer((req) => ({
      statusCode: req.url === "/qa-bus/v1/state" ? 200 : 404,
      body:
        req.url === "/qa-bus/v1/state"
          ? JSON.stringify({
              cursor: 1,
              conversations: [],
              threads: [],
              messages: [],
              events: [],
            })
          : JSON.stringify({ error: `unexpected path: ${req.url}` }),
    }));
    stops.push(server.stop);

    await expect(getQaBusState(`${server.baseUrl}/qa-bus`)).resolves.toMatchObject({
      cursor: 1,
      events: [],
    });
  });
});
