import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MESSAGE_MERGE_STRATEGY_ID,
  registerMessageMergeStrategyForTest,
  resolveMessageMergeStrategy,
  type MessageMergeStrategy,
} from "./message-merge-strategy.js";

let restoreStrategy: (() => void) | undefined;

afterEach(() => {
  restoreStrategy?.();
  restoreStrategy = undefined;
});

describe("message merge strategy registry", () => {
  it("resolves the default orphan trailing user prompt strategy", () => {
    const strategy = resolveMessageMergeStrategy();

    expect(strategy.id).toBe(DEFAULT_MESSAGE_MERGE_STRATEGY_ID);
    expect(
      strategy.mergeOrphanedTrailingUserPrompt({
        prompt: "newest inbound message",
        trigger: "user",
        leafMessage: { content: "older active-turn message" },
      }),
    ).toEqual({
      merged: true,
      removeLeaf: true,
      prompt:
        "[Queued user message that arrived while the previous turn was still active]\n" +
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
