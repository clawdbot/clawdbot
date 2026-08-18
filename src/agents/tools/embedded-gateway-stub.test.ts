// Embedded gateway stub tests cover in-process gateway methods used by agent
// tools when no external gateway transport is available.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbeddedCallGateway } from "./embedded-gateway-stub.js";

const runtime = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({ agents: { list: [{ id: "main", default: true }] } })),
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveSessionStoreKey: vi.fn(({ sessionKey }: { sessionKey: string }) =>
    sessionKey === "main" ? "agent:main:main" : sessionKey,
  ),
  resolveStoredSessionKeyForAgentStore: vi.fn(
    ({ agentId, sessionKey }: { agentId: string; sessionKey: string }) =>
      sessionKey === "global" || sessionKey === "unknown"
        ? sessionKey
        : sessionKey.startsWith("agent:")
          ? sessionKey
          : `agent:${agentId}:${sessionKey}`,
  ),
  searchSessionTranscripts: vi.fn(() => ({ hits: [], indexing: false, truncated: false })),
  resolveSessionKeyFromResolveParams: vi.fn(),
  resolveSessionAgentId: vi.fn(() => "main"),
  loadSessionEntry: vi.fn(() => ({
    cfg: {},
    storePath: "/tmp/openclaw-sessions.json",
    entry: { sessionId: "sess-main" },
    canonicalKey: "agent:main:main",
  })),
  resolveSessionModelRef: vi.fn(() => ({ provider: "openai" })),
  readChatHistoryPage: vi.fn(async () => ({
    messages: [] as unknown[],
    responseOffset: undefined as number | undefined,
    pagination: { offset: 0, totalMessages: 0, rawPageMessages: 0 },
  })),
  resolveChatHistoryNextOffset: vi.fn(
    ({ offset, rawPageMessages }: { offset: number; rawPageMessages: number }) =>
      offset + rawPageMessages,
  ),
  shouldReplayOldestChatHistoryRecord: vi.fn(() => false),
  resolveEffectiveChatHistoryMaxChars: vi.fn(() => 100_000),
  getMaxChatHistoryMessagesBytes: vi.fn(() => 100_000),
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES: 100_000,
  replaceOversizedChatHistoryMessages: vi.fn(({ messages }: { messages: unknown[] }) => ({
    messages,
  })),
  capArrayByJsonBytes: vi.fn((items: unknown[]) => ({ items })),
  loadCombinedSessionStoreForGatewayCore: vi.fn(() => ({
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
    runtime.readChatHistoryPage.mockClear();
    runtime.resolveChatHistoryNextOffset.mockClear();
    runtime.shouldReplayOldestChatHistoryRecord.mockClear();
    runtime.loadSessionEntry.mockClear();
    runtime.resolveSessionAgentId.mockClear();
    runtime.resolveSessionStoreKey.mockClear();
    runtime.resolveStoredSessionKeyForAgentStore.mockClear();
    runtime.searchSessionTranscripts.mockClear();
    runtime.loadCombinedSessionStoreForGatewayCore.mockClear();
    runtime.listSessionsFromStoreAsync.mockClear();
  });

  it("scopes embedded session lists to the requested agent", async () => {
    const callGateway = createEmbeddedCallGateway();
    await callGateway({
      method: "sessions.list",
      params: { agentId: "work", includeGlobal: true, search: "global" },
    });

    expect(runtime.loadCombinedSessionStoreForGatewayCore).toHaveBeenCalledWith(
      { agents: { list: [{ id: "main", default: true }] } },
      { agentId: "work", projection: "list" },
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
      client: null,
      p: { sessionId: "sess-main", includeGlobal: true },
    });
  });

  it("preserves short-id ambiguity as a successful embedded response", async () => {
    const candidates = [
      { key: "agent:main:thread:12345678-0aaa-4000-8000-000000000001", displayName: "One" },
      { key: "agent:main:thread:12345678-0bbb-4000-8000-000000000002", displayName: "Two" },
    ];
    runtime.resolveSessionKeyFromResolveParams.mockResolvedValueOnce({
      ok: true,
      ambiguous: true,
      candidates,
    });

    const callGateway = createEmbeddedCallGateway();
    await expect(
      callGateway({ method: "sessions.resolve", params: { shortId: "12345678" } }),
    ).resolves.toEqual({ ok: false, candidates });
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

  it("canonicalizes embedded session search filters", async () => {
    const callGateway = createEmbeddedCallGateway();
    await callGateway({
      method: "sessions.search",
      params: {
        agentId: "main",
        query: "needle",
        sessionKeys: ["main", "agent:main:other"],
        limit: 3,
      },
    });

    expect(runtime.resolveStoredSessionKeyForAgentStore).toHaveBeenNthCalledWith(1, {
      cfg: { agents: { list: [{ id: "main", default: true }] } },
      agentId: "main",
      sessionKey: "main",
    });
    expect(runtime.resolveStoredSessionKeyForAgentStore).toHaveBeenNthCalledWith(2, {
      cfg: { agents: { list: [{ id: "main", default: true }] } },
      agentId: "main",
      sessionKey: "agent:main:other",
    });
    expect(runtime.searchSessionTranscripts).toHaveBeenCalledWith({
      agentId: "main",
      query: "needle",
      limit: 3,
      sessionKeys: ["agent:main:main", "agent:main:other"],
    });
  });

  it("rejects empty session-key filters instead of widening the search", async () => {
    const callGateway = createEmbeddedCallGateway();

    await expect(
      callGateway({ method: "sessions.search", params: { query: "needle", sessionKeys: [] } }),
    ).rejects.toThrow("sessionKeys must be a non-empty array of session keys");
    await expect(
      callGateway({ method: "sessions.search", params: { query: "needle", sessionKeys: [7] } }),
    ).rejects.toThrow("sessionKeys must be a non-empty array of session keys");
    expect(runtime.searchSessionTranscripts).not.toHaveBeenCalled();
  });

  it("rejects oversized embedded session search queries", async () => {
    const callGateway = createEmbeddedCallGateway();

    await expect(
      callGateway({ method: "sessions.search", params: { query: "x".repeat(4097) } }),
    ).rejects.toThrow("query must not exceed 4096 characters");
    expect(runtime.searchSessionTranscripts).not.toHaveBeenCalled();
  });

  it("rejects an explicit agent that conflicts with an unscoped store owner", async () => {
    runtime.resolveSessionAgentId.mockImplementationOnce(() => {
      throw new Error('The shared fixed-store row belongs to "ops", not "research".');
    });
    const callGateway = createEmbeddedCallGateway();

    await expect(
      callGateway({
        method: "sessions.search",
        params: { agentId: "research", query: "needle", sessionKeys: ["global"] },
      }),
    ).rejects.toThrow('belongs to "ops", not "research"');
    expect(runtime.resolveSessionAgentId).toHaveBeenCalledWith({
      sessionKey: "global",
      config: { agents: { list: [{ id: "main", default: true }] } },
      agentId: "research",
    });
    expect(runtime.searchSessionTranscripts).not.toHaveBeenCalled();
  });

  it("delegates embedded chat history to the canonical history reader", async () => {
    const recoveredMessages = [{ role: "assistant", content: "visible before silent tail" }];
    runtime.readChatHistoryPage.mockResolvedValueOnce({
      messages: recoveredMessages,
      responseOffset: undefined,
      pagination: { offset: 0, totalMessages: 42, rawPageMessages: 42 },
    });

    const callGateway = createEmbeddedCallGateway();
    const result = await callGateway<{ messages: unknown[] }>({
      method: "chat.history",
      params: { sessionKey: "agent:main:main", limit: 1 },
    });

    expect(runtime.readChatHistoryPage).toHaveBeenCalledWith({
      entry: { sessionId: "sess-main" },
      provider: "openai",
      sessionId: "sess-main",
      storePath: "/tmp/openclaw-sessions.json",
      sessionAgentId: "main",
      canonicalKey: "agent:main:main",
      max: 1,
      maxHistoryBytes: 100_000,
      effectiveMaxChars: 100_000,
      offset: undefined,
      messageId: undefined,
    });
    expect(result.messages).toEqual(recoveredMessages);
  });

  it("scopes embedded global chat history to the requested agent", async () => {
    const callGateway = createEmbeddedCallGateway();
    await callGateway({
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
    const callGateway = createEmbeddedCallGateway();
    await callGateway({
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

  it("uses shared pagination after applying the embedded response budget", async () => {
    const projectedMessages = [
      { role: "assistant", content: "older", __openclaw: { seq: 6 } },
      { role: "assistant", content: "newer", __openclaw: { seq: 7 } },
    ];
    const boundedMessages = [projectedMessages[1]];
    runtime.readChatHistoryPage.mockResolvedValueOnce({
      messages: projectedMessages,
      responseOffset: 2,
      pagination: { offset: 2, totalMessages: 10, rawPageMessages: 2 },
    });
    runtime.capArrayByJsonBytes.mockReturnValueOnce({ items: boundedMessages });
    runtime.shouldReplayOldestChatHistoryRecord.mockReturnValueOnce(true);
    runtime.resolveChatHistoryNextOffset.mockReturnValueOnce(4);

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

    expect(runtime.readChatHistoryPage).toHaveBeenCalledWith(
      expect.objectContaining({ max: 2, offset: 2 }),
    );
    expect(runtime.shouldReplayOldestChatHistoryRecord).toHaveBeenCalledWith({
      projected: projectedMessages,
      bounded: boundedMessages,
    });
    expect(runtime.resolveChatHistoryNextOffset).toHaveBeenCalledWith({
      messages: boundedMessages,
      totalMessages: 10,
      offset: 2,
      rawPageMessages: 2,
      replayOldestRecord: true,
    });
    expect(result).toEqual({
      sessionKey: "agent:main:main",
      sessionId: "sess-main",
      messages: boundedMessages,
      offset: 2,
      nextOffset: 4,
      hasMore: true,
      totalMessages: 10,
      thinkingLevel: undefined,
      fastMode: undefined,
      verboseLevel: undefined,
    });
  });

  it("normalizes string chat history limits before delegating", async () => {
    const callGateway = createEmbeddedCallGateway();
    await callGateway({
      method: "chat.history",
      params: { sessionKey: "agent:main:main", limit: "2" },
    });

    expect(runtime.readChatHistoryPage).toHaveBeenCalledWith(expect.objectContaining({ max: 2 }));
  });

  it("rejects malformed chat history limits before reading history", async () => {
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
    expect(runtime.readChatHistoryPage).not.toHaveBeenCalled();
  });

  it("rejects malformed chat history offsets before reading history", async () => {
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
    expect(runtime.readChatHistoryPage).not.toHaveBeenCalled();
  });
});
