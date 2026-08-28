/**
 * Isolated-gateway proof for the #128971 terminal-receipt steer fence
 * (round-8 ClawSweeper evidence request).
 *
 * Round-8 blocked the PR on mock-only evidence again: the round-7 proof
 * replaced `dispatchInboundMessage` and the seam mock then constructed a test
 * follow-up run, scheduled its queue, and called `sendFinalReply` itself —
 * proving the mock's branch, not that a rejected steer reaches the production
 * dispatcher and produces a real outbound result. This file now drives that
 * real boundary:
 *
 *  - a real `installConnectedControlUiServerSuite` loopback Gateway with a
 *    real authenticated WebSocket client (no live credentials, no live
 *    channel);
 *  - the real `chat.send` RPC handler driving the real admission fence —
 *    the production handler path, not the admission starter called directly;
 *  - a real persisted session entry carrying a terminal tombstone for the
 *    active source turn (real session store + real receipt classifier);
 *  - the real `replyRunRegistry` recording the active source-turn identity;
 *  - the real `beginReplyMessageInjectionTarget` (spied) — the fence must
 *    reject before it queues anything;
 *  - the REAL production dispatcher: `dispatchInboundMessageMock` is reset
 *    (no implementation), so the gateway test module mock passes through to
 *    `dispatchInboundMessageWithProjectedDispatcher` — production
 *    `dispatchReplyFromConfig` pipeline, production reply delivery owner
 *    (`ReplyDispatcher` → chat transcript/finalization → `broadcastChatFinal`);
 *  - only the reply SOURCE is controlled: `mockGetReplyFromConfigOnce`
 *    supplies one deterministic reply payload (the same seam every gateway
 *    server-chat test uses to drive the real dispatcher deterministically;
 *    it replaces the LLM/agent-run reply source, not the delivery owner);
 *  - the REAL transport: the loopback WebSocket to the connected test client.
 *    The client records the `chat` wire events the production broadcast path
 *    emits and asserts exactly one outbound final carrying the reply text.
 *
 * The test never constructs a follow-up run, never schedules a queue, and
 * never calls `sendFinalReply`. The asserted reply is produced and delivered
 * by the production dispatcher and observed on the real wire transport.
 *
 * The wire-level assertions show: the inbound is rejected at the injection-
 * start boundary (zero steer enqueues into the live run), the rejected steer
 * reaches the production dispatcher exactly once (one reply-resolver
 * invocation carrying the inbound body and `messageInjectionDisposition:
 * "rejected"` — the fresh-turn disposition), and the production delivery
 * owner emits exactly one outbound final over the real transport (one
 * `chat.final` event carrying the reply text). A positive control (unrelated
 * historical tombstone) shows the steer is enqueued, and a before-fix control
 * (classifier weakened) shows the silent-loss race.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawData, WebSocket } from "ws";
import { installQueueRuntimeErrorSilencer } from "../../auto-reply/reply/queue.test-helpers.js";
import * as replyRunRegistryModule from "../../auto-reply/reply/reply-run-registry.js";
import {
  forceClearReplyOperation,
  createReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.operation.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.registry.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  mockGetReplyFromConfigOnce,
  rpcReq,
  testState,
  writeSessionStore,
} from "../test-helpers.js";
import { installConnectedControlUiServerSuite } from "../test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
installQueueRuntimeErrorSilencer();

const SESSION_KEY = "agent:main:main";
const SOURCE_TURN_ID = "source-failclosed-1";

type WireResponse = {
  ok: boolean;
  payload?: { status?: string; runId?: string; message?: string };
  error?: { message?: string; code?: string };
};

type DispatchCapture = {
  calls: number;
  lastCtx?: { Provider?: string; Body?: string; From?: string; To?: string };
  lastRunId?: string;
};

/**
 * Projection of the gateway-to-pipeline dispatch seam. The seam mock is typed
 * `(...args: unknown[]) => Promise<unknown>`, so implementations cast the
 * first argument to this shape.
 */
