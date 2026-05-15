import { describe, expect, it } from "vitest";
import {
  parseQaRunnerModelOptionsOutput,
  selectQaRunnerModelOptions,
} from "./model-catalog.runtime.js";

describe("qa runner model catalog", () => {
  it("filters to available rows and prefers gpt-5.5 first", () => {
    expect(
      selectQaRunnerModelOptions([
        {
          key: "anthropic/claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          input: "text",
          available: true,
          missing: false,
        },
        {
          key: "openai/gpt-5.5",
          name: "gpt-5.5",
          input: "text,image",
          available: true,
          missing: false,
        },
        {
          key: "openrouter/auto",
          name: "OpenRouter Auto",
          input: "text",
          available: false,
          missing: false,
        },
      ]).map((entry) => entry.key),
    ).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);
  });

  it("reports malformed catalog JSON with an owned error", () => {
    expect(() => parseQaRunnerModelOptionsOutput("{not json")).toThrow(
      "qa model catalog returned malformed JSON",
    );
  });

  it("ignores invalid catalog rows without failing the model picker", () => {
    expect(
      parseQaRunnerModelOptionsOutput(
        JSON.stringify({
          models: [
            null,
            {
              key: "openai/gpt-5.5",
              name: "gpt-5.5",
              input: "text,image",
              available: true,
              missing: false,
            },
          ],
        }),
      ).map((entry) => entry.key),
    ).toEqual(["openai/gpt-5.5"]);
  });
});
