import { describe, expect, it } from "vitest";
import { buildAgentRunTerminalOutcome } from "../agent-run-terminal-outcome.js";
import { classifySubagentTerminalOutcome } from "./subagent-terminal-outcome.js";

describe("classifySubagentTerminalOutcome", () => {
  it("preserves provider timeout attribution over a retained restart marker", () => {
    const outcome = buildAgentRunTerminalOutcome({
      status: "timeout",
      stopReason: "restart",
      timeoutPhase: "provider",
      providerStarted: true,
    });

    expect(classifySubagentTerminalOutcome(outcome)).toBe("timeout");
  });

  it("applies restart cancellation over incomplete liveness projections", () => {
    const outcome = buildAgentRunTerminalOutcome({
      status: "error",
      stopReason: "restart",
      livenessState: "blocked",
    });

    expect(classifySubagentTerminalOutcome(outcome)).toBe("cancellation");
  });
});
