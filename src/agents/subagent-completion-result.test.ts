import { describe, expect, it } from "vitest";
import { resolveSubagentCompletionResultText } from "./subagent-completion-result.js";

describe("resolveSubagentCompletionResultText", () => {
  it.each([
    {
      name: "visible",
      terminalReply: { disposition: "visible", text: "authoritative reply" } as const,
      expected: "authoritative reply",
    },
    {
      name: "silent",
      terminalReply: { disposition: "silent" } as const,
      expected: undefined,
    },
    {
      name: "empty",
      terminalReply: { disposition: "empty" } as const,
      expected: undefined,
    },
  ])(
    "uses $name terminal evidence before retained fallback text",
    ({ terminalReply, expected }) => {
      expect(
        resolveSubagentCompletionResultText({
          completion: {
            required: true,
            resultText: "NO_REPLY",
            fallbackResultText: "older visible fallback",
            terminalReply,
          },
          execution: { status: "terminal", outcome: { status: "ok" } },
        }),
      ).toBe(expected);
    },
  );

  it("keeps legacy result selection when producer terminal evidence is absent", () => {
    expect(
      resolveSubagentCompletionResultText({
        completion: {
          required: true,
          resultText: "NO_REPLY",
          fallbackResultText: "legacy fallback",
        },
        execution: { status: "terminal", outcome: { status: "ok" } },
      }),
    ).toBe("legacy fallback");
  });
});
