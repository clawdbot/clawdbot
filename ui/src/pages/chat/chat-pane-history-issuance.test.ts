/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { getChatHistoryLoadState, loadChatHistory } from "./chat-history.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

function createCanonicalRoutePane(request: ReturnType<typeof vi.fn>) {
  const client = { request } as unknown as GatewayBrowserClient;
  const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
  const hello = {
    snapshot: {
      sessionDefaults: {
        defaultAgentId: "main",
        mainKey: "main",
        mainSessionKey: "agent:main:main",
      },
    },
  } as unknown as NonNullable<ApplicationContext["gateway"]["snapshot"]["hello"]>;
  state.hello = hello;
  state.settings = {
    sessionKey: state.sessionKey,
    lastActiveSessionKey: state.sessionKey,
  } as typeof state.settings;
  pane.sessionKey = "main";
  pane.connectedClient = null;
  pane.active = true;
  pane.presented = true;
  const snapshot = {
    ...pane.context.gateway.snapshot,
    assistantAgentId: "main",
    client,
    hello,
    phase: "connected" as const,
  };
  return { pane, state, snapshot };
}

function assistantHistory(text: string) {
  return {
    messages: [{ role: "assistant", content: [{ type: "text", text }] }],
  };
}

describe("chat pane history issuance across Gateway connection transitions", () => {
  it("issues a disconnected history request once when connection redirects the route", async () => {
    const request = vi.fn().mockResolvedValue(assistantHistory("Recovered transcript"));
    const { pane, state, snapshot } = createCanonicalRoutePane(request);
    state.connected = false;

    await loadChatHistory(state);

    expect(request).not.toHaveBeenCalled();
    expect(getChatHistoryLoadState(state)).toMatchObject({
      phase: "pending-connection",
      sessionKey: "agent:main:current",
      startup: false,
    });
    expect(state.chatLoading).toBe(true);

    pane.applyGatewaySnapshot(snapshot);

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "agent:main:current",
      limit: 800,
    });
    await vi.waitFor(() =>
      expect(state.chatMessages).toEqual([
        { role: "assistant", content: [{ type: "text", text: "Recovered transcript" }] },
      ]),
    );
    expect(getChatHistoryLoadState(state).phase).toBe("committed");
  });

  it("automatically retries a retryable history failure when the Gateway reconnects", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "GATEWAY_UNAVAILABLE",
          message: "Gateway connection interrupted",
          retryable: true,
        }),
      )
      .mockResolvedValueOnce(assistantHistory("Recovered after reconnect"));
    const { pane, state, snapshot } = createCanonicalRoutePane(request);

    await loadChatHistory(state, { startup: true });

    expect(getChatHistoryLoadState(state)).toMatchObject({
      phase: "failed",
      sessionKey: state.sessionKey,
      retryable: true,
      startup: true,
    });
    pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
    pane.applyGatewaySnapshot(snapshot);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenNthCalledWith(2, "chat.startup", {
      sessionKey: state.sessionKey,
      limit: 800,
    });
    await vi.waitFor(() =>
      expect(state.chatMessages).toEqual([
        { role: "assistant", content: [{ type: "text", text: "Recovered after reconnect" }] },
      ]),
    );
    expect(getChatHistoryLoadState(state).phase).toBe("committed");
  });

  it("discards a disconnected history request after the selected session changes", async () => {
    const request = vi.fn();
    const { pane, state, snapshot } = createCanonicalRoutePane(request);
    state.connected = false;

    await loadChatHistory(state);

    expect(getChatHistoryLoadState(state).phase).toBe("pending-connection");
    state.sessionKey = "agent:main:different-session";
    pane.applyGatewaySnapshot(snapshot);

    expect(request).not.toHaveBeenCalled();
    expect(getChatHistoryLoadState(state)).toEqual({ phase: "idle" });
    expect(state.chatLoading).toBe(false);
  });
});
