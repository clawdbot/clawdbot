import { describe, expect, it } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  resetAgentEventsForTest,
} from "../../infra/agent-events.js";
import { buildAgentRunTerminalOutcome } from "../agent-run-terminal-outcome.js";
import { createAgentCommandLifecycle } from "./lifecycle.js";

describe("createAgentCommandLifecycle real event bus", () => {
  it("does not publish malformed receipt metadata or retain producer-owned arrays", () => {
    resetAgentEventsForTest();
    const events: Array<{ data: Record<string, unknown> }> = [];
    const unsubscribe = onAgentEvent((event) => events.push(event));
    const malformedLifecycle = createAgentCommandLifecycle({
      runId: "real-lifecycle-proof-malformed",
      lifecycleGeneration: getAgentEventLifecycleGeneration,
      startedAt: 100,
      state: {
        currentTurnUserMessagePersisted: true,
        lifecycleFinishing: false,
        lifecycleEnded: false,
      },
    });

    malformedLifecycle.emitEnd({
      metadata: {
        terminalReceipt: {
          runId: "real-lifecycle-proof-malformed",
          sessionId: "session-1",
          turnId: "turn-1",
          requested: {
            provider: "provider-1",
            model: { syntheticSecret: "redacted-proof-secret" },
          },
          effective: { provider: "provider-1", model: "model-1", responseModel: "model-1" },
          successfulToolNames: ["read"],
          rerouted: false,
        },
      },
      outcome: buildAgentRunTerminalOutcome({ status: "ok", stopReason: "end_turn" }),
    });

    const successfulToolNames = Object.assign(["read"], {
      syntheticSecret: "redacted-proof-secret",
    });
    const validLifecycle = createAgentCommandLifecycle({
      runId: "real-lifecycle-proof-valid",
      lifecycleGeneration: getAgentEventLifecycleGeneration,
      startedAt: 100,
      state: {
        currentTurnUserMessagePersisted: true,
        lifecycleFinishing: false,
        lifecycleEnded: false,
      },
    });
    validLifecycle.emitEnd({
      metadata: {
        terminalReceipt: {
          runId: "real-lifecycle-proof-valid",
          sessionId: "session-1",
          turnId: "turn-1",
          requested: { provider: "provider-1", model: "model-1" },
          effective: { provider: "provider-1", model: "model-1", responseModel: "model-1" },
          successfulToolNames,
          rerouted: false,
          terminalDisposition: "visible",
        },
      },
      outcome: buildAgentRunTerminalOutcome({ status: "ok", stopReason: "end_turn" }),
    });
    successfulToolNames.push("mutated-after-publication");
    unsubscribe();
    resetAgentEventsForTest();

    const malformedEvent = events[0];
    const validEvent = events[1];
    const malformedSerialized = JSON.stringify(malformedEvent);
    const validSerialized = JSON.stringify(validEvent);
    const malformedHasTerminalReceipt = Object.hasOwn(
      malformedEvent?.data ?? {},
      "terminalReceipt",
    );
    const validReceipt = validEvent?.data.terminalReceipt;
    const validHasTerminalReceipt = Object.hasOwn(validEvent?.data ?? {}, "terminalReceipt");
    const publishedToolNames =
      validReceipt && typeof validReceipt === "object" && !Array.isArray(validReceipt)
        ? (validReceipt as Record<string, unknown>).successfulToolNames
        : null;
    console.log(
      JSON.stringify({
        eventCount: events.length,
        malformedHasTerminalReceipt,
        validHasTerminalReceipt,
        publishedToolNames,
        containsSyntheticSecret:
          malformedSerialized.includes("redacted-proof-secret") ||
          validSerialized.includes("redacted-proof-secret"),
      }),
    );
    expect(events).toHaveLength(2);
    expect(malformedHasTerminalReceipt).toBe(false);
    expect(validHasTerminalReceipt).toBe(true);
    expect(publishedToolNames).toEqual(["read"]);
    expect(malformedSerialized).not.toContain("redacted-proof-secret");
    expect(validSerialized).not.toContain("redacted-proof-secret");
  });
});
