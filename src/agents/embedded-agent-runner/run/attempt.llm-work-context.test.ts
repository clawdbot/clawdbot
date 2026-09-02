import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import {
  normalizeCurrentPromptTextForLlmBoundary,
  normalizeMessagesForLlmBoundary,
} from "./attempt-llm-boundary.js";

describe("work context at the LLM boundary", () => {
  it("projects frozen initial and steered work context without changing user text", () => {
    let history: AgentMessage[] = [];
    const snapshots = ["selection A", "selection A", "selection B", null, undefined, null];
    for (const [index, snapshot] of snapshots.entries()) {
      const runtimeMessage: AgentMessage = {
        role: "user",
        content: `user ${index}`,
        timestamp: index + 1,
      };
      const transcriptMessage = {
        ...runtimeMessage,
        __openclaw: snapshot === undefined ? {} : { workContext: snapshot },
      };
      history = normalizeMessagesForLlmBoundary([...history, runtimeMessage], {
        includeTimestamp: false,
        userTranscriptContexts: [{ runtimeMessage, transcriptMessage }],
      });
      const currentUserMessage = history.at(-1);
      assert(currentUserMessage?.role === "user");
      expect(currentUserMessage.content).toBe(`user ${index}`);
    }
    expect(
      history.flatMap((message) =>
        message.role === "custom" && message.customType === "openclaw.work-context"
          ? [message.details]
          : [],
      ),
    ).toEqual([
      { workContext: "selection A" },
      { workContext: "selection B" },
      { workContext: null },
    ]);
  });

  it("keeps work context paired after temporary runtime context is stripped", () => {
    const temporary: AgentMessage = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "temporary",
      display: false,
      timestamp: 1,
    };
    const runtimeMessage: AgentMessage = { role: "user", content: "clean", timestamp: 2 };
    const transcriptMessage = { ...runtimeMessage, __openclaw: { workContext: "selection" } };
    const options = {
      includeTimestamp: false,
      userTranscriptContexts: [{ runtimeMessage, transcriptMessage }],
    };
    const projected = normalizeMessagesForLlmBoundary([temporary, runtimeMessage], options);
    expect(projected).toMatchObject([
      {
        role: "custom",
        customType: "openclaw.work-context",
        display: false,
        details: { workContext: "selection" },
      },
      { role: "user", content: "clean" },
    ]);
    expect(normalizeMessagesForLlmBoundary(projected, options)).toEqual(projected);
    expect(
      normalizeCurrentPromptTextForLlmBoundary({
        prompt: "clean",
        currentUserTimestamp: 2,
        currentUserTranscriptMessage: transcriptMessage,
        includeTimestamp: false,
      }),
    ).toBe("clean");
  });
});
