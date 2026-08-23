import { describe, expect, it } from "vitest";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  activateCodeModeReconciliation,
  isCodeModeReconciliationTool,
} from "./code-mode-reconciliation.js";
import { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

function eligibleAttempt() {
  return makeEmbeddedRunnerAttempt({
    codeModeReconciliationCandidate: true,
    itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
  });
}

function activates(overrides = {}, hostOwnsToolSurface = true) {
  return activateCodeModeReconciliation({
    attempt: { ...eligibleAttempt(), ...overrides } as ReturnType<typeof eligibleAttempt>,
    hostOwnsToolSurface,
    retryState: createEmbeddedRunTerminalRetryState(),
    activateInternalPrompt: () => undefined,
  });
}

describe("Code Mode reconciliation", () => {
  it("admits one quiescent candidate", () => {
    expect(activates()).toBe(true);
  });

  it.each([
    ["active tool", { itemLifecycle: { startedCount: 2, completedCount: 1, activeCount: 1 } }],
    ["async work", { toolMetas: [{ toolName: "exec", asyncStarted: true }] }],
    ["message delivery", { didSendViaMessagingTool: true }],
    ["child session", { acceptedSessionSpawns: [{ runId: "child" }] }],
    ["approval", { didSendDeterministicApprovalPrompt: true }],
    ["yield", { yieldDetected: true }],
    ["plugin-owned transport", {}, false],
  ])("rejects a candidate with %s", (_label, overrides, hostOwnsToolSurface = true) => {
    expect(activates(overrides, hostOwnsToolSurface)).toBe(false);
  });

  it("exposes only the audited core observation tool", () => {
    expect(
      [
        "read",
        "find",
        "glob",
        "grep",
        "ls",
        "search",
        "exec",
        "write",
        "apply_patch",
        "message",
        "sessions_spawn",
        "web_fetch",
      ].filter((name) => isCodeModeReconciliationTool({ name })),
    ).toEqual(["read"]);
  });
});
