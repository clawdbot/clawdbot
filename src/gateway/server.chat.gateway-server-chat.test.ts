// Gateway server chat tests cover WebSocket chat flow, history construction,
// NO_REPLY handling, agent events, and connected control-UI delivery.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { replyRunRegistry } from "../auto-reply/reply/reply-run-registry.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  claimAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import { createSafeGatewayRestartPreflight } from "../infra/restart-coordinator.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionWorkAdmissionCount,
} from "../sessions/session-lifecycle-admission.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import * as sessionLifecycleState from "./session-lifecycle-state.js";
import {
  agentDiscoveryMock,
  connectOk,
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  mockGetReplyFromConfigOnce,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  testState,
  trackConnectChallengeNonce,
  withGatewayServer,
  writeSessionStore,
} from "./test-helpers.js";
import { agentCommandMock } from "./test-helpers.runtime-state.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

function createGatewayHistoryText(role: "user" | "assistant", text: unknown, timestamp: number) {
  return { role, content: [{ type: "text", text }], timestamp };
}

function createGatewayHistoryMessageToolCall(
  id: string,
  args: Record<string, unknown>,
  timestamp: number,
) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "message", arguments: args }],
    timestamp,
  };
}

function createGatewayHistoryMessageToolResult(id: string, content: unknown, timestamp: number) {
  return { role: "toolResult", toolName: "message", toolCallId: id, content, timestamp };
}

function createGatewayHistoryDeliveryMirror(text: unknown, timestamp: number) {
  return {
    role: "assistant",
    provider: "openclaw",
    model: "delivery-mirror",
    content: [{ type: "text", text }],
    timestamp,
  };
}

function hasGatewayHistoryMessageToolMirror(message: unknown) {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { openclawMessageToolMirror?: unknown }).openclawMessageToolMirror,
  );
}

installGatewayTestHooks({ scope: "suite" });
const CHAT_RESPONSE_TIMEOUT_MS = 10_000;

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

let ws: WebSocket;
let port: number;

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
  port = started.port;
});

