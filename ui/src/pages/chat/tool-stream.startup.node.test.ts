// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHost } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

type AgentEvent = NonNullable<Parameters<typeof handleAgentEvent>[1]>;

function createStartupHost() {
  return createHost({
    chatRunId: "run-1",
    chatRunStartup: { state: "status", runId: "run-1", phase: "starting_model" },
    toolStreamSyncTimer: 1,
  });
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
  it.each(["tool", "preamble"])("clears the active run status on matching %s activity", (kind) => {
    const host = createStartupHost();

    handleAgentEvent(
      host,
      kind === "tool"
        ? toolStart("run-1", "tool-1")
        : {
            runId: "run-1",
            seq: 1,
            stream: "item",
            ts: 1,
            sessionKey: "main",
            data: { kind: "preamble", itemId: "opening", progressText: "Checking the workspace" },
          },
    );

    expect(host.chatRunStartup).toEqual({ state: "activity", runId: "run-1" });
  });

  it("keeps active status for a tool from another run", () => {
    const host = createStartupHost();

    handleAgentEvent(host, toolStart("run-2", "tool-2"));

    expect(host.chatRunStartup).toEqual({
      state: "status",
      runId: "run-1",
      phase: "starting_model",
    });
  });
});
