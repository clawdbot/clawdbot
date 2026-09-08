// Real WebSocket coverage for abort ownership when an in-flight dispatch rejects.
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAgentRunDirectAbortError } from "../agents/run-termination.js";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import * as staging from "../auto-reply/reply/stage-sandbox-media.js";
import { clearConfigCache } from "../config/config.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  interruptSessionWorkAdmissions,
  startSessionWorkAdmissionInterruption,
} from "../sessions/session-lifecycle-admission.js";
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

  test("returns pre-ACK attachment cancellation only after inbound cleanup", async () => {
    const sessionDirectory = temporaryDirectories.make("openclaw-chat-attachment-abort-");
    const storePath = path.join(sessionDirectory, "sessions.json");
    testState.sessionStorePath = storePath;
    const previousAgentConfig = testState.agentConfig;
    testState.agentConfig = {
      ...previousAgentConfig,
      workspace: path.join(sessionDirectory, "workspace"),
      skipBootstrap: true,
      sandbox: {
        mode: "all",
        scope: "agent",
        workspaceRoot: path.join(sessionDirectory, "sandboxes"),
        workspaceAccess: "none",
      },
    };
    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-attachment-abort", updatedAt: Date.now() },
      },
    });

    const socket = await gateway.openWs();
    const stageRelease = createDeferred();
    const stageEntered = createDeferred();
    const reason = createAgentRunDirectAbortError();
    const runId = "real-websocket-pre-ack-attachment-cancellation";
    const bytes = "synthetic attachment awaiting staging";
    let inboundPath: string | undefined;
    let filePresentAtResponse: boolean | undefined;
    let interruption: ReturnType<typeof startSessionWorkAdmissionInterruption> | undefined;
    let send: ReturnType<typeof rpcReq> | undefined;
    const stageSpy = vi.spyOn(staging, "stageSandboxMedia").mockImplementation(async ({ ctx }) => {
      inboundPath = ctx.media?.[0]?.path;
      stageEntered.resolve();
      await stageRelease.promise;
      throw reason;
    });

    try {
      await connectOk(socket);
      dispatchInboundMessageMock.mockResolvedValue({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      });
      send = rpcReq(socket, "chat.send", {
        sessionKey: "main",
        message: "cancel this attachment before dispatch",
        idempotencyKey: runId,
        attachments: [
          {
            fileName: "notes.txt",
            mimeType: "text/plain",
            content: Buffer.from(bytes).toString("base64"),
          },
        ],
      }).then((response) => {
        filePresentAtResponse = inboundPath !== undefined && existsSync(inboundPath);
        return response;
      });
      // Cancel at the staging boundary, independently of RPC setup and filesystem latency.
      await Promise.race([
        stageEntered.promise,
        send.then(() => {
          throw new Error("chat.send completed before attachment staging");
        }),
      ]);
      expect(stageSpy).toHaveBeenCalledOnce();
      if (!inboundPath) {
        throw new Error("the real Gateway did not persist the inbound attachment");
      }
      expect(await fs.readFile(inboundPath, "utf8")).toBe(bytes);
      // This is the real admitted-work interruption path after registration,
      // which forwards its reason without creating an explicit RPC abort marker.
      interruption = startSessionWorkAdmissionInterruption({
        scope: storePath,
        identities: ["main", "agent:main:main", "sess-attachment-abort"],
        reason,
      });
      stageRelease.resolve();
      const response = await send;
      expect(response.ok).toBe(true);
      expect(response.payload).toMatchObject({
        runId,
        status: "timeout",
        summary: "aborted",
        stopReason: "rpc",
      });
      expect(filePresentAtResponse).toBe(false);
      await expect(interruption.released).resolves.toBeUndefined();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      stageRelease.resolve();
      await Promise.allSettled([send, interruption?.released]);
      stageSpy.mockRestore();
      testState.agentConfig = previousAgentConfig;
      socket.close();
    }
  });

  test("waits for pass-through attachment cleanup after sessions.abort before replying to chat.send", async () => {
    const sessionDirectory = temporaryDirectories.make("openclaw-chat-pass-through-abort-");
    testState.sessionStorePath = path.join(sessionDirectory, "sessions.json");
    const previousAgentConfig = testState.agentConfig;
    const prepared = createDeferred();
    const releasePreparation = createDeferred();
    const discarding = createDeferred();
    const releaseDiscard = createDeferred();
    const runId = "real-websocket-pass-through-sessions-abort";
    const bytes = "synthetic pass-through attachment awaiting cancellation";
    let socket: GatewaySocket | undefined;
    let send: ReturnType<typeof rpcReq> | undefined;
    let sendWork: Promise<void> | undefined;
    let discardWork: Promise<void> | undefined;
    let inboundPath: string | undefined;
    let cleanupSettled = false;
    const responses: Array<{
      filePresent: boolean;
      cleanupSettled: boolean;
      payload: unknown;
    }> = [];
    const restoreSpies: Array<() => void> = [];
    await runQaGatewayFixture(
      async () => {
        testState.agentConfig = {
          ...previousAgentConfig,
          workspace: path.join(sessionDirectory, "workspace"),
          skipBootstrap: true,
          sandbox: { mode: "off" },
        };
        await writeSessionStore({
          entries: { main: { sessionId: "sess-pass-through-abort", updatedAt: Date.now() } },
        });
        // Eager chat.send imports bind the real dispatcher before fixture mocks exist.
        const [sandboxContext, attachments, chatSend] = await Promise.all([
          import("../agents/sandbox/context.js"),
          import("./chat-attachments.js"),
          import("./server-methods/chat-send-handler.js"),
        ]);
        const parse = attachments.parseMessageWithAttachments;
        const ensureSandbox = sandboxContext.ensureSandboxWorkspaceForSession;
        const discard = attachments.discardPreparedInboundMedia;
        const handleSend = chatSend.handleChatSend;
        const parseSpy = vi
          .spyOn(attachments, "parseMessageWithAttachments")
          .mockImplementation(async (...args) => {
            const result = await parse(...args);
            inboundPath = result.offloadedRefs[0]?.path;
            return result;
          });
        restoreSpies.push(() => parseSpy.mockRestore());
        const sandboxSpy = vi
          .spyOn(sandboxContext, "ensureSandboxWorkspaceForSession")
          .mockImplementation(async (...args) => {
            const result = await ensureSandbox(...args);
            if (inboundPath) {
              expect(result).toBeNull();
              prepared.resolve();
              await releasePreparation.promise;
            }
            return result;
          });
        restoreSpies.push(() => sandboxSpy.mockRestore());
        const discardSpy = vi
          .spyOn(attachments, "discardPreparedInboundMedia")
          .mockImplementation((...args) => {
            discardWork = releaseDiscard.promise.then(async () => {
              await discard(...args);
              cleanupSettled = true;
            });
            discarding.resolve();
            return discardWork;
          });
        restoreSpies.push(() => discardSpy.mockRestore());
        const sendSpy = vi
          .spyOn(chatSend, "handleChatSend")
          .mockImplementation((options, ...rest) => {
            const respond: typeof options.respond = (...reply) => {
              // Observe before wire scheduling can hide a premature response behind cleanup.
              responses.push({
                filePresent: inboundPath !== undefined && existsSync(inboundPath),
                cleanupSettled,
                payload: reply[1],
              });
              options.respond(...reply);
            };
            sendWork = handleSend({ ...options, respond }, ...rest);
            return sendWork;
          });
        restoreSpies.push(() => sendSpy.mockRestore());
        const connectedSocket = await gateway.openWs();
        socket = connectedSocket;
        await connectOk(connectedSocket);
        dispatchInboundMessageMock.mockResolvedValue({
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        });
        send = rpcReq(connectedSocket, "chat.send", {
          sessionKey: "main",
          message: "cancel this pass-through attachment before dispatch",
          idempotencyKey: runId,
          attachments: [
            {
              fileName: "notes.txt",
              mimeType: "text/plain",
              content: Buffer.from(bytes).toString("base64"),
            },
          ],
        });
        await Promise.race([
          prepared.promise,
          send.then((response) => {
            throw new Error(
              `chat.send completed before real attachment preparation: ${JSON.stringify(response)}`,
            );
          }),
        ]);
        expect(parseSpy).toHaveBeenCalledOnce();
        if (!inboundPath) {
          throw new Error("the real parser did not persist the pass-through attachment");
        }
        expect(await fs.readFile(inboundPath, "utf8")).toBe(bytes);
        expect(responses).toEqual([]);
        const aborted = await rpcReq(connectedSocket, "sessions.abort", {
          key: "main",
          agentId: "main",
          clearQueued: true,
        });
        expect(aborted.ok).toBe(true);
        expect(aborted.payload).toEqual({ ok: true, abortedRunId: runId, status: "aborted" });
        releasePreparation.resolve();
        await Promise.race([
          discarding.promise,
          send.then(() => {
            throw new Error("chat.send completed without discarding the cancelled attachment");
          }),
        ]);
        expect(existsSync(inboundPath)).toBe(true);
        expect(cleanupSettled).toBe(false);
        expect(responses).toEqual([]);
        releaseDiscard.resolve();
        const response = await send;
        await sendWork;
        await discardWork;
        expect(response.ok).toBe(true);
        expect(response.payload).toMatchObject({
          runId,
          status: "timeout",
          summary: "aborted",
          stopReason: "rpc",
        });
        expect(responses).toEqual([
          {
            filePresent: false,
            cleanupSettled: true,
            payload: expect.objectContaining({
              runId,
              status: "timeout",
              summary: "aborted",
              stopReason: "rpc",
            }),
          },
        ]);
        expect(discardSpy).toHaveBeenCalledOnce();
        expect(existsSync(inboundPath)).toBe(false);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      },
      async () => {
        releasePreparation.resolve();
        releaseDiscard.resolve();
        await runQaGatewayFixture(
          async () => {
            await sendWork;
          },
          async () => {
            await discardWork;
          },
          async () => {
            await send;
          },
        );
      },
      () => {
        for (const restore of restoreSpies.toReversed()) {
          restore();
        }
        testState.agentConfig = previousAgentConfig;
        socket?.close();
      },
    );
  });
});
