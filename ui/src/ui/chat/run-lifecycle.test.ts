// Control UI tests cover run lifecycle behavior.
import { describe, expect, it } from "vitest";
import { isSessionRunActive } from "../session-run-state.ts";
import type { SessionsListResult } from "../types.ts";
import {
  reconcileChatRunFromCurrentSessionRow,
  reconcileChatRunFromSessionRow,
  reconcileChatRunLifecycle,
  STALE_ACTIVE_ROW_RECONCILE_WINDOW_MS,
} from "./run-lifecycle.ts";

type ReconcileHost = Parameters<typeof reconcileChatRunFromCurrentSessionRow>[0];
type TestRow = { key: string; hasActiveRun?: boolean; status?: string; startedAt?: number };

function makeSessionsResult(rows: TestRow[]): SessionsListResult {
  return { sessions: rows } as unknown as SessionsListResult;
}

function makeHost(over: Partial<ReconcileHost> = {}): ReconcileHost {
  return {
    sessionKey: "s1",
    chatRunId: null,
    chatStream: null,
    sessionsResult: makeSessionsResult([{ key: "s1", hasActiveRun: true, status: "running" }]),
    requestUpdate: () => {},
    ...over,
  };
}

function rowActive(host: ReconcileHost): boolean {
  const row = host.sessionsResult?.sessions.find((r) => r.key === host.sessionKey);
  return Boolean(row && isSessionRunActive(row));
}

describe("reconcileChatRunFromCurrentSessionRow stale-active suppression (#87875)", () => {
  it("suppresses a stale active row after a recent local completion", () => {
    const host = makeHost({
      lastLocalTerminalReconcile: {
        sessionKey: "s1",
        runId: "r1",
        phase: "done",
        sessionStatus: "done",
        occurredAt: Date.now(),
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

  it("ignores and clears a local terminal reconcile older than the window", () => {
    const host = makeHost({
      lastLocalTerminalReconcile: {
        sessionKey: "s1",
        runId: "r1",
        phase: "done",
        sessionStatus: "done",
        occurredAt: Date.now() - STALE_ACTIVE_ROW_RECONCILE_WINDOW_MS - 1_000,
      },
    });
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(false);
    expect(rowActive(host)).toBe(true);
    expect(host.lastLocalTerminalReconcile).toBeNull();
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
        occurredAt: Date.now(),
      },
    });
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(false);
    expect(rowActive(host)).toBe(true);
  });

  it("clears the flag once the server poll reports a non-active row", () => {
    const host = makeHost({
      sessionsResult: makeSessionsResult([{ key: "s1", hasActiveRun: false, status: "done" }]),
      lastLocalTerminalReconcile: {
        sessionKey: "s1",
        runId: "r1",
        phase: "done",
        sessionStatus: "done",
        occurredAt: Date.now(),
      },
    });
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(false);
    expect(host.lastLocalTerminalReconcile).toBeNull();
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
      { key: "s1", hasActiveRun: true, status: "running" },
    ]);
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(false);
    expect(rowActive(host)).toBe(true);
  });

  it("does not suppress a newer active row after a follow-up run starts", () => {
    const terminalAt = Date.now();
    const host = makeHost({
      sessionsResult: makeSessionsResult([
        {
          key: "s1",
          hasActiveRun: true,
          status: "running",
          startedAt: terminalAt + 1,
        },
      ]),
      lastLocalTerminalReconcile: {
        sessionKey: "s1",
        runId: "r1",
        phase: "done",
        sessionStatus: "done",
        occurredAt: terminalAt,
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

  it("arms suppression on a completed turn, then suppresses the racing refresh", () => {
    const host = makeHost({
      chatRunId: "r1",
      chatStream: "partial...",
      sessionsResult: makeSessionsResult([{ key: "s1", hasActiveRun: true, status: "running" }]),
    });
    reconcileChatRunLifecycle(host, {
      outcome: "done",
      sessionStatus: "done",
      runId: "r1",
      sessionKey: "s1",
      clearLocalRun: true,
      clearChatStream: true,
      publishRunStatus: false,
      armLocalTerminalReconcile: true,
    });
    expect(host.lastLocalTerminalReconcile?.sessionKey).toBe("s1");
    expect(host.chatRunId ?? null).toBeNull();
    // A racing sessions.list refresh re-introduces a stale active row.
    host.sessionsResult = makeSessionsResult([
      { key: "s1", hasActiveRun: true, status: "running" },
    ]);
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(true);
    expect(rowActive(host)).toBe(false);
    expect(host.lastLocalTerminalReconcile?.runId).toBe("r1");
  });

  it("keeps suppressing multiple stale active refreshes within the window", () => {
    const terminalAt = Date.now();
    const host = makeHost({
      lastLocalTerminalReconcile: {
        sessionKey: "s1",
        runId: "r1",
        phase: "done",
        sessionStatus: "done",
        occurredAt: terminalAt,
      },
    });

    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(true);
    host.sessionsResult = makeSessionsResult([
      { key: "s1", hasActiveRun: true, status: "running", startedAt: terminalAt - 1 },
    ]);
    expect(reconcileChatRunFromCurrentSessionRow(host)).toBe(true);
    expect(rowActive(host)).toBe(false);
  });
});
