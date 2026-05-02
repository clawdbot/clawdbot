import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { emitAgentEvent, registerAgentRunContext } from "../infra/agent-events.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { __testing as agentJobTesting } from "./server-methods/agent-job.js";
import {
  connectOk,
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  mockGetReplyFromConfigOnce,
  onceMessage,
  rpcReq,
  testState,
  trackConnectChallengeNonce,
  withGatewayServer,
  writeSessionStore,
} from "./test-helpers.js";
import { agentCommand } from "./test-helpers.runtime-state.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
const CHAT_RESPONSE_TIMEOUT_MS = 10_000;

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

  const buildNoReplyHistoryFixture = (includeMixedAssistant = false) => [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY" }],
      timestamp: 2,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "real reply" }],
      timestamp: 3,
    },
    {
      role: "assistant",
      text: "real text field reply",
      content: "NO_REPLY",
      timestamp: 4,
    },
    {
      role: "user",
      content: [{ type: "text", text: "NO_REPLY" }],
      timestamp: 5,
    },
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
    return withMainSessionStore(async (dir) => {
      const lines = messages.map((message) => JSON.stringify({ message }));
      await fs.writeFile(path.join(dir, "sess-main.jsonl"), lines.join("\n"), "utf-8");

      const res = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(res.ok).toBe(true);
      return res.payload?.messages ?? [];
    });
  };

  const withMainSessionStore = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
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
      return await run(dir);
    } finally {
      testState.sessionStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

  const expectAgentWaitTimeout = (res: Awaited<ReturnType<typeof rpcReq>>) => {
    expect(res.ok).toBe(true);
    expect(res.payload?.status).toBe("timeout");
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

  const waitForAgentRunOk = async (runId: string, timeoutMs = 1_000) => {
    const res = await rpcReq(ws, "agent.wait", {
      runId,
      timeoutMs,
    });
    expect(res.ok).toBe(true);
    expect(res.payload?.status).toBe("ok");
    return res;
  };

  const waitForLifecycleWaiter = async (runId: string) => {
    await vi.waitFor(() => expect(agentJobTesting.getWaiterCount(runId)).toBeGreaterThan(0));
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

  test("sessions.send accepts dashboard messages for existing sessions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-send-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    try {
      await writeSessionStore({
        entries: {
          "agent:main:dashboard:test-send": {
            sessionId: "sess-dashboard-send",
            updatedAt: Date.now(),
          },
        },
      });

      const res = await rpcReq(ws, "sessions.send", {
        key: "agent:main:dashboard:test-send",
        message: "hello from dashboard",
        idempotencyKey: "idem-sessions-send-1",
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.runId).toBe("idem-sessions-send-1");
      expect(res.payload?.messageSeq).toBe(1);
    } finally {
      testState.sessionStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("sessions.steer accepts dashboard follow-up messages for existing sessions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-steer-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    try {
      await writeSessionStore({
        entries: {
          "agent:main:dashboard:test-steer": {
            sessionId: "sess-dashboard-steer",
            updatedAt: Date.now(),
          },
        },
      });

      const res = await rpcReq(ws, "sessions.steer", {
        key: "agent:main:dashboard:test-steer",
        message: "follow-up from dashboard",
        idempotencyKey: "idem-sessions-steer-1",
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.runId).toBe("idem-sessions-steer-1");
      expect(res.payload?.messageSeq).toBe(1);
    } finally {
      testState.sessionStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true });
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
        expect(cancelledEvent.payload?.data).toMatchObject({
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
        expect(waitRes.payload).toMatchObject({
          runId: "idem-sessions-abort-1",
          status: "timeout",
          stopReason: "rpc",
        });
      } else {
        expect(abortRes.payload?.abortedRunId).toBeNull();
      }
    } finally {
      testState.sessionStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true });
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
    } finally {
      testState.sessionStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true });
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
  });

  test("handles chat send and history flows", async () => {
    const tempDirs: string[] = [];
    let webchatWs: WebSocket | undefined;

    try {
      webchatWs = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      trackConnectChallengeNonce(webchatWs);
      await new Promise<void>((resolve) => webchatWs?.once("open", resolve));
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
      testState.agentConfig = undefined;

      const sessionRes = await rpcReq(ws, "chat.send", {
        sessionKey: "agent:main:subagent:abc",
        message: "hello",
        idempotencyKey: "idem-session-key-1",
      });
      expect(sessionRes.ok).toBe(true);
      expect(sessionRes.payload?.runId).toBe("idem-session-key-1");

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

      const agentBlockedRes = await rpcReq(ws, "agent", {
        sessionKey: "cron:job-1",
        message: "hi",
        idempotencyKey: "idem-2",
      });
      expect(agentBlockedRes.ok).toBe(false);
      expect((agentBlockedRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
        /send blocked/i,
      );

      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;

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
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: pngB64,
                },
              },
            ],
          },
        }),
      );

      const imgRes = await onceMessage(
        ws,
        (o) => o.type === "res" && o.id === reqId,
        CHAT_RESPONSE_TIMEOUT_MS,
      );
      expect(imgRes.ok).toBe(true);
      expect(imgRes.payload?.runId).toBeDefined();
      const reqIdOnly = "chat-img-only";
      ws.send(
        JSON.stringify({
          type: "req",
          id: reqIdOnly,
          method: "chat.send",
          params: {
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
          },
        }),
      );

      const imgOnlyRes = await onceMessage(
        ws,
        (o) => o.type === "res" && o.id === reqIdOnly,
        CHAT_RESPONSE_TIMEOUT_MS,
      );
      expect(imgOnlyRes.ok).toBe(true);
      expect(imgOnlyRes.payload?.runId).toBeDefined();

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
      await fs.writeFile(path.join(historyDir, "sess-main.jsonl"), lines.join("\n"), "utf-8");

      const defaultRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(defaultRes.ok).toBe(true);
      const defaultMsgs = defaultRes.payload?.messages ?? [];
      expect(defaultMsgs.length).toBe(200);
      expect(extractFirstTextBlock(defaultMsgs[0])).toBe("m1");
    } finally {
      testState.agentConfig = undefined;
      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;
      if (webchatWs) {
        webchatWs.close();
      }
      await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
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

  test("chat.history hides assistant NO_REPLY-only entries", async () => {
    const historyMessages = await loadChatHistoryWithMessages(buildNoReplyHistoryFixture());
    const textValues = collectHistoryTextValues(historyMessages);
    // The NO_REPLY assistant message (content block) should be dropped.
    // The assistant with text="real text field reply" + content="NO_REPLY" stays
    // because entry.text takes precedence over entry.content for the silent check.
    // The user message with NO_REPLY text is preserved (only assistant filtered).
    expect(textValues).toEqual(["hello", "real reply", "real text field reply", "NO_REPLY"]);
  });

  test("chat.history hides commentary-only assistant entries", async () => {
    const historyMessages = await loadChatHistoryWithMessages([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        phase: "commentary",
        content: [{ type: "text", text: "thinking like caveman" }],
        timestamp: 2,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "real reply" }],
        timestamp: 3,
      },
    ]);

    expect(collectHistoryTextValues(historyMessages)).toEqual(["hello", "real reply"]);
  });

  test("chat.history hides assistant announce/reply skip-only entries", async () => {
    const historyMessages = await loadChatHistoryWithMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "ANNOUNCE_SKIP" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "REPLY_SKIP" }],
        timestamp: 2,
      },
      {
        role: "assistant",
        text: "real text field reply",
        content: "ANNOUNCE_SKIP",
        timestamp: 3,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "real reply" }],
        timestamp: 4,
      },
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
  test("routes chat.send slash commands without agent runs", async () => {
    await withMainSessionStore(async () => {
      const spy = vi.mocked(agentCommand);
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
    await withMainSessionStore(async (dir) => {
      await fs.writeFile(
        path.join(dir, "sess-main.jsonl"),
        `${JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: "main thread context" }],
            timestamp: Date.now(),
          },
        })}\n`,
        "utf-8",
      );
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
      await vi.waitFor(() => {
        expect(dispatchInboundMessageMock).toHaveBeenCalled();
      });
      const sideResult = await sideResultPromise;
      const finalEvent = await finalPromise;
      expect(sideResult.payload).toMatchObject({
        kind: "btw",
        runId: "idem-btw-1",
        sessionKey: "agent:main:main",
        question: "what is 17 * 19?",
        text: "323",
      });
      expect(finalEvent.payload).toMatchObject({
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

  test("routes block-streamed /btw replies through side-result events", async () => {
    await withMainSessionStore(async (dir) => {
      await fs.writeFile(
        path.join(dir, "sess-main.jsonl"),
        `${JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "existing context" }],
            timestamp: Date.now(),
          },
        })}\n`,
        "utf-8",
      );
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
      await vi.waitFor(() => {
        expect(dispatchInboundMessageMock).toHaveBeenCalled();
      });
      const sideResult = await sideResultPromise;
      expect(sideResult.payload).toMatchObject({
        kind: "btw",
        runId: "idem-btw-block-1",
        question: "what changed?",
        text: "first chunk\n\nsecond chunk",
      });
    });
  });

  test("chat.history persists assistant image data URLs as managed image blocks", async () => {
    await withMainSessionStore(async (dir) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = dir;
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
        for (let attempt = 0; attempt < 50; attempt += 1) {
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
          if (assistantMessage) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        expect(assistantMessage).toBeTruthy();
        const assistantContent = (assistantMessage as { content?: unknown[] }).content ?? [];
        expect(assistantContent).toEqual([
          { type: "text", text: "Image reply" },
          expect.objectContaining({
            type: "image",
            url: expect.stringContaining("/api/chat/media/outgoing/"),
            openUrl: expect.stringContaining("/full"),
            alt: "Generated image 1",
            mimeType: "image/png",
            width: 1,
            height: 1,
          }),
        ]);
        const serializedAssistant = JSON.stringify(assistantMessage);
        expect(serializedAssistant).not.toContain("data:image/png;base64");
        expect(serializedAssistant).not.toContain(pngB64);
      } finally {
        if (previousStateDir == null) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }
    });
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

      const historyRes = await rpcReq<{ thinkingLevel?: string }>(ws, "chat.history", {
        sessionKey: "agent:alpha:main",
      });

      expect(historyRes.ok).toBe(true);
      expect(historyRes.payload?.thinkingLevel).toBe("minimal");
    } finally {
      testState.agentConfig = undefined;
      testState.agentsConfig = undefined;
      testState.sessionStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("chat.send does not persist verboseLevel for operator.write callers", async () => {
    await withGatewayServer(async ({ port }) => {
      await withMainSessionStore(async () => {
        let scopedWs: WebSocket | undefined;

        try {
          scopedWs = new WebSocket(`ws://127.0.0.1:${port}`);
          trackConnectChallengeNonce(scopedWs);
          await new Promise<void>((resolve) => scopedWs?.once("open", resolve));
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

          const raw = await fs.readFile(testState.sessionStorePath!, "utf-8");
          const stored = JSON.parse(raw) as {
            "agent:main:main"?: {
              verboseLevel?: string;
            };
          };
          expect(stored["agent:main:main"]?.verboseLevel).toBeUndefined();
        } finally {
          scopedWs?.close();
        }
      });
    });
  });

  test("chat.send does not rotate sessions for operator.write reset triggers", async () => {
    await withGatewayServer(async ({ port }) => {
      await withMainSessionStore(async () => {
        let scopedWs: WebSocket | undefined;

        try {
          scopedWs = new WebSocket(`ws://127.0.0.1:${port}`);
          trackConnectChallengeNonce(scopedWs);
          await new Promise<void>((resolve) => scopedWs?.once("open", resolve));
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

          const raw = await fs.readFile(testState.sessionStorePath!, "utf-8");
          const stored = JSON.parse(raw) as {
            "agent:main:main"?: {
              sessionId?: string;
            };
          };
          expect(stored["agent:main:main"]?.sessionId).toBe("sess-main");
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
    const agentSpy = vi.mocked(agentCommand);
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
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

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

  test("agent.wait keeps lifecycle wait active while same-runId chat.send is active", async () => {
    await withMainSessionStore(async () => {
      const runId = "idem-wait-chat-active-with-agent-lifecycle";
      const releaseBlockedReply = mockBlockedChatReply();

      try {
        await sendChatAndExpectStarted(runId, "hold chat run open");

        const waitP = rpcReq(ws, "agent.wait", {
          runId,
          timeoutMs: 1_000,
        });

        await waitForLifecycleWaiter(runId);
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

        const waitRes = await waitP;
        expect(waitRes.ok).toBe(true);
        expect(waitRes.payload?.status).toBe("ok");

        await abortChatRun(runId);
      } finally {
        releaseBlockedReply();
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
    await new Promise<void>((resolve) => webchatWs.once("open", resolve));
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
        expectAgentWaitTimeout(res);
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
      await fs.rm(dir, { recursive: true, force: true });
      testState.sessionStorePath = undefined;
    }
  });
});
