// Qa Lab tests cover bus server plugin behavior.
import { Agent, createServer, request } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

async function postQaBusJson(baseUrl: string, path: string, body: unknown) {
  return await postQaBusRawJson(baseUrl, path, JSON.stringify(body));
}

async function postQaBusRawJson(baseUrl: string, path: string, body: string) {
  return await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body,
  });
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

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  it("wakes stale-cursor long polls as soon as matching account traffic arrives", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    stops.push(bus["stop"]);

    const pending = pollQaBus({
      baseUrl: bus.baseUrl,
      accountId: "acct-a",
      cursor: 999,
      timeoutMs: 500,
    });

    state.addInboundMessage({
      accountId: "acct-a",
      conversation: { id: "target", kind: "direct" },
      senderId: "acct-a-user",
      text: "fresh event",
    });

    const result = await pending;
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      accountId: "acct-a",
      cursor: 1,
      kind: "inbound-message",
    });
  });

  it("resumes an account after its last acknowledged cursor when the client restarts", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    stops.push(bus["stop"]);

    const consumed = state.addInboundMessage({
      accountId: "acct-a",
      conversation: { id: "first", kind: "direct" },
      senderId: "acct-a-user",
      text: "consumed before restart",
    });
    const firstPoll = await pollQaBus({
      baseUrl: bus.baseUrl,
      accountId: "acct-a",
      cursor: 0,
      timeoutMs: 0,
    });
    expect(firstPoll.events.map((event) => event.cursor)).toEqual([1]);

    await pollQaBus({
      baseUrl: bus.baseUrl,
      accountId: "acct-a",
      cursor: firstPoll.cursor,
      timeoutMs: 0,
    });
    expect(state.getAcknowledgedPollCursor("acct-a")).toBe(firstPoll.cursor);
    const queuedDuringRestart = state.addInboundMessage({
      accountId: "acct-a",
      conversation: { id: "second", kind: "direct" },
      senderId: "acct-a-user",
      text: "queued during restart",
    });

    const restartedPoll = await pollQaBus({
      baseUrl: bus.baseUrl,
      accountId: "acct-a",
      cursor: 0,
      timeoutMs: 0,
    });
    const restartedMessageIds = restartedPoll.events.flatMap((event) =>
      "message" in event ? [event.message.id] : [],
    );
    expect(restartedMessageIds).toEqual([queuedDuringRestart.id]);
    expect(restartedMessageIds).not.toContain(consumed.id);

    state.reset();
    const queuedAfterReset = state.addInboundMessage({
      accountId: "acct-a",
      conversation: { id: "third", kind: "direct" },
      senderId: "acct-a-user",
      text: "queued after bus reset",
    });
    const resetPoll = await pollQaBus({
      baseUrl: bus.baseUrl,
      accountId: "acct-a",
      cursor: 0,
      timeoutMs: 0,
    });
    expect(
      resetPoll.events.flatMap((event) => ("message" in event ? [event.message.id] : [])),
    ).toEqual([queuedAfterReset.id]);
  });

  it("rejects malformed poll numeric fields before long-polling", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    stops.push(bus["stop"]);

    const startedAt = Date.now();
    const response = await postQaBusJson(bus.baseUrl, "/v1/poll", {
      accountId: "acct-a",
      cursor: "999",
      timeoutMs: 500,
    });

    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "poll cursor must be an integer at least 0.",
    });
  });

  it("rejects malformed search limits before querying state", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    stops.push(bus["stop"]);

    const response = await postQaBusJson(bus.baseUrl, "/v1/actions/search", {
      limit: "all",
      query: "anything",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "search limit must be an integer at least 1.",
    });
  });

  it("returns a controlled error when a v1 POST body contains malformed JSON", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    stops.push(bus["stop"]);

    const response = await postQaBusRawJson(bus.baseUrl, "/v1/reset", "{");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Malformed JSON body",
    });
  });

  it("keeps oversized numeric poll and search fields bounded", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    stops.push(bus["stop"]);

    const message = state.addInboundMessage({
      accountId: "acct-a",
      conversation: { id: "target", kind: "direct" },
      senderId: "acct-a-user",
      text: "bounded numeric fields",
    });

    const pollResponse = await postQaBusJson(bus.baseUrl, "/v1/poll", {
      accountId: "acct-a",
      cursor: 0,
      limit: 10_000,
      timeoutMs: 60_000,
    });
    expect(pollResponse.status).toBe(200);
    await expect(pollResponse.json()).resolves.toMatchObject({
      events: [{ message: { id: message.id } }],
    });

    const searchResponse = await postQaBusJson(bus.baseUrl, "/v1/actions/search", {
      accountId: "acct-a",
      limit: 10_000,
      query: "bounded",
    });
    expect(searchResponse.status).toBe(200);
    await expect(searchResponse.json()).resolves.toMatchObject({
      messages: [{ id: message.id }],
    });

    const extremeSearchResponse = await postQaBusRawJson(
      bus.baseUrl,
      "/v1/actions/search",
      `{"accountId":"acct-a","limit":1e309,"query":"bounded"}`,
    );
    expect(extremeSearchResponse.status).toBe(200);
    await expect(extremeSearchResponse.json()).resolves.toMatchObject({
      messages: [{ id: message.id }],
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
