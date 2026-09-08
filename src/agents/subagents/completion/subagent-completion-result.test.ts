import { describe, expect, it } from "vitest";
import { resolveSubagentCompletionResultText } from "./subagent-completion-result.js";

describe("resolveSubagentCompletionResultText", () => {
  it.each([
    {
      name: "visible",
      terminalReply: {
        disposition: "visible",
        text: "authoritative reply",
        modelRouteChange: "Model route changed: requested/model → actual/model.",
      } as const,
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

  it.each([
    { status: "error", resultText: "" },
    { status: "error", resultText: " \n\t " },
    { status: "timeout", resultText: "" },
    { status: "timeout", resultText: " \n\t " },
    { status: "unknown", resultText: "" },
    { status: "unknown", resultText: " \n\t " },
  ] as const)(
    "preserves captured findings when a $status completion has blank primary text ($#)",
    ({ status, resultText }) => {
      expect(
        resolveSubagentCompletionResultText({
          completion: {
            resultText,
            fallbackResultText: "  actionable captured findings  ",
          },
          execution: { status: "terminal", outcome: { status } },
        }),
      ).toBe("actionable captured findings");
    },
  );
});
