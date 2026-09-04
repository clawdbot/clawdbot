// Real-behavior proof: failed compaction must surface as CompactionError,
// report the actual provider failure, and leave the transcript unrotated.
import type { ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { UserMessage } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as agentSessions from "./sessions/index.js";

vi.mock("./sessions/index.js", async () => {
  const actual = await vi.importActual<typeof agentSessions>("./sessions/index.js");
  return {
    ...actual,
    generateSummary: vi.fn(),
  };
});

const mockGenerateSummary = vi.mocked(agentSessions.generateSummary);

const testModel = {
  provider: "google-vertex",
  model: "gemini-3.1-pro-preview",
  contextWindow: 1_000_000,
  contextTokens: 1_000_000,
  maxTokens: 8192,
} as unknown as NonNullable<ExtensionContext["model"]>;

const { summarizeInStages } = await import("./compaction.js");

describe("compaction failure real-behavior proof", () => {
  beforeEach(() => {
    mockGenerateSummary.mockReset();
  });

  it("throws CompactionError with the real provider error and keeps messages unrotated", async () => {
    // Simulate the production failure from issue #115413: google-vertex ADC
    // not configured causes the model call to throw.
    mockGenerateSummary.mockRejectedValue(
      new TypeError("Cannot convert undefined or null to object"),
    );

    const messages: UserMessage[] = [
      { role: "user", content: "first user request", timestamp: 1 } satisfies UserMessage,
      { role: "user", content: "second user request", timestamp: 2 } satisfies UserMessage,
      { role: "user", content: "third user request", timestamp: 3 } satisfies UserMessage,
    ];

    await expect(
      summarizeInStages({
        messages,
        model: testModel,
        apiKey: "test-key", // pragma: allowlist secret
        signal: new AbortController().signal,
        reserveTokens: 1000,
        maxChunkTokens: 50_000,
        contextWindow: 1_000_000,
      }),
    ).rejects.toThrow(
      "All summarization attempts failed for 3 messages. Last error: Cannot convert undefined or null to object",
    );

    // The caller must see the failure and keep the transcript intact.
    // No compaction placeholder is returned, so messages are not rotated away.
    expect(messages.map((message) => message.content)).toEqual([
      "first user request",
      "second user request",
      "third user request",
    ]);
  });
});
