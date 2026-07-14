/**
 * Tests chat abort authorization checks for gateway clients and session owners.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";
import { chatHandlers } from "./chat.js";

vi.mock("../session-utils.js", async () => {
  return {
    ...(await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js")),
    loadSessionEntry: () => ({ entry: { sessionId: "main-session" } }),
  };
});

type AbortResponsePayload = {
  aborted?: boolean;
  runIds?: string[];
};
type AbortRespond = Awaited<ReturnType<typeof invokeChatAbortHandler>>;

async function invokeAbort({
  context,
  sessionKey = "main",
  runId,
  connId,
  deviceId,
  preserveSideRuns,
  scopes = ["operator.write"],
}: {
  context: ReturnType<typeof createChatAbortContext>;
  sessionKey?: string;
  runId?: string;
  connId: string;
  deviceId: string;
  preserveSideRuns?: boolean;
  scopes?: string[];
}) {
  return await invokeChatAbortHandler({
    handler: expectDefined(chatHandlers["chat.abort"], 'chatHandlers["chat.abort"] test invariant'),
    context,
    request: {
      sessionKey,
      ...(runId ? { runId } : {}),
      ...(preserveSideRuns ? { preserveSideRuns: true } : {}),
    },
    client: {
      connId,
      connect: { device: { id: deviceId }, scopes },
    },
  });
}

function createSingleAbortContext() {
  return createChatAbortContext({
    chatAbortControllers: new Map([
      [
        "run-1",
        createActiveRun("main", { owner: { connId: "conn-owner", deviceId: "dev-owner" } }),
      ],
    ]),
  });
}

function requireLastRespondCall(respond: AbortRespond) {
  const calls = respond.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected respond call");
  }
  return call;
}

function expectAbortPayload(
  payload: unknown,
  expected: { aborted: boolean; runIds: string[] },
): void {
  const abortPayload = payload as AbortResponsePayload | undefined;
  expect(abortPayload?.aborted).toBe(expected.aborted);
  expect(abortPayload?.runIds).toEqual(expected.runIds);
}

describe("chat.abort authorization", () => {
  it("rejects non-admin worker-only inference aborts", async () => {
    const cancelInferenceForSession = vi.fn(() => ["worker-run"]);
    const context = createChatAbortContext({
      workerEnvironmentService: {
        cancelInferenceForSession,
        hasInferenceForSession: () => true,
        resolveInferenceSessionForRunId: () => "main-session",
      },
    });
    for (const runId of [undefined, "worker-run"]) {
      const respond = await invokeAbort({
        context,
        runId,
        connId: "conn-other",
        deviceId: "dev-other",
      });
      expect(requireLastRespondCall(respond)[2]?.message).toBe("unauthorized");
    }
    expect(cancelInferenceForSession).not.toHaveBeenCalled();

    const admin = await invokeAbort({
      context,
      runId: "worker-run",
      connId: "conn-admin",
      deviceId: "dev-admin",
      scopes: ["operator.admin"],
    });
    expectAbortPayload(requireLastRespondCall(admin)[1], {
      aborted: true,
      runIds: ["worker-run"],
    });
    expect(cancelInferenceForSession).toHaveBeenCalledWith({
      sessionId: "main-session",
      runId: "worker-run",
    });
  });

  it("does not let a local run owner cancel worker inference", async () => {
    for (const runId of [undefined, "run-1"]) {
      const cancelInferenceForSession = vi.fn(() => ["run-1"]);
      const context = createSingleAbortContext();
      context.workerEnvironmentService = { cancelInferenceForSession } as never;
      const respond = await invokeAbort({
        context,
        ...(runId ? { runId } : {}),
        connId: "conn-owner",
        deviceId: "dev-owner",
      });
      expectAbortPayload(requireLastRespondCall(respond)[1], {
        aborted: true,
        runIds: ["run-1"],
      });
      expect(cancelInferenceForSession).not.toHaveBeenCalled();
    }
  });

  it("rejects explicit run aborts from other clients", async () => {
    const context = createSingleAbortContext();

    const respond = await invokeAbort({
      context,
      runId: "run-1",
      connId: "conn-other",
      deviceId: "dev-other",
      scopes: ["operator.write"],
    });

    const [ok, payload, error] = requireLastRespondCall(respond);
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.code).toBe("INVALID_REQUEST");
    expect(error?.message).toBe("unauthorized");
    expect(context.chatAbortControllers.has("run-1")).toBe(true);
  });

  it("allows the same paired device to abort after reconnecting", async () => {
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-1", createActiveRun("main", { owner: { connId: "conn-old", deviceId: "dev-1" } })],
      ]),
    });

    const respond = await invokeAbort({
      context,
      runId: "run-1",
      connId: "conn-new",
      deviceId: "dev-1",
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { aborted: true, runIds: ["run-1"] });
    expect(context.chatAbortControllers.has("run-1")).toBe(false);
  });

  it("does not abort hidden internal runs by visible session key", async () => {
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-hidden", createActiveRun("main", { controlUiVisible: false })],
      ]),
    });

    const respond = await invokeAbort({
      context,
      connId: "conn-owner",
      deviceId: "dev-owner",
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { aborted: false, runIds: [] });
    expect(context.chatAbortControllers.has("run-hidden")).toBe(true);
  });

  it("preserves BTW runs for TUI session stops", async () => {
    const main = createActiveRun("main", {
      owner: { connId: "conn-owner", deviceId: "dev-owner" },
    });
    const btw = createActiveRun("main", {
      owner: { connId: "conn-owner", deviceId: "dev-owner" },
      turnKind: "btw",
    });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-main", main],
        ["run-btw", btw],
      ]),
    });

    const respond = await invokeAbort({
      context,
      connId: "conn-owner",
      deviceId: "dev-owner",
      preserveSideRuns: true,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { aborted: true, runIds: ["run-main"] });
    expect(main.controller.signal.aborted).toBe(true);
    expect(btw.controller.signal.aborted).toBe(false);
    expect(context.chatAbortControllers.has("run-btw")).toBe(true);
  });

  it("preserves BTW runs waiting for chat admission", async () => {
    const context = createChatAbortContext();
    context.dedupe.set("pending-chat:run-btw", {
      ts: Date.now(),
      ok: true,
      payload: {
        runId: "run-btw",
        sessionKey: "main",
        status: "accepted",
        turnKind: "btw",
        ownerConnId: "conn-owner",
        ownerDeviceId: "dev-owner",
      },
    });

    const respond = await invokeAbort({
      context,
      connId: "conn-owner",
      deviceId: "dev-owner",
      preserveSideRuns: true,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { aborted: false, runIds: [] });
    expect(context.dedupe.get("pending-chat:run-btw")).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ status: "accepted", turnKind: "btw" }),
      }),
    );
  });

  it("clears agent text throttle state through the real abort caller", async () => {
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-1", createActiveRun("main", { owner: { connId: "conn-owner", deviceId: "dev-1" } })],
      ]),
      agentDeltaSentAt: new Map([["run-1:assistant", Date.now()]]),
      bufferedAgentEvents: new Map([
        [
          "run-1:assistant",
          {
            payload: {
              runId: "run-1",
              seq: 1,
              stream: "assistant",
              ts: Date.now(),
              data: { text: "pending", delta: "pending" },
            },
          },
        ],
      ]),
    });

    const respond = await invokeAbort({
      context,
      runId: "run-1",
      connId: "conn-owner",
      deviceId: "dev-1",
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true, runIds: ["run-1"] });
    expect(context.agentDeltaSentAt.has("run-1:assistant")).toBe(false);
    expect(context.bufferedAgentEvents.has("run-1:assistant")).toBe(false);
  });

  it("only aborts session-scoped runs owned by the requester", async () => {
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-mine", createActiveRun("main", { owner: { deviceId: "dev-1" } })],
        ["run-other", createActiveRun("main", { owner: { deviceId: "dev-2" } })],
      ]),
    });

    const respond = await invokeAbort({
      context,
      connId: "conn-1",
      deviceId: "dev-1",
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { aborted: true, runIds: ["run-mine"] });
    expect(context.chatAbortControllers.has("run-mine")).toBe(false);
    expect(context.chatAbortControllers.has("run-other")).toBe(true);
  });

  it("allows operator.admin clients to bypass owner checks", async () => {
    const context = createSingleAbortContext();

    const respond = await invokeAbort({
      context,
      runId: "run-1",
      connId: "conn-admin",
      deviceId: "dev-admin",
      scopes: ["operator.admin"],
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { aborted: true, runIds: ["run-1"] });
  });
});

describe("chat.abort queued-turn contract", () => {
  it("aborts a queued turn by runId after active registration is gone", async () => {
    const controller = new AbortController();
    const context = createChatAbortContext({
      chatQueuedTurns: new Map([
        [
          "queued-1",
          {
            controller,
            sessionId: "main-session",
            sessionKey: "main",
            ownerConnId: "conn-owner",
            ownerDeviceId: "dev-owner",
          },
        ],
      ]),
    });

    const respond = await invokeAbort({
      context,
      runId: "queued-1",
      connId: "conn-owner",
      deviceId: "dev-owner",
    });
    const call = requireLastRespondCall(respond);
    expect(call[0]).toBe(true);
    expectAbortPayload(call[1], { aborted: true, runIds: ["queued-1"] });
    expect(controller.signal.aborted).toBe(true);
    expect(context.chatQueuedTurns.has("queued-1")).toBe(false);
  });

  it("rejects queued-turn abort from other clients", async () => {
    const controller = new AbortController();
    const context = createChatAbortContext({
      chatQueuedTurns: new Map([
        [
          "queued-1",
          {
            controller,
            sessionId: "main-session",
            sessionKey: "main",
            ownerConnId: "conn-owner",
            ownerDeviceId: "dev-owner",
          },
        ],
      ]),
    });

    const respond = await invokeAbort({
      context,
      runId: "queued-1",
      connId: "conn-other",
      deviceId: "dev-other",
    });
    const call = requireLastRespondCall(respond);
    expect(call[0]).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    expect(context.chatQueuedTurns.has("queued-1")).toBe(true);
  });

  it("rejects a mismatched session for ownerless queued turns", async () => {
    const controller = new AbortController();
    const context = createChatAbortContext({
      chatQueuedTurns: new Map([
        [
          "queued-ownerless",
          {
            controller,
            sessionId: "main-session",
            sessionKey: "main",
          },
        ],
      ]),
    });

    const respond = await invokeAbort({
      context,
      sessionKey: "other",
      runId: "queued-ownerless",
      connId: "conn-other",
      deviceId: "dev-other",
    });
    const call = requireLastRespondCall(respond);
    expect(call[0]).toBe(false);
    expect(call[2]?.message).toBe("runId does not match sessionKey");
    expect(controller.signal.aborted).toBe(false);
    expect(context.chatQueuedTurns.has("queued-ownerless")).toBe(true);
  });

  it("session abort cancels authorized queued turns before active runs", async () => {
    const queuedController = new AbortController();
    const activeController = new AbortController();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        [
          "active-1",
          createActiveRun("main", { owner: { connId: "conn-owner", deviceId: "dev-owner" } }),
        ],
      ]),
      chatQueuedTurns: new Map([
        [
          "queued-1",
          {
            controller: queuedController,
            sessionId: "main-session",
            sessionKey: "main",
            ownerConnId: "conn-owner",
            ownerDeviceId: "dev-owner",
          },
        ],
      ]),
    });
    // replace active controller so we can observe abort
    const active = context.chatAbortControllers.get("active-1");
    if (active) {
      (active as { controller: AbortController }).controller = activeController;
    }

    const respond = await invokeAbort({
      context,
      connId: "conn-owner",
      deviceId: "dev-owner",
    });
    const call = requireLastRespondCall(respond);
    expect(call[0]).toBe(true);
    const payload = call[1] as AbortResponsePayload;
    expect(payload.aborted).toBe(true);
    expect(payload.runIds).toEqual(expect.arrayContaining(["queued-1", "active-1"]));
    expect(payload.runIds?.[0]).toBe("queued-1");
    expect(queuedController.signal.aborted).toBe(true);
    expect(activeController.signal.aborted).toBe(true);
    expect(context.chatQueuedTurns.size).toBe(0);
  });

  it("session abort does not clear another owner's queued turns", async () => {
    const foreign = new AbortController();
    const context = createChatAbortContext({
      chatQueuedTurns: new Map([
        [
          "queued-foreign",
          {
            controller: foreign,
            sessionId: "main-session",
            sessionKey: "main",
            ownerConnId: "conn-owner",
            ownerDeviceId: "dev-owner",
          },
        ],
      ]),
    });

    const respond = await invokeAbort({
      context,
      connId: "conn-other",
      deviceId: "dev-other",
    });
    const call = requireLastRespondCall(respond);
    // unauthorized when only foreign queued matches
    expect(call[0]).toBe(false);
    expect(foreign.signal.aborted).toBe(false);
    expect(context.chatQueuedTurns.has("queued-foreign")).toBe(true);
  });
});
