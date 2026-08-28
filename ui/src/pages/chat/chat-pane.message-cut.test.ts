import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import "./chat-pane.ts";
import { consumePaneSessionHandoff } from "./chat-pane-shared.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

type TestChatPane = HTMLElement & {
  connectedClient: GatewayBrowserClient | null;
  connectionGeneration: number;
  context: ApplicationContext;
  forkFromMessage: (entryId: string) => Promise<void>;
  onPaneSessionChange?: (paneId: string, sessionKey: string) => void;
  paneId: string;
  state: ChatPageHost;
};

function createSessionContext(
  client: GatewayBrowserClient,
  sessions: SessionCapability,
): ApplicationContext {
  return {
    gateway: {
      snapshot: {
        client,
        phase: "connected",
        hello: { features: { methods: [] } },
      },
    },
    agents: { state: { agentsList: null } },
    sessions,
  } as unknown as ApplicationContext;
}

function createTestChatPane(params: { client: GatewayBrowserClient; sessions: SessionCapability }) {
  const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
  Object.defineProperty(pane, "isConnected", {
    configurable: true,
    value: true,
  });
  const requestUpdate = vi.fn();
  const state = {
    agentsList: null,
    assistantAgentId: null,
    chatError: null,
    chatHistoryPagination: { hasMore: false },
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    client: params.client,
    connected: true,
    connectionEpoch: 4,
    hello: null,
    lastError: null,
    requestUpdate,
    sessionKey: "agent:main:current",
    sessions: params.sessions,
    sessionsError: null,
    sessionsLoading: false,
    sidebarContent: null,
    sidebarLayout: { columns: [] },
    // Minimal scroll host so scheduleChatScroll is a no-op instead of throwing.
    chatScrollGeneration: 0,
    chatScrollCommitCleanup: null,
    handleChatScroll: vi.fn(),
    handleChatDraftChange: vi.fn(),
    renderLifecycle: { afterCommit: () => () => {}, invalidate: () => {} },
  } as unknown as ChatPageHost;
  pane.context = createSessionContext(params.client, params.sessions);
  pane.state = state;
  pane.connectedClient = params.client;
  pane.connectionGeneration = 4;
  return { pane, state };
}

describe("chat pane message cuts", () => {
  it("restores forked prompt attachments into the new session composer", async () => {
    const sessions = {
      forkAtMessage: vi.fn().mockResolvedValue({
        sessionKey: "agent:main:forked",
        editorText: "edit me",
        editorAttachments: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
      }),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    state.chatAttachments = [{ id: "old", mimeType: "image/jpeg", dataUrl: "data:old" }];

    await pane.forkFromMessage("user-entry");

    expect(state.sessionKey).toBe("agent:main:current");
    expect(state.chatAttachments).toEqual([
      { id: "old", mimeType: "image/jpeg", dataUrl: "data:old" },
    ]);
    expect(consumePaneSessionHandoff(pane.context, pane.paneId, "agent:main:forked")).toEqual({
      attachments: [
        {
          id: expect.stringMatching(/^att-/),
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,aW1hZ2U=",
        },
      ],
      draft: "edit me",
    });
  });

  it("keeps a newer global agent selection when a message fork finishes late", async () => {
    const forked = createDeferred<{ sessionKey: string; editorText?: string }>();
    const sessions = {
      forkAtMessage: vi.fn(() => forked.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;
    state.sessionKey = "global";
    state.assistantAgentId = "main";

    const pending = pane.forkFromMessage("user-entry");
    state.assistantAgentId = "work";
    forked.resolve({ sessionKey: "agent:main:forked", editorText: "edit me" });

    await pending;
    expect(navigate).not.toHaveBeenCalled();
    expect(state.sessionKey).toBe("global");
    expect(state.assistantAgentId).toBe("work");
  });

  it("does not navigate to a fork that finishes after a same-client reconnect", async () => {
    const forked = createDeferred<{ sessionKey: string; editorText?: string }>();
    const sessions = {
      forkAtMessage: vi.fn(() => forked.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;

    const pending = pane.forkFromMessage("user-entry");
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    forked.resolve({ sessionKey: "agent:main:forked", editorText: "stale draft" });

    await pending;
    expect(navigate).not.toHaveBeenCalled();
    expect(consumePaneSessionHandoff(pane.context, pane.paneId, "agent:main:forked")).toBeNull();
  });

  it("does not paint a stale fork error after the selected session changes", async () => {
    let rejectFork!: (error: Error) => void;
    const forked = new Promise<never>((_resolve, reject) => {
      rejectFork = reject;
    });
    const sessions = {
      forkAtMessage: vi.fn(() => forked),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });

    const pending = pane.forkFromMessage("user-entry");
    state.sessionKey = "agent:main:replacement";
    rejectFork(new Error("stale fork failed"));

    await pending;
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
  });
});
