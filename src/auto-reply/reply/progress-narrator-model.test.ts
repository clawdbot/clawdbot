import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateNarrationWithUtilityModel } from "./progress-narrator-model.js";

const complete = vi.hoisted(() => vi.fn());
vi.mock("../../agents/isolated-completion.js", () => ({
  runIsolatedCompletion: complete,
}));
vi.mock("../../agents/utility-completion.js", () => ({
  prepareUtilityCompletionForAgent: vi.fn(),
}));

const prepared: Parameters<typeof generateNarrationWithUtilityModel>[0]["prepared"] = {
  config: {},
  provider: "openai",
  model: "gpt-test",
  authProfileId: undefined,
  outputTextPolicy: "strict-visible",
  agentId: "main",
  agentDir: "/unused-narration-test",
};

beforeEach(() => {
  vi.useFakeTimers();
  complete.mockReset();
  complete.mockResolvedValue({
    text: "Working on the request.",
    provider: "openai",
    model: "gpt-test",
    owner: { kind: "harness", id: "openclaw" },
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
