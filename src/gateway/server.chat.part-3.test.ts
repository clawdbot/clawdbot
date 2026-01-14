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
  rpcReq,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks();

async function _waitFor(condition: () => boolean, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout waiting for condition");
}

describe("gateway server chat", () => {
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
