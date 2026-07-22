// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  handleAgentEvent,
  resolveActiveRunOutputTokens,
  type ToolStreamEntry,
} from "./tool-stream.ts";

type ToolStreamHost = Parameters<typeof handleAgentEvent>[0];
type AgentEvent = NonNullable<Parameters<typeof handleAgentEvent>[1]>;

function createHost(overrides?: Partial<ToolStreamHost>): ToolStreamHost {
  return {
    sessionKey: "main",
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    chatStreamSegments: [],
    toolStreamById: new Map<string, ToolStreamEntry>(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
    sessions: { setModelOverride: () => undefined },
    ...overrides,
  };
}

function agentEvent(
  runId: string,
  seq: number,
  stream: AgentEvent["stream"],
  data: AgentEvent["data"],
  sessionKey?: string,
): AgentEvent {
  return {
    runId,
    seq,
    stream,
    ts: Date.now(),
    ...(sessionKey ? { sessionKey } : {}),
    data,
  };
}

describe("app-tool-stream run usage", () => {
  it("tracks monotonic output usage for a session-owned engine run", () => {
    const host = createHost({ chatRunId: "client-run" });

    handleAgentEvent(host, agentEvent("engine-run", 1, "usage", { outputTokens: 12 }, "main"));
    handleAgentEvent(host, agentEvent("engine-run", 2, "usage", { outputTokens: 8 }, "main"));

    expect(host.chatRunUsageById?.get("engine-run")).toBe(12);

    handleAgentEvent(host, agentEvent("engine-run", 3, "lifecycle", { phase: "start" }, "main"));
    handleAgentEvent(host, agentEvent("engine-run", 4, "usage", { outputTokens: 3 }, "main"));

    expect(host.chatRunUsageById?.get("engine-run")).toBe(3);
  });

  it("keeps session-scoped usage separate for concurrent active runs", () => {
    const host = createHost();

    handleAgentEvent(host, agentEvent("run-a", 1, "usage", { outputTokens: 100 }, "main"));
    handleAgentEvent(host, agentEvent("run-b", 1, "usage", { outputTokens: 10 }, "main"));

    expect(Array.from(host.chatRunUsageById?.entries() ?? [])).toEqual([
      ["run-a", 100],
      ["run-b", 10],
    ]);
  });

  it("requires the local run id when an event has no session identity", () => {
    const host = createHost({ chatRunId: "client-run" });

    handleAgentEvent(host, agentEvent("engine-run", 1, "usage", { outputTokens: 20 }));
    handleAgentEvent(host, agentEvent("client-run", 2, "usage", { outputTokens: 7 }));

    expect(Array.from(host.chatRunUsageById?.entries() ?? [])).toEqual([["client-run", 7]]);
  });
});

describe("active run output usage selection", () => {
  it("prefers local client-run usage and falls back to a server active run", () => {
    const usageByRun = new Map([
      ["client-run", 12],
      ["engine-run", 30],
    ]);

    expect(
      resolveActiveRunOutputTokens({
        localRunId: "client-run",
        activeRunIds: ["engine-run"],
        usageByRun,
      }),
    ).toBe(12);
    expect(
      resolveActiveRunOutputTokens({
        localRunId: "missing-client-run",
        activeRunIds: ["missing-engine-run", "engine-run"],
        usageByRun,
      }),
    ).toBe(30);
  });
});
