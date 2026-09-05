import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it, vi } from "vitest";
import { dispatchA2aInbound } from "./inbound.js";
import { A2aTaskStore } from "./task-store.js";
import type { ResolvedA2aChannelAccount } from "./types.js";

function createA2aDispatchResult(queuedFinal = true) {
  return { queuedFinal, counts: { tool: 0, block: 0, final: Number(queuedFinal) } };
}

function createA2aInboundFixture(peerName = "hermes") {
  const runtime = createPluginRuntimeMock();
  const store = new A2aTaskStore();
  const task = store.create("ctx-inbound", peerName);
  store.start(task.id);
  const account: ResolvedA2aChannelAccount = {
    accountId: "default",
    enabled: true,
    configured: true,
    config: { peers: { hermes: { token: "test-token" } } },
  };
  return {
    runtime,
    store,
    task,
    params: {
      account,
      config: {},
      channelRuntime: runtime.channel,
      buildContext: runtime.channel.inbound.buildContext,
      store,
      taskId: task.id,
      contextId: task.contextId,
      messageId: "incoming-message",
      peerName,
      text: "hello from an external agent",
    },
  };
}

describe("A2A channel inbound dispatch", () => {
  it("ignores non-final replies and completes the task with its final artifact", async () => {
    const fixture = createA2aInboundFixture();
    vi.mocked(fixture.runtime.channel.inbound.dispatch).mockImplementation(async (turn) => {
      await turn.delivery.deliver({ text: "preview" }, { kind: "block" });
      expect(fixture.store.get(fixture.task.id)?.status.state).toBe("TASK_STATE_WORKING");
      await turn.delivery.deliver({ text: "agent answer" }, { kind: "final" });
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: turn.ctxPayload,
        routeSessionKey: turn.route.sessionKey,
        dispatchResult: createA2aDispatchResult(),
      };
    });

    await dispatchA2aInbound(fixture.params);

    expect(fixture.store.get(fixture.task.id)).toEqual(
      expect.objectContaining({
        contextId: "ctx-inbound",
        status: expect.objectContaining({ state: "TASK_STATE_COMPLETED" }),
        artifacts: [expect.objectContaining({ parts: [{ text: "agent answer" }] })],
      }),
    );
    expect(fixture.runtime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "a2a",
        conversation: expect.objectContaining({ id: "ctx-inbound", kind: "direct" }),
        sender: { id: "hermes", name: "hermes" },
      }),
    );
    fixture.store.stop();
  });

  it("records dispatch failures on their task", async () => {
    const fixture = createA2aInboundFixture();
    vi.mocked(fixture.runtime.channel.inbound.dispatch).mockRejectedValue(
      new Error("provider unavailable"),
    );

    await dispatchA2aInbound(fixture.params);

    expect(fixture.store.get(fixture.task.id)?.status).toEqual(
      expect.objectContaining({
        state: "TASK_STATE_FAILED",
        message: expect.objectContaining({ parts: [{ text: "provider unavailable" }] }),
      }),
    );
    fixture.store.stop();
  });

  it("isolates route sessions and replies when distinct peers reuse one context ID", async () => {
    const fixture = createA2aInboundFixture();
    fixture.params.account.config.peers = {
      hermes: { token: "first-token" },
      crew: { token: "second-token" },
    };
    const crewTask = fixture.store.create(fixture.task.contextId, "crew");
    fixture.store.start(crewTask.id);
    vi.mocked(fixture.runtime.channel.inbound.dispatch).mockImplementation(async (turn) => {
      await turn.delivery.deliver({ text: String(turn.ctxPayload.From) }, { kind: "final" });
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: turn.ctxPayload,
        routeSessionKey: turn.route.sessionKey,
        dispatchResult: createA2aDispatchResult(),
      };
    });
    const config = { session: { dmScope: "per-channel-peer" as const } };

    await Promise.all([
      dispatchA2aInbound({ ...fixture.params, config }),
      dispatchA2aInbound({
        ...fixture.params,
        config,
        taskId: crewTask.id,
        messageId: "crew-message",
        peerName: "crew",
      }),
    ]);

    const dispatches = vi.mocked(fixture.runtime.channel.inbound.dispatch).mock.calls;
    expect(dispatches[0]?.[0].route.sessionKey).not.toBe(dispatches[1]?.[0].route.sessionKey);
    expect(fixture.store.get(fixture.task.id)?.artifacts[0]?.parts[0]).toEqual({
      text: "a2a:hermes",
    });
    expect(fixture.store.get(crewTask.id)?.artifacts[0]?.parts[0]).toEqual({ text: "a2a:crew" });
    fixture.store.stop();
  });

  it("rejects a sender missing from the configured peer allowlist before dispatch", async () => {
    const fixture = createA2aInboundFixture("unknown-peer");

    await dispatchA2aInbound(fixture.params);

    expect(fixture.store.get(fixture.task.id)?.status.state).toBe("TASK_STATE_REJECTED");
    expect(fixture.runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    fixture.store.stop();
  });

  it("rejects turns that the runtime declines instead of leaving tasks working forever", async () => {
    const fixture = createA2aInboundFixture();
    vi.mocked(fixture.runtime.channel.inbound.dispatch).mockResolvedValue({
      admission: { kind: "drop", reason: "policy-blocked" },
      dispatched: false,
    });

    await dispatchA2aInbound(fixture.params);

    expect(fixture.store.get(fixture.task.id)?.status.state).toBe("TASK_STATE_REJECTED");
    fixture.store.stop();
  });

  it("fails turns accepted for dispatch when the runtime does not actually run them", async () => {
    const fixture = createA2aInboundFixture();
    vi.mocked(fixture.runtime.channel.inbound.dispatch).mockResolvedValue({
      admission: { kind: "dispatch" },
      dispatched: false,
    });

    await dispatchA2aInbound(fixture.params);

    expect(fixture.store.get(fixture.task.id)?.status.state).toBe("TASK_STATE_FAILED");
    fixture.store.stop();
  });

  it("rejects observe-only runtime admissions because they cannot produce a reply", async () => {
    const fixture = createA2aInboundFixture();
    vi.mocked(fixture.runtime.channel.inbound.dispatch).mockImplementation(async (turn) => ({
      admission: { kind: "observeOnly", reason: "policy-observe-only" },
      dispatched: true,
      ctxPayload: turn.ctxPayload,
      routeSessionKey: turn.route.sessionKey,
      dispatchResult: createA2aDispatchResult(false),
    }));

    await dispatchA2aInbound(fixture.params);

    expect(fixture.store.get(fixture.task.id)?.status.state).toBe("TASK_STATE_REJECTED");
    fixture.store.stop();
  });
});
