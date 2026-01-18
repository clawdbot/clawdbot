import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  agentCommand,
  connectOk,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  sessionStoreSaveDelayMs,
  startServerWithClient,
  testState,
  writeSessionStore,
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
  test("chat.history caps payload bytes", { timeout: 60_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });

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
    await fs.writeFile(path.join(dir, "sess-main.jsonl"), largeLines.join("\n"), "utf-8");

    const cappedRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
      sessionKey: "main",
      limit: 1000,
    });
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
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "+1555",
        },
      },
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "hello",
      idempotencyKey: "idem-route",
    });
    expect(res.ok).toBe(true);

    const stored = JSON.parse(await fs.readFile(testState.sessionStorePath, "utf-8")) as Record<
      string,
      { lastChannel?: string; lastTo?: string } | undefined
    >;
    expect(stored["agent:main:main"]?.lastChannel).toBe("whatsapp");
    expect(stored["agent:main:main"]?.lastTo).toBe("+1555");

    ws.close();
    await server.close();
  });

  test("chat.abort cancels an in-flight chat.send", { timeout: 60_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });

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

      const sendResP = onceMessage(ws, (o) => o.type === "res" && o.id === "send-abort-1", 8000);
      const abortResP = onceMessage(ws, (o) => o.type === "res" && o.id === "abort-1", 8000);
      const abortedEventP = onceMessage(
        ws,
        (o) => o.type === "event" && o.event === "chat" && o.payload?.state === "aborted",
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
          if (Date.now() > deadline) return reject(new Error("timeout waiting for agentCommand"));
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
  });

  test("chat.abort cancels while saving the session store", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });

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
      (o) => o.type === "event" && o.event === "chat" && o.payload?.state === "aborted",
    );

    const sendResP = onceMessage(ws, (o) => o.type === "res" && o.id === "send-abort-save-1");

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

    const abortResP = onceMessage(ws, (o) => o.type === "res" && o.id === "abort-save-1");
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

  test("chat.send treats /stop as an out-of-band abort", { timeout: 60_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
      },
    });

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

    const sendResP = onceMessage(ws, (o) => o.type === "res" && o.id === "send-stop-1", 8000);
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

    const stopResP = onceMessage(ws, (o) => o.type === "res" && o.id === "send-stop-2", 8000);
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
  });

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

    const started = await rpcReq<{ runId?: string; status?: string }>(ws, "chat.send", {
      sessionKey: "main",
      message: "hello",
      idempotencyKey: "idem-status-1",
    });
    expect(started.ok).toBe(true);
    expect(started.payload?.status).toBe("started");

    const inFlight = await rpcReq<{ runId?: string; status?: string }>(ws, "chat.send", {
      sessionKey: "main",
      message: "hello",
      idempotencyKey: "idem-status-1",
    });
    expect(inFlight.ok).toBe(true);
    expect(inFlight.payload?.status).toBe("in_flight");

    resolveRun?.();

    let completed = false;
    for (let i = 0; i < 50; i++) {
      const again = await rpcReq<{ runId?: string; status?: string }>(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-status-1",
      });
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
});