type DispatchInboundParams = {
  ctx: { Provider?: string; Body?: string; From?: string; To?: string };
  replyOptions?: { runId?: string };
  dispatcher: {
    sendFinalReply: (payload: { text: string }) => boolean;
    markComplete: () => void;
    waitForIdle: () => Promise<void>;
  };
};

const dispatchCapture: DispatchCapture = { calls: 0 };

/**
 * Observation of the production reply-resolver seam (`getReplyFromConfig`).
 * The real dispatcher consults this resolver once per dispatched turn; the
 * capture proves the rejected steer reached the production dispatcher with
 * the fresh-turn disposition instead of being injected into the live run.
 */
type ReplyResolverCapture = {
  calls: number;
  ctxBody?: string;
  runId?: string;
  messageInjectionDisposition?: unknown;
};

const resolverCapture: ReplyResolverCapture = { calls: 0 };

/** Wire-level projection of the `chat` event the gateway broadcasts to the client. */
type ChatWirePayload = {
  runId?: string;
  seq?: number;
  state?: string;
  message?: { text?: string; content?: unknown };
};

/** Concatenates the visible text a projected chat message can carry. */
function visibleMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const rec = message as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof rec.text === "string") {
    parts.push(rec.text);
  }
  if (Array.isArray(rec.content)) {
    for (const block of rec.content) {
      if (block && typeof block === "object") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") {
          parts.push(text);
        }
      }
    }
  }
  return parts.join(" ");
}

let ws: WebSocket;
const sharedTempDirs: string[] = [];
let liveOperation: { key: string; op: { complete: () => void } } | undefined;

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

beforeEach(async () => {
  dispatchInboundMessageMock.mockReset();
  dispatchCapture.calls = 0;
  delete dispatchCapture.lastCtx;
  delete dispatchCapture.lastRunId;
  resolverCapture.calls = 0;
  delete resolverCapture.ctxBody;
  delete resolverCapture.runId;
  delete resolverCapture.messageInjectionDisposition;
  // Tear down any reply operation left over from the prior test.
  if (liveOperation) {
    try {
      forceClearReplyOperation(liveOperation.op as never, "test-cleanup");
    } catch {
      // best-effort
    }
    liveOperation = undefined;
  }
  // Default dispatch: record the inbound, emit a final reply via the
  // dispatcher so the wire response and chat-final event settle.
  dispatchInboundMessageMock.mockImplementation(async (params: unknown) => {
    const p = params as DispatchInboundParams;
    dispatchCapture.calls += 1;
    dispatchCapture.lastCtx = p.ctx;
    dispatchCapture.lastRunId = p.replyOptions?.runId;
    p.dispatcher.sendFinalReply({ text: "after-fix follow-up reply" });
    p.dispatcher.markComplete();
    await p.dispatcher.waitForIdle();
    return {
      queuedFinal: true,
      counts: { final: 1, block: 0, tool: 0 },
    };
  });
});

/**
 * Allocate a temp dir for the session store. Cleanup is deferred until
 * `afterAll` (after the gateway closes and releases the agent-sqlite
 * handle) — `fs.rm` mid-suite fails with EBUSY while the gateway holds the
 * sqlite-shm file open.
 */
async function makeSessionDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-iso-gw-"));
  sharedTempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  if (liveOperation) {
    try {
      forceClearReplyOperation(liveOperation.op as never, "test-cleanup-final");
    } catch {
      // best-effort
    }
    liveOperation = undefined;
  }
  for (const dir of sharedTempDirs.splice(0)) {
    // Best-effort cleanup: the gateway may still hold the agent-sqlite
    // handle on Windows even after suite teardown. The temp dir is throwaway
    // — skip silently if the OS still has it locked, so the suite reports
    // its (green) test results rather than failing in teardown.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  testState.sessionStorePath = undefined;
});

