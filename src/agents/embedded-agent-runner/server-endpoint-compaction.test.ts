import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestPreparedCompactionMock } = vi.hoisted(() => ({
  requestPreparedCompactionMock: vi.fn(),
}));

vi.mock("@openclaw/ai/transports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/ai/transports")>()),
  requestPreparedOpenAIResponsesCompaction: requestPreparedCompactionMock,
}));

import { testing } from "../openai-transport-stream.test-support.js";
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
    api: "openai-responses",
    provider: "xai",
    model: "grok-4.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
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
      streamFn: vi.fn(),
      model,
      context: { systemPrompt: "system", messages: session.messages },
      sessionManager: session.sessionManager,
      extraParams: {},
      requestOptions: { apiKey: "test", sessionId: "session-1", timeoutMs: 1_000 },
      ...overrides,
    }),
  };
}

beforeEach(() => {
  requestPreparedCompactionMock.mockReset();
  requestPreparedCompactionMock.mockResolvedValue({
    item: { type: "compaction", id: "cmp_test", encrypted_content: "opaque" },
    output: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "remember copper" }] },
      { type: "compaction", id: "cmp_test", encrypted_content: "opaque" },
    ],
    historyMode: "retained-users",
    usage: { input_tokens: 1_000, output_tokens: 200, dropped_message_count: 1 },
    model,
    replayMetadata: testing.buildOpenAIResponsesReasoningReplayMetadata(model, {
      sessionId: "session-1",
    }),
  });
});

describe("attemptServerEndpointCompaction", () => {
  it("persists a summaryless checkpoint through the SessionManager rewrite owner", async () => {
    const { session, result } = attempt();

    await expect(result).resolves.toMatchObject({
      item: { type: "compaction", id: "cmp_test", encrypted_content: "opaque" },
      usage: { input_tokens: 1_000, output_tokens: 200, dropped_message_count: 1 },
    });
    const owner = session.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (!owner || owner.type !== "message" || owner.message.role !== "assistant") {
      throw new Error("expected persisted assistant checkpoint owner");
    }
    expect(owner.message.content).toEqual([{ type: "text", text: "remembered" }]);
    expect(owner.message.providerReplay).toMatchObject({
      type: "openai-responses-retained-compaction",
      id: "cmp_test",
      data: "opaque",
      compactedWindow: {
        state: "ready",
        output: JSON.stringify([
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "remember copper" }],
          },
          { type: "compaction", id: "cmp_test", encrypted_content: "opaque" },
        ]),
      },
    });
    expect(owner.message.providerReplay).not.toHaveProperty("replayIndex");
  });

  it("marks a checkpoint-only response at the assistant content boundary", async () => {
    requestPreparedCompactionMock.mockResolvedValueOnce({
      item: { type: "compaction", id: "cmp_test", encrypted_content: "opaque" },
      output: [{ type: "compaction", id: "cmp_test", encrypted_content: "opaque" }],
      historyMode: "compacted-prefix",
      usage: { input_tokens: 1_000, output_tokens: 200 },
      model,
      replayMetadata: testing.buildOpenAIResponsesReasoningReplayMetadata(model, {
        sessionId: "session-1",
      }),
    });
    const { session, result } = attempt();

    await expect(result).resolves.toBeDefined();
    const owner = session.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (!owner || owner.type !== "message" || owner.message.role !== "assistant") {
      throw new Error("expected persisted assistant checkpoint owner");
    }
    expect(owner.message.providerReplay?.replayIndex).toBe(1);
  });

  it("aborts a pending endpoint request at the compaction timeout", async () => {
    let requestAborted = false;
    requestPreparedCompactionMock.mockImplementationOnce(
      async (
        _streamFn: unknown,
        _model: unknown,
        _context: unknown,
        options: { signal?: AbortSignal },
      ) =>
        await new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              requestAborted = true;
              reject(
                options.signal?.reason instanceof Error
                  ? options.signal.reason
                  : new Error("request aborted"),
              );
            },
            { once: true },
          );
        }),
    );

    const { result } = attempt({ requestOptions: { apiKey: "test", timeoutMs: 10 } });

    await expect(result).resolves.toBeUndefined();
    expect(requestAborted).toBe(true);
  });

  it("leaves the durable transcript intact when policy would redact the canonical window", async () => {
    const session = createSession();
    const before = structuredClone(session.sessionManager.getBranch());
    const { result } = attempt({
      sessionManager: session.sessionManager,
      context: { systemPrompt: "system", messages: session.messages },
      config: { logging: { redactPatterns: ["remember copper"] } },
    });

    await expect(result).resolves.toBeUndefined();
    expect(session.sessionManager.getBranch()).toEqual(before);
  });

  it("does not call the endpoint during overflow recovery", async () => {
    const { result } = attempt({ trigger: "overflow" });

    await expect(result).resolves.toBeUndefined();
    expect(requestPreparedCompactionMock).not.toHaveBeenCalled();
  });

  it("preserves custom instructions by falling back to client compaction", async () => {
    const { result } = attempt({ customInstructions: "Retain the security caveats." });

    await expect(result).resolves.toBeUndefined();
    expect(requestPreparedCompactionMock).not.toHaveBeenCalled();
  });

  it("does not compact transcript entries that remain after the checkpoint owner", async () => {
    const messages = createSession().messages.concat({
      role: "user",
      content: "trailing turn",
      timestamp: 3,
    });
    const { result } = attempt({ context: { systemPrompt: "system", messages } });

    await expect(result).resolves.toBeUndefined();
    expect(requestPreparedCompactionMock).not.toHaveBeenCalled();
  });
});
