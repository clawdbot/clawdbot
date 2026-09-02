import { describe, expect, it, vi } from "vitest";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";

describe("progress draft reasoning truncation", () => {
  it.each([
    {
      name: "retains a complete filename in the reasoning body",
      input: "review ".repeat(15) + "important.json next",
      expected: "review ".repeat(15) + "important.json…",
    },
    {
      name: "uses code-point positions for reasoning word backoff",
      input: "𠮷".repeat(40) + " " + "x".repeat(100),
      expected: "𠮷".repeat(40) + " " + "x".repeat(78) + "…",
    },
  ])("$name", async ({ input, expected }) => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      mode: "progress",
      active: true,
      seed: "test",
      entry: {
        streaming: { mode: "progress", progress: { label: false, maxLineChars: 122 } },
      },
      update,
    });
    try {
      await progress.start();
      await progress.pushReasoningProgress(input, { snapshot: true });

      expect(update.mock.lastCall?.[0]).toBe(`• _${expected}_`);
    } finally {
      progress.cancel();
    }
  });
});
