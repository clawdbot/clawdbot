import { describe, expect, it, vi } from "vitest";
import { buildAgentRunTerminalOutcome } from "../agent-run-terminal-outcome.js";
import { createAgentCommandLifecycle } from "./lifecycle.js";

const emitAgentEvent = vi.hoisted(() => vi.fn());

vi.mock("../../infra/agent-events.js", () => ({ emitAgentEvent }));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe("createAgentCommandLifecycle", () => {
  it.each(["finishing", "end"] as const)(
    "preserves the canonical terminal facts on %s events",
    (phase) => {
      emitAgentEvent.mockClear();
      const metadata = {
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
        livenessState: "blocked",
      };
      const lifecycle = createAgentCommandLifecycle({
        runId: "terminal-owner",
        lifecycleGeneration: () => "test-generation",
        startedAt: 100,
        state: {
          currentTurnUserMessagePersisted: true,
          lifecycleFinishing: false,
          lifecycleEnded: false,
        },
      });
      const terminal = {
        metadata,
        outcome: buildAgentRunTerminalOutcome({ status: "timeout", ...metadata }),
      };

      if (phase === "finishing") {
        lifecycle.emitFinishing(terminal);
      } else {
        lifecycle.emitEnd(terminal);
      }

      expect(emitAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "terminal-owner",
          stream: "lifecycle",
          data: expect.objectContaining({ phase, ...metadata }),
        }),
      );
    },
  );
});
