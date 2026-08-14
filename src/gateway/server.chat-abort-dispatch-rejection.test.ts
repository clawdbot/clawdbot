// Real WebSocket coverage for abort ownership when an in-flight dispatch rejects.
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import { clearConfigCache } from "../config/config.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { interruptSessionWorkAdmissions } from "../sessions/session-lifecycle-admission.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const temporaryDirectories = useAutoCleanupTempDirTracker(afterEach);
type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type GatewaySocket = Awaited<ReturnType<GatewayHarness["openWs"]>>;
let gateway: GatewayHarness;

function trackChatTerminalStates(socket: GatewaySocket, runId: string): string[] {
  const terminalStates: string[] = [];
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(rawDataToString(raw)) as {
        type?: string;
        event?: string;
        payload?: { runId?: string; state?: string };
      };
      if (
        frame.type === "event" &&
        frame.event === "chat" &&
        frame.payload?.runId === runId &&
        typeof frame.payload.state === "string"
      ) {
        terminalStates.push(frame.payload.state);
      }
    } catch {
      // The owned test socket may also carry unrelated gateway events.
    }
  });
  return terminalStates;
}

beforeAll(async () => {
  gateway = await createGatewaySuiteHarness();
});

afterAll(async () => {
  await gateway.close();
});

afterEach(() => {
  dispatchInboundMessageMock.mockReset();
  testState.sessionStorePath = undefined;
  clearConfigCache();
});

