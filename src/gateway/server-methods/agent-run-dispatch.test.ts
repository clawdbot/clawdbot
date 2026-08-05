import { describe, expect, it, vi } from "vitest";
import { __testing } from "./agent-run-dispatch.js";

const { persistAgentRunTerminalSession } = __testing;

describe("persistAgentRunTerminalSession", () => {
  it("projects a successful suppressed agent RPC into its owned session", async () => {
    const persist = vi.fn(async () => undefined);

    await persistAgentRunTerminalSession({
      agentId: "main",
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

  it("projects a delivered run after transport settlement returns", async () => {
    const persist = vi.fn(async () => undefined);

    await persistAgentRunTerminalSession({
      persist,
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:direct:1",
      terminalOutcome: { reason: "completed", status: "ok" },
    });

    expect(persist).toHaveBeenCalledTimes(1);
  });
});
