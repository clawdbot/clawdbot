import { describe, expect, it } from "vitest";
import type { EmbeddedAgentRunResult } from "./agent-runner-execution.types.js";
import { selectFallbackContinuationMetadata } from "./agent-runner-fallback-candidate.js";

function createResult(text: string): EmbeddedAgentRunResult {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 1,
      error: {
        kind: "incomplete_turn",
        message: `${text} failed`,
      },
    },
  };
}

describe("selectFallbackContinuationMetadata", () => {
  it("keeps requests from an earlier preferred result after exhausted-result merging", () => {
    const preferredResult = createResult("preferred");
    const latestResult = createResult("latest");
    const mergedResult: EmbeddedAgentRunResult = {
      ...latestResult,
      payloads: preferredResult.payloads,
      meta: {
        ...latestResult.meta,
        error: preferredResult.meta.error,
      },
    };

    expect(
      selectFallbackContinuationMetadata(mergedResult, [
        {
          result: preferredResult,
          continueWorkRequests: [{ reason: "continue preferred", delaySeconds: 5 }],
          compactionTraceparent: "00-preferred",
        },
        {
          result: latestResult,
          continueWorkRequests: [{ reason: "continue latest", delaySeconds: 10 }],
          compactionTraceparent: "00-latest",
        },
      ]),
    ).toEqual({
      continueWorkRequests: [{ reason: "continue preferred", delaySeconds: 5 }],
      compactionTraceparent: "00-preferred",
    });
  });
});
