/* @vitest-environment jsdom */

import { GATEWAY_SERVER_CAPS, type ProgressCard } from "@openclaw/gateway-protocol";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionProgressCardController } from "../../components/session-progress-card-controller.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { resetChatHistoryProjection } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";

const history: ChatHistoryResult = {
  sessionId: "research-notes",
  sessionInfo: {
    key: "agent:research:notes",
    agentId: "research",
    sessionId: "research-notes",
    kind: "direct",
    updatedAt: 1,
  },
  messages: [{ role: "assistant", content: [{ type: "text", text: "Research transcript" }] }],
};

function progressCard(revision = 1): ProgressCard {
  return {
    sessionKey: "agent:research:notes",
    markdown: `Research progress ${revision}`,
    revision,
    updatedAt: 1_700_000_000_000 + revision,
  };
}

function createHistoryProgressPane(request: ReturnType<typeof vi.fn>) {
  const client = { request } as unknown as GatewayBrowserClient;
  const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
  const hello = gatewayHelloForMethods(["chat.history", "progressCard.get", "progressCard.put"]);
  hello.features = {
    ...hello.features,
    capabilities: [GATEWAY_SERVER_CAPS.PROGRESS_CARD_AGENT_SCOPE],
  };
  pane.context.gateway.snapshot.hello = hello;
  state.hello = hello;
  state.agentsList = {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id: "main" }, { id: "research" }],
  };
  state.assistantAgentId = "main";
  pane.sessionKey = "notes";
  state.sessionKey = "notes";
  state.settings = { sessionKey: "notes", lastActiveSessionKey: "notes" } as typeof state.settings;
  const progress = (pane as TestChatPane & { progressCard: SessionProgressCardController })
    .progressCard;
  onTestFinished(() => progress.hostDisconnected());
  const emit = (card: ProgressCard) => {
    const gateway = pane.context.gateway as ApplicationContext["gateway"] & {
      emitTestEvent: (event: GatewayEventFrame) => void;
    };
    gateway.emitTestEvent({
      type: "event",
      event: "progressCard.changed",
      payload: { sessionKey: card.sessionKey, revision: card.revision },
    });
  };
  return { pane, state, progress, emit };
}

describe("retained bare pane progress follows accepted history ownership", () => {
  it("loads, refreshes and dismisses the history owner's card without rekeying the composer", async () => {
    let card: ProgressCard | null = progressCard();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return history;
      }
      if (method === "progressCard.put") {
        card = null;
      }
      return { card };
    });
    const { state, progress, emit } = createHistoryProgressPane(request);
    state.chatMessage = "Retained draft";
    progress.hostUpdate();
    expect(request).not.toHaveBeenCalled();

    await loadChatHistory(state, { deferBranches: true });
    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "notes",
      limit: 80,
      maxBytes: 256 * 1024,
    });
    progress.hostUpdate();
    await vi.waitFor(() => expect(progress.card).toEqual(card));
    expect(request).toHaveBeenLastCalledWith("progressCard.get", {
      sessionKey: "agent:research:notes",
    });
    expect(state.sessionKey).toBe("notes");
    expect(state.chatMessage).toBe("Retained draft");
    expect(resolveUiConversationIdentity(state, state.sessionKey)).toEqual({ sessionKey: "notes" });

    card = progressCard(2);
    emit(card);
    await vi.waitFor(() => expect(progress.card).toEqual(card));
    expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(2);
    expect(await progress.dismiss(expectDefined(progress.card, "displayed progress card"))).toBe(
      true,
    );
    expect(request).toHaveBeenLastCalledWith("progressCard.put", {
      sessionKey: "agent:research:notes",
      expectedRevision: 2,
    });
    expect(progress.card).toBeNull();
  });

  it.each([
    "navigation",
    "reconnect",
    "client replacement",
    "disconnect",
    "session replacement",
    "history reset",
  ] as const)("retires the accepted progress identity after %s", async (transition) => {
    const card = progressCard();
    const request = vi.fn(async (method: string) =>
      method === "chat.history" ? history : { card },
    );
    const { pane, state, progress } = createHistoryProgressPane(request);
    await loadChatHistory(state, { deferBranches: true });
    progress.hostUpdate();
    await vi.waitFor(() => expect(progress.card).toEqual(card));

    if (transition === "navigation") {
      state.sessionKey = "scratch";
    } else if (transition === "reconnect") {
      state.connectionEpoch += 1;
    } else if (transition === "client replacement") {
      state.client = { request } as unknown as GatewayBrowserClient;
      pane.context.gateway.snapshot.client = state.client;
    } else if (transition === "disconnect") {
      state.connected = false;
    } else if (transition === "session replacement") {
      state.currentSessionId = "replacement-notes";
    } else {
      resetChatHistoryProjection(state);
    }
    progress.hostUpdate();
    expect(progress.card).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(1);
  });

  it("does not adopt a stale history reply after navigation", async () => {
    const old = createDeferred<ChatHistoryResult>();
    const request = vi.fn(() => old.promise);
    const { state, progress } = createHistoryProgressPane(request);
    const load = loadChatHistory(state, { deferBranches: true });
    state.sessionKey = "scratch";
    old.resolve(history);
    expect(await load).toBeUndefined();
    progress.hostUpdate();
    expect(progress.card).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps accepted progress through a same-session background history refresh", async () => {
    const refreshed = createDeferred<ChatHistoryResult>();
    let historyReads = 0;
    const card = progressCard();
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return ++historyReads === 1 ? Promise.resolve(history) : refreshed.promise;
      }
      return Promise.resolve({ card });
    });
    const { state, progress } = createHistoryProgressPane(request);
    await loadChatHistory(state, { deferBranches: true });
    progress.hostUpdate();
    await vi.waitFor(() => expect(progress.card).toEqual(card));

    const refreshing = loadChatHistory(state, { deferBranches: true });
    progress.hostUpdate();
    expect(progress.card).toEqual(card);
    refreshed.resolve(history);
    await refreshing;
    progress.hostUpdate();
    expect(progress.card).toEqual(card);
    expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(1);
  });

  it("does not infer an existing progress owner from a missing history row", async () => {
    const request = vi.fn(async () => ({
      messages: [],
      sessionInfo: {
        key: "agent:research:notes",
        agentId: "research",
        kind: "direct",
        updatedAt: null,
      },
    }));
    const { state, progress } = createHistoryProgressPane(request);
    await loadChatHistory(state, { deferBranches: true });
    progress.hostUpdate();
    expect(progress.card).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });
});
