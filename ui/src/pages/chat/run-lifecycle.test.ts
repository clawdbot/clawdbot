// @vitest-environment node
// Control UI tests cover run lifecycle behavior.
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import {
  handleAbortChat,
  hasAbortableSessionRun,
  hasDirectSessionRun,
  reconcileChatRunFromCurrentSessionRow,
  reconcileChatRunFromSessionRow,
  reconcileChatRunLifecycle,
  reconcileChatRunAfterSessionStatePublication,
  replayPendingChatAbort,
} from "./run-lifecycle.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";

const CHAT_RUN_STATUS_TOAST_DURATION_MS = 5_000;

type ReconcileHost = Parameters<typeof reconcileChatRunFromCurrentSessionRow>[0];
type TestRow = {
  key: string;
  hasActiveRun?: boolean;
  hasActiveSubagentRun?: boolean;
  activeRunIds?: string[];
  status?: string;
  lastRunId?: string;
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
    hello: sessionMutationGatewayHello(),
    ...over,
  };
}

describe("handleAbortChat", () => {
  it("dispatches sessions.abort when only descendant work remains", async () => {
    const request = vi.fn(async () => ({ status: "aborted" }));
    const host = makeAbortHost({
      client: { request } as unknown as GatewayBrowserClient,
      sessionsResult: makeSessionsResult([
        {
          key: "agent:main",
          hasActiveRun: false,
          hasActiveSubagentRun: true,
          status: "done",
        },
      ]),
    });

    expect(hasDirectSessionRun(host)).toBe(false);
    expect(hasAbortableSessionRun(host)).toBe(true);
    await handleAbortChat(host);

    expect(request).toHaveBeenCalledWith("sessions.abort", {
      key: "agent:main",
      clearQueued: true,
    });
  });

  it("shows reconnect guidance when an offline session run has no browser run identity", async () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const host = makeAbortHost({
      client,
      connected: false,
      chatMessage: "keep this draft",
      sessionsResult: makeSessionsResult([
        { key: "agent:main", hasActiveRun: true, status: "running" },
      ]),
    });

    expect(hasAbortableSessionRun(host)).toBe(true);
    await handleAbortChat(host, { preserveDraft: true });

    expect(host.chatError).toBe("Not connected. Try again after reconnecting.");
    expect(host.lastError).toBe(host.chatError);
    expect(host.chatMessage).toBe("keep this draft");
    expect(host.pendingAbort).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps offline exact-run stops safely queued for reconnect", async () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const host = makeAbortHost({
      client,
      connected: false,
      chatRunId: "run-main",
      chatMessage: "keep this draft",
    });

    await handleAbortChat(host, { preserveDraft: true });

    expect(host.pendingAbort).toEqual({
      sourceClient: client,
      sessionKey: "agent:main",
      runId: "run-main",
    });
    expect(host.chatMessage).toBe("keep this draft");
    expect(host.chatError ?? null).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});

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

  it("denies a queued exact-run stop when the reconnect is read-only", async () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const host = makeAbortHost({
      client,
      hello: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["chat.abort"] },
      },
      pendingAbort: {
        sourceClient: client,
        runId: "run-main",
        sessionKey: "global",
        agentId: "work",
      },
    });

    await expect(replayPendingChatAbort(host)).resolves.toBe(false);

    expect(request).not.toHaveBeenCalled();
    expect(host.pendingAbort).toBeNull();
    expect(host.chatError).toContain("operator.write");
    expect(host.lastError).toBe(host.chatError);
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

type LocalTerminalReconcile = NonNullable<ReconcileHost["lastLocalTerminalReconcile"]>;

function makeLocalTerminalReconcile(
  overrides: Partial<LocalTerminalReconcile> = {},
): LocalTerminalReconcile {
  return {
    sessionKey: "s1",
    runId: "r1",
    phase: "done",
    sessionStatus: "done",
    ...overrides,
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
    expect(host.lastLocalTerminalReconcile).toBeNull();
    expect(host.sessionsResult?.sessions[0]).toMatchObject({
      activeRunIds: [],
      hasActiveRun: false,
      status: "running",
    });
  });
});

