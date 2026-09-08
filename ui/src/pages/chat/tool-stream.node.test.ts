// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readToolApprovalReviews } from "../../lib/chat/tool-approval-reviews.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import type { ToolStreamEntry } from "./tool-stream-contract.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";
import { resetToolStream } from "./tool-stream-state.ts";
import { reconcileWaitingApprovalsFromSnapshot } from "./tool-stream-status.ts";
import {
  agentEvent,
  createHost,
  TOOL_STREAM_TEST_NOW,
  useToolStreamFakeTimers,
} from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

const globalWithWindow = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis;
};
let installedTestWindow = false;

beforeAll(() => {
  if (!globalWithWindow.window) {
    globalWithWindow.window = globalThis as unknown as Window & typeof globalThis;
    installedTestWindow = true;
  }
});

afterAll(() => {
  if (installedTestWindow) {
    Reflect.deleteProperty(globalWithWindow, "window");
  }
});

describe("app-tool-stream approval lifecycle", () => {
  it("carries browser tab details through the completed live result, including empty text", () => {
    const host = createHost();
    handleAgentEvent(
      host,
      agentEvent("browser-run", 1, "tool", {
        phase: "start",
        name: "browser",
        toolCallId: "browser-call",
        args: { action: "open" },
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("browser-run", 2, "tool", {
        phase: "result",
        name: "browser",
        toolCallId: "browser-call",
        result: {
          content: [],
          details: {
            browserTab: { profile: "managed", target: "host", targetId: "tab-1", title: "Example" },
          },
        },
      }),
    );
    const entry = [...host.toolStreamById.values()][0];
    const [card] = extractToolCardsCached(entry?.message);
    expect(card).toMatchObject({
      completed: true,
      live: true,
      preview: {
        kind: "browser-tab",
        profile: "managed",
        target: "host",
        targetId: "tab-1",
        title: "Example",
      },
    });
    resetToolStream(host);
  });

  const approval = (runId: string | undefined, sessionKey = "main") => ({
    id: "approval-1",
    kind: "exec" as const,
    request: { command: "echo test", sessionKey, runId },
    createdAtMs: 1,
    expiresAtMs: 2,
  });

  const learnRun = (host: ReturnType<typeof createHost>, runId: string) => {
    handleAgentEvent(host, agentEvent(runId, 1, "lifecycle", { phase: "start" }));
  };

  it("hydrates a parked run only when the approval matches a learned engine run id", () => {
    const host = createHost({ waitingApprovalStatuses: new Map() });
    learnRun(host, "run-1");

    expect(reconcileWaitingApprovalsFromSnapshot(host, [approval("run-1")])).toBe(true);
    expect(host.waitingApprovalStatuses?.get("approval-1")).toEqual({
      approvalId: "approval-1",
      toolCallId: null,
      runId: "run-1",
    });
  });

  it("does not hydrate absent or mismatched run ids even while a run is active", () => {
    const host = createHost({
      chatRunId: "client-active-run",
      waitingApprovalStatuses: new Map(),
    });
    learnRun(host, "foreground-engine-run");

    expect(reconcileWaitingApprovalsFromSnapshot(host, [approval(undefined)])).toBe(false);
    expect(reconcileWaitingApprovalsFromSnapshot(host, [approval("other-engine-run")])).toBe(false);
    expect(host.waitingApprovalStatuses?.size).toBe(0);
  });

  it("does not label foreground work for an unrelated heartbeat approval", () => {
    const host = createHost({
      chatRunId: "foreground-client-run",
      waitingApprovalStatuses: new Map(),
    });
    learnRun(host, "foreground-engine-run");

    expect(reconcileWaitingApprovalsFromSnapshot(host, [approval("heartbeat-run")])).toBe(false);
    expect(host.waitingApprovalStatuses?.size).toBe(0);
  });

  it("clears only parked runs whose approvals leave the queue snapshot", () => {
    const host = createHost({
      waitingApprovalStatuses: new Map([
        ["approval-1", { approvalId: "approval-1", toolCallId: "tool-1", runId: "run-1" }],
        ["approval-2", { approvalId: "approval-2", toolCallId: "tool-2", runId: "run-2" }],
      ]),
    });

    expect(
      reconcileWaitingApprovalsFromSnapshot(host, [{ ...approval("run-2"), id: "approval-2" }]),
    ).toBe(true);
    expect([...host.waitingApprovalStatuses!.keys()]).toEqual(["approval-2"]);
  });

  it("clears hydrated state when the lifecycle resolution arrives", () => {
    const host = createHost({ waitingApprovalStatuses: new Map() });
    learnRun(host, "run-1");
    reconcileWaitingApprovalsFromSnapshot(host, [approval("run-1")]);

    handleAgentEvent(
      host,
      agentEvent("run-1", 1, "lifecycle", {
        phase: "approval-resolved",
        approvalId: "approval-1",
      }),
    );

    expect(host.waitingApprovalStatuses?.size).toBe(0);

    resetToolStream(host);
    expect(reconcileWaitingApprovalsFromSnapshot(host, [approval("run-1")])).toBe(false);
    expect(host.waitingApprovalStatuses?.size).toBe(0);

    reconcileWaitingApprovalsFromSnapshot(host, []);
    learnRun(host, "run-1");
    expect(reconcileWaitingApprovalsFromSnapshot(host, [approval("run-1")])).toBe(true);
  });

  it("replaces hydrated state with the authoritative lifecycle payload", () => {
    const host = createHost({ waitingApprovalStatuses: new Map() });
    learnRun(host, "run-1");
    reconcileWaitingApprovalsFromSnapshot(host, [approval("run-1")]);

    handleAgentEvent(
      host,
      agentEvent("run-1", 1, "lifecycle", {
        phase: "waiting-approval",
        approvalId: "approval-1",
        toolCallId: "tool-1",
      }),
    );

    expect(host.waitingApprovalStatuses?.get("approval-1")).toEqual({
      approvalId: "approval-1",
      toolCallId: "tool-1",
      runId: "run-1",
    });
  });

  it("does not synthesize waiting state after a reset without a new run event", () => {
    const host = createHost({ waitingApprovalStatuses: new Map() });
    learnRun(host, "run-1");
    reconcileWaitingApprovalsFromSnapshot(host, [approval("run-1")]);

    resetToolStream(host);
    expect(reconcileWaitingApprovalsFromSnapshot(host, [approval("run-1")])).toBe(false);
    expect(host.waitingApprovalStatuses?.size).toBe(0);
  });
});

describe("app-tool-stream throttled projections", () => {
  it.each(["start", "update"] as const)(
    "renders a deferred tool %s when its projection flushes",
    (phase) => {
      useToolStreamFakeTimers();
      try {
        const requestUpdate = vi.fn();
        const host = createHost({ requestUpdate });
        const toolCallId = "call-deferred";
        handleAgentEvent(
          host,
          agentEvent("run-1", 1, "tool", {
            phase: "start",
            name: "read",
            toolCallId,
            args: { path: "notes.txt" },
          }),
        );
        if (phase === "update") {
          vi.advanceTimersByTime(80);
          requestUpdate.mockClear();
          handleAgentEvent(
            host,
            agentEvent("run-1", 2, "tool", {
              phase,
              name: "read",
              toolCallId,
              partialResult: "still reading",
            }),
          );
        }

        expect(requestUpdate).not.toHaveBeenCalled();
        vi.advanceTimersByTime(79);
        expect(requestUpdate).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);

        expect(host.chatToolMessages).toHaveLength(1);
        expect(requestUpdate).toHaveBeenCalledOnce();
        if (phase === "update") {
          expect(host.chatToolMessages[0]?.content).toEqual([
            { type: "toolcall", name: "read", arguments: { path: "notes.txt" } },
            { type: "toolresult", name: "read", text: "still reading" },
          ]);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not let an older replay replace newer live tool progress", () => {
    useToolStreamFakeTimers();
    try {
      const host = createHost();
      const toolCallId = "call-sequenced";
      handleAgentEvent(
        host,
        agentEvent("run-1", 1, "tool", {
          phase: "start",
          name: "read",
          toolCallId,
          args: { path: "README.md" },
        }),
      );
      handleAgentEvent(
        host,
        agentEvent("run-1", 3, "tool", {
          phase: "update",
          name: "read",
          toolCallId,
          partialResult: "newer live progress",
        }),
      );
      handleAgentEvent(
        host,
        agentEvent("run-1", 2, "tool", {
          phase: "update",
          name: "read",
          toolCallId,
          partialResult: "older replayed progress",
        }),
      );
      vi.advanceTimersByTime(80);

      expect(host.chatToolMessages[0]?.content).toEqual([
        { type: "toolcall", name: "read", arguments: { path: "README.md" } },
        { type: "toolresult", name: "read", text: "newer live progress" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("app-tool-stream result blocks", () => {
  it("retains out-of-order review identities and lets a result fence every older review", () => {
    const host = createHost();
    const toolCallId = "call-reviewed";
    handleAgentEvent(
      host,
      agentEvent("run-1", 4, "tool", {
        phase: "review",
        toolCallId,
        approvalReviewOutcome: "approved",
        review: {
          id: "review-b",
          label: "Guardian",
          status: "approved",
          riskLevel: "low",
          userAuthorization: "high",
          rationale: "Newer live review.",
        },
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-1", 1, "tool", {
        phase: "start",
        name: "exec",
        toolCallId,
        args: { command: "git status --short" },
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "tool", {
        phase: "review",
        toolCallId,
        approvalReviewOutcome: "approved",
        review: {
          id: "review-a",
          label: "Guardian",
          status: "approved",
          rationale: "Older snapshot review.",
        },
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-1", 3, "tool", {
        phase: "review",
        toolCallId,
        approvalReviewOutcome: "denied",
        review: { id: "review-b", label: "Guardian", status: "denied" },
      }),
    );

    const identity = buildToolStreamIdentity("run-1", toolCallId);
    const reviewed = host.toolStreamById.get(identity);
    expect(readToolApprovalReviews(reviewed?.details).map((review) => review.id)).toEqual([
      "review-a",
      "review-b",
    ]);
    expect(reviewed?.details).toMatchObject({
      approvalReviewOutcome: "approved",
    });

    handleAgentEvent(
      host,
      agentEvent("run-1", 5, "tool", {
        phase: "result",
        name: "exec",
        toolCallId,
        result: { details: { runtime: "native" } },
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-1", 3, "tool", {
        phase: "review",
        toolCallId,
        approvalReviewOutcome: "denied",
        review: { id: "review-c", label: "Guardian", status: "denied" },
      }),
    );

    const completed = host.toolStreamById.get(identity);
    expect(completed?.resultReceived).toBe(true);
    expect(readToolApprovalReviews(completed?.details).map((review) => review.id)).toEqual([
      "review-a",
      "review-b",
    ]);
    expect(completed?.details).toMatchObject({
      runtime: "native",
      approvalReviewOutcome: "approved",
    });
  });

  it("keeps an early denial after live review rows exceed the display cap", () => {
    const host = createHost();
    const toolCallId = "call-many-reviews";
    handleAgentEvent(
      host,
      agentEvent("run-1", 1, "tool", {
        phase: "start",
        name: "exec",
        toolCallId,
        args: { command: "printf reviewed" },
      }),
    );
    for (let index = 0; index < 18; index += 1) {
      handleAgentEvent(
        host,
        agentEvent("run-1", index + 2, "tool", {
          phase: "review",
          toolCallId,
          approvalReviewOutcome: "denied",
          review: {
            id: `review-${index}`,
            label: "Guardian",
            status: index === 0 ? "denied" : "approved",
          },
        }),
      );
    }

    const entry = host.toolStreamById.get(buildToolStreamIdentity("run-1", toolCallId));
    expect(readToolApprovalReviews(entry?.details).map((review) => review.id)).toEqual(
      Array.from({ length: 16 }, (_, index) => `review-${index + 2}`),
    );
    expect(entry?.details).toMatchObject({ approvalReviewOutcome: "denied" });
  });

  it("keeps an out-of-order denial after newer reviews fill the display cap", () => {
    const host = createHost();
    const toolCallId = "call-out-of-order-denial";
    handleAgentEvent(
      host,
      agentEvent("run-1", 1, "tool", {
        phase: "start",
        name: "exec",
        toolCallId,
        args: { command: "printf reviewed" },
      }),
    );
    for (let index = 0; index < 16; index += 1) {
      handleAgentEvent(
        host,
        agentEvent("run-1", index + 3, "tool", {
          phase: "review",
          toolCallId,
          approvalReviewOutcome: "approved",
          review: {
            id: `newer-review-${index}`,
            label: "Guardian",
            status: "approved",
          },
        }),
      );
    }
    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "tool", {
        phase: "review",
        toolCallId,
        approvalReviewOutcome: "denied",
        review: { id: "older-denied-review", label: "Guardian", status: "denied" },
      }),
    );

    const identity = buildToolStreamIdentity("run-1", toolCallId);
    const reviewed = host.toolStreamById.get(identity);
    expect(readToolApprovalReviews(reviewed?.details).map((review) => review.id)).toEqual(
      Array.from({ length: 16 }, (_, index) => `newer-review-${index}`),
    );
    expect(reviewed?.details).toMatchObject({ approvalReviewOutcome: "denied" });

    handleAgentEvent(
      host,
      agentEvent("run-1", 19, "tool", {
        phase: "result",
        name: "exec",
        toolCallId,
        approvalReviewOutcome: "approved",
        result: { details: { runtime: "native", approvalReviewOutcome: "approved" } },
      }),
    );
    expect(host.toolStreamById.get(identity)?.details).toMatchObject({
      runtime: "native",
      approvalReviewOutcome: "denied",
    });
  });

  it("projects live edit counts and lets the resolved result replace them without flicker", () => {
    useToolStreamFakeTimers();
    try {
      const host = createHost({ chatRunId: "run-1" });
      const toolCallId = "call-live-edit";
      const identity = buildToolStreamIdentity("run-1", toolCallId);
      handleAgentEvent(
        host,
        agentEvent("run-1", 1, "tool", {
          phase: "start",
          name: "edit",
          toolCallId,
          args: { path: "src/report.ts" },
        }),
      );
      handleAgentEvent(
        host,
        agentEvent("run-1", 2, "tool", {
          phase: "input_delta",
          name: "edit",
          toolCallId,
          diff: { added: 12, removed: 3 },
        }),
      );
      vi.advanceTimersByTime(80);

      expect(host.toolStreamById.get(identity)?.liveDiffStat).toEqual({ added: 12, removed: 3 });
      expect(host.chatToolMessages[0]?.["__openclawToolStreamDiffStat"]).toEqual({
        added: 12,
        removed: 3,
      });

      handleAgentEvent(
        host,
        agentEvent("run-1", 3, "tool", {
          phase: "result",
          name: "edit",
          toolCallId,
          result: { details: { diff: "-1 old\n+1 new" } },
        }),
      );

      const resolved = host.toolStreamById.get(identity);
      expect(resolved?.liveDiffStat).toBeUndefined();
      expect(resolved?.details).toEqual({ diff: "-1 old\n+1 new" });
      expect(resolved?.message).not.toHaveProperty("__openclawToolStreamDiffStat");
      expect(host.chatToolMessages[0]).not.toHaveProperty("__openclawToolStreamDiffStat");
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a result block for completed tools with empty output", () => {
    useToolStreamFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: TOOL_STREAM_TEST_NOW,
      sessionKey: "main",
      data: { phase: "start", name: "bash", toolCallId: "call-1", args: { command: "true" } },
    });
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 2,
      stream: "tool",
      ts: TOOL_STREAM_TEST_NOW + 1,
      sessionKey: "main",
      data: { phase: "result", name: "bash", toolCallId: "call-1", result: "" },
    });

    const entry = host.toolStreamById.get(
      buildToolStreamIdentity("run-1", "call-1"),
    ) as ToolStreamEntry;
    expect(entry.resultReceived).toBe(true);
    expect(entry.receivedAt).toBe(TOOL_STREAM_TEST_NOW);
    expect(entry.message["__openclawToolStreamReceivedAt"]).toBe(TOOL_STREAM_TEST_NOW);
    const content = entry.message.content as Array<Record<string, unknown>>;
    // The empty-output result block marks the call as finished so the UI does
    // not keep it in a running state for the rest of the run.
    expect(content.some((block) => block.type === "toolresult" && block.text === "")).toBe(true);
  });

  it.each([
    ["omitted name", undefined],
    ["empty name", ""],
    ["blank name", "   "],
    ["generic placeholder", "tool"],
    ["conflicting name", "write"],
  ])("preserves an established tool identity when the result has an %s", (_label, name) => {
    const host = createHost();
    const toolCallId = "call-preserve-name";
    handleAgentEvent(
      host,
      agentEvent("run-1", 1, "tool", {
        phase: "start",
        name: "read",
        toolCallId,
        args: { path: "/workspace/report.txt" },
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "tool", {
        phase: "result",
        ...(name === undefined ? {} : { name }),
        toolCallId,
        result: "file contents",
      }),
    );

    const entry = host.toolStreamById.get(buildToolStreamIdentity("run-1", toolCallId));
    expect(entry?.name).toBe("read");
    expect(entry?.message.content).toEqual([
      { type: "toolcall", name: "read", arguments: { path: "/workspace/report.txt" } },
      { type: "toolresult", name: "read", text: "file contents" },
    ]);
  });

  it.each([undefined, "tool"])(
    "applies session-status result effects when its known tool name is reported as %j",
    (name) => {
      const host = createHost();
      const toolCallId = "status-preserve-name";
      handleAgentEvent(
        host,
        agentEvent("run-1", 1, "tool", {
          phase: "start",
          name: "session_status",
          toolCallId,
        }),
      );
      handleAgentEvent(
        host,
        agentEvent("run-1", 2, "tool", {
          phase: "result",
          ...(name === undefined ? {} : { name }),
          toolCallId,
          result: {
            details: {
              changedModel: true,
              sessionKey: "main",
              agentId: "main",
              modelOverride: "openai/gpt-5.6-luna",
            },
          },
        }),
      );

      expect(host.sessions.refreshReplacement).toHaveBeenCalledOnce();
      expect(host.sessions.state.modelOverrides).toEqual({});
    },
  );

  it("upgrades a placeholder start name when a later event supplies the concrete name", () => {
    const host = createHost();
    const toolCallId = "call-upgrade-name";
    handleAgentEvent(
      host,
      agentEvent("run-1", 1, "tool", {
        phase: "start",
        toolCallId,
        args: { path: "/workspace/report.txt" },
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "tool", {
        phase: "result",
        name: "read",
        toolCallId,
        result: "file contents",
      }),
    );

    expect(host.toolStreamById.get(buildToolStreamIdentity("run-1", toolCallId))?.name).toBe(
      "read",
    );
  });

  it("keeps interleaved sibling-run calls and results under independent identities", () => {
    const host = createHost({ chatRunId: "run-foreground" });
    const toolCallId = "call-shared";
    const foregroundIdentity = buildToolStreamIdentity("run-foreground", toolCallId);
    const backgroundIdentity = buildToolStreamIdentity("run-background", toolCallId);

    handleAgentEvent(
      host,
      agentEvent("run-foreground", 1, "tool", {
        phase: "start",
        name: "read",
        toolCallId,
        args: { path: "foreground.txt" },
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-background", 1, "tool", {
        phase: "start",
        name: "exec",
        toolCallId,
        args: { command: "background command" },
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-foreground", 2, "tool", {
        phase: "update",
        name: "read",
        toolCallId,
        partialResult: "foreground partial",
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-background", 2, "tool", {
        phase: "update",
        name: "exec",
        toolCallId,
        partialResult: "background partial",
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-background", 3, "tool", {
        phase: "result",
        name: "exec",
        toolCallId,
        isError: true,
        result: "background failed",
      }),
    );

    expect(host.toolStreamOrder).toEqual([foregroundIdentity, backgroundIdentity]);
    expect(host.toolStreamById.get(foregroundIdentity)).toMatchObject({
      runId: "run-foreground",
      toolCallId,
      name: "read",
      args: { path: "foreground.txt" },
      output: "foreground partial",
      message: {
        runId: "run-foreground",
        toolCallId,
        __openclawToolStreamResultReceived: false,
      },
    });
    expect(host.toolStreamById.get(backgroundIdentity)).toMatchObject({
      runId: "run-background",
      toolCallId,
      name: "exec",
      args: { command: "background command" },
      output: "background failed",
      isError: true,
      resultReceived: true,
      message: {
        runId: "run-background",
        toolCallId,
        __openclawToolStreamResultReceived: true,
      },
    });
    expect(host.chatToolMessages.map((message) => message.runId)).toEqual([
      "run-foreground",
      "run-background",
    ]);

    handleAgentEvent(
      host,
      agentEvent("run-foreground", 3, "tool", {
        phase: "result",
        name: "read",
        toolCallId,
        isError: false,
        result: "foreground completed",
      }),
    );

    expect(host.toolStreamById.get(foregroundIdentity)).toMatchObject({
      output: "foreground completed",
      isError: false,
      resultReceived: true,
    });
    expect(host.toolStreamById.get(backgroundIdentity)).toMatchObject({
      output: "background failed",
      isError: true,
      resultReceived: true,
    });
  });
});
