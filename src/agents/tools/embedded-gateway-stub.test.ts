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
  augmentChatHistoryWithCliSessionImports: vi.fn(
    ({ localMessages }: { localMessages?: unknown[] }) => localMessages ?? [],
  ),
  resolveEffectiveChatHistoryMaxChars: vi.fn(() => 100_000),
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
    runtime.projectRecentChatDisplayMessages.mockClear();
    runtime.readSessionMessagesAsync.mockClear();
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
    runtime.readSessionMessagesAsync.mockResolvedValueOnce(rawMessages);
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
    runtime.readSessionMessagesAsync.mockResolvedValueOnce(rawMessages);

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
});
