import { afterEach, describe, expect, it, vi } from "vitest";
import { removeInternalSessionEffectsSession } from "../../internal-session-effects.js";
import {
  clearFailedLaunchRollbacks,
  registerFailedLaunchRollback,
} from "./subagent-failed-launch-rollback.js";
import { createSubagentRegistryContextCleanup } from "./subagent-registry-context-cleanup.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

vi.mock("../../internal-session-effects.js", () => ({
  removeInternalSessionEffectsSession: vi.fn(async () => undefined),
}));

describe("failed-launch context cleanup", () => {
  afterEach(() => {
    clearFailedLaunchRollbacks();
    vi.mocked(removeInternalSessionEffectsSession).mockClear();
  });

  it("persists completion after the prepared context rollback succeeds", async () => {
    const persist = vi.fn();
    const rollback = vi.fn(async () => true);
    const entry = {
      runId: "run-prepared-rollback",
      childSessionKey: "agent:main:subagent:prepared-rollback",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "rollback prepared context",
      cleanup: "delete",
      createdAt: 1,
      execution: { status: "terminal", transcriptTarget: "agent:main:main" },
    } as SubagentRunRecord;
    registerFailedLaunchRollback(entry.runId, rollback);
    const cleanup = createSubagentRegistryContextCleanup({
      deps: () => ({ getRuntimeConfig: () => ({}) }) as never,
      persist,
      warn: vi.fn(),
    });

    await expect(cleanup.cleanupFailedLaunchResources(entry)).resolves.toBe(true);
    expect(rollback).toHaveBeenCalledOnce();
    expect(entry.contextEngineCleanupCompletedAt).toEqual(expect.any(Number));
    expect(persist).toHaveBeenCalledWith(entry.runId);
  });
});
