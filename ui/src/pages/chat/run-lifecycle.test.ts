// @vitest-environment node
// Control UI tests cover run lifecycle behavior.
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import {
  CHAT_RUN_STATUS_TOAST_DURATION_MS,
  hasAbortableSessionRun,
  reconcileChatRunFromCurrentSessionRow,
  reconcileChatRunFromSessionRow,
  reconcileChatRunLifecycle,
  reconcileStaleChatRunAfterSessionStatePublication,
  replayPendingChatAbort,
} from "./run-lifecycle.ts";

type ReconcileHost = Parameters<typeof reconcileChatRunFromCurrentSessionRow>[0];
type TestRow = {
  key: string;
  hasActiveRun?: boolean;
  activeRunIds?: string[];
  status?: string;
  startedAt?: number;
};

function makeSessionsResult(rows: TestRow[]): SessionsListResult {
  return { sessions: rows } as unknown as SessionsListResult;
}

describe("hasAbortableSessionRun", () => {
  it("recognizes the canonical main row while chat uses its main alias", () => {
    expect(
      hasAbortableSessionRun({
        chatRunId: null,
        sessionKey: "main",
        sessionsResult: makeSessionsResult([
          { key: "agent:main:main", hasActiveRun: true, status: "running" },
        ]),
      }),
    ).toBe(true);
  });
});

type AbortHost = Parameters<typeof replayPendingChatAbort>[0];

function makeAbortHost(over: Partial<AbortHost> = {}): AbortHost {
  return {
    client: null,
    connected: true,
    sessionKey: "agent:main",
    chatRunId: null,
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatLocalInputHistoryBySession: {},
    chatInputHistorySessionKey: null,
    chatInputHistoryItems: null,
    chatInputHistoryIndex: -1,
    chatDraftBeforeHistory: null,
    hello: null,
    ...over,
  };
}

