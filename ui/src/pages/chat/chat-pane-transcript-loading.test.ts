/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  createInitializationContext,
  createRenderTestChatPane,
  createSessionCapabilityFixture,
} from "./chat-pane.test-support.ts";

describe("chat pane transcript loading signal", () => {
  it("reports each transcript loading edge from the load owner without a render", async () => {
    const pane = createRenderTestChatPane();
    const first = createDeferred<ChatHistoryResult>();
    const second = createDeferred<ChatHistoryResult>();
    const pending = [first.promise, second.promise];
    const request = vi.fn(() => pending.shift());
    const client = { request } as unknown as GatewayBrowserClient;
    const context: ApplicationContext = {
      ...createInitializationContext(),
      sessions: createSessionCapabilityFixture({
        state: { result: null, agentId: "main", modelOverrides: {} },
        think: () => undefined,
        reconcile: vi.fn(),
      }),
    };
    context.gateway.snapshot.client = client;
    context.gateway.snapshot.phase = "connected";
    const state = pane.initialize(context);
    state.client = client;
    state.connected = true;
    state.sessionKey = "agent:main:signal";
    const invalidate = vi.spyOn(state.renderLifecycle, "invalidate");
    const changed = vi.fn();
    pane.addEventListener("openclaw-chat-transcript-loading-changed", changed);

    // Session-event reloads never re-render the page, so the load owner reports
    // the edge itself, without spending a frame on it.
    const firstLoad = loadChatHistory(state);
    expect(pane.transcriptLoading).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    expect(invalidate).not.toHaveBeenCalled();

    // A coalesced re-entry into the same in-flight request is not an edge.
    void loadChatHistory(state);
    expect(changed).toHaveBeenCalledOnce();

    first.resolve({ completeSnapshot: true, messages: [], sessionId: "id:signal" });
    await firstLoad;
    expect(pane.transcriptLoading).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);

    const secondLoad = loadChatHistory(state);
    expect(changed).toHaveBeenCalledTimes(3);
    second.resolve({ completeSnapshot: true, messages: [], sessionId: "id:signal" });
    await secondLoad;
    expect(changed).toHaveBeenCalledTimes(4);
  });
});
