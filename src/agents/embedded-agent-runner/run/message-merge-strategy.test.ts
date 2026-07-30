// Message merge strategy tests pin behavior when a new inbound user prompt
// arrives while an earlier turn still owns the transcript leaf.
import { describe, expect, it } from "vitest";
import { resolveMessageMergeStrategy } from "./message-merge-strategy.js";

describe("message merge strategy", () => {
  it("resolves the default orphan trailing user prompt strategy", () => {
    // The default merge preserves both user asks and marks the old transcript
    // leaf for removal so the active turn has one canonical prompt.
    const strategy = resolveMessageMergeStrategy();

    expect(strategy.id).toBe("orphan-trailing-user-prompt");
    const result = strategy.mergeOrphanedTrailingUserPrompt({
      prompt: "newest inbound message",
      trigger: "user",
      leafMessage: { content: "older active-turn message" },
    });
    expect(result).toEqual({
      merged: true,
      removeLeaf: true,
      prompt:
        "[Queued user message from a previous active turn; preserved as context only. Continue with the active prompt below.]\n" +
        "older active-turn message\n\nnewest inbound message",
    });
  });
});
