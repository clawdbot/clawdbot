// Message merge strategy tests pin the registry used when a new inbound user
// prompt arrives while an earlier turn still owns the transcript leaf.
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MESSAGE_MERGE_STRATEGY_ID,
  registerMessageMergeStrategyForTest,
  resolveMessageMergeStrategy,
  type MessageMergeStrategy,
} from "./message-merge-strategy.js";

let restoreStrategy: (() => void) | undefined;

afterEach(() => {
  // Test overrides are process-local registry state and must not leak into the
  // next case or later embedded runner tests.
  restoreStrategy?.();
  restoreStrategy = undefined;
});

describe("message merge strategy registry", () => {
  it("resolves the default orphan trailing user prompt strategy", () => {
    // The default merge preserves both user asks and marks the old transcript
    // leaf for removal so the active turn has one canonical prompt.
    const strategy = resolveMessageMergeStrategy();

    expect(strategy.id).toBe(DEFAULT_MESSAGE_MERGE_STRATEGY_ID);
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

  it("allows tests to override and restore the active strategy", () => {
    const override: MessageMergeStrategy = {
      id: DEFAULT_MESSAGE_MERGE_STRATEGY_ID,
      mergeOrphanedTrailingUserPrompt: (params) => ({
        prompt: `override: ${params.prompt}`,
        merged: false,
        removeLeaf: false,
      }),
    };

    restoreStrategy = registerMessageMergeStrategyForTest(override);

    expect(
      resolveMessageMergeStrategy().mergeOrphanedTrailingUserPrompt({
        prompt: "next",
        trigger: "manual",
        leafMessage: { content: "previous" },
      }),
    ).toEqual({
      prompt: "override: next",
      merged: false,
      removeLeaf: false,
    });

    restoreStrategy();
    restoreStrategy = undefined;
    expect(resolveMessageMergeStrategy()).not.toBe(override);
  });
});
