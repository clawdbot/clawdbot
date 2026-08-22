// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHost } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent, resolveActiveRunOutputTokens } from "./tool-stream.ts";

type AgentEvent = NonNullable<Parameters<typeof handleAgentEvent>[1]>;

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

  it("projects provider-independent system warnings into the visible session transcript", () => {
    const host = createHost({ chatRunId: "client-run" });

    expect(
      handleAgentEvent(
        host,
        agentEvent(
          "client-run",
          1,
          "notice",
          { phase: "warning", message: "Custom execution rules were not applied." },
          "main",
        ),
      ),
    ).toBe(true);
    expect(host.guardianNotices).toMatchObject([
      {
        kind: "warning",
        source: "system",
        message: "Custom execution rules were not applied.",
      },
    ]);
  });

  it("replaces a pending targetless Guardian review with its terminal decision", () => {
    const host = createHost({ chatRunId: "client-run" });
    const review = {
      reviewId: "network-review",
      targetItemId: null,
      command: "https://api.example.test:443",
    };

    handleAgentEvent(
      host,
      agentEvent(
        "client-run",
        1,
        "codex_app_server.guardian",
        { ...review, phase: "started", status: "inProgress" },
        "main",
      ),
    );
    expect(host.guardianNotices).toMatchObject([
      { kind: "reviewing", command: "https://api.example.test:443" },
    ]);

    handleAgentEvent(
      host,
      agentEvent(
        "client-run",
        2,
        "codex_app_server.guardian",
        { ...review, phase: "completed", status: "denied" },
        "main",
      ),
    );
    expect(host.guardianNotices).toMatchObject([
      { kind: "denied", command: "https://api.example.test:443" },
    ]);
  });

  it("shows a targeted strict-review requirement only until its decision arrives", () => {
    const host = createHost({ chatRunId: "client-run" });
    const review = {
      reviewId: "strict-review",
      targetItemId: "command-1",
      command: "printf hello",
    };

    handleAgentEvent(
      host,
      agentEvent(
        "client-run",
        1,
        "codex_app_server.guardian",
        { ...review, phase: "strict_review_required" },
        "main",
      ),
    );
    expect(host.guardianNotices).toMatchObject([{ kind: "reviewing", command: "printf hello" }]);

    handleAgentEvent(
      host,
      agentEvent(
        "client-run",
        2,
        "codex_app_server.guardian",
        { ...review, phase: "completed", status: "approved" },
        "main",
      ),
    );
    expect(host.guardianNotices).toEqual([]);
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