describe("replayPendingChatAbort", () => {
  it("dispatches a queued exact browser run stop through chat.abort", async () => {
    const request = vi.fn(async () => ({ aborted: true }));
    const client = { request } as unknown as GatewayBrowserClient;
    const host = makeAbortHost({
      client,
      pendingAbort: {
        sourceClient: client,
        runId: "run-main",
        sessionKey: "global",
        agentId: "work",
      },
    });

    await expect(replayPendingChatAbort(host)).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith("chat.abort", {
      sessionKey: "global",
      agentId: "work",
      runId: "run-main",
    });
    expect(host.pendingAbort).toBeNull();
  });

  it("consumes an ambiguously failed exact-run stop without retrying it", async () => {
    const request = vi.fn(async () => {
      throw new Error("gateway closed before acknowledgement");
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const host = makeAbortHost({
      client,
      pendingAbort: {
        sourceClient: client,
        runId: "run-main",
        sessionKey: "agent:main:telegram:direct:queued-user",
      },
    });

    await expect(replayPendingChatAbort(host)).resolves.toBe(false);

    expect(request).toHaveBeenCalledOnce();
    expect(host.pendingAbort).toBeNull();
    expect(host.chatError).toBe("gateway closed before acknowledgement");
    expect(host.lastError).toBe("gateway closed before acknowledgement");
  });

  it("discards a queued stop when the reconnect uses a replacement client", async () => {
    const sourceClient = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const replacementRequest = vi.fn();
    const host = makeAbortHost({
      client: { request: replacementRequest } as unknown as GatewayBrowserClient,
      pendingAbort: {
        sourceClient,
        runId: "run-main",
        sessionKey: "agent:main:telegram:direct:queued-user",
      },
    });

    await expect(replayPendingChatAbort(host)).resolves.toBe(false);

    expect(replacementRequest).not.toHaveBeenCalled();
    expect(host.pendingAbort).toBeNull();
    expect(host.chatError ?? null).toBeNull();
  });
});

function makeHost(over: Partial<ReconcileHost> = {}): ReconcileHost {
  return {
    sessionKey: "s1",
    chatRunId: null,
    chatStream: null,
    sessionsResult: makeSessionsResult([
      { key: "s1", hasActiveRun: true, activeRunIds: ["r1"], status: "running" },
    ]),
    requestUpdate: () => {},
    ...over,
  };
}

function rowActive(host: ReconcileHost): boolean {
  const row = host.sessionsResult?.sessions.find((r) => r.key === host.sessionKey);
  return Boolean(row && isSessionRunActive(row));
}

function completeLocalRun(host: ReconcileHost, publishRunStatus = true) {
  reconcileChatRunLifecycle(host, {
    outcome: "done",
    sessionStatus: "done",
    runId: "r1",
    sessionKey: "s1",
    clearLocalRun: true,
    clearChatStream: true,
    armLocalTerminalReconcile: true,
    publishRunStatus,
  });
  if (!host.lastLocalTerminalReconcile) {
    throw new Error("Expected local terminal reconciliation to be armed");
  }
}

describe("reconcileChatRunLifecycle yielded parent", () => {
  it("clears the completed model run without publishing terminal task state", () => {
    const host = makeHost({
      chatRunId: "r1",
      chatStream: "Waiting for child completion.",
      chatRunStatus: {
        phase: "done",
        runId: "older-run",
        sessionKey: "s1",
        occurredAt: 1,
      },
      planStatus: {
        steps: [{ step: "Wait for child completion", status: "in_progress" }],
      },
    });

    reconcileChatRunLifecycle(host, {
      yielded: true,
      runId: "r1",
      sessionKey: "s1",
      clearLocalRun: true,
      clearChatStream: true,
    });

    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
    expect(host.chatRunStatus).toBeNull();
    expect(host.planStatus).toBeNull();
    expect(host.lastLocalTerminalReconcile).toBeNull();
    expect(host.sessionsResult?.sessions[0]).toMatchObject({
      activeRunIds: [],
      hasActiveRun: false,
      status: "running",
    });
  });
});

describe("reconcileChatRunLifecycle indicators", () => {
  it("clears plan status on terminal run end", () => {
    const host = makeHost({
      chatRunId: "r1",
      knownAgentRunIds: new Set(["r1", "r2"]),
      waitingApprovalStatuses: new Map([
        ["approval-1", { approvalId: "approval-1", toolCallId: "tool-1", runId: "r1" }],
      ]),
      planStatus: {
        steps: [{ step: "Finish the run", status: "in_progress" }],
      },
    });

    reconcileChatRunLifecycle(host, {
      outcome: "done",
      runId: "r1",
      clearLocalRun: true,
    });

    expect(host.planStatus).toBeNull();
    expect(host.knownAgentRunIds).toEqual(new Set(["r2"]));
    expect(host.waitingApprovalStatuses?.size).toBe(0);
  });

  it("preserves a waiting approval owned by another run", () => {
    const host = makeHost({
      chatRunId: "r1",
      waitingApprovalStatuses: new Map([
        ["approval-1", { approvalId: "approval-1", toolCallId: "tool-1", runId: "r1" }],
      ]),
    });

    reconcileChatRunLifecycle(host, {
      outcome: "done",
      runId: "r2",
      clearIndicators: true,
      clearLocalRun: false,
    });

    expect(host.waitingApprovalStatuses?.has("approval-1")).toBe(true);
  });

  it("preserves an owned plan when another run terminates", () => {
    const host = makeHost({
      chatRunId: "r1",
      planStatus: {
        runId: "r1",
        steps: [{ step: "Finish the run", status: "in_progress" }],
      },
    });

    reconcileChatRunLifecycle(host, {
      outcome: "done",
      runId: "r2",
      clearIndicators: true,
      clearLocalRun: false,
    });

    expect(host.planStatus).toEqual({
      runId: "r1",
      steps: [{ step: "Finish the run", status: "in_progress" }],
    });
  });
});

describe("reconcileChatRunFromCurrentSessionRow stale-active suppression (#87875)", () => {
  it("keeps a local run active when the gateway registry overrides a terminal snapshot", () => {
    const host = makeHost({
      chatRunId: "run-before-finalize",
      chatStream: "final answer",
    });

    expect(
      reconcileChatRunFromSessionRow(host, {
        key: "s1",
        kind: "direct",
        updatedAt: 1,
        hasActiveRun: true,
        status: "done",
      }),
    ).toBe(false);
    expect(host.chatRunId).toBe("run-before-finalize");
    expect(host.chatStream).toBe("final answer");
  });

  it("honors an explicit inactive run when the status is stale", () => {
    const host = makeHost({
      chatRunId: "run-before-terminal-event",
      chatStream: "final answer",
      sessionsResult: makeSessionsResult([
        {
          key: "s1",
          hasActiveRun: true,
          activeRunIds: ["run-before-terminal-event"],
          status: "running",
        },
      ]),
    });

    expect(
      reconcileChatRunFromSessionRow(host, {
        key: "s1",
        kind: "direct",
        updatedAt: 1,
        hasActiveRun: false,
        status: "running",
      }),
    ).toBe(true);
    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
    expect(rowActive(host)).toBe(false);
  });

  it("suppresses a stale completed run published under an equivalent alias", () => {
    const host = makeHost({
      sessionKey: "main",
      sessionsResult: makeSessionsResult([
        {
          key: "agent:main:main",
          hasActiveRun: true,
          activeRunIds: ["r1"],
          status: "running",
        },
      ]),
      lastLocalTerminalReconcile: {
        sessionKey: "main",
        runId: "r1",
        phase: "done",
        sessionStatus: "done",
      },
    });

    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(true);
    expect(isSessionRunActive(host.sessionsResult?.sessions[0] ?? {})).toBe(false);
  });

  it("suppresses a stale active row after a recent local completion", () => {
    const host = makeHost({
      lastLocalTerminalReconcile: {
        sessionKey: "s1",
        runId: "r1",
        phase: "done",
        sessionStatus: "done",
      },
    });
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(true);
    expect(rowActive(host)).toBe(false);
    expect(host.lastLocalTerminalReconcile?.runId).toBe("r1");
  });

  it("does NOT clear a genuinely recovered active run with no recent local completion", () => {
    const host = makeHost({ lastLocalTerminalReconcile: null });
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(false);
    expect(rowActive(host)).toBe(true);
  });

  it("retains the completed run identity while the session row is unavailable", () => {
    const host = makeHost({
      sessionsResult: null,
      lastLocalTerminalReconcile: {
        sessionKey: "s1",
        runId: "r1",
        phase: "done",
        sessionStatus: "done",
      },
    });

    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(false);
    expect(host.lastLocalTerminalReconcile?.runId).toBe("r1");

    host.sessionsResult = makeSessionsResult([
      { key: "s1", hasActiveRun: true, activeRunIds: ["r1"], status: "running" },
    ]);
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(true);
    expect(rowActive(host)).toBe(false);
  });

  it("keeps suppressing the exact completed run without a time limit", () => {
    vi.useFakeTimers();
    const host = makeHost({
      lastLocalTerminalReconcile: {
        sessionKey: "s1",
        runId: "r1",
        phase: "done",
        sessionStatus: "done",
      },
    });
    try {
      vi.advanceTimersByTime(60_000);
      expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(true);
      expect(rowActive(host)).toBe(false);
      expect(host.lastLocalTerminalReconcile?.runId).toBe("r1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not suppress when the recent completion was for a different session", () => {
    const host = makeHost({
      sessionKey: "s2",
      sessionsResult: makeSessionsResult([{ key: "s2", hasActiveRun: true, status: "running" }]),
      lastLocalTerminalReconcile: {
        sessionKey: "s1",
        runId: "r1",
        phase: "done",
        sessionStatus: "done",
      },
    });
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(false);
    expect(rowActive(host)).toBe(true);
  });

  it("retains completed run identity across a terminal row projection", () => {
    const host = makeHost({
      sessionsResult: makeSessionsResult([{ key: "s1", hasActiveRun: false, status: "done" }]),
      lastLocalTerminalReconcile: {
        sessionKey: "s1",
        runId: "r1",
        phase: "done",
        sessionStatus: "done",
      },
    });
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(false);
    expect(host.lastLocalTerminalReconcile?.runId).toBe("r1");
  });

  it("does not arm stale-row suppression from generic lifecycle cleanup", () => {
    const host = makeHost({
      chatRunId: "orphaned-run",
      chatStream: "stale stream",
    });
    reconcileChatRunLifecycle(host, {
      outcome: "interrupted",
      sessionStatus: "killed",
      runId: "orphaned-run",
      sessionKey: "s1",
      clearLocalRun: true,
      clearChatStream: true,
      publishRunStatus: false,
    });
    expect(host.lastLocalTerminalReconcile ?? null).toBeNull();
    host.sessionsResult = makeSessionsResult([
      { key: "s1", hasActiveRun: true, activeRunIds: ["r1"], status: "running" },
    ]);
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(false);
    expect(rowActive(host)).toBe(true);
  });

  it("does not clear an unidentified active row from an unowned terminal event", () => {
    const host = makeHost({
      sessionsResult: makeSessionsResult([{ key: "s1", hasActiveRun: true, status: "running" }]),
    });

    reconcileChatRunLifecycle(host, {
      outcome: "done",
      sessionStatus: "done",
      runId: null,
      sessionKey: "s1",
      publishRunStatus: false,
    });

    expect(rowActive(host)).toBe(true);
  });

  it("does not suppress a different active run id", () => {
    const host = makeHost({
      sessionsResult: makeSessionsResult([
        {
          key: "s1",
          hasActiveRun: true,
          activeRunIds: ["r2"],
          status: "running",
          startedAt: Date.now() - 60_000,
        },
      ]),
      lastLocalTerminalReconcile: {
        sessionKey: "s1",
        runId: "r1",
        phase: "done",
        sessionStatus: "done",
      },
    });
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(false);
    expect(rowActive(host)).toBe(true);
    expect(host.lastLocalTerminalReconcile).toBeNull();
  });

  it("does not suppress an active row without run identity", () => {
    const host = makeHost({
      sessionsResult: makeSessionsResult([{ key: "s1", hasActiveRun: true, status: "running" }]),
      lastLocalTerminalReconcile: {
        sessionKey: "s1",
        runId: "r1",
        phase: "done",
        sessionStatus: "done",
      },
    });

    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(false);
    expect(rowActive(host)).toBe(true);
    expect(host.lastLocalTerminalReconcile).toBeNull();
  });

  it("clears selected agent-main alias runs from canonical global history rows", () => {
    const host = makeHost({
      sessionKey: "agent:work:main",
      chatRunId: "run-global",
      chatStream: "streaming",
      sessionsResult: makeSessionsResult([
        { key: "agent:work:main", hasActiveRun: true, status: "running" },
      ]),
    });

    const reconciled = reconcileChatRunFromSessionRow(
      host,
      { key: "global", kind: "global", updatedAt: 1, hasActiveRun: false, status: "done" },
      { publishRunStatus: false },
    );

    expect(reconciled).toBe(true);
    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
  });

  it("clears selected agent-global alias runs from canonical global history rows", () => {
    const host = makeHost({
      sessionKey: "agent:work:global",
      chatRunId: "run-global",
      chatStream: "streaming",
      sessionsResult: makeSessionsResult([
        { key: "agent:work:global", hasActiveRun: true, status: "running" },
      ]),
    });

    const reconciled = reconcileChatRunFromSessionRow(
      host,
      { key: "global", kind: "global", updatedAt: 1, hasActiveRun: false, status: "done" },
      { publishRunStatus: false },
    );

    expect(reconciled).toBe(true);
    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
  });

  it("clears configured agent-main alias runs from canonical global history rows", () => {
    const host = makeHost({
      sessionKey: "agent:work:inbox",
      agentsList: { mainKey: "inbox" },
      chatRunId: "run-global",
      chatStream: "streaming",
      sessionsResult: makeSessionsResult([
        { key: "agent:work:inbox", hasActiveRun: true, status: "running" },
      ]),
    });

    const reconciled = reconcileChatRunFromSessionRow(
      host,
      { key: "global", kind: "global", updatedAt: 1, hasActiveRun: false, status: "done" },
      { publishRunStatus: false },
    );

    expect(reconciled).toBe(true);
    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
  });

  it("publishes the canonical global row key for a selected agent alias", () => {
    const reconcileRunTerminal = vi.fn();
    const host = makeHost({
      sessionKey: "agent:work:main",
      chatRunId: "run-global",
      chatStream: "streaming",
      sessionsResult: makeSessionsResult([
        {
          key: "global",
          hasActiveRun: true,
          activeRunIds: ["run-global"],
          status: "running",
        },
      ]),
      sessions: {
        reconcileRunTerminal,
        setModelOverride: vi.fn(),
      },
    });

    reconcileChatRunLifecycle(host, {
      outcome: "done",
      sessionStatus: "done",
      runId: "run-global",
      sessionKey: "agent:work:main",
      clearLocalRun: true,
      clearChatStream: true,
    });

    expect(host.sessionsResult?.sessions[0]).toMatchObject({
      key: "global",
      hasActiveRun: false,
      status: "done",
    });
    expect(reconcileRunTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-global",
        sessionKeys: expect.arrayContaining(["agent:work:main", "global"]),
      }),
    );
  });

  it("publishes the canonical global key before the local session list loads", () => {
    const reconcileRunTerminal = vi.fn();
    const host = makeHost({
      sessionKey: "agent:work:main",
      chatRunId: "run-global",
      chatStream: "streaming",
      sessionsResult: null,
      sessions: {
        reconcileRunTerminal,
        setModelOverride: vi.fn(),
      },
    });

    reconcileChatRunLifecycle(host, {
      outcome: "done",
      sessionStatus: "done",
      runId: "run-global",
      sessionKey: "agent:work:main",
      clearLocalRun: true,
      clearChatStream: true,
    });

    expect(reconcileRunTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-global",
        sessionKeys: expect.arrayContaining(["agent:work:main", "global"]),
      }),
    );
  });

  it("arms suppression on a completed turn, then suppresses the racing refresh", () => {
    const host = makeHost({
      chatRunId: "r1",
      chatStream: "partial...",
      sessionsResult: makeSessionsResult([
        { key: "s1", hasActiveRun: true, activeRunIds: ["r1"], status: "running" },
      ]),
    });
    completeLocalRun(host, false);
    expect(host.lastLocalTerminalReconcile?.sessionKey).toBe("s1");
    expect(host.chatRunId ?? null).toBeNull();
    // A racing sessions.list refresh re-introduces a stale active row.
    host.sessionsResult = makeSessionsResult([
      { key: "s1", hasActiveRun: true, activeRunIds: ["r1"], status: "running" },
    ]);
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(true);
    expect(rowActive(host)).toBe(false);
    expect(host.lastLocalTerminalReconcile?.runId).toBe("r1");
  });

  it("reconciles a stale active row when the terminal toast expires", () => {
    vi.useFakeTimers();
    try {
      const host = makeHost({ chatRunId: "r1", chatStream: "partial..." });
      completeLocalRun(host);
      host.sessionsResult = makeSessionsResult([
        { key: "s1", hasActiveRun: true, activeRunIds: ["r1"], status: "running" },
      ]);

      vi.advanceTimersByTime(CHAT_RUN_STATUS_TOAST_DURATION_MS);

      expect(host.chatRunStatus).toBeNull();
      expect(rowActive(host)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a newer run id even when the Gateway clock trails the browser", () => {
    vi.useFakeTimers();
    try {
      const host = makeHost({ chatRunId: "r1", chatStream: "partial..." });
      completeLocalRun(host);
      host.sessionsResult = makeSessionsResult([
        {
          key: "s1",
          hasActiveRun: true,
          activeRunIds: ["r2"],
          status: "running",
          startedAt: Date.now() - 60_000,
        },
      ]);

      vi.advanceTimersByTime(CHAT_RUN_STATUS_TOAST_DURATION_MS);

      expect(host.chatRunStatus).toBeNull();
      expect(rowActive(host)).toBe(true);
      expect(host.lastLocalTerminalReconcile).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clear a follow-up run adopted before the previous toast expires", () => {
    vi.useFakeTimers();
    try {
      const host = makeHost({ chatRunId: "r1", chatStream: "first reply" });
      completeLocalRun(host);
      host.chatRunId = "r2";
      host.chatStream = "follow-up reply";

      vi.advanceTimersByTime(CHAT_RUN_STATUS_TOAST_DURATION_MS);

      expect(host.chatRunStatus).toBeNull();
      expect(host.chatRunId).toBe("r2");
      expect(host.chatStream).toBe("follow-up reply");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles stale session publications while terminal status is visible", () => {
    const completedAt = Date.now();
    const host = makeHost({
      chatRunStatus: {
        phase: "done",
        runId: "r1",
        sessionKey: "s1",
        occurredAt: completedAt,
      },
      lastLocalTerminalReconcile: {
        sessionKey: "s1",
        runId: "r1",
        phase: "done",
        sessionStatus: "done",
      },
    });

    expect(reconcileStaleChatRunAfterSessionStatePublication(host)).toBe(true);
    expect(rowActive(host)).toBe(false);
  });

  it("keeps suppressing repeated stale active refreshes for the completed run", () => {
    const host = makeHost({
      lastLocalTerminalReconcile: {
        sessionKey: "s1",
        runId: "r1",
        phase: "done",
        sessionStatus: "done",
      },
    });

    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(true);
    host.sessionsResult = makeSessionsResult([
      { key: "s1", hasActiveRun: true, activeRunIds: ["r1"], status: "running" },
    ]);
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(true);
    expect(rowActive(host)).toBe(false);
  });
});
