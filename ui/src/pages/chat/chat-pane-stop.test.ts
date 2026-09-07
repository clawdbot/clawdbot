/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-stop.test/"} */

import { describe, expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { createChatPaneSessionActionCallbacks } from "./chat-pane-session-controls.ts";
import { createSessionCapabilityFixture, createTestChatPane } from "./chat-pane.test-support.ts";
import { handleAbortChat, replayPendingChatAbort } from "./run-lifecycle.ts";

function createStopFixture() {
  const request = vi.fn(async () => ({ aborted: true }));
  const client = createTestGatewayClient(request);
  const { pane, state } = createTestChatPane({
    client,
    sessions: createSessionCapabilityFixture(),
  });
  state.chatRunId = "original-run";
  state.chatMessage = "keep this draft";
  let snapshot = pane.context.gateway.snapshot;
  const onDenied = vi.fn();
  const callbacks = (sessionParticipationBlocked = false) =>
    createChatPaneSessionActionCallbacks({
      getSnapshot: () => snapshot,
      hasLocalRun: () => Boolean(state.chatRunId),
      sessionParticipationBlocked,
      onDenied,
      onAbort: () => void handleAbortChat(state, { preserveDraft: true }),
      onRewind: vi.fn(async () => true),
      onFork: vi.fn(async () => {}),
      onReset: vi.fn(),
    });
  const disconnect = (nextClient: typeof state.client = client) => {
    snapshot = { ...snapshot, client: nextClient, phase: "reconnecting", hello: null };
    pane.applyGatewaySnapshot(snapshot);
  };
  const reconnect = (scopes = ["operator.write"]) => {
    snapshot = {
      ...snapshot,
      phase: "connected",
      hello: sessionMutationGatewayHello(scopes),
    };
    state.connected = true;
    state.hello = snapshot.hello;
  };
  return { pane, state, request, callbacks, disconnect, reconnect, onDenied };
}

describe("chat pane Stop intent", () => {
  it("captures offline Stop without a request and replays only the captured run once", async () => {
    const fixture = createStopFixture();
    fixture.disconnect();
    const stop = fixture.callbacks().onAbort;
    expect(stop).toBeTypeOf("function");
    stop?.();
    expect(fixture.request).not.toHaveBeenCalled();
    expect(fixture.state.chatMessage).toBe("keep this draft");

    fixture.state.chatRunId = "replacement-run";
    fixture.reconnect();
    expect(await replayPendingChatAbort(fixture.state)).toBe(true);
    expect(await replayPendingChatAbort(fixture.state)).toBe(false);
    expect(fixture.request.mock.calls).toEqual([
      ["chat.abort", { sessionKey: fixture.state.sessionKey, runId: "original-run" }],
    ]);
  });

  it("rechecks a Stop rendered before the transport dropped", () => {
    const fixture = createStopFixture();
    const stop = fixture.callbacks().onAbort;
    fixture.disconnect();
    stop?.();
    expect(fixture.state.pendingAbort?.runId).toBe("original-run");
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it.each([false, true])("retires the old client's run with queued Stop=%s", async (queued) => {
    const fixture = createStopFixture();
    fixture.disconnect();
    const staleStop = fixture.callbacks().onAbort;
    if (queued) {
      staleStop?.();
    }
    const replacementRequest = vi.fn();
    fixture.disconnect(createTestGatewayClient(replacementRequest));
    staleStop?.();
    expect(fixture.state.chatRunId).toBeNull();
    expect(fixture.callbacks().onAbort).toBeUndefined();
    fixture.reconnect();
    expect(await replayPendingChatAbort(fixture.state)).toBe(false);
    expect(fixture.request).not.toHaveBeenCalled();
    expect(replacementRequest).not.toHaveBeenCalled();
    expect(fixture.state.chatMessage).toBe("keep this draft");
  });

  it("keeps participation and exact-run requirements while offline", () => {
    const fixture = createStopFixture();
    fixture.disconnect();
    expect(fixture.callbacks(true).onAbort).toBeUndefined();
    fixture.state.chatRunId = null;
    expect(fixture.callbacks().onAbort).toBeUndefined();
    fixture.state.chatRunId = "original-run";
    fixture.disconnect(null);
    expect(fixture.callbacks().onAbort).toBeUndefined();
  });

  it("consumes revoked intent and permits a fresh authorized Stop after access returns", async () => {
    const fixture = createStopFixture();
    fixture.disconnect();
    fixture.callbacks().onAbort?.();
    expect(fixture.state.pendingAbort?.runId).toBe("original-run");
    fixture.reconnect(["operator.read"]);
    expect(await replayPendingChatAbort(fixture.state)).toBe(false);
    expect(fixture.request).not.toHaveBeenCalled();
    expect(fixture.callbacks().onAbort).toBeUndefined();

    fixture.reconnect();
    expect(await replayPendingChatAbort(fixture.state)).toBe(false);
    fixture.callbacks().onAbort?.();
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledOnce());
  });

  it("rechecks online write access when a rendered Stop is clicked", () => {
    const fixture = createStopFixture();
    const stop = fixture.callbacks().onAbort;
    fixture.reconnect(["operator.read"]);
    stop?.();
    expect(fixture.request).not.toHaveBeenCalled();
    expect(fixture.onDenied).toHaveBeenCalledOnce();
  });
});
