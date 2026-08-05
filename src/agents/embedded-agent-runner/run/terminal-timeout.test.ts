import { describe, expect, it } from "vitest";
import { buildPromptTimeoutPayloads } from "./terminal-timeout.js";

describe("buildPromptTimeoutPayloads", () => {
  it("replaces an earlier generic timeout error with one actionable final error", () => {
    expect(
      buildPromptTimeoutPayloads({
        hasPartialAssistantTextAfterPromptTimeout: false,
        payloadsWithToolMedia: [
          { text: "LLM request timed out.", isError: true },
          { mediaUrl: "https://example.invalid/evidence.png" },
        ],
        timeoutText: "The model did not produce a response before the model idle timeout.",
      }),
    ).toEqual([
      { mediaUrl: "https://example.invalid/evidence.png" },
      {
        text: "The model did not produce a response before the model idle timeout.",
        isError: true,
      },
    ]);
  });
});
