/** Test mocks for export-command session path and store helpers. */
import type { vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";

type ViLike = Pick<typeof vi, "fn">;

/** Creates hoist-safe mocks used by export command tests. */
export function createExportCommandSessionMocks(viInstance: ViLike) {
  return {
    resolveDefaultSessionStorePathMock: viInstance.fn(() => "/tmp/target-store/sessions.json"),
    resolveSessionFilePathMock: viInstance.fn(() => "/tmp/target-store/session.jsonl"),
    resolveSessionFilePathOptionsMock: viInstance.fn(
      (params: { agentId: string; storePath: string }) => params,
    ),
    loadSessionStoreMock: viInstance.fn(
      (_storePath?: string): Record<string, SessionEntry> => ({
        "agent:target:session": {
          sessionId: "session-1",
          updatedAt: 1,
        },
      }),
    ),
  };
}

/** Command-boundary outcomes: text alone must never imply approval or dispatch. */
export const exportExecOutcomeCases = [
  {
    name: "running",
    details: { status: "running", sessionId: "exec-1", startedAt: 1, tail: "typed output" },
    lead: "is running",
  },
  {
    name: "completed",
    details: { status: "completed", exitCode: 0, durationMs: 1, aggregated: "typed output" },
    lead: "completed (exit code 0)",
  },
  ...(["not-dispatched", "outcome-unknown", "policy-denied", undefined] as const).map((reason) => ({
    name: reason ?? "failed",
    details: {
      status: "failed" as const,
      exitCode: null,
      durationMs: 1,
      aggregated: "typed output",
      reason,
    },
    lead:
      reason === "not-dispatched"
        ? "was not dispatched"
        : reason === "outcome-unknown"
          ? "outcome is unknown"
          : reason === "policy-denied"
            ? "denied by policy"
            : "failed",
  })),
  {
    name: "unavailable",
    details: {
      status: "approval-unavailable",
      reason: "no-approval-route",
      host: "gateway",
      command: "export",
    },
    lead: "approval is unavailable",
  },
  // Synthetic typed control: the current exec-host producer records false, not real DM proof.
  {
    name: "unavailable with a synthetic recorded approver-DM fact",
    details: {
      status: "approval-unavailable",
      reason: "no-approval-route",
      host: "gateway",
      command: "export",
      sentApproverDms: true,
    },
    lead: "I sent approval DMs to the approvers for this account.",
  },
  { name: "missing", details: undefined, lead: "approval and execution could not be confirmed" },
  { name: "thrown", details: undefined, lead: "approval and execution could not be confirmed" },
] satisfies Array<{
  name: string;
  details: import("../../agents/bash-tools.exec-types.js").ExecToolDetails | undefined;
  lead: string;
}>;