describe("gateway WebSocket chat abort ownership", () => {
  test("does not replace an acknowledged abort with a later dispatch rejection", async () => {
    const sessionDirectory = temporaryDirectories.make("openclaw-chat-abort-dispatch-");
    testState.sessionStorePath = path.join(sessionDirectory, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });

    const socket = await gateway.openWs();
    const dispatchRelease = createDeferred();
    const runId = "real-websocket-explicit-abort-before-dispatch-rejection";
    let dispatchRejected = false;
    const terminalStates = trackChatTerminalStates(socket, runId);

    try {
      await connectOk(socket);
      dispatchInboundMessageMock.mockImplementationOnce(async () => {
        await dispatchRelease.promise;
        dispatchRejected = true;
        throw new Error("dispatch rejected after an explicitly aborted run");
      });

      const sendParameters = {
        sessionKey: "main",
        message: "abort this dispatched message",
        idempotencyKey: runId,
      };
      const started = await rpcReq(socket, "chat.send", sendParameters);
      expect(started.ok).toBe(true);
      expect(started.payload).toMatchObject({ runId, status: "started" });
      await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledOnce(), {
        interval: 10,
        timeout: 2_000,
      });

      const abortedFrame = onceMessage(
        socket,
        (frame) =>
          frame.type === "event" &&
          frame.event === "chat" &&
          frame.payload?.runId === runId &&
          frame.payload?.state === "aborted",
        2_000,
      );
      const aborted = await rpcReq(socket, "chat.abort", {
        sessionKey: "main",
        runId,
      });
      expect(aborted.ok).toBe(true);
      expect(aborted.payload).toMatchObject({ ok: true, aborted: true, runIds: [runId] });
      await expect(abortedFrame).resolves.toMatchObject({
        payload: { runId, state: "aborted" },
      });

      dispatchRelease.resolve();
      await vi.waitFor(() => expect(dispatchRejected).toBe(true), {
        interval: 10,
        timeout: 2_000,
      });

      // The replay response is a real WebSocket ordering barrier: any prior
      // contradictory terminal frame must arrive before this cached response.
      const replay = await rpcReq(socket, "chat.send", sendParameters);
      expect(replay.ok).toBe(true);
      expect(replay.payload).toMatchObject({ runId, status: "timeout", summary: "aborted" });
      expect(terminalStates).toEqual(["aborted"]);
    } finally {
      dispatchRelease.resolve();
      socket.close();
    }
  });

  test("does not let a late abort replace an established dispatch error", async () => {
    const sessionDirectory = temporaryDirectories.make("openclaw-chat-error-late-abort-");
    testState.sessionStorePath = path.join(sessionDirectory, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });

    const socket = await gateway.openWs();
    const dispatchRelease = createDeferred();
    const runId = "real-websocket-dispatch-error-before-late-abort";
    const terminalStates = trackChatTerminalStates(socket, runId);

    try {
      await connectOk(socket);
      dispatchInboundMessageMock.mockImplementationOnce(async () => {
        await dispatchRelease.promise;
        throw new Error("dispatch rejected before a late abort");
      });

      const sendParameters = {
        sessionKey: "main",
        message: "reject this dispatched message before the abort",
        idempotencyKey: runId,
      };
      const started = await rpcReq(socket, "chat.send", sendParameters);
      expect(started.ok).toBe(true);
      expect(started.payload).toMatchObject({ runId, status: "started" });
      await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledOnce(), {
        interval: 10,
        timeout: 2_000,
      });

      const errorFrame = onceMessage(
        socket,
        (frame) =>
          frame.type === "event" &&
          frame.event === "chat" &&
          frame.payload?.runId === runId &&
          frame.payload?.state === "error",
        2_000,
      );
      dispatchRelease.resolve();
      await expect(errorFrame).resolves.toMatchObject({
        payload: { runId, state: "error" },
      });

      const lateAbort = await rpcReq(socket, "chat.abort", {
        sessionKey: "main",
        runId,
      });
      expect(lateAbort.ok).toBe(true);
      expect(lateAbort.payload).toMatchObject({ ok: true, aborted: false, runIds: [] });

      const replay = await rpcReq(socket, "chat.send", sendParameters);
      expect(replay.ok).toBe(false);
      expect(replay.payload).toMatchObject({ runId, status: "error" });
      expect(terminalStates).toEqual(["error"]);
    } finally {
      dispatchRelease.resolve();
      socket.close();
    }
  });

  test("keeps a real signal-only lifecycle terminal as the only chat terminal", async () => {
    const sessionDirectory = temporaryDirectories.make("openclaw-chat-lifecycle-interrupt-");
    const storePath = path.join(sessionDirectory, "sessions.json");
    testState.sessionStorePath = storePath;
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          startedAt: 900,
          status: "running",
          updatedAt: Date.now(),
        },
      },
    });

    const socket = await gateway.openWs();
    const dispatchRelease = createDeferred();
    const runId = "real-websocket-signal-only-lifecycle-terminal";
    const terminalStates = trackChatTerminalStates(socket, runId);
    let capturedAbortSignal: AbortSignal | undefined;
    let dispatchRejected = false;
    let interruption: Promise<boolean> | undefined;

    try {
      await connectOk(socket);
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        capturedAbortSignal = (args as { replyOptions?: GetReplyOptions }).replyOptions
          ?.abortSignal;
        await new Promise<void>((resolve) => {
          if (capturedAbortSignal?.aborted) {
            resolve();
            return;
          }
          capturedAbortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await dispatchRelease.promise;
        dispatchRejected = true;
        throw capturedAbortSignal?.reason instanceof Error
          ? capturedAbortSignal.reason
          : new Error("lifecycle interrupted dispatch");
      });

      const started = await rpcReq(socket, "chat.send", {
        sessionKey: "main",
        message: "preserve the signal-only lifecycle terminal",
        idempotencyKey: runId,
      });
      expect(started.ok).toBe(true);
      expect(started.payload).toMatchObject({ runId, status: "started" });
      await vi.waitFor(() => expect(capturedAbortSignal).toBeDefined(), {
        interval: 10,
        timeout: 2_000,
      });

      interruption = interruptSessionWorkAdmissions({
        scope: storePath,
        identities: ["main", "agent:main:main", "sess-main"],
        timeoutMs: 1_000,
      });
      await vi.waitFor(() => expect(capturedAbortSignal?.aborted).toBe(true), {
        interval: 10,
        timeout: 2_000,
      });

      const abortedFrame = onceMessage(
        socket,
        (frame) =>
          frame.type === "event" &&
          frame.event === "chat" &&
          frame.payload?.runId === runId &&
          frame.payload?.state === "aborted",
        2_000,
      );
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        sessionKey: "agent:main:main",
        sessionId: "sess-main",
        agentId: "main",
        data: {
          phase: "end",
          startedAt: 900,
          endedAt: Date.now(),
          aborted: true,
          stopReason: "restart",
        },
      });
      await expect(abortedFrame).resolves.toMatchObject({
        payload: { runId, state: "aborted" },
      });

      dispatchRelease.resolve();
      await vi.waitFor(() => expect(dispatchRejected).toBe(true), {
        interval: 10,
        timeout: 2_000,
      });
      await expect(interruption).resolves.toBe(true);

      // The history RPC response follows every previously emitted chat
      // event on this socket, so it exposes any contradictory late terminal.
      const barrier = await rpcReq(socket, "chat.history", { sessionKey: "main" });
      expect(barrier.ok).toBe(true);
      expect(terminalStates).toEqual(["aborted"]);
    } finally {
      dispatchRelease.resolve();
      await interruption?.catch(() => undefined);
      socket.close();
    }
  });
});
