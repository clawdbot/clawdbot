import type { AgentMessage, Model } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestCompactionMock } = vi.hoisted(() => ({
  requestCompactionMock: vi.fn(),
}));

vi.mock("@openclaw/ai/transports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/ai/transports")>()),
  requestOpenAIResponsesCompaction: requestCompactionMock,
}));

import { attemptServerEndpointCompaction } from "./server-endpoint-compaction.js";

const model = {
  id: "grok-4.5",
  name: "Grok 4.5",
  api: "openai-responses",
  provider: "xai",
  baseUrl: "https://api.x.ai/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 256_000,
  maxTokens: 8_192,
} satisfies Model;

function createSession() {
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage({ role: "user", content: "remember copper", timestamp: 1 });
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "remembered" }],
    timestamp: 2,
  });
  const messages = sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message as AgentMessage);
  return { sessionManager, messages };
}

function attempt(overrides: Partial<Parameters<typeof attemptServerEndpointCompaction>[0]> = {}) {
  const session = createSession();
  return {
    session,
    result: attemptServerEndpointCompaction({
      trigger: "manual",
      model,
      context: { systemPrompt: "system", messages: session.messages },
      sessionManager: session.sessionManager,
      requestOptions: { apiKey: "test", sessionId: "session-1", timeoutMs: 1_000 },
      ...overrides,
    }),
  };
}

beforeEach(() => {
  requestCompactionMock.mockReset();
  requestCompactionMock.mockResolvedValue({
    item: { type: "compaction", id: "cmp_test", encrypted_content: "opaque" },
    usage: { input_tokens: 1_000, output_tokens: 200, dropped_message_count: 1 },
  });
});

describe("attemptServerEndpointCompaction", () => {
  it("persists a summaryless checkpoint through the SessionManager rewrite owner", async () => {
    const { session, result } = attempt();

    await expect(result).resolves.toEqual({
      item: { type: "compaction", id: "cmp_test", encrypted_content: "opaque" },
      usage: { input_tokens: 1_000, output_tokens: 200, dropped_message_count: 1 },
    });
    const owner = session.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    expect(owner?.type === "message" ? owner.message.content : undefined).toEqual([
      { type: "text", text: "remembered" },
    ]);
    expect(owner?.type === "message" ? owner.message.providerReplay : undefined).toMatchObject({
      type: "openai-responses-compaction",
      id: "cmp_test",
      data: "opaque",
      replayIndex: 1,
    });
  });

  it("aborts a pending endpoint request at the compaction timeout", async () => {
    let requestAborted = false;
    requestCompactionMock.mockImplementationOnce(
      async (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) =>
        await new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              requestAborted = true;
              reject(options.signal?.reason);
            },
            { once: true },
          );
        }),
    );

    const { result } = attempt({ requestOptions: { apiKey: "test", timeoutMs: 10 } });

    await expect(result).resolves.toBeUndefined();
    expect(requestAborted).toBe(true);
  });

  it("does not call the endpoint during overflow recovery", async () => {
    const { result } = attempt({ trigger: "overflow" });

    await expect(result).resolves.toBeUndefined();
    expect(requestCompactionMock).not.toHaveBeenCalled();
  });
});
