// Embedded gateway stub tests cover in-process gateway methods used by agent
// tools when no external gateway transport is available.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbeddedCallGateway } from "./embedded-gateway-stub.js";

const runtime = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({ agents: { list: [{ id: "main", default: true }] } })),
  resolveSessionKeyFromResolveParams: vi.fn(),
  resolveSessionAgentId: vi.fn(() => "main"),
  loadSessionEntry: vi.fn(() => ({
    cfg: {},
    storePath: "/tmp/openclaw-sessions.json",
    entry: { sessionId: "sess-main" },
  })),
  resolveSessionModelRef: vi.fn(() => ({ provider: "openai" })),
  readSessionMessagesAsync: vi.fn(async (): Promise<unknown[]> => []),
  readRecentSessionMessagesWithStatsAsync: vi.fn(async () => ({
    messages: [] as unknown[],
    totalMessages: 0,
  })),
  readSessionMessagesPageWithStatsAsync: vi.fn(async () => ({
    messages: [] as unknown[],
    totalMessages: 0,
  })),
  augmentChatHistoryWithCliSessionImports: vi.fn(
    ({ localMessages }: { localMessages?: unknown[] }) => localMessages ?? [],
  ),
  resolveEffectiveChatHistoryMaxChars: vi.fn(() => 100_000),
  dropPreSessionStartAnnouncePairs: vi.fn((messages: unknown[]) => messages),
  projectChatDisplayMessages: vi.fn((messages: unknown[]): unknown[] => messages),
  projectRecentChatDisplayMessages: vi.fn((messages: unknown[]): unknown[] => messages),
  augmentChatHistoryWithCanvasBlocks: vi.fn((messages: unknown[]) => messages),
  getMaxChatHistoryMessagesBytes: vi.fn(() => 100_000),
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES: 100_000,
  replaceOversizedChatHistoryMessages: vi.fn(({ messages }: { messages: unknown[] }) => ({
    messages,
  })),
  capArrayByJsonBytes: vi.fn((items: unknown[]) => ({ items })),
  enforceChatHistoryFinalBudget: vi.fn(({ messages }: { messages: unknown[] }) => ({ messages })),
  loadCombinedSessionStoreForGateway: vi.fn(() => ({
    storePath: "/tmp/openclaw-sessions.json",
    store: {},
  })),
  listSessionsFromStoreAsync: vi.fn(async () => ({ sessions: [] })),
}));

vi.mock("./embedded-gateway-stub.runtime.js", () => runtime);

