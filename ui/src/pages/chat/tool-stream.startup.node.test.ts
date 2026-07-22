// @vitest-environment node
import { describe, expect, it } from "vitest";
import { handleAgentEvent, type ToolStreamEntry } from "./tool-stream.ts";

type ToolStreamHost = Parameters<typeof handleAgentEvent>[0];
type AgentEvent = NonNullable<Parameters<typeof handleAgentEvent>[1]>;

function createHost(): ToolStreamHost {
  return {
    sessionKey: "main",
    chatRunId: "run-1",
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunStartup: { state: "status", runId: "run-1", phase: "starting_model" },
    chatStreamSegments: [],
    toolStreamById: new Map<string, ToolStreamEntry>(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: 1,
    sessions: { setModelOverride: () => {} },
  };
}

function toolStart(runId: string, toolCallId: string): AgentEvent {
  return {
    runId,
    seq: 1,
    stream: "tool",
    ts: 1,
    sessionKey: "main",
    data: { phase: "start", toolCallId, name: "read", args: {} },
  };
}

describe("app-tool-stream startup status", () => {
  it("clears the active run status on the first matching tool start", () => {
    const host = createHost();

    handleAgentEvent(host, toolStart("run-1", "tool-1"));

    expect(host.chatRunStartup).toEqual({ state: "activity", runId: "run-1" });
  });

  it("keeps active status for a tool from another run", () => {
    const host = createHost();

    handleAgentEvent(host, toolStart("run-2", "tool-2"));

    expect(host.chatRunStartup).toEqual({
      state: "status",
      runId: "run-1",
      phase: "starting_model",
    });
  });
});
