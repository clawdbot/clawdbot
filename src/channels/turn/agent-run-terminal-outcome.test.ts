import { describe, expect, it } from "vitest";
import {
  readAgentRunTerminalOutcome,
  recordAgentRunTerminalOutcome,
} from "./agent-run-terminal-outcome.js";

describe("agent run terminal outcome carrier", () => {
  it("survives object spread without entering JSON", () => {
    const result = {
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    };

    expect(recordAgentRunTerminalOutcome(result, "failed")).toBe(result);
    expect(readAgentRunTerminalOutcome(result)).toBe("failed");
    expect(
      Object.getOwnPropertyDescriptor(result, Symbol.for("openclaw.agentRunTerminalOutcome")),
    ).toMatchObject({ enumerable: true, value: "failed" });
    expect(readAgentRunTerminalOutcome({ ...result })).toBe("failed");
    expect(JSON.stringify(result)).toBe(
      JSON.stringify({ queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } }),
    );
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["primitive", "failed"],
    ["array", []],
    ["plain custom dispatch result", { agentRunTerminalOutcome: "failed" }],
    [
      "invalid private carrier value",
      { [Symbol.for("openclaw.agentRunTerminalOutcome")]: "cancelled" },
    ],
  ])("rejects %s", (_label, value) => {
    expect(readAgentRunTerminalOutcome(value)).toBeUndefined();
  });
});
