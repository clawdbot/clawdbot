// Qa Lab tests cover bus server plugin behavior.
import { Agent, createServer, request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeQaHttpServer, startQaBusServer } from "./bus-server.js";
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
  acknowledgedCursor?: number;
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
      acknowledgedCursor: params.acknowledgedCursor,
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

  it("returns a 500 JSON response when request handling rejects", async () => {
    const state = createQaBusState();
    const requestError = new Error("snapshot unavailable");
    state.getSnapshot = () => {
      throw requestError;
    };
    const bus = await startQaBusServer({ state });
    stops.push(async () => await bus.stop());

    const response = await fetch(`${bus.baseUrl}/v1/state`, {
      signal: AbortSignal.timeout(1_000),
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: requestError.message });
  });

  it("normalizes direct-message aliases at HTTP ingress without accepting unknown kinds", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    stops.push(bus["stop"]);

    for (const kind of ["direct", "dm"]) {
      const response = await postQaBusJson(bus.baseUrl, "/v1/inbound/message", {
        conversation: { id: "alice", kind },
        senderId: "alice",
        text: `hello from ${kind}`,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        message: { conversation: { id: "alice", kind: "direct" } },
      });
    }

    const rejected = await postQaBusJson(bus.baseUrl, "/v1/inbound/message", {
      conversation: { id: "alice", kind: "private" },
      senderId: "alice",
      text: "must not be accepted",
    });

    expect(rejected.status).toBe(400);
    expect(state.getSnapshot().messages).toHaveLength(2);
  });

  it("wakes matching polls and fences late polls and writes during shutdown", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    let stopped = false;
    stops.push(async () => {
      if (!stopped) {
        await bus.stop();
      }
    });

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

    const waitForCursorAdvance = state.waitForCursorAdvance.bind(state);
    let pollWaitersStarted = 0;
    let pollWaitersSettled = 0;
    state.waitForCursorAdvance = async (...args) => {
      pollWaitersStarted += 1;
      try {
        return await waitForCursorAdvance(...args);
      } finally {
        pollWaitersSettled += 1;
      }
    };
    const activePoll = fetch(`${bus.baseUrl}/v1/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "active", cursor: 1, timeoutMs: 30_000 }),
    }).catch(() => undefined);
    await vi.waitFor(() => expect(pollWaitersStarted).toBe(1));
    const body = JSON.stringify({ accountId: "late-body", cursor: 0, timeoutMs: 30_000 });
    const slowPoll = request({
      host: "127.0.0.1",
      port: bus.port,
      path: "/v1/poll",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    });
    slowPoll.on("response", (response) => response.resume());
    slowPoll.on("error", () => undefined);
    slowPoll.write(body.slice(0, 1));
    const inboundBody = JSON.stringify({
      conversation: { id: "late-room", kind: "direct" },
      senderId: "late-sender",
      text: "must not survive shutdown",
    });
    const slowInbound = request({
      host: "127.0.0.1",
      port: bus.port,
      path: "/v1/inbound/message",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(inboundBody),
      },
    });
    slowInbound.on("response", (response) => response.resume());
    slowInbound.on("error", () => undefined);
    slowInbound.write(inboundBody.slice(0, 1));
    await sleep(10);

    stopped = true;
    const startedAt = Date.now();
    const stopping = bus.stop();
    setTimeout(() => {
      slowPoll.end(body.slice(1));
      slowInbound.end(inboundBody.slice(1));
    }, 50);
    await stopping;
    await activePoll;

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(pollWaitersStarted).toBe(1);
    expect(pollWaitersSettled).toBe(1);
    expect(state.getSnapshot()).toMatchObject({ events: [], messages: [] });
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
      acknowledgedCursor: 0,
      timeoutMs: 0,
    });
    expect(state.getAcknowledgedPollCursor("acct-a")).toBe(0);
    const unacknowledgedRestart = await pollQaBus({
      baseUrl: bus.baseUrl,
      accountId: "acct-a",
      cursor: 0,
      timeoutMs: 0,
    });
    expect(
      unacknowledgedRestart.events.flatMap((event) =>
        "message" in event ? [event.message.id] : [],
      ),
    ).toEqual([consumed.id]);

    await pollQaBus({
      baseUrl: bus.baseUrl,
      accountId: "acct-a",
      cursor: firstPoll.cursor,
      acknowledgedCursor: firstPoll.cursor,
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

  it("paginates a burst without advancing past events omitted by the poll limit", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    stops.push(bus["stop"]);

    for (let index = 1; index <= 101; index += 1) {
      state.addInboundMessage({
        accountId: "acct-a",
        conversation: { id: "burst", kind: "direct" },
        senderId: "acct-a-user",
        text: `burst event ${index}`,
      });
    }

    const firstPage = await pollQaBus({
      baseUrl: bus.baseUrl,
      accountId: "acct-a",
      cursor: 0,
      timeoutMs: 0,
    });
    expect(firstPage.events).toHaveLength(100);
    expect(firstPage.cursor).toBe(100);

    const secondPage = await pollQaBus({
      baseUrl: bus.baseUrl,
      accountId: "acct-a",
      cursor: firstPage.cursor,
      timeoutMs: 0,
    });
    expect(secondPage.events).toHaveLength(1);
    expect(secondPage.events[0]?.cursor).toBe(101);
    expect(secondPage.cursor).toBe(101);
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

  it("rejects acknowledgements beyond the fetched cursor", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    stops.push(bus["stop"]);

    const response = await postQaBusJson(bus.baseUrl, "/v1/poll", {
      accountId: "acct-a",
      cursor: 1,
      acknowledgedCursor: 2,
      timeoutMs: 0,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "acknowledged poll cursor must not exceed the requested poll cursor.",
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

  it.each(["inbound", "outbound"] as const)(
    "accepts a generated-media payload larger than 1 MiB on the %s message route",
    async (direction) => {
      const state = createQaBusState();
      const bus = await startQaBusServer({ state });
      stops.push(bus["stop"]);

      const generatedImage = Buffer.alloc(1_600_000, 0x71);
      const attachment = {
        id: "qa-lighthouse-image",
        kind: "image",
        mimeType: "image/png",
        fileName: "qa-lighthouse.png",
        contentBase64: generatedImage.toString("base64"),
      };
      const response = await postQaBusJson(bus.baseUrl, `/v1/${direction}/message`, {
        accountId: "acct-a",
        text: "QA lighthouse",
        attachments: [attachment],
        ...(direction === "inbound"
          ? {
              conversation: { id: "qa-operator", kind: "direct" },
              senderId: "qa-operator",
            }
          : { to: "dm:qa-operator" }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        message: { direction, attachments: [attachment] },
      });

      const snapshot = state.getSnapshot();
      expect(snapshot.messages).toHaveLength(1);
      expect(snapshot.events).toHaveLength(1);
      const storedAttachment = snapshot.messages[0]?.attachments?.[0];
      expect(storedAttachment).toEqual(attachment);
      expect(Buffer.from(storedAttachment?.contentBase64 ?? "", "base64")).toEqual(generatedImage);
    },
  );

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
  it.each([
    { pathname: "/v1/inbound/message", limit: 16 * 1024 * 1024 },
    { pathname: "/v1/outbound/message", limit: 16 * 1024 * 1024 },
    { pathname: "/v1/reset", limit: 1024 * 1024 },
  ])(
    "delivers 413 over the wire and closes when the $pathname body exceeds its limit",
    async ({ pathname, limit }) => {
      const bus = await startQaBusServer({ state: createQaBusState() });
      try {
        // Declared over-cap length: rejected from the header alone, while the sender is
        // still mid-upload and can only learn the outcome from what reaches it.
        const result = await postRawWebhook({
          url: `${bus.baseUrl}${pathname}`,
          body: "{}",
          contentLength: limit + 1,
          headers: { "content-type": "application/json" },
        });

        expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
        expect(JSON.parse(result.body)).toEqual({ error: "Payload too large" });
        expect(result.closedByServer).toBe(true);
      } finally {
        await bus.stop();
      }
    },
  );
});
