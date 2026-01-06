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

    const res = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "hello",
      idempotencyKey: "idem-timeout-1",
    });
    expect(res.ok).toBe(true);

    const call = vi.mocked(agentCommand).mock.calls.at(-1)?.[0] as
      | { timeout?: string }
      | undefined;
    expect(call?.timeout).toBe("123");

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
            match: { surface: "discord", chatType: "group" },
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
            surface: "discord",
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
              content:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
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
            lastChannel: "whatsapp",
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
      main?: { lastChannel?: string; lastTo?: string };
    };
    expect(stored.main?.lastChannel).toBe("whatsapp");
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

        const sendRes = await sendResP;
        expect(sendRes.ok).toBe(true);

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