describe("gateway server chat", () => {
  beforeEach(() => {
    dispatchInboundMessageMock.mockReset();
  });

  const removeTempDir = async (dir: string): Promise<void> => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };

  const buildNoReplyHistoryFixture = (includeMixedAssistant = false) => [
    createGatewayHistoryText("user", "hello", 1),
    createGatewayHistoryText("assistant", "NO_REPLY", 2),
    createGatewayHistoryText("assistant", "real reply", 3),
    {
      role: "assistant",
      text: "real text field reply",
      content: "NO_REPLY",
      timestamp: 4,
    },
    createGatewayHistoryText("user", "NO_REPLY", 5),
    ...(includeMixedAssistant
      ? [
          {
            role: "assistant",
            content: [
              { type: "text", text: "NO_REPLY" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
            ],
            timestamp: 6,
          },
        ]
      : []),
  ];

  const loadChatHistoryWithMessages = async (
    messages: Array<Record<string, unknown>>,
  ): Promise<unknown[]> => {
    return withMainSessionStore(async () => {
      const lines = messages.map((message) => JSON.stringify({ message }));
      await replaceMainTranscriptLines(lines);

      const res = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(res.ok).toBe(true);
      return res.payload?.messages ?? [];
    });
  };

  const replaceMainTranscriptLines = async (lines: string[]): Promise<void> => {
    const storePath = testState.sessionStorePath;
    if (!storePath) {
      throw new Error("session store path was not initialized");
    }
    const events = lines.map((line, index) => ({
      ...(JSON.parse(line) as Record<string, unknown>),
      id: `message-${index}`,
      type: "message",
    }));
    await replaceTranscriptEvents(
      { agentId: "main", sessionId: "sess-main", sessionKey: "main", storePath },
      events,
    );
  };

  const withMainSessionStore = async <T>(
    run: (dir: string) => Promise<T>,
    options?: { archivedAt?: number; sessionId?: string },
  ): Promise<T> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    try {
      const sessionId = options?.sessionId ?? "sess-main";
      testState.sessionStorePath = path.join(dir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId,
            sessionFile: path.join(dir, `${sessionId}.jsonl`),
            updatedAt: Date.now(),
            ...(options?.archivedAt !== undefined ? { archivedAt: options.archivedAt } : {}),
          },
        },
      });
      return await run(dir);
    } finally {
      // Dispatch can outlive its RPC; keep its store selected until retained work settles.
      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      testState.sessionStorePath = undefined;
      await removeTempDir(dir);
    }
  };

  const collectHistoryTextValues = (historyMessages: unknown[]) =>
    historyMessages
      .map((message) => {
        if (message && typeof message === "object") {
          const entry = message as { text?: unknown };
          if (typeof entry.text === "string") {
            return entry.text;
          }
        }
        return extractFirstTextBlock(message);
      })
      .filter((value): value is string => typeof value === "string");

  const expectRecordFields = (value: unknown, expected: Record<string, unknown>) => {
    if (!value || typeof value !== "object") {
      throw new Error("Expected record");
    }
    const actual = value as Record<string, unknown>;
    for (const [key, expectedValue] of Object.entries(expected)) {
      expect(actual[key]).toEqual(expectedValue);
    }
    return actual;
  };

  const expectStringRunId = (payload: unknown) => {
    const actual = expectRecordFields(payload, {});
    expect(typeof actual.runId).toBe("string");
    return actual.runId as string;
  };

  const expectAgentWaitTimeout = (res: Awaited<ReturnType<typeof rpcReq>>, error?: string) => {
    expect(res.ok).toBe(true);
    expect(res.payload?.status).toBe("timeout");
    if (error !== undefined) {
      expect(res.payload?.error).toBe(error);
      expect(res.payload?.pendingError).toBe(true);
    }
  };

  const expectAgentWaitStartedAt = (res: Awaited<ReturnType<typeof rpcReq>>, startedAt: number) => {
    expect(res.ok).toBe(true);
    expect(res.payload?.status).toBe("ok");
    expect(res.payload?.startedAt).toBe(startedAt);
  };

  const sendChatAndExpectStarted = async (runId: string, message = "/context list") => {
    const res = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message,
      idempotencyKey: runId,
    });
    expect(res.ok).toBe(true);
    expect(res.payload?.status).toBe("started");
    return res;
  };

  test("chat.send rejects archived sessions before dispatch", async () => {
    await withMainSessionStore(
      async () => {
        dispatchInboundMessageMock.mockClear();
        const res = await rpcReq(ws, "chat.send", {
          sessionKey: "main",
          message: "blocked while archived",
          idempotencyKey: "proof-chat-archived-session",
        });
        expect(res.ok).toBe(false);
        expect(res.error).toMatchObject({
          code: "INVALID_REQUEST",
          message: 'Session "agent:main:main" is archived. Restore it before starting new work.',
        });
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      },
      { archivedAt: Date.now() },
    );
  });

  test("chat.send fences the admitted session settings", async () => {
    await withMainSessionStore(async () => {
      const set = await rpcReq(ws, "sessions.patch", {
        key: "main",
        permissionMode: "guarded",
        toolOverrides: { webSearch: false },
      });
      expect(set.ok).toBe(true);

      const accepted = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "use the matched settings",
        expectedPermissionMode: "guarded",
        expectedToolOverrides: { webSearch: false },
        idempotencyKey: "idem-chat-settings-cas-success",
      });
      expect(accepted.ok).toBe(true);
      await waitForAgentRunDrained("idem-chat-settings-cas-success");

      const changed = await rpcReq(ws, "sessions.patch", {
        key: "main",
        permissionMode: "read-only",
        toolOverrides: { skills: { release: false } },
      });
      expect(changed.ok).toBe(true);
      const rejected = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "do not use stale settings",
        expectedPermissionMode: "guarded",
        expectedToolOverrides: { webSearch: false },
        idempotencyKey: "idem-chat-settings-cas-conflict",
      });
      expect(rejected).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          details: { reason: "session-settings-changed" },
        },
      });
    });
  });

  test("chat.send keeps stored settings for legacy callers after the session row broadens", async () => {
    await withMainSessionStore(async () => {
      const dispatchEntered = createDeferred<InternalGetReplyOptions | undefined>();
      const releaseDispatch = createDeferred();
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        const params = args as { replyOptions?: InternalGetReplyOptions };
        dispatchEntered.resolve(params.replyOptions);
        await releaseDispatch.promise;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      });
      expect(
        (
          await rpcReq(ws, "sessions.patch", {
            key: "main",
            permissionMode: "guarded",
            toolOverrides: { webSearch: false },
          })
        ).ok,
      ).toBe(true);

      const accepted = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "keep admitted authority",
        idempotencyKey: "idem-chat-settings-final-freeze",
      });
      expect(accepted.ok).toBe(true);
      const admittedOptions = await dispatchEntered.promise;

      expect(
        (
          await rpcReq(ws, "sessions.patch", {
            key: "main",
            permissionMode: "full",
            toolOverrides: null,
          })
        ).ok,
      ).toBe(true);
      expect(admittedOptions?.admittedSessionSettings).toEqual({
        permissionMode: "guarded",
        toolOverrides: { webSearch: false },
      });
      releaseDispatch.resolve();
      await waitForAgentRunDrained("idem-chat-settings-final-freeze");
    });
  });

  test("keeps started chat dispatch on its retained request root", async () => {
    await withMainSessionStore(async () => {
      let subordinateAdmissionClosed: boolean | undefined;
      dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        const suspension = tryBeginGatewaySuspendAdmission(() => {});
        expect(suspension).not.toBeNull();
        try {
          subordinateAdmissionClosed = isGatewaySubordinateWorkAdmissionClosed();
        } finally {
          suspension?.rollback();
        }
        const [params] = args as [
          {
            dispatcher: {
              sendFinalReply: (payload: { text: string }) => boolean;
              markComplete: () => void;
              waitForIdle: () => Promise<void>;
              getQueuedCounts: () => { final: number; block: number; tool: number };
            };
          },
        ];
        params.dispatcher.sendFinalReply({ text: "detached root stayed live" });
        params.dispatcher.markComplete();
        await params.dispatcher.waitForIdle();
        return {
          queuedFinal: true,
          counts: params.dispatcher.getQueuedCounts(),
        };
      });
      const finalPromise = onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "chat" &&
          message.payload?.state === "final" &&
          message.payload?.runId === "idem-chat-detached-root",
        8_000,
      );

      const res = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "prove detached root transfer",
        idempotencyKey: "idem-chat-detached-root",
      });

      expect(res.ok).toBe(true);
      expect(res.payload?.status).toBe("started");
      await waitForFast(() => {
        expect(subordinateAdmissionClosed).toBe(false);
      });
      await finalPromise;
      await waitForFast(() => {
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      });
    });
  });

  test("delivers a queued WebChat reply over the live Gateway WebSocket after its source ends", async () => {
    await withMainSessionStore(async () => {
      let options: InternalGetReplyOptions | undefined;
      const releaseDispatch = createDeferred();
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        options = (args as { replyOptions?: InternalGetReplyOptions }).replyOptions;
        options?.turnAdoptionLifecycle?.onDeferred?.();
        await releaseDispatch.promise;
        return {};
      });

      const sourceRunId = "idem-live-webchat-late-source";
      const sourceFinal = onceMessage(
        ws,
        (event) =>
          event.type === "event" &&
          event.event === "chat" &&
          event.payload?.state === "final" &&
          event.payload?.runId === sourceRunId,
        CHAT_RESPONSE_TIMEOUT_MS,
      );
      const response = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "queue a reply while the previous run is active",
        idempotencyKey: sourceRunId,
      });
      expect(response.ok).toBe(true);
      await waitForFast(() => expect(options?.onQueuedFollowupReplyBatch).toBeTypeOf("function"));
      releaseDispatch.resolve();
      await sourceFinal;

      const followupRunId = "idem-live-webchat-late-followup";
      const queuedFinal = onceMessage(
        ws,
        (event) =>
          event.type === "event" &&
          event.event === "chat" &&
          event.payload?.state === "final" &&
          event.payload?.runId === followupRunId,
        CHAT_RESPONSE_TIMEOUT_MS,
      );
      await options?.onQueuedFollowupReplyBatch?.({
        kind: "queued-followup",
        runId: followupRunId,
        originatingChannel: "webchat",
        payloads: [{ text: "late answer arrived over the live WebSocket" }],
      });
      expect((await queuedFinal).payload?.message).toMatchObject({
        content: [{ type: "text", text: "late answer arrived over the live WebSocket" }],
      });
      options?.turnAdoptionLifecycle?.onSettled?.();
    });
  });

  const waitForAgentRunOk = async (runId: string, timeoutMs = 1_000) => {
    const res = await rpcReq(ws, "agent.wait", {
      runId,
      timeoutMs,
    });
    expect(res.ok).toBe(true);
    expect(res.payload?.status, JSON.stringify(res.payload)).toBe("ok");
    return res;
  };
  const waitForAgentRunDrained = async (runId: string) => {
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    await waitForAgentRunOk(runId, 0);
  };
  const abortChatRun = async (runId: string) => {
    const res = await rpcReq(ws, "chat.abort", {
      sessionKey: "main",
      runId,
    });
    expect(res.ok).toBe(true);
    return res;
  };

  const mockBlockedChatReply = () => {
    let releaseBlockedReply: (() => void) | undefined;
    const blockedReply = new Promise<void>((resolve) => {
      releaseBlockedReply = resolve;
    });
    mockGetReplyFromConfigOnce(async (_ctx, opts) => {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve();
        };
        void blockedReply.then(finish);
        if (opts?.abortSignal?.aborted) {
          finish();
          return;
        }
        opts?.abortSignal?.addEventListener("abort", finish, { once: true });
      });
      return undefined;
    });
    return () => {
      releaseBlockedReply?.();
    };
  };

  test.each([
    { method: "send", message: "hello from dashboard" },
    { method: "steer", message: "follow-up from dashboard" },
  ])(
    "sessions.$method accepts an existing session input before reporting its committed history position",
    async ({ method, message }) => {
      const sessionKey = `agent:main:dashboard:test-${method}`;
      const runId = `idem-sessions-${method}-1`;
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-sessions-${method}-`));
      testState.sessionStorePath = path.join(dir, "sessions.json");
      try {
        await writeSessionStore({
          entries: {
            [sessionKey]: {
              sessionId: `sess-dashboard-${method}`,
              updatedAt: Date.now(),
            },
          },
        });

        const res = await rpcReq(ws, `sessions.${method}`, {
          key: sessionKey,
          message,
          idempotencyKey: runId,
        });
        expect(res.ok).toBe(true);
        expectRecordFields(res.payload, { runId, status: "started" });
        // The suite's TEST client ACKs before dispatch can commit the user turn.
        expect(res.payload).not.toHaveProperty("messageSeq");
        await waitForAgentRunDrained(runId);

        const history = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", { sessionKey });
        expect(history.ok).toBe(true);
        const users = (history.payload?.messages ?? []).filter(
          (entry) => expectRecordFields(entry, {}).role === "user",
        );
        expect(users).toHaveLength(1);
        const user = expectRecordFields(users[0], { role: "user" });
        expectRecordFields(user["__openclaw"], { seq: 1, idempotencyKey: `${runId}:user` });
        expect(collectHistoryTextValues(users)).toEqual([message]);
      } finally {
        // A failed ACK assertion must not retire storage before detached work finishes.
        await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        testState.sessionStorePath = undefined;
        await removeTempDir(dir);
      }
    },
  );

  test("chat.send interrupt drains the captured admission before starting", async () => {
    await withMainSessionStore(async () => {
      const activeRunStarted = createDeferred();
      mockGetReplyFromConfigOnce(async (_ctx, opts) => {
        activeRunStarted.resolve(undefined);
        if (!opts?.abortSignal?.aborted) {
          await new Promise<void>((resolve) => {
            opts?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return undefined;
      });
      const active = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "captured active turn",
        idempotencyKey: "idem-chat-interrupt-old",
      });
      expect(active.ok).toBe(true);
      await activeRunStarted.promise;

      const res = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "replace the captured turn",
        queueMode: "interrupt",
        idempotencyKey: "idem-chat-interrupt-active",
      });
      expect(res.ok).toBe(true);
      expect(res.payload).toMatchObject({
        runId: "idem-chat-interrupt-active",
        status: "started",
        interruptedActiveRun: true,
      });
      await waitForAgentRunDrained("idem-chat-interrupt-active");
    });
  });

  test("chat.send interrupt releases its admission when backend cancellation throws", async () => {
    await withMainSessionStore(async () => {
      const activeRunStarted = createDeferred();
      mockGetReplyFromConfigOnce(async (_ctx, opts) => {
        activeRunStarted.resolve(undefined);
        if (!opts?.abortSignal?.aborted) {
          await new Promise<void>((resolve) => {
            opts?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return undefined;
      });
      const active = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "captured active turn",
        idempotencyKey: "idem-chat-interrupt-throw-old",
      });
      expect(active.ok).toBe(true);
      await activeRunStarted.promise;

      const operation = replyRunRegistry.get("agent:main:main");
      expect(operation).toBeDefined();
      operation?.attachBackend({
        kind: "embedded",
        cancel: () => {
          throw new Error("cancel failed");
        },
        isStreaming: () => true,
      });

      const res = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "replace the captured turn",
        queueMode: "interrupt",
        idempotencyKey: "idem-chat-interrupt-throw-new",
      });
      expect(res.ok).toBe(false);
      await waitForFast(() => expect(getActiveSessionWorkAdmissionCount()).toBe(0));
      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

      const reset = await rpcReq(ws, "sessions.reset", { key: "main", reason: "new" });
      expect(reset.ok).toBe(true);
    });
  });

  test("chat.send interrupt releases its admission when session interruption throws", async () => {
    await withMainSessionStore(async () => {
      const storePath = testState.sessionStorePath;
      if (!storePath) {
        throw new Error("session store path was not initialized");
      }
      const activeAdmission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: ["agent:main:main", "sess-main"],
        assertAllowed: () => {},
        onInterrupt: () => {
          activeAdmission.release();
          throw new Error("session interruption failed");
        },
      });

      try {
        const res = await rpcReq(ws, "chat.send", {
          sessionKey: "main",
          message: "replace non-reply session work",
          queueMode: "interrupt",
          idempotencyKey: "idem-chat-interrupt-non-reply-throw",
        });

        expect(res.ok).toBe(false);
        await waitForFast(() => expect(getActiveSessionWorkAdmissionCount()).toBe(0));
        await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

        const reset = await rpcReq(ws, "sessions.reset", { key: "main", reason: "new" });
        expect(reset.ok).toBe(true);
      } finally {
        activeAdmission.release();
      }
    });
  });

  test("chat.send interrupt drains a non-reply session admission before dispatching", async () => {
    await withMainSessionStore(async () => {
      const storePath = testState.sessionStorePath;
      if (!storePath) {
        throw new Error("session store path was not initialized");
      }
      const onInterrupt = vi.fn();
      const interrupted = createDeferred();
      const activeAdmission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: ["agent:main:main", "sess-main"],
        assertAllowed: () => {},
        onInterrupt: () => {
          onInterrupt();
          interrupted.resolve(undefined);
        },
      });
      const activeWork = activeAdmission.run(async () => {
        await interrupted.promise;
        activeAdmission.release();
      });

      try {
        const res = await rpcReq(ws, "chat.send", {
          sessionKey: "main",
          message: "replace non-reply session work",
          queueMode: "interrupt",
          idempotencyKey: "idem-chat-interrupt-non-reply",
        });

        expect(res.ok).toBe(true);
        expect(onInterrupt).toHaveBeenCalledOnce();
        expect(res.payload).toMatchObject({
          runId: "idem-chat-interrupt-non-reply",
          status: "started",
          interruptedActiveRun: true,
        });
        await waitForAgentRunDrained("idem-chat-interrupt-non-reply");
      } finally {
        interrupted.resolve(undefined);
        activeAdmission.release();
        await activeWork;
      }
    });
  });

  test("chat.send interrupt starts normally when the session is idle", async () => {
    await withMainSessionStore(async () => {
      const res = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "start from idle",
        queueMode: "interrupt",
        idempotencyKey: "idem-chat-interrupt-idle",
      });
      expect(res.ok).toBe(true);
      expect(res.payload).toMatchObject({
        runId: "idem-chat-interrupt-idle",
        status: "started",
      });
      expect(res.payload).not.toHaveProperty("interruptedActiveRun");
      await waitForAgentRunDrained("idem-chat-interrupt-idle");
    });
  });

  test("sessions.send creates a configured agent main session before sending", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-send-agent-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    testState.agentsConfig = {
      list: [{ id: "main", default: true }, { id: "orion" }],
    };
    try {
      await writeSessionStore({ entries: {} });
      await prepareGatewayReplyRuntimeForTest({ force: true });

      const res = await rpcReq(ws, "sessions.send", {
        key: "agent:orion:main",
        message: "hello orion",
        idempotencyKey: "idem-sessions-send-orion",
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.runId).toBe("idem-sessions-send-orion");

      expect(
        loadSessionEntry({
          sessionKey: "agent:orion:main",
          storePath: testState.sessionStorePath,
        })?.sessionId,
      ).toBeTypeOf("string");
      await waitForAgentRunDrained("idem-sessions-send-orion");
    } finally {
      testState.agentsConfig = undefined;
      testState.sessionStorePath = undefined;
      await removeTempDir(dir);
    }
  });

  test("sessions.abort stops active dashboard runs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-abort-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    try {
      await writeSessionStore({
        entries: {
          "agent:main:dashboard:test-abort": {
            sessionId: "sess-dashboard-abort",
            updatedAt: Date.now(),
          },
        },
      });

      const sendRes = await rpcReq(ws, "sessions.send", {
        key: "agent:main:dashboard:test-abort",
        message: "hello",
        idempotencyKey: "idem-sessions-abort-1",
        timeoutMs: 30_000,
      });
      expect(sendRes.ok).toBe(true);

      const cancelledEventP = onceMessage(
        ws,
        (o) => {
          const data =
            o.payload?.data && typeof o.payload.data === "object"
              ? (o.payload.data as Record<string, unknown>)
              : {};
          return (
            o.type === "event" &&
            o.event === "agent" &&
            o.payload?.runId === "idem-sessions-abort-1" &&
            o.payload?.stream === "lifecycle" &&
            data.phase === "end" &&
            data.stopReason === "rpc"
          );
        },
        8000,
      );
      void cancelledEventP.catch(() => undefined);

      const abortRes = await rpcReq(ws, "sessions.abort", {
        key: "agent:main:dashboard:test-abort",
        runId: "idem-sessions-abort-1",
      });
      expect(abortRes.ok).toBe(true);
      expect(["aborted", "no-active-run"]).toContain(abortRes.payload?.status);
      if (abortRes.payload?.status === "aborted") {
        expect(abortRes.payload?.abortedRunId).toBe("idem-sessions-abort-1");
        const cancelledEvent = await cancelledEventP;
        expectRecordFields(cancelledEvent.payload?.data, {
          phase: "end",
          status: "cancelled",
          aborted: true,
          stopReason: "rpc",
        });
        const waitRes = await rpcReq(ws, "agent.wait", {
          runId: "idem-sessions-abort-1",
          timeoutMs: 0,
        });
        expect(waitRes.ok).toBe(true);
        expectRecordFields(waitRes.payload, {
          runId: "idem-sessions-abort-1",
          status: "error",
          stopReason: "rpc",
        });
      } else {
        expect(abortRes.payload?.abortedRunId).toBeNull();
      }
      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    } finally {
      testState.sessionStorePath = undefined;
      await removeTempDir(dir);
    }
  });

  test("sessions.abort resolves active runs by runId without a caller session key", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-abort-runid-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    try {
      await writeSessionStore({
        entries: {
          "agent:main:dashboard:test-abort-runid": {
            sessionId: "sess-dashboard-abort-runid",
            updatedAt: Date.now(),
          },
        },
      });

      const sendRes = await rpcReq(ws, "sessions.send", {
        key: "agent:main:dashboard:test-abort-runid",
        message: "hello",
        idempotencyKey: "idem-sessions-abort-runid-1",
        timeoutMs: 30_000,
      });
      expect(sendRes.ok).toBe(true);

      const abortRes = await rpcReq(ws, "sessions.abort", {
        runId: "idem-sessions-abort-runid-1",
      });
      expect(abortRes.ok).toBe(true);
      expect(["aborted", "no-active-run"]).toContain(abortRes.payload?.status);
      if (abortRes.payload?.status === "aborted") {
        expect(abortRes.payload?.abortedRunId).toBe("idem-sessions-abort-runid-1");
      }
      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    } finally {
      testState.sessionStorePath = undefined;
      await removeTempDir(dir);
    }
  });

  test("sanitizes inbound chat.send message text and rejects null bytes", async () => {
    const nullByteRes = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "hello\u0000world",
      idempotencyKey: "idem-null-byte-1",
    });
    expect(nullByteRes.ok).toBe(false);
    expect((nullByteRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
      /null bytes/i,
    );

    const sanitizedRes = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "Cafe\u0301\u0007\tline",
      idempotencyKey: "idem-sanitized-1",
    });
    expect(sanitizedRes.ok).toBe(true);
    await waitForAgentRunDrained("idem-sanitized-1");
  });

  test("handles chat send and history flows", async () => {
    const tempDirs: string[] = [];
    let webchatWs: WebSocket | undefined;
    agentDiscoveryMock.enabled = true;
    agentDiscoveryMock.models = [
      { id: "claude-opus-4-6", provider: "anthropic", input: ["text", "image"] },
    ];

    try {
      webchatWs = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      trackConnectChallengeNonce(webchatWs);
      await new Promise<void>((resolve) => {
        webchatWs?.once("open", resolve);
      });
      await connectOk(webchatWs, {
        client: {
          id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          version: "dev",
          platform: "web",
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        },
      });

      const webchatRes = await rpcReq(webchatWs, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-webchat-1",
      });
      expect(webchatRes.ok).toBe(true);
      await waitForAgentRunDrained("idem-webchat-1");

      webchatWs.close();
      webchatWs = undefined;

      testState.agentConfig = { timeoutSeconds: 123 };
      const timeoutRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-timeout-1",
      });
      expect(timeoutRes.ok).toBe(true);
      expect(timeoutRes.payload?.runId).toBe("idem-timeout-1");
      await waitForAgentRunDrained("idem-timeout-1");
      testState.agentConfig = undefined;

      const sessionRes = await rpcReq(ws, "chat.send", {
        sessionKey: "agent:main:subagent:abc",
        message: "hello",
        idempotencyKey: "idem-session-key-1",
      });
      expect(sessionRes.ok).toBe(true);
      expect(sessionRes.payload?.runId).toBe("idem-session-key-1");
      await waitForAgentRunDrained("idem-session-key-1");

      const sendPolicyDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(sendPolicyDir);
      testState.sessionStorePath = path.join(sendPolicyDir, "sessions.json");
      testState.sessionConfig = {
        sendPolicy: {
          default: "allow",
          rules: [
            {
              action: "deny",
              match: { channel: "discord", chatType: "group" },
            },
          ],
        },
      };

      await writeSessionStore({
        entries: {
          "discord:group:dev": {
            sessionId: "sess-discord",
            updatedAt: Date.now(),
            chatType: "group",
            channel: "discord",
          },
        },
      });

      const blockedRes = await rpcReq(ws, "chat.send", {
        sessionKey: "discord:group:dev",
        message: "hello",
        idempotencyKey: "idem-1",
      });
      expect(blockedRes.ok).toBe(false);
      expect((blockedRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
        /send blocked/i,
      );

      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;

      const agentBlockedDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(agentBlockedDir);
      testState.sessionStorePath = path.join(agentBlockedDir, "sessions.json");
      testState.sessionConfig = {
        sendPolicy: {
          default: "allow",
          rules: [{ action: "deny", match: { keyPrefix: "cron:" } }],
        },
      };

      await writeSessionStore({
        entries: {
          "cron:job-1": {
            sessionId: "sess-cron",
            updatedAt: Date.now(),
          },
        },
      });

      vi.mocked(agentCommandMock).mockClear();
      const agentAllowedRes = await rpcReq(ws, "agent", {
        sessionKey: "cron:job-1",
        message: "hi",
        idempotencyKey: "idem-2",
      });
      expect(agentAllowedRes.ok).toBe(true);
      expect(agentAllowedRes.payload?.status).toBe("accepted");
      expect(agentAllowedRes.payload?.runId).toBe("idem-2");
      await waitForFast(() => expect(agentCommandMock).toHaveBeenCalled());
      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;

      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
      // The discovered model advertises image input, so the real capability
      // resolver must keep these attachments inline; offloading here would mean
      // the catalog lookup silently failed and returned false. Capability
      // resolution happens before dispatch, so capturing dispatch args observes
      // the real resolver's decision.
      const inlineDispatches: { runId?: string; images?: unknown[] }[] = [];
      const captureInlineDispatch = async (args: unknown) => {
        const replyOptions = (args as { replyOptions?: { runId?: string; images?: unknown[] } })
          .replyOptions;
        inlineDispatches.push({ runId: replyOptions?.runId, images: replyOptions?.images });
        return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
      };

      dispatchInboundMessageMock.mockImplementationOnce(captureInlineDispatch);
      const imgRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "see image",
        idempotencyKey: "idem-img",
        attachments: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: pngB64,
            },
          },
        ],
      });
      expect(imgRes.ok).toBe(true);
      expectStringRunId(imgRes.payload);
      await waitForAgentRunDrained("idem-img");
      expect(inlineDispatches).toEqual([{ runId: "idem-img", images: [expect.anything()] }]);
      dispatchInboundMessageMock.mockImplementationOnce(captureInlineDispatch);
      const imgOnlyRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "",
        idempotencyKey: "idem-img-only",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "dot.png",
            content: `data:image/png;base64,${pngB64}`,
          },
        ],
      });
      expect(imgOnlyRes.ok).toBe(true);
      expectStringRunId(imgOnlyRes.payload);
      await waitForAgentRunDrained("idem-img-only");
      expect(inlineDispatches).toEqual([
        { runId: "idem-img", images: [expect.anything()] },
        { runId: "idem-img-only", images: [expect.anything()] },
      ]);

      const historyDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(historyDir);
      testState.sessionStorePath = path.join(historyDir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      const lines: string[] = [];
      for (let i = 0; i < 201; i += 1) {
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
      await replaceMainTranscriptLines(lines);

      const defaultRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(defaultRes.ok).toBe(true);
      const defaultMsgs = defaultRes.payload?.messages ?? [];
      expect(defaultMsgs.length).toBe(200);
      expect(extractFirstTextBlock(defaultMsgs[0])).toBe("m1");
    } finally {
      Object.assign(agentDiscoveryMock, { enabled: false, models: [] });
      testState.agentConfig = undefined;
      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;
      if (webchatWs) {
        webchatWs.close();
      }
      await Promise.all(tempDirs.map((dir) => removeTempDir(dir)));
    }
  });

  test("chat.send accepts the backing session id returned by chat.history", async () => {
    await withMainSessionStore(async () => {
      const historyRes = await rpcReq<{ sessionId?: string }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(historyRes.ok).toBe(true);
      const sessionId = historyRes.payload?.sessionId;
      expect(sessionId).toBe("sess-main");

      const runId = "idem-chat-send-history-session-id";
      const sendRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        sessionId,
        message: "/context list",
        idempotencyKey: runId,
      });
      expect(sendRes.ok).toBe(true);
      expect(sendRes.payload?.status).toBe("started");

      await waitForAgentRunOk(runId);
    });
  });

  test("chat.history applies the reset kept-tail cut and preserves its marker", async () => {
    await withMainSessionStore(async () => {
      const storePath = testState.sessionStorePath;
      if (!storePath) {
        throw new Error("session store path was not initialized");
      }
      await replaceTranscriptEvents(
        { agentId: "main", sessionId: "sess-main", sessionKey: "main", storePath },
        [
          { type: "message", id: "old", parentId: null, message: { role: "user", content: "old" } },
          {
            type: "message",
            id: "kept-user",
            parentId: "old",
            message: { role: "user", content: "kept question" },
          },
          {
            type: "message",
            id: "kept-tool",
            parentId: "kept-user",
            message: { role: "toolResult", content: "hidden tool" },
          },
          {
            type: "message",
            id: "kept-assistant",
            parentId: "kept-tool",
            message: { role: "assistant", content: "kept answer" },
          },
          {
            type: "reset",
            id: "reset-boundary",
            parentId: "kept-assistant",
            timestamp: "2026-07-22T00:00:00.000Z",
            reason: "new",
            firstKeptEntryId: "kept-user",
          },
          {
            type: "message",
            id: "post-reset",
            parentId: "reset-boundary",
            message: { role: "user", content: "new turn" },
          },
        ],
      );

      const history = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });

      expect(history.ok).toBe(true);
      expect(collectHistoryTextValues(history.payload?.messages ?? [])).toEqual([
        "kept question",
        "kept answer",
        "Reset",
        "new turn",
      ]);
    });
  });

  test("marks a running webchat session failed when restart drain overlaps dispatch rejection", async () => {
    await withMainSessionStore(async (dir) => {
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            sessionFile: path.join(dir, "sess-main.jsonl"),
            updatedAt: 1_000,
            status: "running",
            startedAt: 900,
          },
        },
      });
      const subscribeRes = await rpcReq(ws, "sessions.subscribe", {});
      expect(subscribeRes.ok).toBe(true);
      const rejectDispatch = createDeferred();
      const releasePersistence = createDeferred();
      let dispatchStarted = false;
      const persistenceEntered = createDeferred();
      const persistLifecycleEvent = sessionLifecycleState.persistGatewaySessionLifecycleEvent;
      const persistSpy = vi
        .spyOn(sessionLifecycleState, "persistGatewaySessionLifecycleEvent")
        .mockImplementation(async (params) => {
          if (params.event.runId !== "idem-dispatch-error-1") {
            await persistLifecycleEvent(params);
            return;
          }
          persistenceEntered.resolve();
          await releasePersistence.promise;
          await persistLifecycleEvent(params);
        });
      const messagePromises: Promise<unknown>[] = [];
      const sessionChanged = await (async () => {
        try {
          dispatchInboundMessageMock.mockImplementationOnce(async () => {
            dispatchStarted = true;
            await rejectDispatch.promise;
            throw new Error("provider rejected request");
          });
          const errorPromise = onceMessage(
            ws,
            (o) =>
              o.type === "event" &&
              o.event === "chat" &&
              o.payload?.state === "error" &&
              o.payload?.runId === "idem-dispatch-error-1",
            8_000,
          );
          messagePromises.push(errorPromise);
          const sessionChangedPromise = onceMessage(
            ws,
            (o) =>
              o.type === "event" &&
              o.event === "sessions.changed" &&
              o.payload?.reason === "chat.dispatch-error" &&
              o.payload?.sessionKey === "agent:main:main",
            8_000,
          );
          messagePromises.push(sessionChangedPromise);
          const res = await rpcReq(ws, "chat.send", {
            sessionKey: "main",
            message: "run: pwd",
            idempotencyKey: "idem-dispatch-error-1",
          });
          expect(res.ok).toBe(true);
          await waitForFast(() => {
            expect(dispatchStarted).toBe(true);
          });
          markGatewayRestartDraining();
          rejectDispatch.resolve();
          await errorPromise;
          await persistenceEntered.promise;
          const restartInspectors = {
            getQueueSize: () => 0,
            getPendingReplies: () => 0,
            getEmbeddedRuns: () => 0,
            getCronRuns: () => 0,
            getBackgroundExecSessions: () => 0,
            getActiveTasks: () => 0,
            getTaskBlockers: () => [],
          };
          expect(createSafeGatewayRestartPreflight(restartInspectors)).toMatchObject({
            safe: false,
            counts: { rootRequests: 1 },
          });
          releasePersistence.resolve();
          const changed = await sessionChangedPromise;
          await waitForFast(() => {
            expect(createSafeGatewayRestartPreflight(restartInspectors).safe).toBe(true);
          });
          return changed;
        } finally {
          rejectDispatch.resolve();
          releasePersistence.resolve();
          await Promise.allSettled(messagePromises);
          persistSpy.mockRestore();
          resetGatewayWorkAdmission();
        }
      })();
      expectRecordFields(sessionChanged.payload, {
        sessionId: "sess-main",
        status: "failed",
        lastRunId: "idem-dispatch-error-1",
        hasActiveRun: false,
      });

      const sessionsRes = await rpcReq<{ sessions?: unknown[] }>(ws, "sessions.list", {});
      expect(sessionsRes.ok).toBe(true);
      const session = sessionsRes.payload?.sessions?.find(
        (row): row is Record<string, unknown> =>
          Boolean(row) &&
          typeof row === "object" &&
          (row as { key?: unknown }).key === "agent:main:main",
      );
      const actualSession = expectRecordFields(session, {
        status: "failed",
        lastRunId: "idem-dispatch-error-1",
        hasActiveRun: false,
      });
      expect(typeof actualSession.startedAt).toBe("number");
      expect(typeof actualSession.endedAt).toBe("number");
      expect(typeof actualSession.runtimeMs).toBe("number");
    });
  });

  test.each([
    {
      name: "structured context-overflow code",
      fields: {
        errorCode: "context_overflow",
        errorMessage: "private upstream body: 203557 tokens sent",
      },
      overflow: true,
    },
    {
      name: "provider request-too-large code",
      fields: {
        errorCode: "request_too_large",
        errorMessage: "private upstream body: 196607 tokens sent",
      },
      overflow: true,
    },
    {
      name: "provider context-window message",
      fields: {
        errorType: "invalid_request_error",
        errorMessage: "Request size exceeds model context window: 203557 tokens",
      },
      overflow: true,
    },
    {
      name: "embedded context-overflow message",
      fields: { errorMessage: "Unhandled stop reason: context_overflow" },
      overflow: true,
    },
    {
      name: "token-per-minute rate limit",
      fields: {
        errorCode: "rate_limit_exceeded",
        errorMessage: "413 request too large: 203557 tokens per minute (TPM)",
      },
      overflow: false,
    },
    {
      name: "private upstream failure",
      fields: { errorMessage: "private upstream at secret.internal.example failed" },
      overflow: false,
    },
  ])(
    "chat.history safely displays $name over authenticated WebSocket",
    async ({ fields, overflow }) => {
      const historyMessages = await loadChatHistoryWithMessages([
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          ...fields,
          timestamp: 1,
        },
      ]);

      expect(collectHistoryTextValues(historyMessages)).toEqual([
        overflow
          ? "Context overflow: this conversation is too large for the model. Try /compact, use /new to start a fresh session, or retry the command with a tighter output limit."
          : "The agent run failed before producing a reply.",
      ]);
      const wirePayload = JSON.stringify(historyMessages);
      expect(wirePayload).not.toContain("203557");
      expect(wirePayload).not.toContain("196607");
      expect(wirePayload).not.toContain("secret.internal.example");
      expect(historyMessages[0]).not.toHaveProperty("errorCode");
      expect(historyMessages[0]).not.toHaveProperty("errorType");
      expect(historyMessages[0]).not.toHaveProperty("errorMessage");
    },
  );

  test("chat.history hides assistant NO_REPLY-only entries", async () => {
    const historyMessages = await loadChatHistoryWithMessages(buildNoReplyHistoryFixture());
    const textValues = collectHistoryTextValues(historyMessages);
    // The NO_REPLY assistant message (content block) should be dropped.
    // The assistant with text="real text field reply" + content="NO_REPLY" stays
    // because entry.text takes precedence over entry.content for the silent check.
    // The user message with NO_REPLY text is preserved (only assistant filtered).
    expect(textValues).toEqual(["hello", "real reply", "real text field reply", "NO_REPLY"]);
  });

  test("chat.history hides assistant control replies in Responses output blocks", async () => {
    const historyMessages = await loadChatHistoryWithMessages([
      {
        role: "assistant",
        content: [{ type: "output_text", text: "NO_REPLY" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "visible response" }],
        timestamp: 2,
      },
      {
        role: "assistant",
        content: [{ type: "input_text", text: "NO_REPLY" }],
        timestamp: 3,
      },
      {
        role: "assistant",
        content: [{ type: "input_text", text: "visible assistant input" }],
        timestamp: 4,
      },
    ]);

    expect(collectHistoryTextValues(historyMessages)).toEqual([
      "visible response",
      "visible assistant input",
    ]);
  });

  test("chat.history mirrors current-session message tool sends before NO_REPLY", async () => {
    const replyText = "Here, love. Eva, not Evo.";
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryText("user", "Evo, you there?", 1),
      createGatewayHistoryMessageToolCall(
        "call-message-1",
        { action: "send", message: replyText },
        2,
      ),
      createGatewayHistoryMessageToolResult(
        "call-message-1",
        { ok: true, messageId: "24268", chatId: "8455538490" },
        3,
      ),
      createGatewayHistoryText("assistant", "NO_REPLY", 4),
    ]);

    expect(collectHistoryTextValues(historyMessages)).toEqual(["Evo, you there?", replyText]);
    expect(historyMessages.some(hasGatewayHistoryMessageToolMirror)).toBe(true);
  });

  test.each([
    {
      name: "chat.history mirrors message success encoded in a result text block",
      content: [{ type: "text", text: JSON.stringify({ ok: true, messageId: "text-result" }) }],
      visible: true,
    },
    {
      name: "chat.history mirrors message success encoded in a result content block",
      content: [
        { type: "message", content: JSON.stringify({ ok: true, messageId: "content-result" }) },
      ],
      visible: true,
    },
    {
      name: "chat.history hides suppressed delivery encoded in a result text block",
      content: [{ type: "text", text: JSON.stringify({ ok: true, deliveryStatus: "suppressed" }) }],
      visible: false,
    },
    {
      name: "chat.history hides dry-run delivery encoded in a result content block",
      content: [{ type: "message", content: JSON.stringify({ ok: true, dryRun: true }) }],
      visible: false,
    },
  ])("$name", async ({ content, visible }) => {
    const replyText = "Nested message-tool reply.";
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryMessageToolCall(
        "call-message-nested-result",
        { action: "send", message: replyText },
        1,
      ),
      createGatewayHistoryMessageToolResult("call-message-nested-result", content, 2),
      createGatewayHistoryText("assistant", "NO_REPLY", 3),
    ]);

    const resultText = content.flatMap((block) => ("text" in block ? [block.text] : []));
    expect(collectHistoryTextValues(historyMessages)).toEqual([
      ...resultText,
      ...(visible ? [replyText] : []),
    ]);
    expect(historyMessages.some(hasGatewayHistoryMessageToolMirror)).toBe(visible);
  });

  test("chat.history marks message-tool replies held for internal source delivery", async () => {
    const replyText = "Forward this source reply.";
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryMessageToolCall(
        "call-message-internal-source",
        { action: "send", message: replyText },
        1,
      ),
      {
        role: "toolResult",
        toolName: "message",
        toolCallId: "call-message-internal-source",
        content: [{ type: "text", text: "Sent visible reply via internal-ui." }],
        details: {
          status: "ok",
          deliveryStatus: "sent",
          sourceReplySink: "internal-ui",
        },
        timestamp: 2,
      },
      createGatewayHistoryText("assistant", "NO_REPLY", 3),
    ]);

    const visibleAssistantMessages = historyMessages.filter((message) => {
      if (!message || typeof message !== "object") {
        return false;
      }
      const entry = message as { role?: unknown };
      return entry.role === "assistant" && extractFirstTextBlock(message) !== undefined;
    });
    expect(visibleAssistantMessages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: replyText }],
        openclawMessageToolMirror: {
          toolName: "message",
          toolCallId: "call-message-internal-source",
          sourceReplySink: "internal-ui",
          sourceMessageSeq: 1,
        },
      }),
    ]);
  });

  test("chat.history hides raw delivery-mirror rows but keeps message-tool mirrors", async () => {
    const replyText = "One visible send.";
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryText("user", "send once", 1),
      createGatewayHistoryMessageToolCall(
        "call-message-transcript-only",
        { action: "send", message: replyText },
        2,
      ),
      createGatewayHistoryMessageToolResult(
        "call-message-transcript-only",
        { ok: true, messageId: "24271", chatId: "current-run" },
        3,
      ),
      createGatewayHistoryDeliveryMirror(replyText, 4),
      createGatewayHistoryText("assistant", "NO_REPLY", 5),
    ]);

    expect(collectHistoryTextValues(historyMessages)).toEqual(["send once", replyText]);
    expect(historyMessages.some(hasGatewayHistoryMessageToolMirror)).toBe(true);
    expect(historyMessages).not.toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "delivery-mirror" }),
    );
  });

  test("chat.history carries managed images from a message-tool delivery mirror", async () => {
    const replyText = "Two visible attachments.";
    const imageBlocks = ["first", "second"].map((name) => ({
      type: "image",
      artifactId: `artifact_managed_image_${name}`,
      url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${name}/full`,
      openUrl: `/api/chat/media/outgoing/agent%3Amain%3Amain/${name}/full`,
      alt: `${name}.png`,
      mimeType: "image/png",
    }));
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryMessageToolCall(
        "call-message-images",
        {
          action: "send",
          message: replyText,
          mediaUrls: ["/tmp/first.png", "/tmp/second.png"],
        },
        1,
      ),
      {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: [{ type: "text", text: replyText }, ...imageBlocks],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolName: "message",
        toolCallId: "call-message-images",
        content: [{ type: "text", text: "Sent visible reply via internal-ui." }],
        details: {
          status: "ok",
          deliveryStatus: "sent",
          sourceReplySink: "internal-ui",
        },
        timestamp: 3,
      },
    ]);

    expect(historyMessages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: replyText }, ...imageBlocks],
        openclawMessageToolMirror: expect.objectContaining({
          toolCallId: "call-message-images",
          sourceReplySink: "internal-ui",
        }),
      }),
    );
    expect(historyMessages).not.toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "delivery-mirror" }),
    );
  });

  test("chat.history binds equal-text delivery mirrors to their message tool calls", async () => {
    const replyText = "Repeated attachment caption.";
    const imageBlocks = ["first", "second"].map((name) => ({
      type: "image",
      artifactId: `artifact_managed_image_${name}`,
      url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${name}/full`,
      openUrl: `/api/chat/media/outgoing/agent%3Amain%3Amain/${name}/full`,
      alt: `${name}.png`,
      mimeType: "image/png",
    }));
    const historyMessages = await loadChatHistoryWithMessages([
      {
        role: "assistant",
        content: ["first", "second"].map((name) => ({
          type: "toolCall",
          id: `call-message-${name}`,
          name: "message",
          arguments: {
            action: "send",
            message: replyText,
            media: `/tmp/${name}.png`,
          },
        })),
        timestamp: 1,
      },
      ...["first", "second"].map((name, index) => ({
        role: "toolResult",
        toolName: "message",
        toolCallId: `call-message-${name}`,
        content: [{ type: "text", text: "Sent visible reply via internal-ui." }],
        details: {
          status: "ok",
          deliveryStatus: "sent",
          sourceReplySink: "internal-ui",
        },
        timestamp: index + 2,
      })),
      ...["first", "second"].map((name, index) => ({
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: [{ type: "text", text: replyText }, imageBlocks[index]],
        openclawDeliveryMirror: {
          kind: "message-tool-source-reply",
          toolCallId: `call-message-${name}`,
        },
        timestamp: index + 4,
      })),
    ]);

    const mirrors = historyMessages.filter(hasGatewayHistoryMessageToolMirror);
    expect(mirrors).toHaveLength(2);
    expect(mirrors).toEqual([
      expect.objectContaining({
        content: [{ type: "text", text: replyText }, imageBlocks[0]],
        openclawMessageToolMirror: expect.objectContaining({
          toolCallId: "call-message-first",
        }),
      }),
      expect.objectContaining({
        content: [{ type: "text", text: replyText }, imageBlocks[1]],
        openclawMessageToolMirror: expect.objectContaining({
          toolCallId: "call-message-second",
        }),
      }),
    ]);
    expect(historyMessages).not.toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "delivery-mirror" }),
    );
  });

  test("chat.history does not caption-match a populated unmatched delivery ID", async () => {
    const replyText = "Repeated attachment caption.";
    const wrongImage = {
      type: "image",
      artifactId: "artifact_managed_image_wrong",
      url: "/api/chat/media/outgoing/agent%3Amain%3Amain/wrong/full",
      openUrl: "/api/chat/media/outgoing/agent%3Amain%3Amain/wrong/full",
      alt: "wrong.png",
      mimeType: "image/png",
    };
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryMessageToolCall(
        "call-message-expected",
        { action: "send", message: replyText, media: "/tmp/expected.png" },
        1,
      ),
      createGatewayHistoryMessageToolResult(
        "call-message-expected",
        { ok: true, messageId: "24276", chatId: "current-run" },
        2,
      ),
      {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: [{ type: "text", text: replyText }, wrongImage],
        openclawDeliveryMirror: {
          kind: "message-tool-source-reply",
          toolCallId: "call-message-other",
        },
        timestamp: 3,
      },
      createGatewayHistoryText("assistant", "NO_REPLY", 4),
    ]);

    expect(historyMessages).toContainEqual(
      expect.objectContaining({
        content: [{ type: "text", text: replyText }],
        openclawMessageToolMirror: expect.objectContaining({
          toolCallId: "call-message-expected",
        }),
      }),
    );
    expect(historyMessages).toContainEqual(
      expect.objectContaining({
        provider: "openclaw",
        model: "delivery-mirror",
        content: [{ type: "text", text: replyText }, wrongImage],
      }),
    );
  });

  test("chat.history keeps message-tool mirrors before silent completion rows", async () => {
    const replyText = "Visible before completion.";
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryMessageToolCall(
        "call-message-before-completion",
        { action: "send", message: replyText },
        1,
      ),
      createGatewayHistoryMessageToolResult(
        "call-message-before-completion",
        { ok: true, messageId: "24272", chatId: "current-run" },
        2,
      ),
      createGatewayHistoryDeliveryMirror(replyText, 3),
    ]);

    expect(collectHistoryTextValues(historyMessages)).toEqual([replyText]);
    expect(historyMessages.some(hasGatewayHistoryMessageToolMirror)).toBe(true);
    expect(historyMessages).not.toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "delivery-mirror" }),
    );
  });

  test("chat.history hides delivery mirrors that precede successful tool results", async () => {
    const replyText = "Visible after result.";
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryMessageToolCall(
        "call-message-before-result",
        { action: "send", message: replyText },
        1,
      ),
      createGatewayHistoryDeliveryMirror(replyText, 2),
      createGatewayHistoryMessageToolResult(
        "call-message-before-result",
        { ok: true, messageId: "24273", chatId: "current-run" },
        3,
      ),
    ]);

    expect(collectHistoryTextValues(historyMessages)).toEqual([replyText]);
    expect(historyMessages.some(hasGatewayHistoryMessageToolMirror)).toBe(true);
    expect(historyMessages).not.toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "delivery-mirror" }),
    );
  });

  test("chat.history preserves other pending message-tool mirrors while deduping one send", async () => {
    const firstText = "First visible send.";
    const secondText = "Second visible send.";
    const historyMessages = await loadChatHistoryWithMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-message-first",
            name: "message",
            arguments: {
              action: "send",
              message: firstText,
            },
          },
          {
            type: "toolCall",
            id: "call-message-second",
            name: "message",
            arguments: {
              action: "send",
              message: secondText,
            },
          },
        ],
        timestamp: 1,
      },
      createGatewayHistoryMessageToolResult(
        "call-message-first",
        { ok: true, messageId: "24274", chatId: "current-run" },
        2,
      ),
      createGatewayHistoryDeliveryMirror(firstText, 3),
      createGatewayHistoryMessageToolResult(
        "call-message-second",
        { ok: true, messageId: "24275", chatId: "current-run" },
        4,
      ),
      createGatewayHistoryDeliveryMirror(secondText, 5),
    ]);

    expect(collectHistoryTextValues(historyMessages)).toEqual([firstText, secondText]);
    expect(historyMessages.filter(hasGatewayHistoryMessageToolMirror)).toHaveLength(2);
    expect(historyMessages).not.toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "delivery-mirror" }),
    );
  });

  test("chat.history keeps standalone delivery-mirror rows", async () => {
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryDeliveryMirror("standalone delivered reply", 1),
    ]);

    expect(collectHistoryTextValues(historyMessages)).toEqual(["standalone delivered reply"]);
  });

  test("chat.history mirrors current-session message tool sends with channel hints", async () => {
    const replyText = "Still the current chat.";
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryText("user", "reply here", 1),
      createGatewayHistoryMessageToolCall(
        "call-message-channel-hint",
        { action: "send", channel: "telegram", message: replyText },
        2,
      ),
      createGatewayHistoryMessageToolResult(
        "call-message-channel-hint",
        { ok: true, messageId: "24270", chatId: "current-run" },
        3,
      ),
      createGatewayHistoryText("assistant", "NO_REPLY", 4),
    ]);

    expect(collectHistoryTextValues(historyMessages)).toEqual(["reply here", replyText]);
    expect(historyMessages.some(hasGatewayHistoryMessageToolMirror)).toBe(true);
  });

  test("chat.history does not mirror explicitly routed message tool sends", async () => {
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryText("user", "send that elsewhere", 1),
      createGatewayHistoryMessageToolCall(
        "call-message-remote",
        { action: "send", to: "8455538490", message: "Remote-only reply" },
        2,
      ),
      createGatewayHistoryMessageToolResult(
        "call-message-remote",
        { ok: true, messageId: "24269", chatId: "8455538490" },
        3,
      ),
      createGatewayHistoryText("assistant", "NO_REPLY", 4),
    ]);

    expect(collectHistoryTextValues(historyMessages)).toEqual(["send that elsewhere"]);
    expect(historyMessages.some(hasGatewayHistoryMessageToolMirror)).toBe(false);
  });

  test("chat.history keeps confirmed current-source sends before a later final", async () => {
    const sourceReply = "Visible reply delivered to Telegram.";
    const laterFinal = "A later run produced this different final.";
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryText("user", "reply in this Telegram chat", 1),
      createGatewayHistoryMessageToolCall(
        "call-message-current-source",
        {
          action: "send",
          channel: "telegram",
          target: "8455538490",
          message: sourceReply,
        },
        2,
      ),
      {
        role: "toolResult",
        toolName: "message",
        toolCallId: "call-message-current-source",
        content: { ok: true, messageId: "24269", chatId: "8455538490" },
        details: {
          ok: true,
          messageId: "24269",
          chatId: "8455538490",
          sourceReplyRoute: "current-source",
        },
        timestamp: 3,
      },
      createGatewayHistoryText("assistant", "NO_REPLY", 4),
      createGatewayHistoryText("user", "continue", 5),
      createGatewayHistoryText("assistant", laterFinal, 6),
    ]);

    expect(collectHistoryTextValues(historyMessages)).toEqual([
      "reply in this Telegram chat",
      sourceReply,
      "continue",
      laterFinal,
    ]);
    expect(historyMessages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: sourceReply }],
        openclawMessageToolMirror: expect.objectContaining({
          toolCallId: "call-message-current-source",
        }),
      }),
    );
  });

  test("chat.history does not mirror suppressed current-source sends", async () => {
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryText("user", "reply here", 1),
      createGatewayHistoryMessageToolCall(
        "call-message-suppressed-current-source",
        { action: "send", target: "8455538490", message: "Must not appear" },
        2,
      ),
      {
        role: "toolResult",
        toolName: "message",
        toolCallId: "call-message-suppressed-current-source",
        content: { ok: true, messageId: "suppressed" },
        details: {
          ok: true,
          messageId: "suppressed",
          deliveryStatus: "suppressed",
          sourceReplyRoute: "current-source",
        },
        timestamp: 3,
      },
      createGatewayHistoryText("assistant", "NO_REPLY", 4),
    ]);

    expect(collectHistoryTextValues(historyMessages)).toEqual(["reply here"]);
  });

  test("chat.history does not mirror message tool sends from unmatched results", async () => {
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryText("user", "reply here", 1),
      createGatewayHistoryMessageToolCall(
        "call-message-expected",
        { action: "send", message: "Should wait for matching result." },
        2,
      ),
      {
        role: "toolResult",
        content: { ok: true, messageId: "wrong-result" },
        timestamp: 3,
      },
      createGatewayHistoryText("assistant", "NO_REPLY", 4),
    ]);

    expect(collectHistoryTextValues(historyMessages)).toEqual(["reply here"]);
    expect(historyMessages.some(hasGatewayHistoryMessageToolMirror)).toBe(false);
  });

  test("chat.history does not mirror dry-run message tool sends", async () => {
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryText("user", "preview that", 1),
      createGatewayHistoryMessageToolCall(
        "call-message-dry-run",
        { action: "send", dryRun: true, message: "Preview-only reply" },
        2,
      ),
      createGatewayHistoryMessageToolResult(
        "call-message-dry-run",
        { ok: true, dryRun: true, deliveryStatus: "dry_run" },
        3,
      ),
      createGatewayHistoryText("assistant", "NO_REPLY", 4),
    ]);

    expect(collectHistoryTextValues(historyMessages)).toEqual(["preview that"]);
    expect(historyMessages.some(hasGatewayHistoryMessageToolMirror)).toBe(false);
  });

  test("chat.history hides commentary-only assistant entries", async () => {
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryText("user", "hello", 1),
      {
        role: "assistant",
        phase: "commentary",
        content: [{ type: "text", text: "thinking like caveman" }],
        timestamp: 2,
      },
      createGatewayHistoryText("assistant", "real reply", 3),
    ]);

    expect(collectHistoryTextValues(historyMessages)).toEqual(["hello", "real reply"]);
  });

  test("chat.history hides assistant announce/reply skip-only entries", async () => {
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryText("assistant", "ANNOUNCE_SKIP", 1),
      createGatewayHistoryText("assistant", "REPLY_SKIP", 2),
      {
        role: "assistant",
        text: "real text field reply",
        content: "ANNOUNCE_SKIP",
        timestamp: 3,
      },
      createGatewayHistoryText("assistant", "real reply", 4),
    ]);
    const roleAndText = historyMessages
      .map((message) => {
        const role =
          message &&
          typeof message === "object" &&
          typeof (message as { role?: unknown }).role === "string"
            ? (message as { role: string }).role
            : "unknown";
        const text =
          message &&
          typeof message === "object" &&
          typeof (message as { text?: unknown }).text === "string"
            ? (message as { text: string }).text
            : (extractFirstTextBlock(message) ?? "");
        return `${role}:${text}`;
      })
      .filter((entry) => entry !== "unknown:");

    expect(roleAndText).toEqual(["assistant:real text field reply", "assistant:real reply"]);
  });
  test("preserves split fenced-code indentation in chat.send events and history", async () => {
    await withMainSessionStore(async () => {
      const expected = "```yaml\nroot:\n  nested:\n    value: true\n```";
      dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
        const [params] = args as [
          {
            dispatcher: {
              sendFinalReply: (payload: { text: string }) => boolean;
              markComplete: () => void;
              waitForIdle: () => Promise<void>;
              getQueuedCounts: () => { final: number; block: number; tool: number };
            };
          },
        ];
        params.dispatcher.sendFinalReply({ text: "```yaml\nroot:\n" });
        params.dispatcher.sendFinalReply({ text: "  nested:\n    value: true\n```" });
        params.dispatcher.markComplete();
        await params.dispatcher.waitForIdle();
        return { queuedFinal: true, counts: params.dispatcher.getQueuedCounts() };
      });
      const finalPromise = onceMessage(
        ws,
        (event) =>
          event.type === "event" &&
          event.event === "chat" &&
          event.payload?.state === "final" &&
          event.payload?.runId === "idem-fenced-code-indentation",
        8_000,
      );

      const result = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "show the YAML",
        idempotencyKey: "idem-fenced-code-indentation",
      });
      expect(result.ok).toBe(true);
      const finalEvent = await finalPromise;
      expect(extractFirstTextBlock(finalEvent.payload?.message)).toBe(expected);

      const history = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(history.ok).toBe(true);
      expect(collectHistoryTextValues(history.payload?.messages ?? [])).toContain(expected);
    });
  });

  test("routes chat.send slash commands without agent runs", async () => {
    await withMainSessionStore(async () => {
      const spy = vi.mocked(agentCommandMock);
      const callsBefore = spy.mock.calls.length;
      const eventPromise = onceMessage(
        ws,
        (o) =>
          o.type === "event" &&
          o.event === "chat" &&
          o.payload?.state === "final" &&
          o.payload?.runId === "idem-command-1",
        8000,
      );
      const res = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "/context list",
        idempotencyKey: "idem-command-1",
      });
      expect(res.ok).toBe(true);
      await eventPromise;
      expect(spy.mock.calls.length).toBe(callsBefore);
    });
  });

  test("routes /btw replies through side-result events without transcript injection", async () => {
    await withMainSessionStore(async () => {
      await replaceMainTranscriptLines([
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: "main thread context" }],
            timestamp: Date.now(),
          },
        }),
      ]);
      dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
        const [params] = args as [
          {
            dispatcher: {
              sendFinalReply: (payload: { text: string; btw: { question: string } }) => boolean;
              markComplete: () => void;
              waitForIdle: () => Promise<void>;
              getQueuedCounts: () => { final: number; block: number; tool: number };
            };
          },
        ];
        params.dispatcher.sendFinalReply({
          text: "323",
          btw: { question: "what is 17 * 19?" },
        });
        params.dispatcher.markComplete();
        await params.dispatcher.waitForIdle();
        return {
          queuedFinal: true,
          counts: params.dispatcher.getQueuedCounts(),
        };
      });
      const sideResultPromise = onceMessage(
        ws,
        (o) =>
          o.type === "event" &&
          o.event === "chat.side_result" &&
          o.payload?.kind === "btw" &&
          o.payload?.runId === "idem-btw-1",
        8000,
      );
      const finalPromise = onceMessage(
        ws,
        (o) =>
          o.type === "event" &&
          o.event === "chat" &&
          o.payload?.state === "final" &&
          o.payload?.runId === "idem-btw-1",
        8000,
      );

      const res = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "/btw what is 17 * 19?",
        idempotencyKey: "idem-btw-1",
      });

      expect(res.ok).toBe(true);
      await waitForFast(() => {
        expect(dispatchInboundMessageMock).toHaveBeenCalled();
      });
      const sideResult = await sideResultPromise;
      const finalEvent = await finalPromise;
      expectRecordFields(sideResult.payload, {
        kind: "btw",
        runId: "idem-btw-1",
        sessionKey: "agent:main:main",
        question: "what is 17 * 19?",
        text: "323",
      });
      expectRecordFields(finalEvent.payload, {
        runId: "idem-btw-1",
        sessionKey: "agent:main:main",
        state: "final",
      });

      const historyRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(historyRes.ok).toBe(true);
      const historyTexts = collectHistoryTextValues(historyRes.payload?.messages ?? []);
      expect(historyTexts).toEqual(["main thread context"]);
    });
  });

  test("preserves split fenced-code indentation in /btw side-result events", async () => {
    await withMainSessionStore(async () => {
      dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
        const [params] = args as [
          {
            dispatcher: {
              sendBlockReply: (payload: { text: string; btw: { question: string } }) => boolean;
              markComplete: () => void;
              waitForIdle: () => Promise<void>;
              getQueuedCounts: () => { final: number; block: number; tool: number };
            };
          },
        ];
        params.dispatcher.sendBlockReply({
          text: "```yaml\nroot:\n",
          btw: { question: "show YAML" },
        });
        params.dispatcher.sendBlockReply({
          text: "  nested:\n    value: true\n```",
          btw: { question: "show YAML" },
        });
        params.dispatcher.markComplete();
        await params.dispatcher.waitForIdle();
        return { queuedFinal: false, counts: params.dispatcher.getQueuedCounts() };
      });
      const sideResultPromise = onceMessage(
        ws,
        (event) =>
          event.type === "event" &&
          event.event === "chat.side_result" &&
          event.payload?.kind === "btw" &&
          event.payload?.runId === "idem-btw-fenced-code-indentation",
        8_000,
      );

      const result = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "/btw show YAML",
        idempotencyKey: "idem-btw-fenced-code-indentation",
      });
      expect(result.ok).toBe(true);
      expectRecordFields((await sideResultPromise).payload, {
        kind: "btw",
        runId: "idem-btw-fenced-code-indentation",
        question: "show YAML",
        text: "```yaml\nroot:\n  nested:\n    value: true\n```",
      });
    });
  });

  test("routes block-streamed /btw replies through side-result events", async () => {
    await withMainSessionStore(async () => {
      await replaceMainTranscriptLines([
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "existing context" }],
            timestamp: Date.now(),
          },
        }),
      ]);
      dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
        const [params] = args as [
          {
            dispatcher: {
              sendBlockReply: (payload: { text: string; btw: { question: string } }) => boolean;
              markComplete: () => void;
              waitForIdle: () => Promise<void>;
              getQueuedCounts: () => { final: number; block: number; tool: number };
            };
          },
        ];
        params.dispatcher.sendBlockReply({
          text: "first chunk",
          btw: { question: "what changed?" },
        });
        params.dispatcher.sendBlockReply({
          text: "second chunk",
          btw: { question: "what changed?" },
        });
        params.dispatcher.markComplete();
        await params.dispatcher.waitForIdle();
        return {
          queuedFinal: false,
          counts: params.dispatcher.getQueuedCounts(),
        };
      });
      const sideResultPromise = onceMessage(
        ws,
        (o) =>
          o.type === "event" &&
          o.event === "chat.side_result" &&
          o.payload?.kind === "btw" &&
          o.payload?.runId === "idem-btw-block-1",
        8000,
      );

      const res = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "/btw what changed?",
        idempotencyKey: "idem-btw-block-1",
      });

      expect(res.ok).toBe(true);
      await waitForFast(() => {
        expect(dispatchInboundMessageMock).toHaveBeenCalled();
      });
      const sideResult = await sideResultPromise;
      expectRecordFields(sideResult.payload, {
        kind: "btw",
        runId: "idem-btw-block-1",
        question: "what changed?",
        text: "first chunk\n\nsecond chunk",
      });
    });
  });

  test("chat.history persists assistant image data URLs as managed image blocks", async () => {
    await withMainSessionStore(
      async (dir) => {
        const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
        setTestEnvValue("OPENCLAW_STATE_DIR", dir);
        const pngB64 =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
        dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
          const [params] = args as [
            {
              dispatcher: {
                sendFinalReply: (payload: { text?: string; mediaUrls?: string[] }) => boolean;
                markComplete: () => void;
                waitForIdle: () => Promise<void>;
                getQueuedCounts: () => { final: number; block: number; tool: number };
              };
            },
          ];
          params.dispatcher.sendFinalReply({
            text: "Image reply",
            mediaUrls: [`data:image/png;base64,${pngB64}`],
          });
          params.dispatcher.markComplete();
          await params.dispatcher.waitForIdle();
          return {
            queuedFinal: true,
            counts: params.dispatcher.getQueuedCounts(),
          };
        });

        try {
          const finalPromise = onceMessage(
            ws,
            (o) =>
              o.type === "event" &&
              o.event === "chat" &&
              o.payload?.state === "final" &&
              o.payload?.runId === "idem-managed-image-history",
            8000,
          );
          const res = await rpcReq(ws, "chat.send", {
            sessionKey: "main",
            message: "show me an image",
            idempotencyKey: "idem-managed-image-history",
          });

          expect(res.ok).toBe(true);
          expect(res.payload?.runId).toBe("idem-managed-image-history");
          await finalPromise;

          let assistantMessage: Record<string, unknown> | undefined;
          await waitForFast(
            async () => {
              const historyRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
                sessionKey: "main",
              });
              expect(historyRes.ok).toBe(true);
              const messages = historyRes.payload?.messages ?? [];
              assistantMessage = messages.find(
                (message): message is Record<string, unknown> =>
                  typeof message === "object" &&
                  message !== null &&
                  (message as { role?: unknown }).role === "assistant",
              );
              if (!assistantMessage) {
                throw new Error("Expected assistant history message");
              }
            },
            { timeout: CHAT_RESPONSE_TIMEOUT_MS },
          );
          const assistantContent = (assistantMessage as { content?: unknown[] }).content ?? [];
          expect(assistantContent).toHaveLength(2);
          expect(assistantContent[0]).toEqual({ type: "text", text: "Image reply" });
          const imageBlock = expectRecordFields(assistantContent[1], {
            type: "image",
            alt: "Generated image 1",
            mimeType: "image/png",
            width: 1,
            height: 1,
          });
          expect(String(imageBlock.url)).toContain("/api/chat/media/outgoing/");
          expect(String(imageBlock.openUrl)).toContain("/full");
          const serializedAssistant = JSON.stringify(assistantMessage);
          expect(serializedAssistant).not.toContain("data:image/png;base64");
          expect(serializedAssistant).not.toContain(pngB64);
        } finally {
          envSnapshot.restore();
        }
      },
      { sessionId: "sess-managed-image-history" },
    );
  });

  test("chat.history hides assistant NO_REPLY-only entries and keeps mixed-content assistant entries", async () => {
    const historyMessages = await loadChatHistoryWithMessages(buildNoReplyHistoryFixture(true));
    const roleAndText = historyMessages
      .map((message) => {
        const role =
          message &&
          typeof message === "object" &&
          typeof (message as { role?: unknown }).role === "string"
            ? (message as { role: string }).role
            : "unknown";
        const text =
          message &&
          typeof message === "object" &&
          typeof (message as { text?: unknown }).text === "string"
            ? (message as { text: string }).text
            : (extractFirstTextBlock(message) ?? "");
        return `${role}:${text}`;
      })
      .filter((entry) => entry !== "unknown:");

    expect(roleAndText).toEqual([
      "user:hello",
      "assistant:real reply",
      "assistant:real text field reply",
      "user:NO_REPLY",
      "assistant:NO_REPLY",
    ]);
  });

  test("chat.history uses the owning agent thinkingDefault for non-default agent sessions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    try {
      testState.sessionStorePath = path.join(dir, "sessions.json");
      testState.agentConfig = {
        model: { primary: "openai/gpt-5" },
        thinkingDefault: "low",
      };
      testState.agentsConfig = {
        list: [
          { id: "main", default: true },
          { id: "alpha", thinkingDefault: "minimal" },
        ],
      };
      await writeSessionStore({
        entries: {
          "agent:alpha:main": {
            sessionId: "sess-alpha",
            updatedAt: Date.now(),
            modelProvider: "openai",
            model: "gpt-5",
          },
        },
      });
      agentDiscoveryMock.enabled = true;
      agentDiscoveryMock.models = [{ id: "gpt-5", provider: "openai", reasoning: true }];
      await prepareGatewayReplyRuntimeForTest({ force: true });

      const historyRes = await rpcReq<{
        thinkingLevel?: string;
        sessionInfo?: { thinkingLevel?: string };
      }>(ws, "chat.history", { sessionKey: "agent:alpha:main" });

      expect(historyRes.ok).toBe(true);
      expect(historyRes.payload?.thinkingLevel).toBe("minimal");
      expect(historyRes.payload?.sessionInfo?.thinkingLevel).toBeUndefined();
    } finally {
      Object.assign(agentDiscoveryMock, { enabled: false, models: [] });
      testState.agentConfig = undefined;
      testState.agentsConfig = undefined;
      testState.sessionStorePath = undefined;
      await removeTempDir(dir);
    }
  });

  test("chat.send does not persist verboseLevel for operator.write callers", async () => {
    await withGatewayServer(async ({ port: portValue }) => {
      await withMainSessionStore(async () => {
        let scopedWs: WebSocket | undefined;

        try {
          scopedWs = new WebSocket(`ws://127.0.0.1:${portValue}`);
          trackConnectChallengeNonce(scopedWs);
          await new Promise<void>((resolve) => {
            scopedWs?.once("open", resolve);
          });
          await connectOk(scopedWs, {
            scopes: ["operator.write"],
          });

          const sendRes = await rpcReq(scopedWs, "chat.send", {
            sessionKey: "main",
            message: "/verbose full",
            idempotencyKey: "idem-write-scope-verbose-no-persist",
          });
          expect(sendRes.ok).toBe(true);

          const waitRes = await rpcReq(scopedWs, "agent.wait", {
            runId: "idem-write-scope-verbose-no-persist",
            timeoutMs: 1_000,
          });
          expect(waitRes.ok).toBe(true);
          expect(waitRes.payload?.status).toBe("ok");

          const sessionStorePath = testState.sessionStorePath;
          if (!sessionStorePath) {
            throw new Error("session store path was not initialized");
          }
          expect(
            loadSessionEntry({ sessionKey: "agent:main:main", storePath: sessionStorePath })
              ?.verboseLevel,
          ).toBeUndefined();
        } finally {
          scopedWs?.close();
        }
      });
    });
  });

  test("chat.send does not persist one-turn thinking metadata", async () => {
    await withMainSessionStore(async () => {
      const sendRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hello from phone",
        thinking: "low",
        idempotencyKey: "idem-chat-thinking-no-persist",
      });
      expect(sendRes.ok).toBe(true);

      const waitRes = await rpcReq(ws, "agent.wait", {
        runId: "idem-chat-thinking-no-persist",
        timeoutMs: 1_000,
      });
      expect(waitRes.ok).toBe(true);
      expect(waitRes.payload?.status).toBe("ok");

      const sessionStorePath = testState.sessionStorePath;
      if (!sessionStorePath) {
        throw new Error("session store path was not initialized");
      }
      expect(
        loadSessionEntry({ sessionKey: "agent:main:main", storePath: sessionStorePath })
          ?.thinkingLevel,
      ).toBeUndefined();
      expect(
        loadSessionEntry({ sessionKey: "main", storePath: sessionStorePath })?.thinkingLevel,
      ).toBeUndefined();
    });
  });

  test("chat.send does not rotate sessions for operator.write reset triggers", async () => {
    await withGatewayServer(async ({ port: portLocal }) => {
      await withMainSessionStore(async () => {
        let scopedWs: WebSocket | undefined;

        try {
          scopedWs = new WebSocket(`ws://127.0.0.1:${portLocal}`);
          trackConnectChallengeNonce(scopedWs);
          await new Promise<void>((resolve) => {
            scopedWs?.once("open", resolve);
          });
          await connectOk(scopedWs, {
            scopes: ["operator.write"],
          });

          const sendRes = await rpcReq(scopedWs, "chat.send", {
            sessionKey: "main",
            message: "/reset",
            idempotencyKey: "idem-write-scope-reset-no-rotate",
          });
          expect(sendRes.ok).toBe(true);

          const waitRes = await rpcReq(scopedWs, "agent.wait", {
            runId: "idem-write-scope-reset-no-rotate",
            timeoutMs: 1_000,
          });
          expect(waitRes.ok).toBe(true);
          expect(waitRes.payload?.status).toBe("ok");

          const sessionStorePath = testState.sessionStorePath;
          if (!sessionStorePath) {
            throw new Error("session store path was not initialized");
          }
          expect(
            loadSessionEntry({ sessionKey: "agent:main:main", storePath: sessionStorePath })
              ?.sessionId,
          ).toBe("sess-main");
        } finally {
          scopedWs?.close();
        }
      });
    });
  });

  test("agent.wait resolves chat.send runs that finish without lifecycle events", async () => {
    await withMainSessionStore(async () => {
      const runId = "idem-wait-chat-1";
      await sendChatAndExpectStarted(runId);
      await waitForAgentRunOk(runId);
    });
  });

  test("agent.wait ignores stale chat dedupe when an agent run with the same runId is in flight", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    let resolveAgentRun: (() => void) | undefined;
    const blockedAgentRun = new Promise<void>((resolve) => {
      resolveAgentRun = resolve;
    });
    const agentSpy = vi.mocked(agentCommandMock);
    agentSpy.mockImplementationOnce(async () => {
      await blockedAgentRun;
      return undefined;
    });

    try {
      testState.sessionStorePath = path.join(dir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      const runId = "idem-wait-chat-vs-agent";
      await sendChatAndExpectStarted(runId);
      await waitForAgentRunOk(runId);

      const agentRes = await rpcReq(ws, "agent", {
        sessionKey: "main",
        message: "hold this run open",
        idempotencyKey: runId,
      });
      expect(agentRes.ok).toBe(true);
      expect(agentRes.payload?.status).toBe("accepted");

      const waitWhileAgentInFlight = await rpcReq(ws, "agent.wait", {
        runId,
        timeoutMs: 40,
      });
      expectAgentWaitTimeout(waitWhileAgentInFlight);

      resolveAgentRun?.();
      await waitForAgentRunOk(runId);
    } finally {
      resolveAgentRun?.();
      testState.sessionStorePath = undefined;
      await removeTempDir(dir);
    }
  });

  test.each(["return", "throw"] as const)(
    "retains the session fixture while admitted dispatch settles after callback %s",
    async (outcome) => {
      const runId = `idem-fixture-dispatch-${outcome}`;
      const dispatchStarted = createDeferred();
      const releaseDispatch = createDeferred();
      const callbackFinished = createDeferred();
      const callbackError = new Error("fixture callback failed");
      let fixtureDir = "";
      let storePath = "";
      dispatchInboundMessageMock.mockImplementationOnce(async () => {
        dispatchStarted.resolve();
        await releaseDispatch.promise;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      });
      const fixture = withMainSessionStore(async (dir) => {
        fixtureDir = dir;
        storePath = path.join(dir, "sessions.json");
        try {
          await sendChatAndExpectStarted(runId, "hold fixture dispatch open");
          await dispatchStarted.promise;
          if (outcome === "throw") {
            throw callbackError;
          }
          return "fixture result";
        } finally {
          callbackFinished.resolve();
        }
      });
      const completion = Promise.allSettled([fixture]);
      try {
        await callbackFinished.promise;
        // Let the fixture's finally run while the admitted dispatch is still held.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(getActiveGatewayRootWorkCount()).toBeGreaterThan(0);
        expect(testState.sessionStorePath).toBe(storePath);
        expect((await fs.stat(fixtureDir)).isDirectory()).toBe(true);
      } finally {
        releaseDispatch.resolve();
        await completion;
        await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      }
      expect(await completion).toEqual([
        outcome === "throw"
          ? { status: "rejected", reason: callbackError }
          : { status: "fulfilled", value: "fixture result" },
      ]);
      expect(testState.sessionStorePath).toBeUndefined();
      await expect(fs.stat(fixtureDir)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("agent.wait ignores stale agent snapshots while same-runId chat.send is active", async () => {
    await withMainSessionStore(async () => {
      const runId = "idem-wait-chat-active-vs-stale-agent";
      const seedAgentRes = await rpcReq(ws, "agent", {
        sessionKey: "main",
        message: "seed stale agent snapshot",
        idempotencyKey: runId,
      });
      expect(seedAgentRes.ok).toBe(true);
      expect(seedAgentRes.payload?.status).toBe("accepted");

      const seedWaitRes = await rpcReq(ws, "agent.wait", {
        runId,
        timeoutMs: 1_000,
      });
      expect(seedWaitRes.ok).toBe(true);
      expect(seedWaitRes.payload?.status).toBe("ok");

      const releaseBlockedReply = mockBlockedChatReply();

      try {
        await sendChatAndExpectStarted(runId, "hold chat run open");

        const waitWhileChatActive = await rpcReq(ws, "agent.wait", {
          runId,
          timeoutMs: 40,
        });
        expectAgentWaitTimeout(waitWhileChatActive);

        await abortChatRun(runId);
      } finally {
        releaseBlockedReply();
      }
    });
  });

  test("agent.wait ignores lifecycle completion while same-runId chat.send is active", async () => {
    await withMainSessionStore(async () => {
      const runId = "idem-wait-chat-active-with-agent-lifecycle";
      const blockedReply = createDeferred();
      const runtimeStarted = createDeferred();
      mockGetReplyFromConfigOnce(async (_ctx, opts) => {
        opts?.onAgentRunStart?.(runId);
        const runtimeOwner = claimAgentRunContext(
          runId,
          {
            agentId: "main",
            projectSessionActive: true,
            sessionId: "sess-main",
            sessionKey: "agent:main:main",
          },
          { ownsContext: true, trackOwner: true },
        );
        expect(runtimeOwner).toBeDefined();
        runtimeStarted.resolve();
        try {
          await blockedReply.promise;
        } finally {
          releaseAgentRunContext(runId, runtimeOwner);
        }
      });

      try {
        const subscribeRes = await rpcReq(ws, "sessions.subscribe", {});
        expect(subscribeRes.ok).toBe(true);
        await sendChatAndExpectStarted(runId, "hold chat run open");
        // The ACK precedes dispatch; emit lifecycle only after the runtime owns this run.
        await runtimeStarted.promise;

        const terminalSessionChange = onceMessage(
          ws,
          (event) =>
            event.type === "event" &&
            event.event === "sessions.changed" &&
            event.payload?.phase === "end" &&
            event.payload?.runId === runId,
          8_000,
        );
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "start", startedAt: 1 },
        });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "end", startedAt: 1, endedAt: 2 },
        });

        expect((await terminalSessionChange).payload?.activeRunIds).toBeNull();
        const waitWhileChatActive = await rpcReq(ws, "agent.wait", {
          runId,
          timeoutMs: 40,
        });
        expectAgentWaitTimeout(waitWhileChatActive);

        // Match the published ownership fact, not the `reason` label: sessions.changed
        // coalesces bursts per session key and keeps only the newest payload, so any
        // same-key mutation inside that window legitimately replaces the label while
        // the row (activeRunIds/lastRunId) is still rebuilt at broadcast time.
        const settledSessionChange = onceMessage(
          ws,
          (event) =>
            event.type === "event" &&
            event.event === "sessions.changed" &&
            event.payload?.sessionKey === "agent:main:main" &&
            event.payload?.hasActiveRun === false &&
            Array.isArray(event.payload?.activeRunIds) &&
            event.payload.activeRunIds.length === 0 &&
            event.payload?.lastRunId === runId,
          8_000,
        );
        blockedReply.resolve();
        const settledEvent = await settledSessionChange.catch((cause: unknown) => {
          throw new Error("Gateway did not publish settled run ownership after chat.send cleanup", {
            cause,
          });
        });
        await waitForAgentRunOk(runId);
        expectRecordFields(settledEvent.payload, {
          activeRunIds: [],
          hasActiveRun: false,
          lastRunId: runId,
        });
      } finally {
        blockedReply.resolve();
      }
    });
  });

  test("agent events include sessionKey and agent.wait covers lifecycle flows", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          verboseLevel: "off",
        },
      },
    });

    const webchatWs = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    trackConnectChallengeNonce(webchatWs);
    await new Promise<void>((resolve) => {
      webchatWs.once("open", resolve);
    });
    await connectOk(webchatWs, {
      client: {
        id: GATEWAY_CLIENT_NAMES.WEBCHAT,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    });

    try {
      registerAgentRunContext("run-tool-1", {
        sessionKey: "main",
        verboseLevel: "on",
      });

      {
        const agentEvtP = onceMessage(
          webchatWs,
          (o) => o.type === "event" && o.event === "agent" && o.payload?.runId === "run-tool-1",
          8000,
        );

        emitAgentEvent({
          runId: "run-tool-1",
          stream: "assistant",
          data: { text: "hello" },
        });

        const evt = await agentEvtP;
        const payload = evt.payload && typeof evt.payload === "object" ? evt.payload : {};
        expect(payload.sessionKey).toBe("main");
        expect(payload.stream).toBe("assistant");
      }

      {
        const waitP = rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-1",
          timeoutMs: 200,
        });

        queueMicrotask(() => {
          emitAgentEvent({
            runId: "run-wait-1",
            stream: "lifecycle",
            data: { phase: "end", startedAt: 200, endedAt: 210 },
          });
        });

        const res = await waitP;
        expectAgentWaitStartedAt(res, 200);
      }

      {
        emitAgentEvent({
          runId: "run-wait-early",
          stream: "lifecycle",
          data: { phase: "end", startedAt: 50, endedAt: 55 },
        });

        const res = await rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-early",
          timeoutMs: 200,
        });
        expect(res.ok).toBe(true);
        expect(res.payload?.status).toBe("ok");
        expect(res.payload?.startedAt).toBe(50);
      }

      {
        const res = await rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-3",
          timeoutMs: 30,
        });
        expectAgentWaitTimeout(res);
      }

      {
        const waitP = rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-err",
          timeoutMs: 50,
        });

        queueMicrotask(() => {
          emitAgentEvent({
            runId: "run-wait-err",
            stream: "lifecycle",
            data: { phase: "error", error: "boom" },
          });
        });

        const res = await waitP;
        expectAgentWaitTimeout(res, "boom");
      }

      {
        const waitP = rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-start",
          timeoutMs: 200,
        });

        emitAgentEvent({
          runId: "run-wait-start",
          stream: "lifecycle",
          data: { phase: "start", startedAt: 123 },
        });

        queueMicrotask(() => {
          emitAgentEvent({
            runId: "run-wait-start",
            stream: "lifecycle",
            data: { phase: "end", endedAt: 456 },
          });
        });

        const res = await waitP;
        expectAgentWaitStartedAt(res, 123);
        expect(res.payload?.endedAt).toBe(456);
      }
    } finally {
      webchatWs.close();
      await removeTempDir(dir);
      testState.sessionStorePath = undefined;
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
