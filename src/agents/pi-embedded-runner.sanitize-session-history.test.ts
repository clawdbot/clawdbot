import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as helpers from "./pi-embedded-helpers.js";

type SanitizeSessionHistory =
  typeof import("./pi-embedded-runner/google.js").sanitizeSessionHistory;
let sanitizeSessionHistory: SanitizeSessionHistory;

// Mock dependencies
vi.mock("./pi-embedded-helpers.js", async () => {
  const actual = await vi.importActual("./pi-embedded-helpers.js");
  return {
    ...actual,
    isGoogleModelApi: vi.fn(),
    sanitizeSessionMessagesImages: vi.fn().mockImplementation(async (msgs) => msgs),
  };
});

// We don't mock session-transcript-repair.js as it is a pure function and complicates mocking.
// We rely on the real implementation which should pass through our simple messages.

describe("sanitizeSessionHistory", () => {
  const mockSessionManager = {
    getEntries: vi.fn().mockReturnValue([]),
    appendCustomEntry: vi.fn(),
  } as unknown as SessionManager;

  const mockMessages: AgentMessage[] = [{ role: "user", content: "hello" }];

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.mocked(helpers.sanitizeSessionMessagesImages).mockImplementation(async (msgs) => msgs);
    vi.resetModules();
    ({ sanitizeSessionHistory } = await import("./pi-embedded-runner/google.js"));
  });

  it("sanitizes tool call ids for Google model APIs", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(true);

    await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "google-generative-ai",
      provider: "google-vertex",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(helpers.sanitizeSessionMessagesImages).toHaveBeenCalledWith(
      mockMessages,
      "session:history",
      expect.objectContaining({ sanitizeMode: "full", sanitizeToolCallIds: true }),
    );
  });

  it("sanitizes tool call ids with strict9 for Mistral models", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(false);

    await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "openai-responses",
      provider: "openrouter",
      modelId: "mistralai/devstral-2512:free",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(helpers.sanitizeSessionMessagesImages).toHaveBeenCalledWith(
      mockMessages,
      "session:history",
      expect.objectContaining({
        sanitizeMode: "full",
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict9",
      }),
    );
  });

  it("does not sanitize tool call ids for non-Google APIs", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(false);

    await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(helpers.sanitizeSessionMessagesImages).toHaveBeenCalledWith(
      mockMessages,
      "session:history",
      expect.objectContaining({ sanitizeMode: "full", sanitizeToolCallIds: false }),
    );
  });

  it("sanitizes tool call ids for openai-responses", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(false);

    await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(helpers.sanitizeSessionMessagesImages).toHaveBeenCalledWith(
      mockMessages,
      "session:history",
      expect.objectContaining({ sanitizeMode: "images-only", sanitizeToolCallIds: true }),
    );
  });

  it("keeps reasoning-only assistant messages for openai-responses", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(false);

    const messages: AgentMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        stopReason: "aborted",
        content: [
          {
            type: "thinking",
            thinking: "reasoning",
            thinkingSignature: "sig",
          },
        ],
      },
    ];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(result).toHaveLength(2);
    expect(result[1]?.role).toBe("assistant");
  });

  it("does not synthesize tool results for openai-responses", async () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
    ];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("assistant");
  });

  it("does not downgrade openai reasoning when the model has not changed", async () => {
    const sessionEntries: Array<{ type: string; customType: string; data: unknown }> = [
      {
        type: "custom",
        customType: "model-snapshot",
        data: {
          timestamp: Date.now(),
          provider: "openai",
          modelApi: "openai-responses",
          modelId: "gpt-5.2-codex",
        },
      },
    ];
    const sessionManager = {
      getEntries: vi.fn(() => sessionEntries),
      appendCustomEntry: vi.fn((customType: string, data: unknown) => {
        sessionEntries.push({ type: "custom", customType, data });
      }),
    } as unknown as SessionManager;
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "reasoning",
            thinkingSignature: JSON.stringify({ id: "rs_test", type: "reasoning" }),
          },
        ],
      },
    ];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      modelId: "gpt-5.2-codex",
      sessionManager,
      sessionId: "test-session",
    });

    expect(result).toEqual(messages);
  });

  it("downgrades openai reasoning only when the model changes", async () => {
    const sessionEntries: Array<{ type: string; customType: string; data: unknown }> = [
      {
        type: "custom",
        customType: "model-snapshot",
        data: {
          timestamp: Date.now(),
          provider: "anthropic",
          modelApi: "anthropic-messages",
          modelId: "claude-3-7",
        },
      },
    ];
    const sessionManager = {
      getEntries: vi.fn(() => sessionEntries),
      appendCustomEntry: vi.fn((customType: string, data: unknown) => {
        sessionEntries.push({ type: "custom", customType, data });
      }),
    } as unknown as SessionManager;
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "reasoning",
            thinkingSignature: { id: "rs_test", type: "reasoning" },
          },
        ],
      },
    ];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      modelId: "gpt-5.2-codex",
      sessionManager,
      sessionId: "test-session",
    });

    expect(result).toEqual([]);
  });
});
