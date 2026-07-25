// @vitest-environment node
import { describe, expect, it } from "vitest";
import { handleAgentEvent, type ToolStreamEntry } from "./tool-stream.ts";

type ToolStreamHost = Parameters<typeof handleAgentEvent>[0];

function createHost(overrides?: Partial<ToolStreamHost>): ToolStreamHost {
  return {
    sessionKey: "main",
    chatRunId: "run-1",
    chatStream: null,
    chatStreamStartedAt: null,
    chatThinkingStream: null,
    chatThinkingStartedAt: null,
    chatRunStartup: null,
    chatStreamSegments: [],
    toolStreamById: new Map<string, ToolStreamEntry>(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
    sessions: {
      setModelOverride: () => {},
    },
    ...overrides,
  };
}

describe("handleAgentEvent thinking stream", () => {
  it("accumulates absolute thinking text for the active chat run", () => {
    const host = createHost();
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "thinking",
      ts: 100,
      sessionKey: "main",
      data: { text: "Checking files", delta: "Checking files" },
    });
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 2,
      stream: "thinking",
      ts: 110,
      sessionKey: "main",
      data: { text: "Checking files done", delta: " done" },
    });
    expect(host.chatThinkingStream).toBe("Checking files done");
    expect(host.chatThinkingStartedAt).toBe(100);
    expect(host.chatRunStartup).toEqual({ state: "activity", runId: "run-1" });
  });

  it("ignores thinking events from other sessions", () => {
    const host = createHost();
    handleAgentEvent(host, {
      runId: "run-other",
      seq: 1,
      stream: "thinking",
      ts: 100,
      sessionKey: "agent:other:main",
      data: { text: "secret", delta: "secret" },
    });
    expect(host.chatThinkingStream).toBeNull();
  });

  it("clears thinking on lifecycle end for the active run", () => {
    const host = createHost({
      chatThinkingStream: "partial",
      chatThinkingStartedAt: 50,
    });
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 3,
      stream: "lifecycle",
      ts: 200,
      sessionKey: "main",
      data: { phase: "end" },
    });
    expect(host.chatThinkingStream).toBeNull();
    expect(host.chatThinkingStartedAt).toBeNull();
  });
});
