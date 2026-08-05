import { describe, expect, it, vi } from "vitest";
import { persistNonDeliveredAgentRunTerminalSession } from "./agent-run-dispatch.js";

describe("persistNonDeliveredAgentRunTerminalSession", () => {
  it("projects a successful suppressed agent RPC into its owned session", async () => {
    const persist = vi.fn(async () => undefined);

    await persistNonDeliveredAgentRunTerminalSession({
      agentId: "main",
      deliver: false,
      persist,
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:cli-check",
      terminalOutcome: { reason: "completed", status: "ok", endedAt: 2_000 },
    });

    expect(persist).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:cli-check",
      event: {
        runId: "run-1",
        sessionId: "session-1",
        ts: 2_000,
        data: { phase: "end", endedAt: 2_000 },
      },
    });
  });

  it("leaves delivered runs to transport settlement", async () => {
    const persist = vi.fn(async () => undefined);

    await persistNonDeliveredAgentRunTerminalSession({
      deliver: true,
      persist,
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:direct:1",
      terminalOutcome: { reason: "completed", status: "ok" },
    });

    expect(persist).not.toHaveBeenCalled();
  });
});
