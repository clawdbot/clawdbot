// @vitest-environment node
import { describe, expect, it } from "vitest";
import { activeChatRunStartupStatus, chatStartupStatusLabel } from "./chat-run-startup.ts";
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

    expect(host.chatRunStartup).toEqual({ state: "activity", runId: "run-1", seq: 1 });
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

  it.each(["tool", "preamble", "assistant"])(
    "keeps retry waits transient and ordered across %s progress and delayed replay",
    (kind) => {
      const host = createStartupHost();
      const retry: AgentEvent = {
        runId: "run-1",
        seq: 3,
        stream: "run_status",
        ts: 3,
        sessionKey: "main",
        data: { phase: "retrying", message: "Rate limited. Retrying in 2 seconds (attempt 2/8)." },
      };
      const retryLabel = () =>
        chatStartupStatusLabel(activeChatRunStartupStatus(host.chatRunStartup), null);
      handleAgentEvent(host, toolStart("run-1", "tool-1"));
      handleAgentEvent(host, retry);
      handleAgentEvent(host, { ...retry, runId: "run-other", seq: 4 });
      handleAgentEvent(host, { ...toolStart("run-1", "tool-old"), seq: 2 });
      expect(host.chatRunId).toBe("run-1");
      expect(retryLabel()).toBe(retry.data.message);

      handleAgentEvent(host, {
        ...retry,
        seq: 4,
        stream: kind === "preamble" ? "item" : kind,
        data:
          kind === "tool"
            ? { phase: "start", toolCallId: "tool-next", name: "read" }
            : kind === "preamble"
              ? { kind: "preamble", itemId: "resumed", progressText: "Continuing" }
              : { text: "Continuing" },
      });
      handleAgentEvent(host, retry);
      expect(retryLabel()).toBeUndefined();
      expect(host.chatRunId).toBe("run-1");

      handleAgentEvent(host, { ...retry, seq: 5 });
      expect(retryLabel()).toBe(retry.data.message);
    },
  );
});
