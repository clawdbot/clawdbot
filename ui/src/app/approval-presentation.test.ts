// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  deriveApprovalBadgeSnapshot,
  findInlineApproval,
  modalApprovalQueue,
  sessionHasPendingApproval,
} from "./approval-presentation.ts";
import type { ExecApprovalRequest } from "./exec-approval.ts";

function approval(
  id: string,
  options: { agentId?: string; sessionKey?: string } = {},
): ExecApprovalRequest {
  return {
    id,
    kind: "exec",
    request: { command: `echo ${id}`, ...options },
    createdAtMs: Number(id.replace(/\D/g, "")) || 1,
    expiresAtMs: Date.now() + 60_000,
  };
}

describe("approval presentation", () => {
  it("puts the oldest matching active-session request inline and suppresses only it", () => {
    const queue = [
      approval("approval-1", { sessionKey: "agent:main:current" }),
      approval("approval-2", { sessionKey: "agent:main:other" }),
      approval("approval-3", { sessionKey: "AGENT:MAIN:CURRENT" }),
    ];

    const inline = findInlineApproval(queue, "agent:main:current");

    expect(inline?.id).toBe("approval-1");
    expect(modalApprovalQueue(queue, inline?.id).map((entry) => entry.id)).toEqual([
      "approval-2",
      "approval-3",
    ]);
  });

  it("keeps every request in the modal when the active session does not match", () => {
    const queue = [approval("approval-1", { sessionKey: "agent:main:other" })];

    const inline = findInlineApproval(queue, "agent:main:current");

    expect(inline).toBeNull();
    expect(modalApprovalQueue(queue, inline?.id)).toBe(queue);
  });

  it("keeps catalog-session requests modal because catalog chat cannot render them inline", () => {
    const queue = [approval("approval-1", { sessionKey: "catalog:codex:host:thread" })];

    const inline = findInlineApproval(queue, "catalog:codex:host:thread");

    expect(inline).toBeNull();
    expect(modalApprovalQueue(queue, inline?.id)).toBe(queue);
  });

  it("derives per-agent counts and per-session flags from one queue snapshot", () => {
    const snapshot = deriveApprovalBadgeSnapshot([
      approval("approval-1", { agentId: "Main", sessionKey: "agent:main:one" }),
      approval("approval-2", { agentId: "main", sessionKey: "agent:main:two" }),
      approval("approval-3", { agentId: "worker", sessionKey: "agent:worker:one" }),
      approval("approval-4"),
    ]);

    expect(Object.fromEntries(snapshot.agentCounts)).toEqual({ main: 2, worker: 1 });
    expect(sessionHasPendingApproval(snapshot, "AGENT:MAIN:ONE")).toBe(true);
    expect(sessionHasPendingApproval(snapshot, "agent:main:missing")).toBe(false);
  });

  it("falls back to the agent session key when agentId is absent", () => {
    const snapshot = deriveApprovalBadgeSnapshot([
      approval("approval-1", { sessionKey: "agent:worker:one" }),
      approval("approval-2", { sessionKey: "not-an-agent-key" }),
    ]);

    expect(Object.fromEntries(snapshot.agentCounts)).toEqual({ worker: 1 });
  });
});
