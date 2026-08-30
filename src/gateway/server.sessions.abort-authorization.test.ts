import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";
import type { RawData } from "ws";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import {
  clearActiveEmbeddedRun,
  resolveActiveEmbeddedRunOwnerByRunId,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import * as subagentControl from "../agents/subagents/registry/subagent-control.js";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import * as queueCleanup from "../auto-reply/reply/queue/cleanup.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import { getExistingFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import * as chatAbort from "./chat-abort.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let harness: GatewayServerHarness;
let registration: MockInstance<typeof chatAbort.registerChatAbortController>;
let childCancellation: MockInstance<typeof subagentControl.killAllControlledSubagentRuns>;
let queueClearing: MockInstance<typeof queueCleanup.clearSessionQueues>;

beforeAll(async () => {
  harness = await startGatewayServerHarness();
  // Observe production admission and effects without replacing their implementations.
  registration = vi.spyOn(chatAbort, "registerChatAbortController");
  childCancellation = vi.spyOn(subagentControl, "killAllControlledSubagentRuns");
  queueClearing = vi.spyOn(queueCleanup, "clearSessionQueues");
});

beforeEach(async () => {
  agentCommandMock.mockReset();
  registration.mockClear();
  childCancellation.mockClear();
  queueClearing.mockClear();
  await prepareGatewayReplyRuntimeForTest();
});

afterAll(async () => {
  registration.mockRestore();
  childCancellation.mockRestore();
  queueClearing.mockRestore();
  await harness.close();
});

async function openOperator(device: string, scopes = ["operator.write"]) {
  const deviceIdentityPath = path.join(process.env.OPENCLAW_STATE_DIR!, `${device}.sqlite`);
  const client = await harness.openClient({
    scopes,
    deviceIdentityPath,
    prePairDevice: true,
  });
  expect(client.hello).toMatchObject({ auth: { role: "operator", scopes } });
  return {
    ...client,
    hello: client.hello as HelloOk,
    deviceId: loadOrCreateDeviceIdentity({ path: deviceIdentityPath }).deviceId,
  };
}

async function startNativeRun(owner: Awaited<ReturnType<typeof openOperator>>, name: string) {
  const runId = `native-abort-${name}`;
  const sessionKey = `agent:main:${name}`;
  const started = createDeferred();
  const finish = createDeferred();
  const nativeAbort = vi.fn();
  let command: AgentCommandOpts;
  let handle: Parameters<typeof setActiveEmbeddedRun>[1];
  agentCommandMock.mockImplementationOnce(async (input) => {
    command = input as AgentCommandOpts;
    expect(command.abortSignal).toBeInstanceOf(AbortSignal);
    const runController = new AbortController();
    const abort = () => {
      nativeAbort();
      runController.abort();
    };
    handle = {
      runId,
      abort,
      cancel: abort,
      isAborted: () => runController.signal.aborted,
      isStreaming: () => !runController.signal.aborted,
      isCompacting: () => false,
      queueMessage: async () => {},
    };
    // Production relays the admitted controller signal into the native attempt.
    command.abortSignal!.addEventListener("abort", abort, { once: true });
    setActiveEmbeddedRun(command.sessionId!, handle, sessionKey);
    command.onExecutionStarted?.();
    started.resolve();
    try {
      await finish.promise;
    } finally {
      command.abortSignal!.removeEventListener("abort", abort);
      clearActiveEmbeddedRun(command.sessionId!, handle, sessionKey);
    }
  });
  const accepted = onceMessage(owner.ws, (frame) => frame.type === "res" && frame.id === runId);
  owner.ws.send(
    JSON.stringify({
      type: "req",
      id: runId,
      method: "agent",
      params: { message: "Keep this native run active", sessionKey, idempotencyKey: runId },
    }),
  );
  try {
    expect(await accepted).toMatchObject({ ok: true, payload: { runId, status: "accepted" } });
    await started.promise;
    const admission = registration.mock.calls.find(([input]) => input.runId === runId)?.[0];
    expect(admission).toBeDefined();
    const entry = admission!.chatAbortControllers.get(runId)!;
    expect(entry).toMatchObject({
      ownerConnId: owner.hello.server.connId,
      ownerDeviceId: owner.deviceId,
      kind: "agent",
      sessionKey,
    });
    expect(resolveActiveEmbeddedRunOwnerByRunId(runId)).toMatchObject({
      runId,
      sessionKey,
      sessionId: entry.sessionId,
    });
    return {
      runId,
      sessionKey,
      entry,
      nativeAbort,
      finish: async () => {
        // The modeled command cannot finish until released. Start its response
        // deadline here, not while the test deliberately holds execution open.
        const terminal = onceMessage(
          owner.ws,
          (frame) =>
            frame.type === "res" && frame.id === runId && frame.payload?.status !== "accepted",
        );
        finish.resolve();
        await terminal;
      },
    };
  } catch (error) {
    finish.resolve();
    owner.ws.close();
    throw new Error("Native run admission fixture failed", { cause: error });
  }
}

describe("native sessions.abort requester authorization over WebSocket", () => {
  test("rejects a foreign write-only device without cancellation effects", async () => {
    const owner = await openOperator("owner", ["operator.read", "operator.write"]);
    const foreign = await openOperator("foreign");
    expect(foreign.hello.server.connId).not.toBe(owner.hello.server.connId);
    expect(foreign.deviceId).not.toBe(owner.deviceId);
    const run = await startNativeRun(owner, "foreign");
    expect(await rpcReq(owner.ws, "sessions.subscribe", {})).toMatchObject({
      ok: true,
      payload: { subscribed: true },
    });
    const events: string[] = [];
    const record = (data: RawData) => {
      const frame = JSON.parse(rawDataToString(data)) as {
        type?: string;
        event?: string;
        payload?: { sessionKey?: string; state?: string; reason?: string };
      };
      if (
        frame.type === "event" &&
        frame.payload?.sessionKey === run.sessionKey &&
        ((frame.event === "chat" && frame.payload.state === "aborted") ||
          (frame.event === "sessions.changed" && frame.payload.reason === "abort"))
      ) {
        events.push(frame.event);
      }
    };
    owner.ws.on("message", record);
    const queued = createQueueTestRun({ prompt: "preserve queued followup" });
    enqueueFollowupRun(run.sessionKey, queued, { mode: "collect" });
    const queue = getExistingFollowupQueue(run.sessionKey)!;
    try {
      // A no-op on this same method proves that scope/participation gates admit
      // this client before the live controller's separate ownership check.
      expect(
        await rpcReq(foreign.ws, "sessions.abort", {
          key: run.sessionKey,
          runId: "no-such-native-run",
        }),
      ).toMatchObject({ ok: true, payload: { status: "no-active-run" } });
      expect(
        await rpcReq(foreign.ws, "chat.abort", { sessionKey: run.sessionKey, runId: run.runId }),
      ).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "unauthorized" },
      });
      const result = await rpcReq(foreign.ws, "sessions.abort", {
        key: run.sessionKey,
        runId: run.runId,
        clearQueued: true,
      });
      // Drain the real publisher, then cross a same-socket response barrier.
      flushPendingSessionsChangedEvents();
      expect(await rpcReq(owner.ws, "sessions.subscribe", {})).toMatchObject({
        ok: true,
        payload: { subscribed: true },
      });
      expect
        .soft(result)
        .toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", message: "unauthorized" } });
      expect.soft(run.entry.controller.signal.aborted).toBe(false);
      expect.soft(run.nativeAbort).not.toHaveBeenCalled();
      expect.soft(childCancellation).not.toHaveBeenCalled();
      expect.soft(queueClearing).not.toHaveBeenCalled();
      expect.soft(getExistingFollowupQueue(run.sessionKey)).toBe(queue);
      expect.soft(queue.items).toEqual([queued]);
      expect.soft(queue.abortController.signal.aborted).toBe(false);
      expect.soft(events).toEqual([]);
      // Witness the same subscription receiving a legitimate abort so the
      // preceding absence check cannot pass merely because nothing was subscribed.
      expect(
        await rpcReq(owner.ws, "sessions.abort", { key: run.sessionKey, runId: run.runId }),
      ).toMatchObject({ ok: true, payload: { status: "aborted", abortedRunId: run.runId } });
      await expect.poll(() => events).toContain("sessions.changed");
    } finally {
      owner.ws.off("message", record);
      queueCleanup.clearSessionQueues([run.sessionKey]);
      await run.finish();
      owner.ws.close();
      foreign.ws.close();
    }
  });

  test.each(["owner", "same-device", "admin"])("preserves Stop by %s", async (requester) => {
    const owner = await openOperator(`owner-${requester}`);
    const stopper =
      requester === "owner"
        ? owner
        : await openOperator(
            requester === "same-device" ? `owner-${requester}` : "admin",
            requester === "admin" ? ["operator.admin"] : ["operator.write"],
          );
    if (requester !== "owner") {
      expect(stopper.hello.server.connId).not.toBe(owner.hello.server.connId);
    }
    if (requester === "same-device") {
      expect(stopper.deviceId).toBe(owner.deviceId);
    }
    const run = await startNativeRun(owner, requester);
    try {
      expect(
        await rpcReq(stopper.ws, "sessions.abort", { key: run.sessionKey, runId: run.runId }),
      ).toMatchObject({
        ok: true,
        payload: { status: "aborted", abortedRunId: run.runId },
      });
      expect(run.entry.controller.signal.aborted).toBe(true);
      expect(run.nativeAbort).toHaveBeenCalledTimes(1);
    } finally {
      await run.finish();
      owner.ws.close();
      stopper.ws.close();
    }
  });

  test("preserves controller-less native Stop", async () => {
    const owner = await openOperator("recovered-owner");
    const sessionKey = "agent:main:recovered";
    const runId = "native-recovered";
    const abort = vi.fn();
    const handle = {
      runId,
      abort,
      isStreaming: () => true,
      isCompacting: () => false,
      queueMessage: async () => {},
    };
    setActiveEmbeddedRun("recovered-session", handle, sessionKey);
    try {
      expect(await rpcReq(owner.ws, "sessions.abort", { key: sessionKey, runId })).toMatchObject({
        ok: true,
        payload: { status: "aborted", abortedRunId: runId },
      });
      expect(abort).toHaveBeenCalledTimes(1);
    } finally {
      clearActiveEmbeddedRun("recovered-session", handle, sessionKey);
      owner.ws.close();
    }
  });
});
