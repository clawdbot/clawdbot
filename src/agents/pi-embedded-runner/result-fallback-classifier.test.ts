import { describe, expect, it } from "vitest";
import { classifyEmbeddedPiRunResultForModelFallback } from "./result-fallback-classifier.js";

describe("classifyEmbeddedPiRunResultForModelFallback", () => {
  it("does not fallback when sessions_spawn accepted a child session", () => {
    expect(
      classifyEmbeddedPiRunResultForModelFallback({
        provider: "mock-openai",
        model: "gpt-5.5",
        result: {
          meta: { durationMs: 1 },
          acceptedSessionSpawns: [
            {
              runId: "run-child",
              childSessionKey: "agent:qa:subagent:child",
            },
          ],
        },
      }),
    ).toBeNull();
  });
});
