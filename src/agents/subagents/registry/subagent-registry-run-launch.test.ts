import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentLaunchManager } from "./subagent-registry-run-launch.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const taskRuntimeMocks = vi.hoisted(() => ({
  createQueuedTaskRun: vi.fn(),
  createRunningTaskRun: vi.fn(),
}));

vi.mock("../../../tasks/detached-task-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../tasks/detached-task-runtime.js")>()),
  createQueuedTaskRun: taskRuntimeMocks.createQueuedTaskRun,
  createRunningTaskRun: taskRuntimeMocks.createRunningTaskRun,
}));

function createManager(runs: Map<string, SubagentRunRecord>) {
  const getRunsForChildSession = (childSessionKey: string) =>
    [...runs.values()].filter((entry) => entry.childSessionKey === childSessionKey);
  const options = {
    runs,
    getRunsForChildSession,
    resumedRuns: new Set<string>(),
    persist: vi.fn(),
    persistOrThrow: vi.fn(),
    callGateway: vi.fn(),
    getRuntimeConfig: vi.fn(() => ({})),
    ensureListener: vi.fn(),
    startSweeper: vi.fn(),
    stopSweeper: vi.fn(),
    resumeSubagentRun: vi.fn(),
    clearPendingLifecycleError: vi.fn(),
    clearPendingLifecycleTimeout: vi.fn(),
    resolveSubagentWaitTimeoutMs: vi.fn(() => 60_000),
    scheduleSweep: vi.fn(),
    resolveSubagentSessionCompletion: vi.fn(() => null),
    resolveSubagentSessionStartedAt: vi.fn(),
    notifyContextEngineSubagentEnded: vi.fn(async () => {}),
    completeCleanupBookkeeping: vi.fn(),
    completeSubagentRun: vi.fn(async () => {}),
    resolveSubagentTask: vi.fn(() => ({ lookup: "unavailable" as const })),
  } as unknown as SubagentManagerOptions;
  return { manager: new SubagentLaunchManager(options), options };
}

describe("subagent launch lifecycle ownership", () => {
  beforeEach(() => {
    taskRuntimeMocks.createQueuedTaskRun.mockReset();
    taskRuntimeMocks.createRunningTaskRun.mockReset();
  });

  it("persists ACP observers without creating a duplicate subagent task", () => {
    const runs = new Map<string, SubagentRunRecord>();
    const { manager, options } = createManager(runs);

    manager.registerSubagentRun({
      runId: "run-acp-observer",
      lifecycleOwner: "acp",
      childSessionKey: "agent:codex:acp:child",
      requesterSessionKey: "agent:main:slack:direct:owner",
      requesterDisplayKey: "owner",
      task: "Review a pull request",
      cleanup: "keep",
      expectsCompletionMessage: false,
      queued: true,
    });

    expect(runs.get("run-acp-observer")).toMatchObject({
      lifecycleOwner: "acp",
      execution: {
        status: "queued",
        suppressSessionEffects: true,
      },
      delivery: { status: "not_required" },
    });
    expect(options.persistOrThrow).toHaveBeenCalledWith("run-acp-observer");
    expect(taskRuntimeMocks.createQueuedTaskRun).not.toHaveBeenCalled();
    expect(taskRuntimeMocks.createRunningTaskRun).not.toHaveBeenCalled();
  });
});
