/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type {
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
  SessionsCatalogListResult,
  SessionsCatalogReadResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { TERMINAL_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import { buildCatalogSessionKey, type CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { consumePaneSessionHandoff } from "./chat-pane-shared.ts";
import { createSessionContext, createTestChatPane } from "./chat-pane.test-support.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";

function createCatalogContinuationPane(request: ReturnType<typeof vi.fn>) {
  const client = { request } as unknown as GatewayBrowserClient;
  const sessions = {} as SessionCapability;
  const { pane, requestUpdate, state } = createTestChatPane({ client, sessions });
  const key = {
    catalogId: "codex",
    hostId: "gateway:local",
    threadId: "thread-101",
  } satisfies CatalogSessionKey;
  const sourceSessionKey = buildCatalogSessionKey(key);
  state.sessionKey = sourceSessionKey;
  pane.sessionKey = sourceSessionKey;
  state.chatMessage = "Continue the original catalog conversation";
  state.handleChatDraftChange = vi.fn((draft: string) => {
    state.chatMessage = draft;
  });
  state.handleSendChat = vi.fn(async () => undefined);
  pane.catalogSession = {
    threadId: key.threadId,
    status: "idle",
    archived: false,
    canContinue: true,
    canArchive: true,
  };
  pane.onPaneSessionChange = vi.fn();
  return { client, key, pane, requestUpdate, sessions, sourceSessionKey, state };
}

describe("chat pane catalog session lifecycle", () => {
  it("shows the eligible catalog terminal action and dispatches its typed reference", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const key = {
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-101",
    } satisfies CatalogSessionKey;
    state.sessionKey = buildCatalogSessionKey(key);
    state.terminalAvailable = true;
    pane.catalogSession = {
      threadId: key.threadId,
      status: "idle",
      archived: false,
      canContinue: true,
      canArchive: true,
      canOpenTerminal: true,
    };
    const container = document.createElement("div");
    render(
      pane.renderPaneHeader(
        createSessionWorkspaceProps(state),
        createBackgroundTasksProps(state),
        undefined,
        true,
        undefined,
        false,
      ),
      container,
    );
    let detail: unknown;
    const listener = (event: Event) => {
      detail = (event as CustomEvent).detail;
    };
    window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, listener);
    try {
      (container.querySelector('[aria-label="Open in terminal"]') as HTMLElement).click();
    } finally {
      window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, listener);
    }
    expect(detail).toEqual({ open: true, agentId: "main", catalog: key });
  });

  it("finds continuation metadata on a later catalog page", async () => {
    const key = {
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-101",
    } satisfies CatalogSessionKey;
    const selectedSession: SessionCatalogSession = {
      threadId: key.threadId,
      sourceHomeId: "source-home-a",
      status: "idle",
      archived: false,
      canContinue: true,
      canArchive: true,
    };
    const firstPage: SessionsCatalogListResult = {
      catalogs: [
        {
          id: key.catalogId,
          label: "Codex",
          capabilities: { continueSession: true, archive: true },
          hosts: [
            {
              hostId: key.hostId,
              label: "Gateway",
              kind: "gateway",
              connected: true,
              sessions: [],
              nextCursor: "page-2",
            },
          ],
        },
      ],
    };
    const secondPage: SessionsCatalogListResult = {
      catalogs: [
        {
          ...firstPage.catalogs[0]!,
          hosts: [{ ...firstPage.catalogs[0]!.hosts[0]!, sessions: [selectedSession] }],
        },
      ],
    };
    const transcript: SessionsCatalogReadResult = {
      hostId: key.hostId,
      threadId: key.threadId,
      items: [],
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)
      .mockResolvedValueOnce(transcript);
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });
    pane.sessionKey = buildCatalogSessionKey(key);

    await pane.loadCatalogSession(key, false);

    expect(request).toHaveBeenNthCalledWith(2, "sessions.catalog.list", {
      agentId: "main",
      catalogId: key.catalogId,
      hostIds: [key.hostId],
      limitPerHost: 100,
      cursors: { [key.hostId]: "page-2" },
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.catalog.read", {
      agentId: "main",
      catalogId: key.catalogId,
      hostId: key.hostId,
      threadId: key.threadId,
      sourceHomeId: "source-home-a",
      limit: 50,
    });
    expect(pane.catalogSession).toEqual(selectedSession);
  });

  it("discards a catalog read when the selected agent changes", async () => {
    const key = {
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-101",
    } satisfies CatalogSessionKey;
    const read = createDeferred<SessionsCatalogReadResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        catalogs: [
          {
            id: "codex",
            label: "Codex",
            capabilities: {},
            hosts: [
              {
                hostId: "gateway:local",
                label: "Gateway",
                kind: "gateway",
                connected: true,
                sessions: [
                  {
                    threadId: key.threadId,
                    status: "idle",
                    archived: false,
                    canContinue: true,
                    canArchive: true,
                  },
                ],
              },
            ],
          },
        ],
      })
      .mockImplementationOnce(() => read.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    pane.sessionKey = buildCatalogSessionKey(key);
    state.sessionKey = pane.sessionKey;
    state.assistantAgentId = "main";

    const pending = pane.loadCatalogSession(key, false);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    state.assistantAgentId = "jarvis";
    read.resolve({
      hostId: key.hostId,
      threadId: key.threadId,
      items: [{ id: "u1", type: "userMessage", text: "stale" }],
    });

    await expect(pending).resolves.toBe(false);
    expect(pane.catalogMessages).toEqual([]);
  });

  it.each([
    {
      name: "uses a raw command for an empty tool call",
      item: { type: "toolCall", raw: { command: "git status --short" } },
      expected: "Tool call\n\ngit status --short",
    },
    {
      name: "uses aggregated output for an empty tool result",
      item: { type: "toolResult", raw: { aggregatedOutput: "working tree clean" } },
      expected: "Tool result\n\nworking tree clean",
    },
    {
      name: "renders an empty reasoning item as its label alone",
      item: { type: "reasoning" },
      expected: "Thinking",
    },
  ])("$name", ({ item, expected }) => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });

    const message = pane.catalogItemMessage(item as SessionCatalogTranscriptItem) as {
      content: Array<{ text: string }>;
    };

    expect(message.content[0]?.text).toBe(expected);
    expect(message.content[0]?.text).not.toContain("Unsupported external session item");
  });

  it("clamps oversized aggregated tool output before rendering", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });

    const message = pane.catalogItemMessage({
      type: "toolResult",
      raw: { aggregatedOutput: "x".repeat(5000) },
    } as SessionCatalogTranscriptItem) as { content: Array<{ text: string }> };

    // The 500-char preview cap keeps a single huge tool result from injecting
    // megabytes into one chat message; the "Tool result\n\n" prefix adds a bit.
    expect(message.content[0]?.text.length).toBeLessThan(600);
    expect(message.content[0]?.text.startsWith("Tool result")).toBe(true);
  });

  it("skips an empty unknown catalog item", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });

    expect(pane.catalogItemMessage({ type: "other" })).toBeNull();
  });

  it("preserves provider order when catalog items omit timestamps", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });

    expect(
      pane.catalogItemMessage({ id: "u1", type: "userMessage", text: "older question" }),
    ).not.toHaveProperty("timestamp");
  });

  it("exhausts pagination when an older read does not advance the cursor", async () => {
    const readPage: SessionsCatalogReadResult = {
      hostId: "gateway:local",
      threadId: "thread-1",
      items: [{ id: "u1", type: "userMessage", text: "hi" }],
      // Same cursor the request was made with: a stale provider that would loop.
      nextCursor: "cursor-1",
    };
    const client = {
      request: vi.fn(async () => readPage),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const key = "catalog:claude:gateway%3Alocal:thread-1";
    state.sessionKey = key;
    pane.sessionKey = key;
    pane.catalogCursor = "cursor-1";

    const progressed = await pane.loadCatalogSession(
      { catalogId: "claude", hostId: "gateway:local", threadId: "thread-1" },
      true,
    );

    expect(progressed).toBe(false);
    // Cursor cleared → hasOlderMessages() is false, so the observer will not refire.
    expect(pane.catalogCursor).toBeUndefined();
  });

  it("keeps paging when an advancing older page renders nothing new", async () => {
    const readPage: SessionsCatalogReadResult = {
      hostId: "gateway:local",
      threadId: "thread-1",
      // A page of only unsupported/empty items renders nothing but still advances
      // the cursor: older renderable history may sit behind it, so paging continues.
      items: [{ id: "x1", type: "other" }],
      nextCursor: "cursor-2",
    };
    const client = {
      request: vi.fn(async () => readPage),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const key = "catalog:claude:gateway%3Alocal:thread-1";
    state.sessionKey = key;
    pane.sessionKey = key;
    pane.catalogCursor = "cursor-1";

    const progressed = await pane.loadCatalogSession(
      { catalogId: "claude", hostId: "gateway:local", threadId: "thread-1" },
      true,
    );

    expect(progressed).toBe(true);
    expect(pane.catalogCursor).toBe("cursor-2");
  });

  it("exhausts pagination when an older read cycles back to a visited cursor", async () => {
    const readPage: SessionsCatalogReadResult = {
      hostId: "gateway:local",
      threadId: "thread-1",
      items: [{ id: "x1", type: "other" }],
      // Cursor points back to one already visited this session: a c1 -> c2 -> c1
      // cycle that would otherwise loop forever on empty pages.
      nextCursor: "cursor-1",
    };
    const client = {
      request: vi.fn(async () => readPage),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const key = "catalog:claude:gateway%3Alocal:thread-1";
    state.sessionKey = key;
    pane.sessionKey = key;
    pane.catalogCursor = "cursor-2";
    pane.olderCursorsSeen.add("cursor-1");

    const progressed = await pane.loadCatalogSession(
      { catalogId: "claude", hostId: "gateway:local", threadId: "thread-1" },
      true,
    );

    expect(progressed).toBe(false);
    expect(pane.catalogCursor).toBeUndefined();
  });
});

describe("chat pane catalog continuation lifecycle", () => {
  it("hands a continued catalog draft to the retained destination pane", async () => {
    const request = vi.fn().mockResolvedValue({ sessionKey: "agent:main:continued" });
    const { key, pane, state } = createCatalogContinuationPane(request);
    pane.catalogSession = { ...pane.catalogSession!, sourceHomeId: "source-home-a" };

    await pane.continueCatalogSession(key);

    expect(request).toHaveBeenCalledWith("sessions.catalog.continue", {
      ...key,
      agentId: "main",
      sourceHomeId: "source-home-a",
    });
    expect(pane.onPaneSessionChange).toHaveBeenCalledWith("single", "agent:main:continued");
    expect(consumePaneSessionHandoff(pane.context, pane.paneId, "agent:main:continued")).toEqual({
      attachments: [],
      draft: "Continue the original catalog conversation",
      send: true,
    });
    expect(state.sessionKey).not.toBe("agent:main:continued");
    expect(state.handleSendChat).not.toHaveBeenCalled();
  });

  it("carries staged attachments through the continuation handoff", async () => {
    const request = vi.fn().mockResolvedValue({ sessionKey: "agent:main:continued-attachments" });
    const { key, pane, state } = createCatalogContinuationPane(request);
    state.chatAttachments = [
      {
        id: "att-1",
        mimeType: "image/png",
        fileName: "shot.png",
        dataUrl: "data:image/png;base64,AAAA",
      },
    ];

    await pane.continueCatalogSession(key);

    const handoff = consumePaneSessionHandoff(
      pane.context,
      pane.paneId,
      "agent:main:continued-attachments",
    );
    expect(handoff?.send).toBe(true);
    expect(handoff?.attachments).toHaveLength(1);
    expect(handoff?.attachments[0]).toMatchObject({
      mimeType: "image/png",
      fileName: "shot.png",
      dataUrl: "data:image/png;base64,AAAA",
    });
  });

  it("continues an attachment-only draft instead of silently ignoring the send", async () => {
    const request = vi.fn().mockResolvedValue({ sessionKey: "agent:main:attachment-only" });
    const { key, pane, state } = createCatalogContinuationPane(request);
    state.chatMessage = "";
    state.chatAttachments = [
      {
        id: "att-2",
        mimeType: "image/png",
        fileName: "only.png",
        dataUrl: "data:image/png;base64,BBBB",
      },
    ];

    await pane.continueCatalogSession(key);

    expect(request).toHaveBeenCalledWith("sessions.catalog.continue", {
      ...key,
      agentId: "main",
    });
    const handoff = consumePaneSessionHandoff(
      pane.context,
      pane.paneId,
      "agent:main:attachment-only",
    );
    expect(handoff?.send).toBe(true);
    expect(handoff?.attachments).toHaveLength(1);
  });

  it("still ignores a continuation with no draft and no attachments", async () => {
    const request = vi.fn();
    const { key, pane, state } = createCatalogContinuationPane(request);
    state.chatMessage = "   ";
    state.chatAttachments = [];

    await pane.continueCatalogSession(key);

    expect(request).not.toHaveBeenCalled();
  });

  it("does not stage or send a continuation rejected by its logical pane", async () => {
    const request = vi.fn().mockResolvedValue({ sessionKey: "agent:main:rejected-continuation" });
    const { key, pane, state } = createCatalogContinuationPane(request);
    pane.onPaneSessionChange = vi.fn(() => false);

    await pane.continueCatalogSession(key);

    expect(
      consumePaneSessionHandoff(pane.context, pane.paneId, "agent:main:rejected-continuation"),
    ).toBeNull();
    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(state.chatSending).toBe(false);
  });

  it("does not send a stale catalog draft after the user switches conversations", async () => {
    const continued = createDeferred<{ sessionKey: string }>();
    const request = vi.fn(() => continued.promise);
    const { key, pane, state } = createCatalogContinuationPane(request);

    const pending = pane.continueCatalogSession(key);
    state.sessionKey = "agent:main:different-conversation";
    pane.sessionKey = state.sessionKey;
    pane.catalogLoadGeneration += 1;
    state.chatMessage = "Draft belonging to the selected conversation";
    continued.resolve({ sessionKey: "agent:main:stale-continuation" });
    await pending;

    expect(pane.onPaneSessionChange).not.toHaveBeenCalled();
    expect(state.handleChatDraftChange).not.toHaveBeenCalled();
    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(state.sessionKey).toBe("agent:main:different-conversation");
    expect(state.chatMessage).toBe("Draft belonging to the selected conversation");
    expect(state.chatSending).toBe(false);
  });

  it("does not apply a catalog continuation after the selected agent changes", async () => {
    const continued = createDeferred<{ sessionKey: string }>();
    const request = vi.fn(() => continued.promise);
    const { key, pane, state } = createCatalogContinuationPane(request);
    state.assistantAgentId = "main";

    const pending = pane.continueCatalogSession(key);
    state.assistantAgentId = "jarvis";
    continued.resolve({ sessionKey: "agent:main:stale-owner" });
    await pending;

    expect(request).toHaveBeenCalledWith("sessions.catalog.continue", {
      ...key,
      agentId: "main",
    });
    expect(pane.onPaneSessionChange).not.toHaveBeenCalled();
    expect(state.handleChatDraftChange).not.toHaveBeenCalled();
    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(state.chatSending).toBe(false);
  });

  it("does not send a stale catalog draft after reconnecting the same Gateway client", async () => {
    const continued = createDeferred<{ sessionKey: string }>();
    const request = vi.fn(() => continued.promise);
    const { key, pane, state } = createCatalogContinuationPane(request);

    const pending = pane.continueCatalogSession(key);
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    state.chatMessage = "Draft from the reconnected conversation";
    continued.resolve({ sessionKey: "agent:main:stale-continuation" });
    await pending;

    expect(pane.onPaneSessionChange).not.toHaveBeenCalled();
    expect(state.handleChatDraftChange).not.toHaveBeenCalled();
    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(state.chatMessage).toBe("Draft from the reconnected conversation");
    expect(state.chatSending).toBe(false);
  });

  it("does not apply an old catalog continuation after replacing the Gateway client", async () => {
    const continued = createDeferred<{ sessionKey: string }>();
    const request = vi.fn(() => continued.promise);
    const { key, pane, sessions, state } = createCatalogContinuationPane(request);
    const replacementClient = { request: vi.fn() } as unknown as GatewayBrowserClient;

    const pending = pane.continueCatalogSession(key);
    state.client = replacementClient;
    pane.connectedClient = replacementClient;
    pane.context = createSessionContext(replacementClient, sessions);
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    state.chatMessage = "Draft from the replacement Gateway";
    continued.resolve({ sessionKey: "agent:main:stale-continuation" });
    await pending;

    expect(pane.onPaneSessionChange).not.toHaveBeenCalled();
    expect(state.handleChatDraftChange).not.toHaveBeenCalled();
    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(state.client).toBe(replacementClient);
    expect(state.chatMessage).toBe("Draft from the replacement Gateway");
    expect(state.chatSending).toBe(false);
  });

  it("does not clear a newer scoped send when a stale catalog continuation resolves", async () => {
    const continued = createDeferred<{ sessionKey: string }>();
    const request = vi.fn(() => continued.promise);
    const { key, pane, state } = createCatalogContinuationPane(request);

    const pending = pane.continueCatalogSession(key);
    state.sessionKey = "agent:main:different-conversation";
    pane.sessionKey = state.sessionKey;
    pane.catalogLoadGeneration += 1;
    state.chatSendingScopeKey = "newer-conversation-send";
    state.chatSending = true;
    continued.resolve({ sessionKey: "agent:main:stale-continuation" });
    await pending;

    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(state.chatSendingScopeKey).toBe("newer-conversation-send");
    expect(state.chatSending).toBe(true);
  });

  it("allows only the latest overlapping catalog continuation to adopt and send", async () => {
    const first = createDeferred<{ sessionKey: string }>();
    const second = createDeferred<{ sessionKey: string }>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { key, pane, state } = createCatalogContinuationPane(request);

    const staleContinuation = pane.continueCatalogSession(key);
    state.chatMessage = "Only send the latest catalog draft";
    const currentContinuation = pane.continueCatalogSession(key);
    first.resolve({ sessionKey: "agent:main:stale-continuation" });
    await staleContinuation;

    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(state.chatSending).toBe(true);

    second.resolve({ sessionKey: "agent:main:latest-continuation" });
    await currentContinuation;

    expect(pane.onPaneSessionChange).toHaveBeenCalledOnce();
    expect(
      consumePaneSessionHandoff(pane.context, pane.paneId, "agent:main:latest-continuation"),
    ).toEqual({
      attachments: [],
      draft: "Only send the latest catalog draft",
      send: true,
    });
    expect(state.handleSendChat).not.toHaveBeenCalled();
  });

  it("does not display a rejected catalog continuation in a different conversation", async () => {
    const continued = createDeferred<{ sessionKey: string }>();
    const request = vi.fn(() => continued.promise);
    const { key, pane, requestUpdate, state } = createCatalogContinuationPane(request);

    const pending = pane.continueCatalogSession(key);
    state.sessionKey = "agent:main:different-conversation";
    pane.sessionKey = state.sessionKey;
    pane.catalogLoadGeneration += 1;
    state.lastError = "Current conversation error";
    state.chatMessage = "Draft belonging to the selected conversation";
    const updatesBeforeReject = requestUpdate.mock.calls.length;
    continued.reject(new Error("Stale catalog continuation failed"));
    await pending;

    expect(state.lastError).toBe("Current conversation error");
    expect(state.chatSending).toBe(false);
    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(requestUpdate).toHaveBeenCalledTimes(updatesBeforeReject + 1);
  });

  it("reports a catalog continuation failure in the original conversation", async () => {
    const request = vi.fn().mockRejectedValue(new Error("Catalog continuation failed"));
    const { key, pane, state } = createCatalogContinuationPane(request);

    await pane.continueCatalogSession(key);

    expect(state.lastError).toBe("Catalog continuation failed");
    expect(state.chatSending).toBe(false);
    expect(state.handleSendChat).not.toHaveBeenCalled();
  });
});
