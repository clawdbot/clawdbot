import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
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
) {
  return onceMessage(
    ws,
    (message) =>
      message.type === "event" &&
      message.event === "session.message" &&
      (message.payload as { sessionKey?: string } | undefined)?.sessionKey === sessionKey,
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

async function emitTranscriptUpdateAndCollectEvents(params: {
  ws: Awaited<ReturnType<Awaited<ReturnType<typeof createGatewaySuiteHarness>>["openWs"]>>;
  sessionKey: string;
  sessionFile: string;
  message: Record<string, unknown>;
  messageId: string;
}) {
  const messageEventPromise = waitForSessionMessageEvent(params.ws, params.sessionKey);
  const changedEventPromise = waitForSessionsChangedMessagePhase(params.ws, params.sessionKey);

  emitSessionTranscriptUpdate({
    sessionFile: params.sessionFile,
    sessionKey: params.sessionKey,
    message: params.message,
    messageId: params.messageId,
  });

  const [messageEvent, changedEvent] = await Promise.all([
    messageEventPromise,
    changedEventPromise,
  ]);
  return { messageEvent, changedEvent };
}

async function expectNoMessageWithin(params: {
  action?: () => Promise<void> | void;
  watch: () => Promise<unknown>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 300;
  let received = false;
  const watch = params
    .watch()
    .then(() => {
      received = true;
    })
    .catch(() => undefined);
  await params.action?.();
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  expect(received).toBe(false);
  await watch;
}

describe("session.message websocket events", () => {
  test("includes spawned session ownership metadata on lifecycle sessions.changed events", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        child: {
          sessionId: "sess-child",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:parent",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
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
      expect(event.payload).toMatchObject({
        sessionKey: "agent:main:child",
        reason: "reactivated",
        spawnedBy: "agent:main:parent",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        displayName: "Ops Child",
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
      await expect(subscribedEvent).resolves.toBeTruthy();
      await expectNoMessageWithin({
        watch: () =>
          onceMessage(
            unsubscribedWs,
            (message) => message.type === "event" && message.event === "session.message",
            300,
          ),
      });
      await expectNoMessageWithin({
        watch: () =>
          onceMessage(
            nodeWs,
            (message) => message.type === "event" && message.event === "session.message",
            300,
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
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionFile: appended.sessionFile,
          sessionKey: "agent:main:main",
          messageId: appended.messageId,
          message: expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "live websocket message" }],
          }),
        }),
      );
      const transcript = await fs.readFile(appended.sessionFile, "utf-8");
      expect(transcript).toContain('"live websocket message"');
    } finally {
      emitSpy.mockRestore();
    }
  });

  test("includes live usage metadata on session.message and sessions.changed transcript events", async () => {
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
    const transcriptPath = path.join(path.dirname(storePath), "sess-main.jsonl");
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
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
        JSON.stringify({ id: "msg-usage", message: transcriptMessage }),
      ].join("\n"),
      "utf-8",
    );

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent, changedEvent } = await emitTranscriptUpdateAndCollectEvents({
        ws,
        sessionKey: "agent:main:main",
        sessionFile: transcriptPath,
        message: transcriptMessage,
        messageId: "msg-usage",
      });
      expect(messageEvent.payload).toMatchObject({
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
      expect(changedEvent.payload).toMatchObject({
        sessionKey: "agent:main:main",
        phase: "message",
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

  test("includes spawnedBy metadata on session.message and sessions.changed transcript events", async () => {
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
      const changedEventPromise = onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "sessions.changed" &&
          (message.payload as { phase?: string; sessionKey?: string } | undefined)?.phase ===
            "message" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:child",
      );

      emitSessionTranscriptUpdate({
        sessionFile: transcriptPath,
        sessionKey: "agent:main:child",
        message: transcriptMessage,
        messageId: "msg-spawn",
      });

      const [messageEvent, changedEvent] = await Promise.all([
        messageEventPromise,
        changedEventPromise,
      ]);
      expect(messageEvent.payload).toMatchObject({
        sessionKey: "agent:main:child",
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        parentSessionKey: "agent:main:main",
      });
      expect(changedEvent.payload).toMatchObject({
        sessionKey: "agent:main:child",
        phase: "message",
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

  test("includes route thread metadata on session.message and sessions.changed transcript events", async () => {
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
      const { messageEvent, changedEvent } = await emitTranscriptUpdateAndCollectEvents({
        ws,
        sessionKey: "agent:main:main",
        sessionFile: transcriptPath,
        message: transcriptMessage,
        messageId: "msg-thread",
      });
      expect(messageEvent.payload).toMatchObject({
        sessionKey: "agent:main:main",
        lastChannel: "telegram",
        lastTo: "-100123",
        lastAccountId: "acct-1",
        lastThreadId: 42,
      });
      expect(changedEvent.payload).toMatchObject({
        sessionKey: "agent:main:main",
        phase: "message",
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
        watch: () =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "session.message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:worker",
            300,
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
        watch: () =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "session.message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:main",
            300,
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

  test("routes transcript-only updates to the freshest session owner when different sessionIds share a transcript path", async () => {
    const storePath = await createSessionStoreFile();
    const transcriptPath = path.join(path.dirname(storePath), "shared.jsonl");
    await writeSessionStore({
      entries: {
        older: {
          sessionId: "sess-old",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
        },
        newer: {
          sessionId: "sess-new",
          sessionFile: transcriptPath,
          updatedAt: Date.now() + 10,
        },
      },
      storePath,
    });
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-new" }),
        JSON.stringify({
          id: "msg-shared",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "shared transcript update" }],
            timestamp: Date.now(),
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    await withOperatorSessionSubscriber(async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:newer");

      emitSessionTranscriptUpdate({
        sessionFile: transcriptPath,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "shared transcript update" }],
          timestamp: Date.now(),
        },
        messageId: "msg-shared",
      });

      const messageEvent = await messageEventPromise;
      expect(messageEvent.payload).toMatchObject({
        sessionKey: "agent:main:newer",
        messageId: "msg-shared",
        messageSeq: 1,
      });
    });
  });
});