describe("reconcileChatRunLifecycle indicators", () => {
  it("clears run-owned transient indicators on terminal run end", () => {
    const host = makeHost({
      chatRunId: "r1",
      knownAgentRunIds: new Set(["r1", "r2"]),
      waitingApprovalStatuses: new Map([
        ["approval-1", { approvalId: "approval-1", toolCallId: "tool-1", runId: "r1" }],
      ]),
    });

    reconcileChatRunLifecycle(host, {
      outcome: "done",
      runId: "r1",
      clearLocalRun: true,
    });

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
});

describe("reconcileChatRunFromSessionRow transient projections", () => {
  it("clears only the terminal run's tool stream", () => {
    const runId = "r1";
    const siblingRunId = "r2";
    const toolIdentity = buildToolStreamIdentity(runId, "tool-1");
    const siblingToolIdentity = buildToolStreamIdentity(siblingRunId, "tool-2");
    const toolMessage = { role: "assistant", runId, toolCallId: "tool-1" };
    const siblingToolMessage = {
      role: "assistant",
      runId: siblingRunId,
      toolCallId: "tool-2",
    };
    const host = makeHost({
      chatRunId: runId,
      chatStream: "Final reply",
      chatStreamSegments: [
        { text: "run one", ts: 1, runId },
        { text: "run two", ts: 2, runId: siblingRunId },
      ],
      chatToolMessages: [toolMessage, siblingToolMessage],
      toolStreamById: new Map([
        [
          toolIdentity,
          {
            message: toolMessage,
            name: "exec",
            receivedAt: 1,
            runId,
            startedAt: 1,
            toolCallId: "tool-1",
          },
        ],
        [
          siblingToolIdentity,
          {
            message: siblingToolMessage,
            name: "read",
            receivedAt: 2,
            runId: siblingRunId,
            startedAt: 2,
            toolCallId: "tool-2",
          },
        ],
      ]),
      toolStreamOrder: [toolIdentity, siblingToolIdentity],
      toolStreamSyncTimer: null,
      knownAgentRunIds: new Set([runId, siblingRunId]),
      waitingApprovalStatuses: new Map([
        ["approval-1", { approvalId: "approval-1", toolCallId: "tool-1", runId }],
        ["approval-2", { approvalId: "approval-2", toolCallId: "tool-2", runId: siblingRunId }],
      ]),
    });

    expect(
      reconcileChatRunFromSessionRow(host, {
        key: "s1",
        kind: "direct",
        updatedAt: 2,
        hasActiveRun: false,
        status: "done",
      }),
    ).toBe(true);

    expect(host.chatStreamSegments).toEqual([{ text: "run two", ts: 2, runId: siblingRunId }]);
    expect(host.chatToolMessages).toEqual([siblingToolMessage]);
    expect(host.toolStreamById?.has(toolIdentity)).toBe(false);
    expect(host.toolStreamById?.has(siblingToolIdentity)).toBe(true);
    expect(host.toolStreamOrder).toEqual([siblingToolIdentity]);
    expect(host.knownAgentRunIds).toEqual(new Set([siblingRunId]));
    expect([...host.waitingApprovalStatuses!.keys()]).toEqual(["approval-2"]);
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
      lastLocalTerminalReconcile: makeLocalTerminalReconcile({ sessionKey: "main" }),
    });

    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(true);
    expect(isSessionRunActive(host.sessionsResult?.sessions[0] ?? {})).toBe(false);
  });

  it("suppresses a stale active row after a recent local completion", () => {
    const host = makeHost({
      lastLocalTerminalReconcile: makeLocalTerminalReconcile(),
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
      lastLocalTerminalReconcile: makeLocalTerminalReconcile(),
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
      lastLocalTerminalReconcile: makeLocalTerminalReconcile(),
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
      lastLocalTerminalReconcile: makeLocalTerminalReconcile(),
    });
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(false);
    expect(rowActive(host)).toBe(true);
  });

  it("retains completed run identity across a terminal row projection", () => {
    const host = makeHost({
      sessionsResult: makeSessionsResult([{ key: "s1", hasActiveRun: false, status: "done" }]),
      lastLocalTerminalReconcile: makeLocalTerminalReconcile(),
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
      lastLocalTerminalReconcile: makeLocalTerminalReconcile(),
    });
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(false);
    expect(rowActive(host)).toBe(true);
    expect(host.lastLocalTerminalReconcile).toBeNull();
  });

  it("does not suppress an active row without run identity", () => {
    const host = makeHost({
      sessionsResult: makeSessionsResult([{ key: "s1", hasActiveRun: true, status: "running" }]),
      lastLocalTerminalReconcile: makeLocalTerminalReconcile(),
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
      lastLocalTerminalReconcile: makeLocalTerminalReconcile(),
    });

    expect(reconcileChatRunAfterSessionStatePublication(host)).toBe(true);
    expect(rowActive(host)).toBe(false);
  });

  it("recovers a missed terminal event from the exact settled session row", () => {
    const host = makeHost({
      chatRunId: "r1",
      chatStream: "complete reply",
      sessionsResult: makeSessionsResult([
        { key: "s1", hasActiveRun: false, lastRunId: "r1", status: "done" },
      ]),
    });

    expect(reconcileChatRunAfterSessionStatePublication(host)).toBe(true);
    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
  });

  it.each([undefined, "older-run"])(
    "does not settle a live run from a %s terminal row identity",
    (lastRunId) => {
      const host = makeHost({
        chatRunId: "r1",
        chatStream: "still running",
        sessionsResult: makeSessionsResult([
          { key: "s1", hasActiveRun: false, lastRunId, status: "done" },
        ]),
      });

      expect(reconcileChatRunAfterSessionStatePublication(host)).toBe(false);
      expect(host.chatRunId).toBe("r1");
      expect(host.chatStream).toBe("still running");
    },
  );

  it("keeps suppressing repeated stale active refreshes for the completed run", () => {
    const host = makeHost({
      lastLocalTerminalReconcile: makeLocalTerminalReconcile(),
    });

    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(true);
    host.sessionsResult = makeSessionsResult([
      { key: "s1", hasActiveRun: true, activeRunIds: ["r1"], status: "running" },
    ]);
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(true);
    expect(rowActive(host)).toBe(false);
  });
});
