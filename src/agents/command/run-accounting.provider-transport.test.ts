import { getAiTransportHost } from "@openclaw/ai";
import { describe, expect, it } from "vitest";
import "../../llm/ai-transport-host.js";
import {
  observeProviderTransportLogicalCallFinalized,
  observeProviderTransportLogicalCallSettled,
  observeProviderTransportLogicalCallStarted,
} from "../provider-transport-accounting.js";
import {
  resolveAgentCommandRunAccounting,
  runWithAgentCommandAccounting,
} from "./run-accounting.js";

describe("command provider transport accounting", () => {
  it("projects host events through the active command collector", async () => {
    const snapshot = await runWithAgentCommandAccounting(async (accounting) => {
      observeProviderTransportLogicalCallStarted({
        callId: "call-command",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
      });
      getAiTransportHost().observeModelTransportEvent({
        type: "attempt",
        eventId: "attempt-command",
        callId: "call-command",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        transport: "http",
        ordinal: 1,
        reason: "initial",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-command", "completed");
      observeProviderTransportLogicalCallFinalized("call-command");
      return accounting.project();
    });

    expect(snapshot).toMatchObject({
      providerTransport: {
        logicalCalls: { total: 1, completed: 1, failed: 0, aborted: 0 },
        attempts: { total: 1, initial: 1, retries: 0 },
        connections: { total: 0 },
        fallbacks: { total: 0 },
      },
      coverage: { providerTransport: { state: "complete" } },
    });
  });

  it("attaches zero-submission accounting to command failures", async () => {
    const failure = new Error("provider exploded");

    await expect(
      runWithAgentCommandAccounting(async () => {
        observeProviderTransportLogicalCallStarted({
          callId: "call-thrown",
          provider: "openai",
          model: "gpt-test",
          api: "openai-responses",
        });
        getAiTransportHost().observeModelTransportEvent({
          type: "submission",
          eventId: "submission-thrown",
          callId: "call-thrown",
          provider: "openai",
          model: "gpt-test",
          api: "openai-responses",
          transport: "http",
          total: 0,
          outcome: "failed",
          reason: "failed_before_submission",
        });
        observeProviderTransportLogicalCallSettled("call-thrown", "failed");
        observeProviderTransportLogicalCallFinalized("call-thrown");
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(resolveAgentCommandRunAccounting(failure)).toMatchObject({
      providerTransport: {
        logicalCalls: { total: 1, completed: 0, failed: 1, aborted: 0 },
        attempts: { total: 0 },
        zeroSubmissions: { total: 1, failed: 1, aborted: 0 },
      },
      coverage: { providerTransport: { state: "complete" } },
    });
  });
});