describe("terminal-receipt steer fence isolated-gateway proof (#128971 round-8)", () => {
  /**
   * Drive a real chat.send RPC over a real loopback Gateway WebSocket against
   * a session whose latest persisted entry tombstones the active source turn.
   * The rejected steer must flow through the REAL production dispatcher and
   * the production delivery owner must emit exactly one outbound result over
   * the real transport. The test never constructs a follow-up run, never
   * schedules a queue, and never calls `sendFinalReply`.
   */
  it(
    "isolated gateway: a rejected steer flows through the real production dispatcher and yields exactly one outbound reply over the real transport",
    { timeout: 30_000 },
    async () => {
      const dir = await makeSessionDir();
      testState.sessionStorePath = path.join(dir, "sessions.json");
      // Real persisted entry: terminal tombstone for the active source turn.
      await writeSessionStore({
        entries: {
          [SESSION_KEY]: {
            sessionId: "session-failclosed",
            updatedAt: Date.now(),
            restartRecoveryTerminalRunIds: [SOURCE_TURN_ID],
            restartRecoveryDeliverySourceRunId: SOURCE_TURN_ID,
            status: "running",
          },
        },
      });
      // Real reply-run registry: a live run owns this source turn.
      const operation = createReplyOperation({
        sessionKey: SESSION_KEY,
        sessionId: "session-failclosed",
        resetTriggered: false,
      });
      liveOperation = { key: SESSION_KEY, op: operation as never };
      operation.setPhase("running");
      // Attach a backend so the gate resolves an injection target (not
      // "injection_unavailable"); the steer is then attempted through the
      // real fence and either enqueued or rejected by it.
      operation.attachBackend({
        kind: "embedded",
        runId: "live-run-failclosed",
        cancel: () => {},
        isStreaming: () => false,
        messageInjection: {
          isAvailable: () => true,
          queueMessage: async () => {},
        },
      });
      replyRunRegistry.bindSourceTurnId(SESSION_KEY, SOURCE_TURN_ID);

      const registrySpy = vi.spyOn(replyRunRegistryModule, "beginReplyMessageInjectionTarget");

      // REAL production dispatcher: no seam implementation. The gateway test
      // module mock then passes dispatchInboundMessageWithProjectedDispatcher
      // straight through to production (dispatchReplyFromConfig pipeline +
      // production reply delivery owner). The mocked seam must never run.
      dispatchInboundMessageMock.mockReset();

      // Controlled reply SOURCE: the production dispatcher consults
      // getReplyFromConfig for the reply payload (the agent-run/LLM source is
      // out of scope). Everything downstream — the dispatcher pipeline, the
      // reply delivery owner, the broadcast — is production code.
      const replyText = "after-fix follow-up reply from the production dispatcher";
      mockGetReplyFromConfigOnce(async (ctx, opts) => {
        resolverCapture.calls += 1;
        resolverCapture.ctxBody = (ctx as { Body?: string }).Body;
        const options = (opts ?? {}) as { runId?: string; messageInjectionDisposition?: unknown };
        resolverCapture.runId = options.runId;
        resolverCapture.messageInjectionDisposition = options.messageInjectionDisposition;
        return { text: replyText };
      });

      // Recording transport: the REAL transport is the loopback WebSocket
      // back to the connected test client. Record every `chat` wire event
      // the production broadcast path emits for this run.
      const runId = `idem-iso-gw-${randomUUID()}`;
      const chatFrames: ChatWirePayload[] = [];
      const onChatFrame = (raw: RawData) => {
        try {
          const frame = JSON.parse(rawDataToString(raw)) as {
            type?: string;
            event?: string;
            payload?: ChatWirePayload;
          };
          if (frame.type === "event" && frame.event === "chat" && frame.payload?.runId === runId) {
            chatFrames.push(frame.payload);
          }
        } catch {
          // Unrelated frames on the shared test socket.
        }
      };
      ws.on("message", onChatFrame);
      try {
        const res = (await rpcReq(
          ws,
          "chat.send",
          {
            sessionKey: SESSION_KEY,
            message: "round-8 isolated-gateway inbound",
            idempotencyKey: runId,
            queueMode: "steer",
          },
          20_000,
        )) as WireResponse;

        // Wire-level proof: the gateway admitted the inbound for dispatch.
        expect(res.ok).toBe(true);
        expect(res.payload?.status).toBe("started");
        expect(res.payload?.runId).toBe(runId);

        // Fence-level proof: no steer was ever enqueued into the live run.
        expect(registrySpy).not.toHaveBeenCalled();

        // Production-dispatcher proof: the rejected steer reached the real
        // dispatcher exactly once, as its own fresh turn — the client run id
        // with the "rejected" injection disposition — carrying the inbound
        // body. The mocked seam never handled the dispatch.
        await vi.waitFor(() => expect(resolverCapture.calls).toBe(1), {
          interval: 50,
          timeout: 15_000,
        });
        expect(resolverCapture.ctxBody).toBe("round-8 isolated-gateway inbound");
        expect(resolverCapture.runId).toBe(runId);
        expect(resolverCapture.messageInjectionDisposition).toBe("rejected");
        expect(dispatchCapture.calls).toBe(0);

        // Transport-level proof: the production delivery owner emitted
        // exactly one outbound final over the real transport, carrying the
        // reply text produced through the real dispatcher.
        await vi.waitFor(
          () => {
            expect(chatFrames.some((frame) => frame.state === "final")).toBe(true);
          },
          { interval: 50, timeout: 15_000 },
        );
        // Quiet-period check: no second terminal may follow the first.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
        const finals = chatFrames.filter((frame) => frame.state === "final");
        expect(finals.length).toBe(1);
        const finalMessage = finals[0]?.message;
        expect(visibleMessageText(finalMessage)).toContain(replyText);
      } finally {
        ws.off("message", onChatFrame);
      }

      registrySpy.mockRestore();
    },
  );

  /**
   * Positive control: same isolated gateway, but the persisted tombstone
   * belongs to an *unrelated* prior source turn. The fence scopes the
   * classification to the active source (round-5 fix), so a safe steer is
   * accepted — `beginReplyMessageInjectionTarget` IS called. This locks in
   * that the after-fix behavior is gated on source identity, not on the
   * mere presence of any tombstone.
   */
  it(
    "isolated gateway: still steers when the tombstone belongs to an unrelated prior source turn",
    { timeout: 30_000 },
    async () => {
      const dir = await makeSessionDir();
      testState.sessionStorePath = path.join(dir, "sessions.json");
      await writeSessionStore({
        entries: {
          [SESSION_KEY]: {
            sessionId: "session-unrelated",
            updatedAt: Date.now(),
            // Tombstone on an unrelated earlier source turn.
            restartRecoveryTerminalRunIds: ["source-old"],
            status: "running",
          },
        },
      });
      const operation = createReplyOperation({
        sessionKey: SESSION_KEY,
        sessionId: "session-unrelated",
        resetTriggered: false,
      });
      liveOperation = { key: SESSION_KEY, op: operation as never };
      operation.setPhase("running");
      operation.attachBackend({
        kind: "embedded",
        runId: "live-run-unrelated",
        cancel: () => {},
        isStreaming: () => false,
        messageInjection: {
          isAvailable: () => true,
          queueMessage: async () => {},
        },
      });
      // Bind a different active source turn than the tombstoned one.
      replyRunRegistry.bindSourceTurnId(SESSION_KEY, SOURCE_TURN_ID);

      // Spy and resolve so the steer path is observable. Return a valid
      // attempt with acceptance=true so the chat-send handler treats the
      // steer as enqueued (skips follow-up dispatch) instead of falling
      // through to the dispatch boundary on an undefined attempt.
      const registrySpy = vi
        .spyOn(replyRunRegistryModule, "beginReplyMessageInjectionTarget")
        .mockImplementation(() => ({
          targetRunId: "live-run-unrelated",
          acceptance: Promise.resolve(true),
          outcome: Promise.resolve({ status: "accepted" as const }),
        }));

      const runId = `idem-iso-gw-unrelated-${randomUUID()}`;
      const res = (await rpcReq(
        ws,
        "chat.send",
        {
          sessionKey: SESSION_KEY,
          message: "unrelated-tombstone inbound",
          idempotencyKey: runId,
          queueMode: "steer",
        },
        20_000,
      )) as WireResponse;

      expect(res.ok).toBe(true);
      expect(res.payload?.status).toBe("started");
      expect(registrySpy).toHaveBeenCalledTimes(1);
      // The safe-steer path took the steer, so the follow-up dispatch
      // boundary was NOT invoked (the steer is enqueued into the live run).
      expect(dispatchCapture.calls).toBe(0);

      registrySpy.mockRestore();
    },
  );

  /**
   * Before-fix regression control: stub the classifier to never fail-close
   * (i.e. the pre-fix behavior the gate is closing). With the classifier
   * weakened, the same isolated-gateway path enqueues the steer and does
   * NOT route to follow-up dispatch — exactly the silent-loss race the PR
   * closes.
   */
  it(
    "isolated gateway (before-fix control): with the classifier weakened, the steer is enqueued and follow-up dispatch is skipped",
    { timeout: 30_000 },
    async () => {
      const dir = await makeSessionDir();
      testState.sessionStorePath = path.join(dir, "sessions.json");
      await writeSessionStore({
        entries: {
          [SESSION_KEY]: {
            sessionId: "session-before-fix",
            updatedAt: Date.now(),
            restartRecoveryTerminalRunIds: [SOURCE_TURN_ID],
            restartRecoveryDeliverySourceRunId: SOURCE_TURN_ID,
            status: "running",
          },
        },
      });
      const operation = createReplyOperation({
        sessionKey: SESSION_KEY,
        sessionId: "session-before-fix",
        resetTriggered: false,
      });
      liveOperation = { key: SESSION_KEY, op: operation as never };
      operation.setPhase("running");
      operation.attachBackend({
        kind: "embedded",
        runId: "live-run-before-fix",
        cancel: () => {},
        isStreaming: () => false,
        messageInjection: {
          isAvailable: () => true,
          queueMessage: async () => {},
        },
      });
      replyRunRegistry.bindSourceTurnId(SESSION_KEY, SOURCE_TURN_ID);

      // Simulate the pre-fix classifier: never fail-closed.
      const receiptModule = await import("../../config/sessions/restart-recovery-receipt.js");
      const classifierSpy = vi
        .spyOn(receiptModule, "isRestartRecoveryTerminalDeliveryFailClosed")
        .mockReturnValue(false);

      const registrySpy = vi
        .spyOn(replyRunRegistryModule, "beginReplyMessageInjectionTarget")
        .mockImplementation(() => ({
          targetRunId: "live-run-before-fix",
          acceptance: Promise.resolve(true),
          outcome: Promise.resolve({ status: "accepted" as const }),
        }));

      const runId = `idem-iso-gw-before-${randomUUID()}`;
      const res = (await rpcReq(
        ws,
        "chat.send",
        {
          sessionKey: SESSION_KEY,
          message: "before-fix inbound",
          idempotencyKey: runId,
          queueMode: "steer",
        },
        20_000,
      )) as WireResponse;

      expect(res.ok).toBe(true);
      expect(res.payload?.status).toBe("started");
      // Pre-fix: the steer is enqueued (the silent-loss race the fence
      // closes). The follow-up dispatch boundary is not reached.
      expect(registrySpy).toHaveBeenCalled();
      expect(dispatchCapture.calls).toBe(0);

      classifierSpy.mockRestore();
      registrySpy.mockRestore();
    },
  );
});
