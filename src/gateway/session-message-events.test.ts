/**
 * Session message event indexing and broadcast tests.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { RawData } from "ws";
import {
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  emitAgentEvent,
} from "../infra/agent-events.js";
import { rawDataToString } from "../infra/ws.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import * as transcriptEvents from "../sessions/transcript-events.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  writeSessionStore,
} from "./test-helpers.server.js";
import type { WorkerConnectionIdentity } from "./worker-environments/connection-identity.js";
import { createWorkerLiveEventReceiver } from "./worker-environments/live-events.js";
import type { WorkerTranscriptCommitStore } from "./worker-environments/transcript-commit-store.js";
import { createWorkerTranscriptCommitter } from "./worker-environments/transcript-commit.js";

installGatewayTestHooks({ scope: "suite" });

const cleanupDirs: string[] = [];
const SETUP_RPC_TIMEOUT_MS = 30_000;
let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let subscribedOperatorWs:
  | Awaited<ReturnType<Awaited<ReturnType<typeof createGatewaySuiteHarness>>["openWs"]>>
  | undefined;

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
  subscribedOperatorWs = await harness.openWs();
  await connectOk(subscribedOperatorWs, {
    scopes: ["operator.read"],
    timeoutMs: SETUP_RPC_TIMEOUT_MS,
  });
  await rpcReq(subscribedOperatorWs, "sessions.subscribe", undefined, SETUP_RPC_TIMEOUT_MS);
}, 60_000);

afterAll(async () => {
  subscribedOperatorWs?.close();
  if (harness) {
    await harness.close();
  }
});

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createSessionStoreFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-message-"));
  cleanupDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  return storePath;
}

async function withOperatorSessionSubscriber<T>(
  run: (ws: NonNullable<typeof subscribedOperatorWs>) => Promise<T>,
) {
  if (!subscribedOperatorWs) {
    throw new Error("subscribed operator websocket is not ready");
  }
  return await run(subscribedOperatorWs);
}

function waitForSessionMessageEvent(
  ws: Awaited<ReturnType<Awaited<ReturnType<typeof createGatewaySuiteHarness>>["openWs"]>>,
  sessionKey: string,
  timeoutMs?: number,
) {
  return onceMessage(
    ws,
    (message) =>
      message.type === "event" &&
      message.event === "session.message" &&
      (message.payload as { sessionKey?: string } | undefined)?.sessionKey === sessionKey,
    timeoutMs,
  );
}

function waitForSessionsChangedMessagePhase(
  ws: Awaited<ReturnType<Awaited<ReturnType<typeof createGatewaySuiteHarness>>["openWs"]>>,
  sessionKey: string,
) {
  return onceMessage(
    ws,
    (message) =>
      message.type === "event" &&
      message.event === "sessions.changed" &&
      (message.payload as { phase?: string; sessionKey?: string } | undefined)?.phase ===
        "message" &&
      (message.payload as { sessionKey?: string } | undefined)?.sessionKey === sessionKey,
  );
}

async function emitTranscriptUpdateAndCollectMessageEvent(params: {
  ws: Awaited<ReturnType<Awaited<ReturnType<typeof createGatewaySuiteHarness>>["openWs"]>>;
  sessionKey: string;
  sessionFile: string;
  message: Record<string, unknown>;
  messageId: string;
  agentId?: string;
  messageSeq?: number;
}) {
  const messageEventPromise = waitForSessionMessageEvent(params.ws, params.sessionKey);

  emitSessionTranscriptUpdate({
    sessionFile: params.sessionFile,
    sessionKey: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    message: params.message,
    messageId: params.messageId,
    ...(typeof params.messageSeq === "number" ? { messageSeq: params.messageSeq } : {}),
  });

  const messageEvent = await messageEventPromise;
  return { messageEvent };
}

async function expectNoMessageWithin(params: {
  action?: () => Promise<void> | void;
  watch: (timeoutMs: number) => Promise<unknown>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 300;
  const received = params.watch(timeoutMs).then(
    () => true,
    () => false,
  );
  await params.action?.();
  await expect(received).resolves.toBe(false);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(value: unknown, expected: Record<string, unknown>): void {
  const record = requireRecord(value, "record");
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

describe("session.message websocket events", () => {
  test("includes spawned session ownership metadata on lifecycle sessions.changed events", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        child: {
          sessionId: "sess-child",
          updatedAt: Date.now(),
          goal: {
            schemaVersion: 1,
            id: "goal-child",
            objective: "Finish child work",
            status: "active",
            createdAt: 1,
            updatedAt: 2,
            tokenStart: 0,
            tokensUsed: 42,
            continuationTurns: 0,
          },
          spawnedBy: "agent:main:parent",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
          spawnedCwd: "/tmp/task-repo",
          forkedFromParent: true,
          spawnDepth: 2,
          subagentRole: "orchestrator",
          subagentControlScope: "children",
          displayName: "Ops Child",
        },
      },
      storePath,
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const changedEvent = onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "sessions.changed" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:child",
      );

      emitSessionLifecycleEvent({
        sessionKey: "agent:main:child",
        reason: "reactivated",
      });

      const event = await changedEvent;
      expectRecordFields(event.payload, {
        sessionKey: "agent:main:child",
        reason: "reactivated",
        spawnedBy: "agent:main:parent",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        spawnedCwd: "/tmp/task-repo",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        displayName: "Ops Child",
        goal: {
          schemaVersion: 1,
          id: "goal-child",
          objective: "Finish child work",
          status: "active",
          createdAt: 1,
          updatedAt: 2,
          tokenStart: 0,
          tokenStartFresh: true,
          tokensUsed: 42,
          continuationTurns: 0,
        },
      });
    });
  });

  test("only sends transcript events to subscribed operator clients", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    const subscribedWs = await harness.openWs();
    const unsubscribedWs = await harness.openWs();
    const nodeWs = await harness.openWs();
    try {
      await connectOk(subscribedWs, { scopes: ["operator.read"] });
      await rpcReq(subscribedWs, "sessions.subscribe");
      await connectOk(unsubscribedWs, { scopes: ["operator.read"] });
      await connectOk(nodeWs, { role: "node", scopes: [] });

      const subscribedEvent = onceMessage(
        subscribedWs,
        (message) =>
          message.type === "event" &&
          message.event === "session.message" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:main",
      );
      const appended = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "subscribed only",
        storePath,
      });
      expect(appended.ok).toBe(true);
      const event = await subscribedEvent;
      expectRecordFields(event, {
        type: "event",
        event: "session.message",
      });
      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            unsubscribedWs,
            (message) => message.type === "event" && message.event === "session.message",
            timeoutMs,
          ),
      });
      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            nodeWs,
            (message) => message.type === "event" && message.event === "session.message",
            timeoutMs,
          ),
      });
    } finally {
      subscribedWs.close();
      unsubscribedWs.close();
      nodeWs.close();
    }
  });

  test("broadcasts appended transcript messages with the session key", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    try {
      const appended = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "live websocket message",
        storePath,
      });
      expect(appended.ok).toBe(true);
      if (!appended.ok) {
        throw new Error(`append failed: ${appended.reason}`);
      }
      const emitParams = requireRecord(emitSpy.mock.calls.at(0)?.[0], "transcript update params");
      expect(emitParams.sessionFile).toBe(appended.sessionFile);
      expect(emitParams.sessionKey).toBe("agent:main:main");
      expect(emitParams.messageId).toBe(appended.messageId);
      expectRecordFields(emitParams.message, {
        role: "assistant",
        content: [{ type: "text", text: "live websocket message" }],
      });
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          sessionId: "sess-main",
          sessionKey: "agent:main:main",
          storePath,
        }),
      ).resolves.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            content: [{ type: "text", text: "live websocket message" }],
          }),
          type: "message",
        }),
      );
    } finally {
      emitSpy.mockRestore();
    }
  });

  test("strips blocked original content from live session.message events", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });
    const transcriptPath = path.join(path.dirname(storePath), "sess-main.jsonl");
    await fs.writeFile(
      transcriptPath,
      JSON.stringify({ type: "session", version: 1, id: "sess-main" }) + "\n",
      "utf-8",
    );

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:main",
        sessionFile: transcriptPath,
        messageId: "blocked-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "The agent cannot read this message." }],
          __openclaw: {
            beforeAgentRunBlocked: { blockedBy: "policy-plugin", blockedAt: 1 },
          },
        },
      });

      const payload = messageEvent.payload as {
        message?: { content?: unknown; __openclaw?: { beforeAgentRunBlocked?: unknown } };
      };
      expect(payload.message?.content).toEqual([
        { type: "text", text: "The agent cannot read this message." },
      ]);
      expect(JSON.stringify(payload.message)).not.toContain("secret blocked prompt");
      expect(JSON.stringify(payload.message)).not.toContain("contains protected content");
    });
  });

  test("broadcasts redacted blocked user appends to live session listeners", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:main");
      emitSessionTranscriptUpdate({
        sessionFile: path.join(path.dirname(storePath), "sess-main.jsonl"),
        sessionKey: "agent:main:main",
        messageId: "blocked-message",
        message: {
          role: "user",
          content: [{ type: "text", text: "The agent cannot read this message." }],
          __openclaw: {
            beforeAgentRunBlocked: {
              blockedBy: "policy-plugin",
              blockedAt: Date.now(),
            },
          },
        },
      });

      const messageEvent = await messageEventPromise;
      const payload = messageEvent.payload as {
        message?: {
          role?: unknown;
          content?: unknown;
          __openclaw?: { beforeAgentRunBlocked?: unknown };
        };
      };
      expect(payload.message?.role).toBe("user");
      expect(payload.message?.content).toEqual([
        { type: "text", text: "The agent cannot read this message." },
      ]);
      expect(JSON.stringify(payload.message)).not.toContain("secret blocked prompt");
      expect(JSON.stringify(payload.message)).not.toContain("contains protected content");
    });
  });

  test("does not broadcast hidden runtime-context custom messages as live chat messages", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        "hidden-runtime": {
          sessionId: "sess-hidden-runtime",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const changedEventPromise = waitForSessionsChangedMessagePhase(
        ws,
        "agent:main:hidden-runtime",
      );
      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "session.message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:hidden-runtime",
            timeoutMs,
          ),
        action: () => {
          emitSessionTranscriptUpdate({
            sessionFile: path.join(path.dirname(storePath), "sess-hidden-runtime.jsonl"),
            sessionKey: "agent:main:hidden-runtime",
            messageId: "runtime-context-1",
            messageSeq: 1,
            message: {
              role: "custom",
              customType: "openclaw.runtime-context",
              content: "secret runtime context",
              display: false,
            },
          });
        },
      });

      const changedEvent = await changedEventPromise;
      expectRecordFields(changedEvent.payload, {
        sessionKey: "agent:main:hidden-runtime",
        phase: "message",
        goal: null,
      });
    });
  });

  test("does not duplicate displayable transcript updates with sessions.changed", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:main");
      await expectNoMessageWithin({
        action: () => {
          emitSessionTranscriptUpdate({
            sessionFile: path.join(path.dirname(storePath), "sess-main.jsonl"),
            sessionKey: "agent:main:main",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "single frame" }],
              timestamp: Date.now(),
            },
            messageId: "msg-single-frame",
            messageSeq: 1,
          });
        },
        watch: (timeoutMs) =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "sessions.changed" &&
              (message.payload as { phase?: string; sessionKey?: string } | undefined)?.phase ===
                "message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:main",
            timeoutMs,
          ),
      });
      const messageEvent = await messageEventPromise;
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-single-frame",
        messageSeq: 1,
      });
    });
  });

  test("broadcasts identity-only transcript updates to live session listeners", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:main");
      emitSessionTranscriptUpdate({
        target: {
          agentId: "main",
          sessionId: "sess-main",
          sessionKey: "agent:main:main",
        },
        message: {
          role: "assistant",
          content: [{ type: "text", text: "identity frame" }],
          timestamp: Date.now(),
        },
        messageId: "msg-identity-frame",
        messageSeq: 1,
      });

      const messageEvent = await messageEventPromise;
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-identity-frame",
        messageSeq: 1,
      });
    });
  });

  test("includes live usage metadata on session.message transcript events", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.4",
          contextTokens: 123_456,
          totalTokens: 0,
          totalTokensFresh: false,
        },
      },
      storePath,
    });
    const transcriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "usage snapshot" }],
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        input: 2_000,
        output: 400,
        cacheRead: 300,
        cacheWrite: 100,
        cost: { total: 0.0042 },
      },
      timestamp: Date.now(),
    };
    const turn = await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath,
      },
      {
        messages: [{ message: transcriptMessage }],
        updateMode: "none",
      },
    );

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:main",
        sessionFile: turn.sessionFile,
        message: transcriptMessage,
        messageId: "msg-usage",
      });
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-usage",
        messageSeq: 1,
        totalTokens: 2_400,
        totalTokensFresh: true,
        contextTokens: 123_456,
        estimatedCostUsd: 0.0042,
        modelProvider: "openai",
        model: "gpt-5.4",
      });
    });
  });

  test("prefers carried transcript sequence for live session events", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:main",
        sessionFile: path.join(path.dirname(storePath), "missing-transcript.jsonl"),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "carried sequence" }],
          timestamp: Date.now(),
        },
        messageId: "msg-carried-seq",
        messageSeq: 7,
      });
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-carried-seq",
        messageSeq: 7,
      });
      const payload = requireRecord(messageEvent.payload, "session.message payload");
      const message = requireRecord(payload.message, "session.message payload message");
      expect((message["__openclaw"] as { seq?: unknown } | undefined)?.seq).toBe(7);
    });
  });

  test("derives message sequence for selected-session transcript subscribers", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });
    const transcriptMessage = {
      role: "user",
      content: [{ type: "text", text: "early selected prompt" }],
      timestamp: Date.now(),
    };
    const turn = await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath,
      },
      {
        messages: [{ message: transcriptMessage }],
        updateMode: "none",
      },
    );

    const ws = await harness.openWs();
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      const subscribeRes = await rpcReq(ws, "sessions.messages.subscribe", {
        key: "main",
      });
      expect(subscribeRes.ok).toBe(true);
      expect(subscribeRes.payload?.key).toBe("agent:main:main");

      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:main");
      emitSessionTranscriptUpdate({
        sessionFile: turn.sessionFile,
        sessionKey: "agent:main:main",
        message: transcriptMessage,
        messageId: "msg-selected",
      });

      const messageEvent = await messageEventPromise;
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-selected",
        messageSeq: 1,
      });
    } finally {
      ws.close();
    }
  });

  test("routes selected-agent global transcript updates to matching message subscribers", async () => {
    const storePath = await createSessionStoreFile();
    testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
    const transcriptPath = path.join(path.dirname(storePath), "global-work.jsonl");
    await writeSessionStore({
      entries: {
        global: {
          sessionId: "sess-work-global",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
          goal: {
            schemaVersion: 1,
            id: "goal-work-global",
            objective: "Finish work global task",
            status: "active",
            createdAt: 1,
            updatedAt: 2,
            tokenStart: 0,
            tokensUsed: 5,
            continuationTurns: 0,
          },
        },
      },
      storePath,
      agentId: "work",
    });
    const transcriptMessage = {
      role: "user",
      content: [{ type: "text", text: "work selected global prompt" }],
      timestamp: Date.now(),
    };
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-work-global" }),
        JSON.stringify({ id: "msg-work-global", message: transcriptMessage }),
      ].join("\n"),
      "utf-8",
    );

    const workWs = await harness.openWs();
    const mainWs = await harness.openWs();
    const bareWs = await harness.openWs();
    try {
      await connectOk(workWs, { scopes: ["operator.read"] });
      await connectOk(mainWs, { scopes: ["operator.read"] });
      await connectOk(bareWs, { scopes: ["operator.read"] });
      await rpcReq(workWs, "sessions.messages.subscribe", {
        key: "global",
        agentId: "work",
      });
      await rpcReq(mainWs, "sessions.messages.subscribe", {
        key: "global",
        agentId: "main",
      });
      await rpcReq(bareWs, "sessions.messages.subscribe", {
        key: "global",
      });

      const workMessagePromise = waitForSessionMessageEvent(workWs, "global");
      const mainMessagePromise = expectNoMessageWithin({
        watch: (timeoutMs) => waitForSessionMessageEvent(mainWs, "global", timeoutMs),
        timeoutMs: 250,
      });
      const bareMessagePromise = expectNoMessageWithin({
        watch: (timeoutMs) => waitForSessionMessageEvent(bareWs, "global", timeoutMs),
        timeoutMs: 250,
      });
      emitSessionTranscriptUpdate({
        sessionFile: transcriptPath,
        sessionKey: "global",
        agentId: "work",
        message: transcriptMessage,
        messageId: "msg-work-global",
      });

      const workMessage = await workMessagePromise;
      await mainMessagePromise;
      await bareMessagePromise;
      expectRecordFields(workMessage.payload, {
        sessionKey: "global",
        agentId: "work",
        messageId: "msg-work-global",
        goal: {
          schemaVersion: 1,
          id: "goal-work-global",
          objective: "Finish work global task",
          status: "active",
          createdAt: 1,
          updatedAt: 2,
          tokenStart: 0,
          tokenStartFresh: true,
          tokensUsed: 5,
          continuationTurns: 0,
        },
      });
    } finally {
      workWs.close();
      mainWs.close();
      bareWs.close();
      testState.agentsConfig = undefined;
      testState.sessionStorePath = undefined;
    }
  });

  test("routes unscoped global transcript events to default-agent global subscribers", async () => {
    const storePath = await createSessionStoreFile();
    const transcriptPath = path.join(path.dirname(storePath), "sess-default-global.jsonl");
    await writeSessionStore({
      entries: {
        global: {
          sessionId: "sess-default-global",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
        },
      },
      storePath,
    });
    const transcriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "default global prompt" }],
      timestamp: Date.now(),
    };
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-default-global" }),
        JSON.stringify({ id: "msg-default-global", message: transcriptMessage }),
      ].join("\n"),
      "utf-8",
    );

    const workWs = await harness.openWs();
    const mainWs = await harness.openWs();
    const bareWs = await harness.openWs();
    try {
      await connectOk(workWs, { scopes: ["operator.read"] });
      await connectOk(mainWs, { scopes: ["operator.read"] });
      await connectOk(bareWs, { scopes: ["operator.read"] });
      await rpcReq(workWs, "sessions.messages.subscribe", {
        key: "global",
        agentId: "work",
      });
      await rpcReq(mainWs, "sessions.messages.subscribe", {
        key: "global",
        agentId: "main",
      });
      await rpcReq(bareWs, "sessions.messages.subscribe", {
        key: "global",
      });

      const mainMessagePromise = waitForSessionMessageEvent(mainWs, "global");
      const bareMessagePromise = waitForSessionMessageEvent(bareWs, "global");
      const workMessagePromise = expectNoMessageWithin({
        watch: (timeoutMs) => waitForSessionMessageEvent(workWs, "global", timeoutMs),
        timeoutMs: 250,
      });
      emitSessionTranscriptUpdate({
        sessionFile: transcriptPath,
        sessionKey: "global",
        message: transcriptMessage,
        messageId: "msg-default-global",
      });

      const mainMessage = await mainMessagePromise;
      const bareMessage = await bareMessagePromise;
      await workMessagePromise;
      expectRecordFields(mainMessage.payload, {
        sessionKey: "global",
        messageId: "msg-default-global",
      });
      expectRecordFields(bareMessage.payload, {
        sessionKey: "global",
        messageId: "msg-default-global",
      });
      expect((mainMessage.payload as { agentId?: unknown }).agentId).toBeUndefined();
      expect((bareMessage.payload as { agentId?: unknown }).agentId).toBeUndefined();
    } finally {
      workWs.close();
      mainWs.close();
      bareWs.close();
    }
  });

  test("routes default-agent scoped global transcript events to legacy global subscribers", async () => {
    const storePath = await createSessionStoreFile();
    const transcriptPath = path.join(path.dirname(storePath), "sess-default-scoped-global.jsonl");
    await writeSessionStore({
      entries: {
        global: {
          sessionId: "sess-default-scoped-global",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
        },
      },
      storePath,
      agentId: "main",
    });
    const transcriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "default scoped global prompt" }],
      timestamp: Date.now(),
    };
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-default-scoped-global" }),
        JSON.stringify({ id: "msg-default-scoped-global", message: transcriptMessage }),
      ].join("\n"),
      "utf-8",
    );

    const workWs = await harness.openWs();
    const mainWs = await harness.openWs();
    const bareWs = await harness.openWs();
    try {
      await connectOk(workWs, { scopes: ["operator.read"] });
      await connectOk(mainWs, { scopes: ["operator.read"] });
      await connectOk(bareWs, { scopes: ["operator.read"] });
      await rpcReq(workWs, "sessions.messages.subscribe", {
        key: "global",
        agentId: "work",
      });
      await rpcReq(mainWs, "sessions.messages.subscribe", {
        key: "global",
        agentId: "main",
      });
      await rpcReq(bareWs, "sessions.messages.subscribe", {
        key: "global",
      });

      const mainMessagePromise = waitForSessionMessageEvent(mainWs, "global");
      const bareMessagePromise = waitForSessionMessageEvent(bareWs, "global");
      const workMessagePromise = expectNoMessageWithin({
        watch: (timeoutMs) => waitForSessionMessageEvent(workWs, "global", timeoutMs),
        timeoutMs: 250,
      });
      emitSessionTranscriptUpdate({
        sessionFile: transcriptPath,
        sessionKey: "global",
        agentId: "main",
        message: transcriptMessage,
        messageId: "msg-default-scoped-global",
      });

      const mainMessage = await mainMessagePromise;
      const bareMessage = await bareMessagePromise;
      await workMessagePromise;
      expectRecordFields(mainMessage.payload, {
        sessionKey: "global",
        agentId: "main",
        messageId: "msg-default-scoped-global",
      });
      expectRecordFields(bareMessage.payload, {
        sessionKey: "global",
        agentId: "main",
        messageId: "msg-default-scoped-global",
      });
    } finally {
      workWs.close();
      mainWs.close();
      bareWs.close();
    }
  });

  test("includes spawnedBy metadata on session.message transcript events", async () => {
    const storePath = await createSessionStoreFile();
    const transcriptPath = path.join(path.dirname(storePath), "sess-child.jsonl");
    await writeSessionStore({
      entries: {
        child: {
          sessionId: "sess-child",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
          spawnedBy: "agent:main:main",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
          forkedFromParent: true,
          spawnDepth: 2,
          subagentRole: "orchestrator",
          subagentControlScope: "children",
          parentSessionKey: "agent:main:main",
        },
      },
      storePath,
    });
    const transcriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "spawn metadata snapshot" }],
      timestamp: Date.now(),
    };
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-child" }),
        JSON.stringify({ id: "msg-spawn", message: transcriptMessage }),
      ].join("\n"),
      "utf-8",
    );

    const ws = await harness.openWs();
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      await rpcReq(ws, "sessions.subscribe");

      const messageEventPromise = onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "session.message" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:child",
      );

      emitSessionTranscriptUpdate({
        sessionFile: transcriptPath,
        sessionKey: "agent:main:child",
        message: transcriptMessage,
        messageId: "msg-spawn",
      });

      const messageEvent = await messageEventPromise;
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:child",
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        parentSessionKey: "agent:main:main",
      });
    } finally {
      ws.close();
    }
  });

  test("includes route thread metadata on session.message transcript events", async () => {
    const storePath = await createSessionStoreFile();
    const transcriptPath = path.join(path.dirname(storePath), "sess-thread.jsonl");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-thread",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100123",
          lastAccountId: "acct-1",
          lastThreadId: 42,
        },
      },
      storePath,
    });
    const transcriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "thread route snapshot" }],
      timestamp: Date.now(),
    };
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-thread" }),
        JSON.stringify({ id: "msg-thread", message: transcriptMessage }),
      ].join("\n"),
      "utf-8",
    );

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:main",
        sessionFile: transcriptPath,
        message: transcriptMessage,
        messageId: "msg-thread",
      });
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        lastChannel: "telegram",
        lastTo: "-100123",
        lastAccountId: "acct-1",
        lastThreadId: 42,
      });
    });
  });

  test("sessions.messages.subscribe only delivers transcript events for the requested session", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
        worker: {
          sessionId: "sess-worker",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    const ws = await harness.openWs();
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      const subscribeRes = await rpcReq(ws, "sessions.messages.subscribe", {
        key: "agent:main:main",
      });
      expect(subscribeRes.ok).toBe(true);
      expect(subscribeRes.payload?.subscribed).toBe(true);
      expect(subscribeRes.payload?.key).toBe("agent:main:main");

      const mainEvent = waitForSessionMessageEvent(ws, "agent:main:main");
      const [mainAppend] = await Promise.all([
        appendAssistantMessageToSessionTranscript({
          sessionKey: "agent:main:main",
          text: "main only",
          storePath,
        }),
        mainEvent,
      ]);
      expect(mainAppend.ok).toBe(true);

      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "session.message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:worker",
            timeoutMs,
          ),
        action: async () => {
          const workerAppend = await appendAssistantMessageToSessionTranscript({
            sessionKey: "agent:main:worker",
            text: "worker hidden",
            storePath,
          });
          expect(workerAppend.ok).toBe(true);
        },
      });

      const unsubscribeRes = await rpcReq(ws, "sessions.messages.unsubscribe", {
        key: "agent:main:main",
      });
      expect(unsubscribeRes.ok).toBe(true);
      expect(unsubscribeRes.payload?.subscribed).toBe(false);

      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "session.message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:main",
            timeoutMs,
          ),
        action: async () => {
          const hiddenAppend = await appendAssistantMessageToSessionTranscript({
            sessionKey: "agent:main:main",
            text: "hidden after unsubscribe",
            storePath,
          });
          expect(hiddenAppend.ok).toBe(true);
        },
      });
    } finally {
      ws.close();
    }
  });

  test("streams worker commits and local-equivalent live events to the selected session", async () => {
    const storePath = await createSessionStoreFile();
    const sessionId = "sess-worker-commit-fanout";
    const sessionKey = "agent:main:worker";
    await writeSessionStore({
      entries: {
        worker: {
          sessionId,
          updatedAt: Date.now(),
        },
      },
      storePath,
    });
    const config: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }] },
      session: { mainKey: "main", store: storePath },
    };
    const ledger: WorkerTranscriptCommitStore = {
      begin: () => ({ kind: "claimed" }),
      complete: ({ outcome }) => outcome,
    };
    const committer = createWorkerTranscriptCommitter({ getConfig: () => config, store: ledger });
    const identity: WorkerConnectionIdentity = {
      environmentId: "environment-fanout",
      credentialHash: ["fanout", "credential", "hash"].join("-"),
      bundleHash: "f".repeat(64),
      sessionId,
      runId: "run-fanout",
      ownerEpoch: 4,
      rpcSetVersion: 1,
      protocolFeatures: ["worker-live-event-v1", "worker-transcript-commit-v1"],
      credentialExpiresAtMs: Date.now() + 10_000,
    };
    const receiver = createWorkerLiveEventReceiver({
      getConfig: () => config,
      startupBindings: [{ environmentId: identity.environmentId, runEpoch: 4, sessionId }],
      startupOwners: new Map([[identity.environmentId, 4]]),
    });
    const ws = await harness.openWs();
    const workerChats: Record<string, unknown>[] = [];
    const collectWorkerChats = (data: RawData) => {
      const message = JSON.parse(rawDataToString(data)) as {
        type?: string;
        event?: string;
        payload?: Record<string, unknown>;
      };
      if (
        message.type === "event" &&
        message.event === "chat" &&
        message.payload?.runId === "worker"
      ) {
        workerChats.push(message.payload);
      }
    };
    ws.on("message", collectWorkerChats);
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      const subscribeRes = await rpcReq(ws, "sessions.messages.subscribe", { key: sessionKey });
      expect(subscribeRes.ok).toBe(true);
      expect(subscribeRes.payload?.subscribed).toBe(true);
      expect(subscribeRes.payload?.key).toBe(sessionKey);

      const eventPromises = [1, 2, 3].map((messageSeq) =>
        onceMessage(
          ws,
          (message) =>
            message.type === "event" &&
            message.event === "session.message" &&
            (message.payload as { sessionKey?: unknown } | undefined)?.sessionKey === sessionKey &&
            (message.payload as { messageSeq?: unknown } | undefined)?.messageSeq === messageSeq,
        ),
      );
      const outcome = await committer.commit({
        identity,
        request: {
          runEpoch: identity.ownerEpoch,
          seq: 1,
          baseLeafId: null,
          messages: ["first", "second", "third"].map((text, index) => ({
            role: "user" as const,
            content: [{ type: "text" as const, text }],
            timestamp: 100 + index,
          })),
        },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        throw new Error(`expected worker transcript commit, received ${outcome.reason}`);
      }
      const events = await Promise.all(eventPromises);
      const payloads = events.map((event) =>
        requireRecord(event.payload, "session.message payload"),
      );
      expect(payloads.map((payload) => payload.messageId)).toEqual(outcome.result.entryIds);
      expect(payloads.map((payload) => payload.messageSeq)).toEqual([1, 2, 3]);
      expect(
        payloads.map((payload) => {
          const message = requireRecord(payload.message, "session.message payload message");
          return requireRecord(message["__openclaw"], "session.message metadata").id;
        }),
      ).toEqual(outcome.result.entryIds);
      expect(
        payloads.map((payload) => {
          const message = requireRecord(payload.message, "session.message payload message");
          return requireRecord(message["__openclaw"], "session.message metadata").seq;
        }),
      ).toEqual([1, 2, 3]);

      const waitForChat = (runId: string, timeoutMs?: number) =>
        onceMessage(
          ws,
          ({ type, event, payload }) =>
            type === "event" &&
            event === "chat" &&
            (payload as Record<string, unknown>).runId === runId,
          timeoutMs,
        );
      const liveEvent = {
        event: { kind: "assistant", payload: { text: "hello", delta: "hello" } },
        lastAckedSeq: 0,
        seq: 1,
      } as const;
      const push = (runEpoch = 4, runId = "worker") =>
        receiver.apply({ identity, request: { ...liveEvent, runEpoch, runId } });
      const [workerEvent] = await Promise.all([
        waitForChat("worker"),
        expectNoMessageWithin({
          watch: (timeoutMs) => waitForSessionMessageEvent(ws, sessionKey, timeoutMs),
          action: () => expect(push().ok).toBe(true),
        }),
      ]);
      const workerChat = requireRecord(workerEvent.payload, "worker chat");
      await expectNoMessageWithin({
        watch: (timeoutMs) => waitForChat("worker", timeoutMs),
        action: () => {
          expect(push()).toEqual({ ok: true, result: { ackedSeq: 1 } });
        },
      });
      expect(workerChats).toHaveLength(1);

      claimAgentRunContext("local", {
        sessionKey,
        sessionId,
        agentId: "main",
        isControlUiVisible: false,
      });
      const localEvent = waitForChat("local");
      emitAgentEvent({
        runId: "local",
        stream: "assistant",
        data: { text: "hello", delta: "hello" },
      });
      const localChat = requireRecord((await localEvent).payload, "local chat");
      for (const payload of [workerChat, localChat]) {
        payload.runId = "normalized";
        requireRecord(payload.message, "chat message").timestamp = 0;
      }
      expect(workerChat).toEqual(localChat);
      await expectNoMessageWithin({
        watch: (timeoutMs) => waitForChat("stale", timeoutMs),
        action: () => expect(push(3, "stale").ok).toBe(false),
      });
    } finally {
      receiver.clear();
      clearAgentRunContext("local");
      ws.off("message", collectWorkerChats);
      ws.close();
    }
  });

  test("routes transcript-only SQLite marker updates to the matching session owner", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        older: {
          sessionId: "sess-old",
          updatedAt: Date.now(),
        },
        newer: {
          sessionId: "sess-new",
          updatedAt: Date.now() + 10,
        },
      },
      storePath,
    });
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "shared transcript update" }],
      timestamp: Date.now(),
    };
    const turn = await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId: "sess-new",
        sessionKey: "agent:main:newer",
        storePath,
      },
      {
        messages: [{ message }],
        updateMode: "none",
      },
    );

    await withOperatorSessionSubscriber(async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:newer");

      emitSessionTranscriptUpdate({
        sessionFile: turn.sessionFile,
        message,
        messageId: "msg-shared",
      });

      const messageEvent = await messageEventPromise;
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:newer",
        messageId: "msg-shared",
        messageSeq: 1,
      });
    });
  });
});