describe("embedded gateway stub", () => {
  beforeEach(() => {
    runtime.getRuntimeConfig.mockClear();
    runtime.resolveSessionKeyFromResolveParams.mockReset();
    runtime.augmentChatHistoryWithCliSessionImports.mockClear();
    runtime.projectChatDisplayMessages.mockClear();
    runtime.projectRecentChatDisplayMessages.mockClear();
    runtime.dropPreSessionStartAnnouncePairs.mockClear();
    runtime.readSessionMessagesAsync.mockClear();
    runtime.readRecentSessionMessagesWithStatsAsync.mockClear();
    runtime.readSessionMessagesPageWithStatsAsync.mockClear();
    runtime.loadSessionEntry.mockClear();
    runtime.resolveSessionAgentId.mockClear();
    runtime.loadCombinedSessionStoreForGateway.mockClear();
    runtime.listSessionsFromStoreAsync.mockClear();
  });

  it("scopes embedded session lists to the requested agent", async () => {
    const callGateway = createEmbeddedCallGateway();
    await callGateway({
      method: "sessions.list",
      params: { agentId: "work", includeGlobal: true, search: "global" },
    });

    expect(runtime.loadCombinedSessionStoreForGateway).toHaveBeenCalledWith(
      { agents: { list: [{ id: "main", default: true }] } },
      { agentId: "work" },
    );
    expect(runtime.listSessionsFromStoreAsync).toHaveBeenCalledWith({
      cfg: { agents: { list: [{ id: "main", default: true }] } },
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      opts: { agentId: "work", includeGlobal: true, search: "global" },
    });
  });

  it("resolves sessions through the gateway session resolver", async () => {
    runtime.resolveSessionKeyFromResolveParams.mockResolvedValueOnce({
      ok: true,
      key: "agent:main:main",
    });

    const callGateway = createEmbeddedCallGateway();
    const result = await callGateway<{ ok: true; key: string }>({
      method: "sessions.resolve",
      params: { sessionId: "sess-main", includeGlobal: true },
    });

    expect(result).toEqual({ ok: true, key: "agent:main:main" });
    expect(runtime.resolveSessionKeyFromResolveParams).toHaveBeenCalledWith({
      cfg: { agents: { list: [{ id: "main", default: true }] } },
      p: { sessionId: "sess-main", includeGlobal: true },
    });
  });

  it("throws resolver errors for unresolved sessions", async () => {
    runtime.resolveSessionKeyFromResolveParams.mockResolvedValueOnce({
      ok: false,
      error: { message: "No session found: missing" },
    });

    const callGateway = createEmbeddedCallGateway();

    await expect(
      callGateway({
        method: "sessions.resolve",
        params: { key: "missing" },
      }),
    ).rejects.toThrow("No session found: missing");
  });

  it("projects embedded chat history through the shared display projector", async () => {
    // Embedded history must use the same projection path as gateway history so
    // byte/message limits and display filtering stay aligned.
    const rawMessages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const projectedMessages = [{ role: "assistant", content: "hi" }];
    runtime.readSessionMessagesAsync.mockImplementationOnce(async () => rawMessages);
    runtime.projectRecentChatDisplayMessages.mockReturnValueOnce(projectedMessages);

    const callGateway = createEmbeddedCallGateway();
    const result = await callGateway<{ messages: unknown[] }>({
      method: "chat.history",
      params: { sessionKey: "agent:main:main" },
    });

    expect(runtime.projectRecentChatDisplayMessages).toHaveBeenCalledWith(rawMessages, {
      maxChars: 100_000,
      maxMessages: 200,
    });
    expect(runtime.readSessionMessagesAsync).toHaveBeenCalledWith(
      {
        agentId: "main",
        sessionEntry: { sessionId: "sess-main" },
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/openclaw-sessions.json",
      },
      {
        mode: "recent",
        maxMessages: 200,
        maxBytes: 1024 * 1024,
        allowResetArchiveFallback: true,
      },
    );
    expect(result.messages).toEqual(projectedMessages);
  });

  it("scopes embedded global chat history to the requested agent", async () => {
    const callGateway = createEmbeddedCallGateway();
    await callGateway<{ messages: unknown[] }>({
      method: "chat.history",
      params: { sessionKey: "global", agentId: "work" },
    });

    expect(runtime.loadSessionEntry).toHaveBeenCalledWith("global", { agentId: "work" });
    expect(runtime.resolveSessionAgentId).toHaveBeenCalledWith({
      sessionKey: "global",
      config: {},
      agentId: "work",
    });
  });

  it("infers embedded global chat history scope from agent-prefixed aliases", async () => {
    // Agent-prefixed global aliases carry the target agent id even when the
    // caller does not pass agentId separately.
    const callGateway = createEmbeddedCallGateway();
    await callGateway<{ messages: unknown[] }>({
      method: "chat.history",
      params: { sessionKey: "agent:work:main" },
    });

    expect(runtime.loadSessionEntry).toHaveBeenCalledWith("agent:work:main", { agentId: "work" });
    expect(runtime.resolveSessionAgentId).toHaveBeenCalledWith({
      sessionKey: "agent:work:main",
      config: {},
      agentId: "work",
    });
  });

  it("passes the requested recent history window to projection", async () => {
    const rawMessages = [
      { role: "user", content: "visible older" },
      { role: "assistant", content: "hidden newer" },
    ];
    runtime.readSessionMessagesAsync.mockImplementationOnce(async () => rawMessages);

    const callGateway = createEmbeddedCallGateway();
    await callGateway<{ messages: unknown[] }>({
      method: "chat.history",
      params: { sessionKey: "agent:main:main", limit: 1 },
    });

    expect(runtime.projectRecentChatDisplayMessages).toHaveBeenCalledWith(rawMessages, {
      maxChars: 100_000,
      maxMessages: 1,
    });
    expect(runtime.readSessionMessagesAsync).toHaveBeenCalledWith(
      {
        agentId: "main",
        sessionEntry: { sessionId: "sess-main" },
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/openclaw-sessions.json",
      },
      {
        mode: "recent",
        maxMessages: 1,
        maxBytes: 1024 * 1024,
        allowResetArchiveFallback: true,
      },
    );
  });

  it("uses a bounded page read for offset chat history pages", async () => {
    const rawMessages = [
      { role: "user", content: "oldest" },
      { role: "assistant", content: "older" },
      { role: "user", content: "newer" },
      { role: "assistant", content: "latest" },
    ];
    runtime.readSessionMessagesPageWithStatsAsync.mockImplementationOnce(async () => ({
      messages: rawMessages.slice(0, 2),
      totalMessages: rawMessages.length,
    }));

    const callGateway = createEmbeddedCallGateway();
    const result = await callGateway<{
      messages: unknown[];
      offset?: number;
      nextOffset?: number;
      hasMore?: boolean;
      totalMessages?: number;
    }>({
      method: "chat.history",
      params: { sessionKey: "agent:main:main", limit: 2, offset: 2 },
    });

    expect(runtime.readSessionMessagesAsync).not.toHaveBeenCalled();
    expect(runtime.readSessionMessagesPageWithStatsAsync).toHaveBeenCalledWith(
      {
        agentId: "main",
        sessionEntry: { sessionId: "sess-main" },
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/openclaw-sessions.json",
      },
      {
        offset: 2,
        maxMessages: 3,
        allowResetArchiveFallback: true,
      },
    );
    expect(runtime.projectChatDisplayMessages).toHaveBeenCalledWith(rawMessages.slice(0, 2), {
      maxChars: 100_000,
    });
    expect(result).toMatchObject({
      messages: rawMessages.slice(0, 2),
      offset: 2,
      hasMore: false,
      totalMessages: 4,
    });
    expect(result.nextOffset).toBeUndefined();
  });

  it("caps projected offset chat history pages to the requested limit", async () => {
    const rawMessages = [
      { role: "assistant", content: "overread", __openclaw: { seq: 1 } },
      { role: "assistant", content: "page anchor", __openclaw: { seq: 2 } },
    ];
    const projectedMessages = [
      { role: "assistant", content: "projected one", __openclaw: { seq: 2 } },
      { role: "assistant", content: "projected two", __openclaw: { seq: 3 } },
    ];
    runtime.readSessionMessagesPageWithStatsAsync.mockImplementationOnce(async () => ({
      messages: rawMessages,
      totalMessages: 4,
    }));
    runtime.projectChatDisplayMessages.mockReturnValueOnce(projectedMessages);

    const callGateway = createEmbeddedCallGateway();
    const result = await callGateway<{
      messages: unknown[];
      nextOffset?: number;
      hasMore?: boolean;
    }>({
      method: "chat.history",
      params: { sessionKey: "agent:main:main", limit: 1, offset: 1 },
    });

    expect(runtime.projectChatDisplayMessages).toHaveBeenCalledWith([rawMessages[1]], {
      maxChars: 100_000,
    });
    expect(result.messages).toEqual([projectedMessages[1]]);
    expect(result.nextOffset).toBe(2);
    expect(result.hasMore).toBe(true);
  });

  it("filters offset chat history pages at the session start boundary", async () => {
    const rawMessages = [
      { role: "user", content: "stale announce", __openclaw: { seq: 1 } },
      { role: "assistant", content: "stale reply", __openclaw: { seq: 2 } },
    ];
    const filteredMessages: unknown[] = [];
    runtime.loadSessionEntry.mockReturnValueOnce({
      cfg: {},
      storePath: "/tmp/openclaw-sessions.json",
      entry: { sessionId: "sess-main", sessionStartedAt: 1234 } as {
        sessionId: string;
        sessionStartedAt: number;
      },
    });
    runtime.readSessionMessagesPageWithStatsAsync.mockImplementationOnce(async () => ({
      messages: rawMessages,
      totalMessages: 2,
    }));
    runtime.dropPreSessionStartAnnouncePairs.mockReturnValueOnce(filteredMessages);

    const callGateway = createEmbeddedCallGateway();
    const result = await callGateway<{ messages: unknown[] }>({
      method: "chat.history",
      params: { sessionKey: "agent:main:main", limit: 1, offset: 1 },
    });

    expect(runtime.dropPreSessionStartAnnouncePairs).toHaveBeenCalledWith(rawMessages, 1234);
    expect(runtime.projectChatDisplayMessages).toHaveBeenCalledWith(filteredMessages, {
      maxChars: 100_000,
    });
    expect(result.messages).toEqual(filteredMessages);
  });

  it("does not merge full CLI imports into explicit offset chat history pages", async () => {
    const rawMessages = [{ role: "assistant", content: "local page", __openclaw: { seq: 2 } }];
    runtime.readSessionMessagesPageWithStatsAsync.mockImplementationOnce(async () => ({
      messages: rawMessages,
      totalMessages: 2,
    }));

    const callGateway = createEmbeddedCallGateway();
    const result = await callGateway<{ messages: unknown[] }>({
      method: "chat.history",
      params: { sessionKey: "agent:main:main", limit: 1, offset: 1 },
    });

    expect(runtime.augmentChatHistoryWithCliSessionImports).not.toHaveBeenCalled();
    expect(result.messages).toEqual(rawMessages);
  });

  it("overreads bounded recent history for the first offset page", async () => {
    const rawMessages = [
      { role: "user", content: "visible older", __openclaw: { seq: 6 } },
      { role: "assistant", content: "hidden control", __openclaw: { seq: 7 } },
      { role: "assistant", content: "visible latest", __openclaw: { seq: 8 } },
    ];
    const projectedMessages = [rawMessages[0], rawMessages[2]];
    runtime.readRecentSessionMessagesWithStatsAsync.mockImplementationOnce(async () => ({
      messages: rawMessages,
      totalMessages: 10,
    }));
    runtime.projectRecentChatDisplayMessages.mockReturnValueOnce(projectedMessages);

    const callGateway = createEmbeddedCallGateway();
    const result = await callGateway<{
      messages: unknown[];
      offset?: number;
      nextOffset?: number;
      hasMore?: boolean;
      totalMessages?: number;
    }>({
      method: "chat.history",
      params: { sessionKey: "agent:main:main", limit: 2, offset: 0 },
    });

    expect(runtime.readSessionMessagesAsync).not.toHaveBeenCalled();
    expect(runtime.readRecentSessionMessagesWithStatsAsync).toHaveBeenCalledWith(
      {
        agentId: "main",
        sessionEntry: { sessionId: "sess-main" },
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/openclaw-sessions.json",
      },
      {
        maxMessages: 61,
        maxBytes: 1024 * 1024,
        allowResetArchiveFallback: true,
      },
    );
    expect(runtime.projectRecentChatDisplayMessages).toHaveBeenCalledWith(rawMessages, {
      maxChars: 100_000,
      maxMessages: 2,
    });
    expect(result).toMatchObject({
      messages: projectedMessages,
      offset: 0,
      nextOffset: 5,
      hasMore: true,
      totalMessages: 10,
    });
  });

  it("computes offset continuation from the final budgeted chat history page", async () => {
    const rawMessages = [
      { role: "user", content: "visible older", __openclaw: { seq: 6 } },
      { role: "assistant", content: "visible newer", __openclaw: { seq: 7 } },
      { role: "assistant", content: "visible latest", __openclaw: { seq: 8 } },
    ];
    const returnedMessages = [rawMessages[2]];
    runtime.readRecentSessionMessagesWithStatsAsync.mockImplementationOnce(async () => ({
      messages: rawMessages,
      totalMessages: 10,
    }));
    runtime.enforceChatHistoryFinalBudget.mockReturnValueOnce({ messages: returnedMessages });

    const callGateway = createEmbeddedCallGateway();
    const result = await callGateway<{
      messages: unknown[];
      nextOffset?: number;
      hasMore?: boolean;
    }>({
      method: "chat.history",
      params: { sessionKey: "agent:main:main", limit: 3, offset: 0 },
    });

    expect(result.messages).toEqual(returnedMessages);
    expect(result.nextOffset).toBe(3);
    expect(result.hasMore).toBe(true);
  });

  it("normalizes string chat history limits before projection", async () => {
    const rawMessages = [
      { role: "user", content: "older" },
      { role: "assistant", content: "newer" },
    ];
    runtime.readSessionMessagesAsync.mockResolvedValueOnce(rawMessages);

    const callGateway = createEmbeddedCallGateway();
    await callGateway<{ messages: unknown[] }>({
      method: "chat.history",
      params: { sessionKey: "agent:main:main", limit: "2" },
    });

    expect(runtime.projectRecentChatDisplayMessages).toHaveBeenCalledWith(rawMessages, {
      maxChars: 100_000,
      maxMessages: 2,
    });
    expect(runtime.readSessionMessagesAsync).toHaveBeenCalledWith(
      {
        agentId: "main",
        sessionEntry: { sessionId: "sess-main" },
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/openclaw-sessions.json",
      },
      {
        mode: "recent",
        maxMessages: 2,
        maxBytes: 1024 * 1024,
        allowResetArchiveFallback: true,
      },
    );
  });

  it("rejects malformed chat history limits before reading session files", async () => {
    const callGateway = createEmbeddedCallGateway();

    await expect(
      callGateway({
        method: "chat.history",
        params: { sessionKey: "agent:main:main", limit: "2.5" },
      }),
    ).rejects.toThrow("limit must be a positive integer");
    await expect(
      callGateway({
        method: "chat.history",
        params: { sessionKey: "agent:main:main", limit: -1 },
      }),
    ).rejects.toThrow("limit must be a positive integer");
    expect(runtime.readSessionMessagesAsync).not.toHaveBeenCalled();
  });

  it("rejects malformed chat history offsets before reading session files", async () => {
    const callGateway = createEmbeddedCallGateway();

    await expect(
      callGateway({
        method: "chat.history",
        params: { sessionKey: "agent:main:main", offset: -1 },
      }),
    ).rejects.toThrow("offset must be a non-negative integer");
    await expect(
      callGateway({
        method: "chat.history",
        params: { sessionKey: "agent:main:main", offset: 1.5 },
      }),
    ).rejects.toThrow("offset must be a non-negative integer");
    await expect(
      callGateway({
        method: "chat.history",
        params: { sessionKey: "agent:main:main", offset: "1abc" },
      }),
    ).rejects.toThrow("offset must be a non-negative integer");
    expect(runtime.readSessionMessagesAsync).not.toHaveBeenCalled();
    expect(runtime.readRecentSessionMessagesWithStatsAsync).not.toHaveBeenCalled();
    expect(runtime.readSessionMessagesPageWithStatsAsync).not.toHaveBeenCalled();
  });
});
