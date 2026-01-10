import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  agentCommand,
  connectOk,
  installGatewayTestHooks,
  onceMessage,
  piSdkMock,
  rpcReq,
  sessionStoreSaveDelayMs,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks();

async function waitFor(condition: () => boolean, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout waiting for condition");
}

describe("gateway server chat", () => {
  test("webchat can chat.send without a mobile node", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws, {
      client: {
        name: "clawdbot-control-ui",
        version: "dev",
        platform: "web",
        mode: "webchat",
      },
    });

    const res = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "hello",
      idempotencyKey: "idem-webchat-1",
    });
    expect(res.ok).toBe(true);

    ws.close();
    await server.close();
  });

  test("chat.send defaults to agent timeout config", async () => {
    testState.agentConfig = { timeoutSeconds: 123 };
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const spy = vi.mocked(agentCommand);
    const callsBefore = spy.mock.calls.length;
    const res = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "hello",
      idempotencyKey: "idem-timeout-1",
    });
    expect(res.ok).toBe(true);

    await waitFor(() => spy.mock.calls.length > callsBefore);
    const call = spy.mock.calls.at(-1)?.[0] as { timeout?: string } | undefined;
    expect(call?.timeout).toBe("123");

    ws.close();
    await server.close();
  });

  test("chat.send forwards sessionKey to agentCommand", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const spy = vi.mocked(agentCommand);
    const callsBefore = spy.mock.calls.length;
    const res = await rpcReq(ws, "chat.send", {
      sessionKey: "agent:main:subagent:abc",
      message: "hello",
      idempotencyKey: "idem-session-key-1",
    });
    expect(res.ok).toBe(true);

    await waitFor(() => spy.mock.calls.length > callsBefore);
    const call = spy.mock.calls.at(-1)?.[0] as
      | { sessionKey?: string }
      | undefined;
    expect(call?.sessionKey).toBe("agent:main:subagent:abc");

    ws.close();
    await server.close();
  });

  test("chat.send blocked by send policy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    testState.sessionConfig = {
      sendPolicy: {
        default: "allow",
        rules: [
          {
            action: "deny",
            match: { provider: "discord", chatType: "group" },
          },
        ],
      },
    };

    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          "discord:group:dev": {
            sessionId: "sess-discord",
            updatedAt: Date.now(),
            chatType: "group",
            provider: "discord",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "chat.send", {
      sessionKey: "discord:group:dev",
      message: "hello",
      idempotencyKey: "idem-1",
    });
    expect(res.ok).toBe(false);
    expect(
      (res.error as { message?: string } | undefined)?.message ?? "",
    ).toMatch(/send blocked/i);

    ws.close();
    await server.close();
  });

  test("agent blocked by send policy for sessionKey", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    testState.sessionConfig = {
      sendPolicy: {
        default: "allow",
        rules: [{ action: "deny", match: { keyPrefix: "cron:" } }],
      },
    };

    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          "cron:job-1": {
            sessionId: "sess-cron",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent", {
      sessionKey: "cron:job-1",
      message: "hi",
      idempotencyKey: "idem-2",
    });
    expect(res.ok).toBe(false);
    expect(
      (res.error as { message?: string } | undefined)?.message ?? "",
    ).toMatch(/send blocked/i);

    ws.close();
    await server.close();
  });
  test("chat.send accepts image attachment", { timeout: 12000 }, async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const spy = vi.mocked(agentCommand);
    const callsBefore = spy.mock.calls.length;

    const pngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

    const reqId = "chat-img";
    ws.send(
      JSON.stringify({
        type: "req",
        id: reqId,
        method: "chat.send",
        params: {
          sessionKey: "main",
          message: "see image",
          idempotencyKey: "idem-img",
          attachments: [
            {
              type: "image",
              mimeType: "image/png",
              fileName: "dot.png",
              content: `data:image/png;base64,${pngB64}`,
            },
          ],
        },
      }),
    );

    const res = await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === reqId,
      8000,
    );
    expect(res.ok).toBe(true);
    expect(res.payload?.runId).toBeDefined();

    await waitFor(() => spy.mock.calls.length > callsBefore, 8000);
    const call = spy.mock.calls.at(-1)?.[0] as
      | { images?: Array<{ type: string; data: string; mimeType: string }> }
      | undefined;
    expect(call?.images).toEqual([
      { type: "image", data: pngB64, mimeType: "image/png" },
    ]);

    ws.close();
    await server.close();
  });

  test("chat.history caps large histories and honors limit", async () => {
    const firstContentText = (msg: unknown): string | undefined => {
      if (!msg || typeof msg !== "object") return undefined;
      const content = (msg as { content?: unknown }).content;
      if (!Array.isArray(content) || content.length === 0) return undefined;
      const first = content[0];
      if (!first || typeof first !== "object") return undefined;
      const text = (first as { text?: unknown }).text;
      return typeof text === "string" ? text : undefined;
    };

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const lines: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      lines.push(
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: `m${i}` }],
            timestamp: Date.now() + i,
          },
        }),
      );
    }
    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      lines.join("\n"),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const defaultRes = await rpcReq<{ messages?: unknown[] }>(
      ws,
      "chat.history",
      {
        sessionKey: "main",
      },
    );
    expect(defaultRes.ok).toBe(true);
    const defaultMsgs = defaultRes.payload?.messages ?? [];
    expect(defaultMsgs.length).toBe(200);
    expect(firstContentText(defaultMsgs[0])).toBe("m100");

    const limitedRes = await rpcReq<{ messages?: unknown[] }>(
      ws,
      "chat.history",
      {
        sessionKey: "main",
        limit: 5,
      },
    );
    expect(limitedRes.ok).toBe(true);
    const limitedMsgs = limitedRes.payload?.messages ?? [];
    expect(limitedMsgs.length).toBe(5);
    expect(firstContentText(limitedMsgs[0])).toBe("m295");

    const largeLines: string[] = [];
    for (let i = 0; i < 1500; i += 1) {
      largeLines.push(
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: `b${i}` }],
            timestamp: Date.now() + i,
          },
        }),
      );
    }
    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      largeLines.join("\n"),
      "utf-8",
    );

    const cappedRes = await rpcReq<{ messages?: unknown[] }>(
      ws,
      "chat.history",
      {
        sessionKey: "main",
      },
    );
    expect(cappedRes.ok).toBe(true);
    const cappedMsgs = cappedRes.payload?.messages ?? [];
    expect(cappedMsgs.length).toBe(200);
    expect(firstContentText(cappedMsgs[0])).toBe("b1300");

    const maxRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
      sessionKey: "main",
      limit: 1000,
    });
    expect(maxRes.ok).toBe(true);
    const maxMsgs = maxRes.payload?.messages ?? [];
    expect(maxMsgs.length).toBe(1000);
    expect(firstContentText(maxMsgs[0])).toBe("b500");

    ws.close();
    await server.close();
  });

  test("chat.history prefers sessionFile when set", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");

    const forkedPath = path.join(dir, "sess-forked.jsonl");
    await fs.writeFile(
      forkedPath,
      JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "text", text: "from-fork" }],
          timestamp: Date.now(),
        },
      }),
      "utf-8",
    );

    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "text", text: "from-default" }],
          timestamp: Date.now(),
        },
      }),
      "utf-8",
    );

    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            sessionFile: forkedPath,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
      sessionKey: "main",
    });
    expect(res.ok).toBe(true);
    const messages = res.payload?.messages ?? [];
    expect(messages.length).toBe(1);
    const first = messages[0] as { content?: { text?: string }[] };
    expect(first.content?.[0]?.text).toBe("from-fork");

    ws.close();
    await server.close();
  });

  test("chat.history defaults thinking to low for reasoning-capable models", async () => {
    piSdkMock.enabled = true;
    piSdkMock.models = [
      {
        id: "claude-opus-4-5",
        name: "Opus 4.5",
        provider: "anthropic",
        reasoning: true,
      },
    ];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: Date.now(),
        },
      }),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq<{ thinkingLevel?: string }>(ws, "chat.history", {
      sessionKey: "main",
    });
    expect(res.ok).toBe(true);
    expect(res.payload?.thinkingLevel).toBe("low");

    ws.close();
    await server.close();
  });

  test("chat.history caps payload bytes", { timeout: 15_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const bigText = "x".repeat(200_000);
    const largeLines: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      largeLines.push(
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: `${i}:${bigText}` }],
            timestamp: Date.now() + i,
          },
        }),
      );
    }
    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      largeLines.join("\n"),
      "utf-8",
    );

    const cappedRes = await rpcReq<{ messages?: unknown[] }>(
      ws,
      "chat.history",
      { sessionKey: "main", limit: 1000 },
    );
    expect(cappedRes.ok).toBe(true);
    const cappedMsgs = cappedRes.payload?.messages ?? [];
    const bytes = Buffer.byteLength(JSON.stringify(cappedMsgs), "utf8");
    expect(bytes).toBeLessThanOrEqual(6 * 1024 * 1024);
    expect(cappedMsgs.length).toBeLessThan(60);

    ws.close();
    await server.close();
  });

  test("chat.send does not overwrite last delivery route", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            lastProvider: "whatsapp",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "hello",
      idempotencyKey: "idem-route",
    });
    expect(res.ok).toBe(true);

    const stored = JSON.parse(
      await fs.readFile(testState.sessionStorePath, "utf-8"),
    ) as {
      main?: { lastProvider?: string; lastTo?: string };
    };
    expect(stored.main?.lastProvider).toBe("whatsapp");
    expect(stored.main?.lastTo).toBe("+1555");

    ws.close();
    await server.close();
  });

  test(
    "chat.abort cancels an in-flight chat.send",
    { timeout: 15000 },
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
      testState.sessionStorePath = path.join(dir, "sessions.json");
      await fs.writeFile(
        testState.sessionStorePath,
        JSON.stringify(
          {
            main: {
              sessionId: "sess-main",
              updatedAt: Date.now(),
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const { server, ws } = await startServerWithClient();
      let inFlight: Promise<unknown> | undefined;
      try {
        await connectOk(ws);

        const spy = vi.mocked(agentCommand);
        const callsBefore = spy.mock.calls.length;
        spy.mockImplementationOnce(async (opts) => {
          const signal = (opts as { abortSignal?: AbortSignal }).abortSignal;
          await new Promise<void>((resolve) => {
            if (!signal) return resolve();
            if (signal.aborted) return resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        });

        const sendResP = onceMessage(
          ws,
          (o) => o.type === "res" && o.id === "send-abort-1",
          8000,
        );
        const abortResP = onceMessage(
          ws,
          (o) => o.type === "res" && o.id === "abort-1",
          8000,
        );
        const abortedEventP = onceMessage(
          ws,
          (o) =>
            o.type === "event" &&
            o.event === "chat" &&
            o.payload?.state === "aborted",
          8000,
        );
        inFlight = Promise.allSettled([sendResP, abortResP, abortedEventP]);

        ws.send(
          JSON.stringify({
            type: "req",
            id: "send-abort-1",
            method: "chat.send",
            params: {
              sessionKey: "main",
              message: "hello",
              idempotencyKey: "idem-abort-1",
              timeoutMs: 30_000,
            },
          }),
        );

        const sendRes = await sendResP;
        expect(sendRes.ok).toBe(true);

        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 1000;
          const tick = () => {
            if (spy.mock.calls.length > callsBefore) return resolve();
            if (Date.now() > deadline)
              return reject(new Error("timeout waiting for agentCommand"));
            setTimeout(tick, 5);
          };
          tick();
        });

        ws.send(
          JSON.stringify({
            type: "req",
            id: "abort-1",
            method: "chat.abort",
            params: { sessionKey: "main", runId: "idem-abort-1" },
          }),
        );

        const abortRes = await abortResP;
        expect(abortRes.ok).toBe(true);

        const evt = await abortedEventP;
        expect(evt.payload?.runId).toBe("idem-abort-1");
        expect(evt.payload?.sessionKey).toBe("main");
      } finally {
        ws.close();
        await inFlight;
        await server.close();
      }
    },
  );

  test("chat.abort cancels while saving the session store", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    sessionStoreSaveDelayMs.value = 120;

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const spy = vi.mocked(agentCommand);
    spy.mockImplementationOnce(async (opts) => {
      const signal = (opts as { abortSignal?: AbortSignal }).abortSignal;
      await new Promise<void>((resolve) => {
        if (!signal) return resolve();
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const abortedEventP = onceMessage(
      ws,
      (o) =>
        o.type === "event" &&
        o.event === "chat" &&
        o.payload?.state === "aborted",
    );

    const sendResP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "send-abort-save-1",
    );

    ws.send(
      JSON.stringify({
        type: "req",
        id: "send-abort-save-1",
        method: "chat.send",
        params: {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-abort-save-1",
          timeoutMs: 30_000,
        },
      }),
    );

    const abortResP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "abort-save-1",
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "abort-save-1",
        method: "chat.abort",
        params: { sessionKey: "main", runId: "idem-abort-save-1" },
      }),
    );

    const abortRes = await abortResP;
    expect(abortRes.ok).toBe(true);

    const sendRes = await sendResP;
    expect(sendRes.ok).toBe(true);

    const evt = await abortedEventP;
    expect(evt.payload?.runId).toBe("idem-abort-save-1");
    expect(evt.payload?.sessionKey).toBe("main");

    ws.close();
    await server.close();
  });

  test(
    "chat.send treats /stop as an out-of-band abort",
    { timeout: 15000 },
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
      testState.sessionStorePath = path.join(dir, "sessions.json");
      await fs.writeFile(
        testState.sessionStorePath,
        JSON.stringify(
          { main: { sessionId: "sess-main", updatedAt: Date.now() } },
          null,
          2,
        ),
        "utf-8",
      );

      const { server, ws } = await startServerWithClient();
      await connectOk(ws);

      const spy = vi.mocked(agentCommand);
      const callsBefore = spy.mock.calls.length;
      spy.mockImplementationOnce(async (opts) => {
        const signal = (opts as { abortSignal?: AbortSignal }).abortSignal;
        await new Promise<void>((resolve) => {
          if (!signal) return resolve();
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      });

      const sendResP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "send-stop-1",
        8000,
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "send-stop-1",
          method: "chat.send",
          params: {
            sessionKey: "main",
            message: "hello",
            idempotencyKey: "idem-stop-run",
          },
        }),
      );
      const sendRes = await sendResP;
      expect(sendRes.ok).toBe(true);

      await waitFor(() => spy.mock.calls.length > callsBefore);

      const abortedEventP = onceMessage(
        ws,
        (o) =>
          o.type === "event" &&
          o.event === "chat" &&
          o.payload?.state === "aborted" &&
          o.payload?.runId === "idem-stop-run",
        8000,
      );

      const stopResP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "send-stop-2",
        8000,
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "send-stop-2",
          method: "chat.send",
          params: {
            sessionKey: "main",
            message: "/stop",
            idempotencyKey: "idem-stop-req",
          },
        }),
      );
      const stopRes = await stopResP;
      expect(stopRes.ok).toBe(true);

      const evt = await abortedEventP;
      expect(evt.payload?.sessionKey).toBe("main");

      expect(spy.mock.calls.length).toBe(callsBefore + 1);

      ws.close();
      await server.close();
    },
  );

  test("chat.send idempotency returns started → in_flight → ok", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const spy = vi.mocked(agentCommand);
    let resolveRun: (() => void) | undefined;
    const runDone = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    spy.mockImplementationOnce(async () => {
      await runDone;
    });

    const started = await rpcReq<{ runId?: string; status?: string }>(
      ws,
      "chat.send",
      {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-status-1",
      },
    );
    expect(started.ok).toBe(true);
    expect(started.payload?.status).toBe("started");

    const inFlight = await rpcReq<{ runId?: string; status?: string }>(
      ws,
      "chat.send",
      {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-status-1",
      },
    );
    expect(inFlight.ok).toBe(true);
    expect(inFlight.payload?.status).toBe("in_flight");

    resolveRun?.();

    let completed = false;
    for (let i = 0; i < 50; i++) {
      const again = await rpcReq<{ runId?: string; status?: string }>(
        ws,
        "chat.send",
        {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-status-1",
        },
      );
      if (again.ok && again.payload?.status === "ok") {
        completed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(completed).toBe(true);

    ws.close();
    await server.close();
  });

  test("chat.abort without runId aborts active runs and suppresses chat events after abort", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const spy = vi.mocked(agentCommand);
    spy.mockImplementationOnce(async (opts) => {
      const signal = (opts as { abortSignal?: AbortSignal }).abortSignal;
      await new Promise<void>((resolve) => {
        if (!signal) return resolve();
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const abortedEventP = onceMessage(
      ws,
      (o) =>
        o.type === "event" &&
        o.event === "chat" &&
        o.payload?.state === "aborted" &&
        o.payload?.runId === "idem-abort-all-1",
    );

    const started = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "hello",
      idempotencyKey: "idem-abort-all-1",
    });
    expect(started.ok).toBe(true);

    const abortRes = await rpcReq<{
      ok?: boolean;
      aborted?: boolean;
      runIds?: string[];
    }>(ws, "chat.abort", { sessionKey: "main" });
    expect(abortRes.ok).toBe(true);
    expect(abortRes.payload?.aborted).toBe(true);
    expect(abortRes.payload?.runIds ?? []).toContain("idem-abort-all-1");

    await abortedEventP;

    const noDeltaP = onceMessage(
      ws,
      (o) =>
        o.type === "event" &&
        o.event === "chat" &&
        (o.payload?.state === "delta" || o.payload?.state === "final") &&
        o.payload?.runId === "idem-abort-all-1",
      250,
    );

    emitAgentEvent({
      runId: "idem-abort-all-1",
      stream: "assistant",
      data: { text: "should be suppressed" },
    });
    emitAgentEvent({
      runId: "idem-abort-all-1",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    await expect(noDeltaP).rejects.toThrow(/timeout/i);

    ws.close();
    await server.close();
  });

  test("chat.abort returns aborted=false for unknown runId", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify({}, null, 2),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const abortRes = await rpcReq<{
      ok?: boolean;
      aborted?: boolean;
    }>(ws, "chat.abort", { sessionKey: "main", runId: "missing-run" });

    expect(abortRes.ok).toBe(true);
    expect(abortRes.payload?.aborted).toBe(false);

    ws.close();
    await server.close();
  });

  test("chat.abort rejects mismatched sessionKey", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const spy = vi.mocked(agentCommand);
    let agentStartedResolve: (() => void) | undefined;
    const agentStartedP = new Promise<void>((resolve) => {
      agentStartedResolve = resolve;
    });
    spy.mockImplementationOnce(async (opts) => {
      agentStartedResolve?.();
      const signal = (opts as { abortSignal?: AbortSignal }).abortSignal;
      await new Promise<void>((resolve) => {
        if (!signal) return resolve();
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const sendResP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "send-mismatch-1",
      10_000,
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "send-mismatch-1",
        method: "chat.send",
        params: {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-mismatch-1",
          timeoutMs: 30_000,
        },
      }),
    );

    await agentStartedP;

    const abortRes = await rpcReq(ws, "chat.abort", {
      sessionKey: "other",
      runId: "idem-mismatch-1",
    });
    expect(abortRes.ok).toBe(false);
    expect(abortRes.error?.code).toBe("INVALID_REQUEST");

    const abortRes2 = await rpcReq(ws, "chat.abort", {
      sessionKey: "main",
      runId: "idem-mismatch-1",
    });
    expect(abortRes2.ok).toBe(true);

    const sendRes = await sendResP;
    expect(sendRes.ok).toBe(true);

    ws.close();
    await server.close();
  }, 15_000);

  test("chat.abort is a no-op after chat.send completes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const spy = vi.mocked(agentCommand);
    spy.mockResolvedValueOnce(undefined);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "send-complete-1",
        method: "chat.send",
        params: {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-complete-1",
          timeoutMs: 30_000,
        },
      }),
    );

    const sendRes = await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "send-complete-1",
    );
    expect(sendRes.ok).toBe(true);

    // chat.send returns before the run ends; wait until dedupe is populated
    // (meaning the run completed and the abort controller was cleared).
    let completed = false;
    for (let i = 0; i < 50; i++) {
      const again = await rpcReq<{ runId?: string; status?: string }>(
        ws,
        "chat.send",
        {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-complete-1",
          timeoutMs: 30_000,
        },
      );
      if (again.ok && again.payload?.status === "ok") {
        completed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(completed).toBe(true);

    const abortRes = await rpcReq(ws, "chat.abort", {
      sessionKey: "main",
      runId: "idem-complete-1",
    });
    expect(abortRes.ok).toBe(true);
    expect(abortRes.payload?.aborted).toBe(false);

    ws.close();
    await server.close();
  });

  test("chat.send preserves run ordering for queued runs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res1 = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "first",
      idempotencyKey: "idem-1",
    });
    expect(res1.ok).toBe(true);

    const res2 = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "second",
      idempotencyKey: "idem-2",
    });
    expect(res2.ok).toBe(true);

    const final1P = onceMessage(
      ws,
      (o) =>
        o.type === "event" &&
        o.event === "chat" &&
        o.payload?.state === "final",
      8000,
    );

    emitAgentEvent({
      runId: "idem-1",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    const final1 = await final1P;
    const run1 =
      final1.payload && typeof final1.payload === "object"
        ? (final1.payload as { runId?: string }).runId
        : undefined;
    expect(run1).toBe("idem-1");

    const final2P = onceMessage(
      ws,
      (o) =>
        o.type === "event" &&
        o.event === "chat" &&
        o.payload?.state === "final",
      8000,
    );

    emitAgentEvent({
      runId: "idem-2",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    const final2 = await final2P;
    const run2 =
      final2.payload && typeof final2.payload === "object"
        ? (final2.payload as { runId?: string }).runId
        : undefined;
    expect(run2).toBe("idem-2");

    ws.close();
    await server.close();
  });
});
