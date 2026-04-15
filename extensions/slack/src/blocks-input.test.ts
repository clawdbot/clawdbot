import { describe, expect, it } from "vitest";
import { parseSlackBlocksInput } from "./blocks-input.js";

describe("parseSlackBlocksInput", () => {
  it("returns undefined when blocks are missing", () => {
    expect(parseSlackBlocksInput(undefined)).toBeUndefined();
    expect(parseSlackBlocksInput(null)).toBeUndefined();
  });

  it("accepts blocks arrays", () => {
    const parsed = parseSlackBlocksInput([{ type: "divider" }]);
    expect(parsed).toEqual([{ type: "divider" }]);
  });

  it("accepts JSON blocks strings", () => {
    const parsed = parseSlackBlocksInput(
      '[{"type":"section","text":{"type":"mrkdwn","text":"hi"}}]',
    );
    expect(parsed).toEqual([{ type: "section", text: { type: "mrkdwn", text: "hi" } }]);
  });

  it("rejects invalid block payloads", () => {
    const cases = [
      {
        name: "invalid JSON",
        input: "{bad-json",
        expectedMessage: /valid JSON/i,
      },
      {
        name: "non-array payload",
        input: { type: "divider" },
        expectedMessage: /must be an array/i,
      },
      {
        name: "empty array",
        input: [],
        expectedMessage: /at least one block/i,
      },
      {
        name: "non-object block",
        input: ["not-a-block"],
        expectedMessage: /must be an object/i,
      },
      {
        name: "missing block type",
        input: [{}],
        expectedMessage: /non-empty string type/i,
      },
    ] as const;

    for (const testCase of cases) {
      expect(() => parseSlackBlocksInput(testCase.input), testCase.name).toThrow(
        testCase.expectedMessage,
      );
    }
  });
});
