// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHost } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent, resetToolStream } from "./tool-stream.ts";

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
  it("bounds retained usage while keeping the most recently updated run", () => {
    const host = createHost();
    for (let index = 0; index < 60; index++) {
      handleAgentEvent(
        host,
        agentEvent(`run-${index}`, 1, "usage", { outputTokens: index }, "main"),
      );
      handleAgentEvent(
        host,
        agentEvent("still-active", index + 1, "usage", { outputTokens: index }, "main"),
      );
    }
    expect(host.chatRunUsageById?.size).toBe(50);
    expect(host.chatRunUsageById?.has("run-0")).toBe(false);
    expect(host.chatRunUsageById?.get("still-active")?.outputTokens).toBe(59);
  });

  it("keeps the last usage through completion even without an intervening render", () => {
    const host = createHost({ chatRunId: "client-run" });
    handleAgentEvent(host, agentEvent("client-run", 1, "usage", { outputTokens: 695 }, "main"));
    handleAgentEvent(host, agentEvent("client-run", 2, "lifecycle", { phase: "end" }, "main"));
    expect(host.chatRunUsageById?.get("client-run")?.outputTokens).toBe(695);
  });

  it("accepts a newer corrected count but ignores older recovery usage", () => {
    const host = createHost({ chatRunId: "client-run" });
    handleAgentEvent(host, agentEvent("client-run", 8, "usage", { outputTokens: 120 }, "main"));
    handleAgentEvent(host, agentEvent("client-run", 9, "usage", { outputTokens: 115 }, "main"));
    resetToolStream(host);
    handleAgentEvent(host, agentEvent("client-run", 7, "lifecycle", { phase: "start" }, "main"));
    handleAgentEvent(host, agentEvent("client-run", 7, "usage", { outputTokens: 150 }, "main"));
    expect(host.chatRunUsageById?.get("client-run")?.outputTokens).toBe(115);
  });

  it("tracks sequence-ordered output usage for a session-owned engine run", () => {
    const host = createHost({ chatRunId: "client-run" });

    handleAgentEvent(host, agentEvent("engine-run", 1, "usage", { outputTokens: 12 }, "main"));
    handleAgentEvent(host, agentEvent("engine-run", 2, "usage", { outputTokens: 8 }, "main"));

    expect(host.chatRunUsageById?.get("engine-run")?.outputTokens).toBe(8);

    handleAgentEvent(host, agentEvent("engine-run", 3, "lifecycle", { phase: "start" }, "main"));
    handleAgentEvent(host, agentEvent("engine-run", 4, "usage", { outputTokens: 3 }, "main"));

    expect(host.chatRunUsageById?.get("engine-run")?.outputTokens).toBe(3);
  });

  it("keeps session-scoped usage separate for concurrent active runs", () => {
    const host = createHost();

    handleAgentEvent(host, agentEvent("run-a", 1, "usage", { outputTokens: 100 }, "main"));
    handleAgentEvent(host, agentEvent("run-b", 1, "usage", { outputTokens: 10 }, "main"));

    expect(Array.from(host.chatRunUsageById?.entries() ?? [])).toEqual([
      ["run-a", { outputTokens: 100, seq: 1 }],
      ["run-b", { outputTokens: 10, seq: 1 }],
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
    expect(host.guardianNotices).toMatchObject([
      { kind: "strict-review-required", command: "printf hello" },
    ]);

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

  it("rejects a sessionless system notice from a foreign run", () => {
    const host = createHost({ chatRunId: "client-run" });

    expect(
      handleAgentEvent(
        host,
        agentEvent("foreign-run", 1, "notice", {
          phase: "warning",
          message: "Foreign system warning",
        }),
      ),
    ).toBe(true);
    expect(host.guardianNotices).toEqual([]);
  });

  it("rejects a same-session Guardian notice from a foreign run", () => {
    const host = createHost({ chatRunId: "client-run" });

    expect(
      handleAgentEvent(
        host,
        agentEvent(
          "foreign-run",
          1,
          "codex_app_server.guardian",
          {
            reviewId: "foreign-review",
            phase: "started",
            status: "inProgress",
            command: "foreign command",
            rationale: "foreign rationale",
          },
          "main",
        ),
      ),
    ).toBe(true);
    expect(host.guardianNotices).toEqual([]);
  });

  it("requires the local run id when an event has no session identity", () => {
    const host = createHost({ chatRunId: "client-run" });

    handleAgentEvent(host, agentEvent("engine-run", 1, "usage", { outputTokens: 20 }));
    handleAgentEvent(host, agentEvent("client-run", 2, "usage", { outputTokens: 7 }));

    expect(Array.from(host.chatRunUsageById?.entries() ?? [])).toEqual([
      ["client-run", { outputTokens: 7, seq: 2 }],
    ]);
  });
});
