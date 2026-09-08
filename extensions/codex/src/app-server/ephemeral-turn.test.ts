import { describe, expect, it } from "vitest";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import { CodexEphemeralTurn } from "./ephemeral-turn.js";
import type { CodexTurn } from "./protocol.js";

describe("CodexEphemeralTurn", () => {
  it.each(["last", "all"] as const)(
    "counts each completed response once with %s text aggregation",
    async (textMode) => {
      const fixture = createFakeCodexAppServerClient();
      const collector = new CodexEphemeralTurn(fixture.client, "side-thread", { textMode });
      const turn = {
        id: "side-turn",
        status: "inProgress",
        items: [],
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      } satisfies CodexTurn;
      const responses = [
        {
          responseId: "first-response",
          usage: {
            inputTokens: 8,
            cachedInputTokens: 2,
            cacheWriteInputTokens: 1,
            outputTokens: 4,
            reasoningOutputTokens: 3,
            totalTokens: 12,
          },
        },
        {
          responseId: "final-response",
          usage: {
            inputTokens: 15,
            cachedInputTokens: 5,
            cacheWriteInputTokens: 2,
            outputTokens: 5,
            reasoningOutputTokens: 2,
            totalTokens: 20,
          },
        },
      ];
      try {
        for (const response of [...responses, responses[0]]) {
          await fixture.notify({
            method: "rawResponse/completed",
            params: { threadId: "side-thread", turnId: turn.id, ...response },
          });
        }
        await fixture.notify({
          method: "turn/completed",
          params: {
            threadId: "side-thread",
            turn: {
              ...turn,
              status: "completed",
              items: [
                { id: "commentary", type: "agentMessage", text: "Checking the answer." },
                { id: "answer", type: "agentMessage", text: "Final answer." },
              ],
            },
          },
        });
        const result = await collector.wait(turn, {
          signal: new AbortController().signal,
          abortError: () => new Error("aborted"),
        });
        expect(result.text).toBe(
          textMode === "last" ? "Final answer." : "Checking the answer.\n\nFinal answer.",
        );
        expect(result.usage).toEqual({
          input: 13,
          output: 9,
          cacheRead: 7,
          cacheWrite: 3,
          reasoningTokens: 5,
          total: responses.reduce((total, response) => total + response.usage.totalTokens, 0),
          contextUsage: { state: "available", promptTokens: 15, totalTokens: 20 },
        });
      } finally {
        collector.route.release();
      }
    },
  );
});
