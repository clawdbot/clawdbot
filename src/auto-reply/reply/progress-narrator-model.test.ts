import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateNarrationWithUtilityModel } from "./progress-narrator-model.js";

const complete = vi.hoisted(() => vi.fn());
vi.mock("../../agents/simple-completion-runtime.js", () => ({
  completeWithPreparedSimpleCompletionModel: complete,
  prepareSimpleCompletionModelForAgent: vi.fn(),
}));

const prepared: Parameters<typeof generateNarrationWithUtilityModel>[0]["prepared"] = {
  selection: { provider: "openai", modelId: "gpt-test", agentDir: "/unused-narration-test" },
  model: {
    provider: "openai",
    id: "gpt-test",
    name: "Narration test",
    api: "openai-responses",
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 4096,
  },
  auth: { apiKey: "synthetic", source: "test", mode: "api-key" },
};

beforeEach(() => {
  vi.useFakeTimers();
  complete.mockReset();
  complete.mockResolvedValue({
    stopReason: "stop",
    content: [{ type: "text", text: "Working on the request." }],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("progress narration completion cancellation", () => {
  it.each([false, true])(
    "does not dispatch an already aborted request: aborted=%s",
    async (aborted) => {
      const controller = new AbortController();
      if (aborted) {
        controller.abort();
      }

      const result = await generateNarrationWithUtilityModel({
        cfg: {},
        prepared,
        input: {
          userMessage: "Inspect the fixture",
          activityNotes: ["Tool read"],
          previousText: "",
        },
        abortSignal: controller.signal,
      });

      expect(complete).toHaveBeenCalledTimes(aborted ? 0 : 1);
      expect(result.text).toBe(aborted ? null : "Working on the request.");
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
