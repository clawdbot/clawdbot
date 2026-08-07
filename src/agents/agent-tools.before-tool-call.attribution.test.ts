import { describe, expect, it } from "vitest";
import { createAgentExecutionAttribution } from "./agent-execution-attribution.js";
import {
  bindToolExecutionAttribution,
  resolveToolExecutionCorrelation,
} from "./agent-tools.before-tool-call.attribution.js";

describe("tool execution attribution", () => {
  it("keeps exact execution identity in the host-only correlation", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-1",
      lifecycleGeneration: "generation-1",
      sessionKey: "session-1",
      sessionId: "session-id-1",
      agentId: "agent-1",
    });
    const hookContext = bindToolExecutionAttribution(
      {
        runId: "flat-run",
        sessionKey: "flat-session",
        sessionId: "flat-session-id",
        agentId: "flat-agent",
      },
      attribution,
    );

    expect(resolveToolExecutionCorrelation(hookContext)).toEqual({
      runId: attribution.runId,
      contextId: attribution.contextId,
      executionId: attribution.executionId,
      lifecycleGeneration: attribution.lifecycleGeneration,
      sessionKey: attribution.sessionKey,
      sessionId: attribution.sessionId,
      agentId: attribution.agentId,
    });
    expect(hookContext).not.toHaveProperty("attribution");
    expect(hookContext).not.toHaveProperty("executionId");
    expect(hookContext).not.toHaveProperty("contextId");
  });

  it("ignores forged exact identity fields on an unbound hook context", () => {
    expect(
      resolveToolExecutionCorrelation({
        runId: "public-run",
        sessionKey: "public-session",
        contextId: "forged-context",
        executionId: "forged-execution",
        lifecycleGeneration: "forged-generation",
      } as never),
    ).toEqual({
      runId: "public-run",
      sessionKey: "public-session",
    });
  });

  it("treats absent bound identity fields as authoritative", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-sparse",
      lifecycleGeneration: "generation-sparse",
    });
    const hookContext = bindToolExecutionAttribution(
      {
        runId: "flat-run",
        sessionKey: "flat-session",
        sessionId: "flat-session-id",
        agentId: "flat-agent",
      },
      attribution,
    );

    expect(resolveToolExecutionCorrelation(hookContext)).toEqual({
      runId: attribution.runId,
      contextId: attribution.contextId,
      executionId: attribution.executionId,
      lifecycleGeneration: attribution.lifecycleGeneration,
    });
  });
});
