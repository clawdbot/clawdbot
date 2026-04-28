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
  readSessionMessages: vi.fn((): unknown[] => []),
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
}));

vi.mock("./embedded-gateway-stub.runtime.js", () => runtime);

describe("embedded gateway stub", () => {
  beforeEach(() => {
    runtime.getRuntimeConfig.mockClear();
    runtime.resolveSessionKeyFromResolveParams.mockReset();
    runtime.projectRecentChatDisplayMessages.mockClear();
    runtime.readSessionMessages.mockClear();
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
    const rawMessages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const projectedMessages = [{ role: "assistant", content: "hi" }];
    runtime.readSessionMessages.mockReturnValueOnce(rawMessages);
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
    expect(result.messages).toEqual(projectedMessages);
  });

  it("passes the full raw history to projection before limiting visible messages", async () => {
    const rawMessages = [
      { role: "user", content: "visible older" },
      { role: "assistant", content: "hidden newer" },
    ];
    runtime.readSessionMessages.mockReturnValueOnce(rawMessages);

    const callGateway = createEmbeddedCallGateway();
    await callGateway<{ messages: unknown[] }>({
      method: "chat.history",
      params: { sessionKey: "agent:main:main", limit: 1 },
    });

    expect(runtime.projectRecentChatDisplayMessages).toHaveBeenCalledWith(rawMessages, {
      maxChars: 100_000,
      maxMessages: 1,
    });
  });
});
