import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const noop = () => {};
const waitForFast = <T>(callback: () => T | Promise<T>) =>
  vi.waitFor(callback, { timeout: 1_000, interval: 1 });

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  onAgentEvent: vi.fn(() => noop),
  loadConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
    session: { mainKey: "main", scope: "per-sender" as const },
  })),
  loadSessionStore: vi.fn(() => ({})),
  resolveAgentIdFromSessionKey: vi.fn((sessionKey: string) => {
    return sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main";
  }),
  resolveStorePath: vi.fn(() => "/tmp/test-session-store.json"),
  updateSessionStore: vi.fn(),
  emitSessionLifecycleEvent: vi.fn(),
  persistSubagentRunsToDisk: vi.fn(),
  restoreSubagentRunsFromDisk: vi.fn(() => 0),
  getSubagentRunsSnapshotForRead: vi.fn(
    (runs: Map<string, import("./subagent-registry.types.js").SubagentRunRecord>) => new Map(runs),
  ),
  resetAnnounceQueuesForTests: vi.fn(),
  captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
  runSubagentAnnounceFlow: vi.fn(async () => true),
  getGlobalHookRunner: vi.fn(() => null),
  ensureRuntimePluginsLoaded: vi.fn(),
  ensureContextEnginesInitialized: vi.fn(),
  resolveContextEngine: vi.fn(),
  onSubagentEnded: vi.fn(async () => {}),
  runSubagentEnded: vi.fn(async () => {}),
  resolveAgentTimeoutMs: vi.fn(() => 1_000),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: mocks.onAgentEvent,
}));

vi.mock("../config/config.js", () => {
  return {
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  resolveAgentIdFromSessionKey: mocks.resolveAgentIdFromSessionKey,
  resolveStorePath: mocks.resolveStorePath,
  updateSessionStore: mocks.updateSessionStore,
}));

vi.mock("../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: mocks.emitSessionLifecycleEvent,
}));

vi.mock("./subagent-registry-state.js", () => ({
  getSubagentRunsSnapshotForRead: mocks.getSubagentRunsSnapshotForRead,
  persistSubagentRunsToDisk: mocks.persistSubagentRunsToDisk,
  restoreSubagentRunsFromDisk: mocks.restoreSubagentRunsFromDisk,
}));

vi.mock("./subagent-announce-queue.js", () => ({
  resetAnnounceQueuesForTests: mocks.resetAnnounceQueuesForTests,
}));

vi.mock("./subagent-announce.js", () => ({
  captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
  runSubagentAnnounceFlow: mocks.runSubagentAnnounceFlow,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: mocks.getGlobalHookRunner,
}));

vi.mock("./runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded: mocks.ensureRuntimePluginsLoaded,
}));

vi.mock("../context-engine/init.js", () => ({
  ensureContextEnginesInitialized: mocks.ensureContextEnginesInitialized,
}));

vi.mock("../context-engine/registry.js", () => ({
  resolveContextEngine: mocks.resolveContextEngine,
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: mocks.resolveAgentTimeoutMs,
}));

describe("subagent registry seam flow", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));
    mocks.onAgentEvent.mockReturnValue(noop);
    mocks.loadConfig.mockReturnValue({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" as const },
    });
    mocks.resolveAgentIdFromSessionKey.mockImplementation((sessionKey: string) => {
      return sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main";
    });
    mocks.resolveStorePath.mockReturnValue("/tmp/test-session-store.json");
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 1,
      },
    });
    mocks.getGlobalHookRunner.mockReturnValue(null);
    mocks.resolveContextEngine.mockResolvedValue({
      onSubagentEnded: mocks.onSubagentEnded,
    });
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return {
          status: "ok",
          startedAt: 111,
          endedAt: 222,
        };
      }
      return {};
    });
    mod.__testing.setDepsForTest({
      callGateway: mocks.callGateway,
      captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
      cleanupBrowserSessionsForLifecycleEnd: async () => {},
      onAgentEvent: mocks.onAgentEvent,
      persistSubagentRunsToDisk: mocks.persistSubagentRunsToDisk,
      resolveAgentTimeoutMs: mocks.resolveAgentTimeoutMs,
      restoreSubagentRunsFromDisk: mocks.restoreSubagentRunsFromDisk,
      runSubagentAnnounceFlow: mocks.runSubagentAnnounceFlow,
      ensureContextEnginesInitialized: mocks.ensureContextEnginesInitialized,
      ensureRuntimePluginsLoaded: mocks.ensureRuntimePluginsLoaded,
      resolveContextEngine: mocks.resolveContextEngine,
    });
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    mod.__testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
  });

  it("completes a registered run across timing persistence, lifecycle status, and announce cleanup", async () => {
    mod.registerSubagentRun({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: " discord ", accountId: " acct-1 " },
      requesterDisplayKey: "main",
      task: "finish the task",
      cleanup: "delete",
    });

    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });

    expect(mocks.emitSessionLifecycleEvent).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:child",
      reason: "subagent-status",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionKey: "agent:main:subagent:child",
        childRunId: "run-1",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: { channel: "discord", accountId: "acct-1" },
        task: "finish the task",
        cleanup: "delete",
        roundOneReply: "final completion reply",
        outcome: {
          status: "ok",
          startedAt: 111,
          endedAt: 222,
          elapsedMs: 111,
        },
      }),
    );

    expect(mocks.updateSessionStore).toHaveBeenCalledTimes(1);
    expect(mocks.updateSessionStore).toHaveBeenCalledWith(
      "/tmp/test-session-store.json",
      expect.any(Function),
    );

    const updateStore = mocks.updateSessionStore.mock.calls[0]?.[1] as
      | ((store: Record<string, Record<string, unknown>>) => void)
      | undefined;
    expect(updateStore).toBeTypeOf("function");
    const store = {
      "agent:main:subagent:child": {
        sessionId: "sess-child",
      },
    };
    updateStore?.(store);
    expect(store["agent:main:subagent:child"]).toMatchObject({
      startedAt: Date.parse("2026-03-24T12:00:00Z"),
      endedAt: 222,
      runtimeMs: 111,
      status: "done",
    });

    expect(mocks.persistSubagentRunsToDisk).toHaveBeenCalled();
  });

  it("deletes delete-mode completion runs when announce cleanup gives up after retry limit", async () => {
    mocks.runSubagentAnnounceFlow.mockResolvedValue(false);
    const endedAt = Date.parse("2026-03-24T12:00:00Z");
    mocks.callGateway.mockResolvedValueOnce({
      status: "ok",
      startedAt: endedAt - 500,
      endedAt,
    });

    mod.registerSubagentRun({
      runId: "run-delete-give-up",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "completion cleanup retry",
      cleanup: "delete",
      expectsCompletionMessage: true,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-delete-give-up"),
    ).toBeDefined();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(3);
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-delete-give-up"),
    ).toBeUndefined();
  });

  it("finalizes retry-budgeted completion delete runs during resume", async () => {
    const endedHookRunner = {
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    };
    mocks.getGlobalHookRunner.mockReturnValue(endedHookRunner as never);
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
      mergeOnly?: boolean;
    }) => {
      params.runs.set("run-resume-delete", {
        runId: "run-resume-delete",
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "resume delete retry budget",
        cleanup: "delete",
        createdAt: Date.parse("2026-03-24T11:58:00Z"),
        startedAt: Date.parse("2026-03-24T11:59:00Z"),
        endedAt: Date.parse("2026-03-24T11:59:30Z"),
        expectsCompletionMessage: true,
        announceRetryCount: 3,
        lastAnnounceRetryAt: Date.parse("2026-03-24T11:59:40Z"),
      });
      return 1;
    }) as never);

    mod.initSubagentRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    await waitForFast(() => {
      expect(mocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    });
    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:child",
        reason: "deleted",
        workspaceDir: undefined,
      });
    });
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-resume-delete"),
    ).toBeUndefined();
  });

  it("finalizes expired delete-mode parents when descendant cleanup retriggers deferred announce handling", async () => {
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:parent": {
        sessionId: "sess-parent",
        updatedAt: 1,
      },
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 1,
      },
    });

    mod.addSubagentRunForTests({
      runId: "run-parent-expired",
      childSessionKey: "agent:main:subagent:parent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "expired parent cleanup",
      cleanup: "delete",
      createdAt: Date.parse("2026-03-24T11:50:00Z"),
      startedAt: Date.parse("2026-03-24T11:50:30Z"),
      endedAt: Date.parse("2026-03-24T11:51:00Z"),
      cleanupHandled: false,
      cleanupCompletedAt: undefined,
    });

    mod.registerSubagentRun({
      runId: "run-child-finished",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "parent",
      task: "descendant settles",
      cleanup: "keep",
    });

    await waitForFast(() => {
      expect(
        mod
          .listSubagentRunsForRequester("agent:main:main")
          .find((entry) => entry.runId === "run-parent-expired"),
      ).toBeUndefined();
    });

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        childRunId: "run-child-finished",
      }),
    );
    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:parent",
        reason: "deleted",
        workspaceDir: undefined,
      });
    });
  });

  it("loads runtime plugins before emitting killed subagent ended hooks", async () => {
    const endedHookRunner = {
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    };
    mocks.getGlobalHookRunner.mockReturnValue(null);
    mocks.ensureRuntimePluginsLoaded.mockImplementation(() => {
      mocks.getGlobalHookRunner.mockReturnValue(endedHookRunner as never);
    });

    mod.registerSubagentRun({
      runId: "run-killed-init",
      childSessionKey: "agent:main:subagent:killed",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", accountId: "acct-1" },
      task: "kill after init",
      cleanup: "keep",
      workspaceDir: "/tmp/killed-workspace",
    });

    const updated = mod.markSubagentRunTerminated({
      runId: "run-killed-init",
      reason: "manual kill",
    });

    expect(updated).toBe(1);
    const killedRun = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-killed-init");
    const killedAt = Date.parse("2026-03-24T12:00:00Z");
    expect(killedRun?.outcome).toEqual({
      status: "error",
      error: "manual kill",
      startedAt: killedAt,
      endedAt: killedAt,
      elapsedMs: 0,
    });
    await waitForFast(() => {
      expect(mocks.ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
        config: {
          agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
          session: { mainKey: "main", scope: "per-sender" },
        },
        workspaceDir: "/tmp/killed-workspace",
        allowGatewaySubagentBinding: true,
      });
    });
    expect(mocks.runSubagentEnded).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKey: "agent:main:subagent:killed",
        reason: "subagent-killed",
        accountId: "acct-1",
        runId: "run-killed-init",
        outcome: "killed",
        error: "manual kill",
      }),
      expect.objectContaining({
        runId: "run-killed-init",
        childSessionKey: "agent:main:subagent:killed",
        requesterSessionKey: "agent:main:main",
      }),
    );
  });

  it("deletes killed delete-mode runs and notifies deleted cleanup", async () => {
    mod.registerSubagentRun({
      runId: "run-killed-delete",
      childSessionKey: "agent:main:subagent:killed-delete",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "kill and delete",
      cleanup: "delete",
      workspaceDir: "/tmp/killed-delete-workspace",
    });

    const updated = mod.markSubagentRunTerminated({
      runId: "run-killed-delete",
      reason: "manual kill",
    });

    expect(updated).toBe(1);
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-killed-delete"),
    ).toBeUndefined();
    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:killed-delete",
        reason: "deleted",
        workspaceDir: "/tmp/killed-delete-workspace",
      });
    });
  });

  it("removes attachments for killed delete-mode runs", async () => {
    const attachmentsRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-kill-attachments-"),
    );
    const attachmentsDir = path.join(attachmentsRootDir, "child");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact");

    mod.registerSubagentRun({
      runId: "run-killed-delete-attachments",
      childSessionKey: "agent:main:subagent:killed-delete-attachments",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "kill and delete attachments",
      cleanup: "delete",
      attachmentsDir,
      attachmentsRootDir,
    });

    const updated = mod.markSubagentRunTerminated({
      runId: "run-killed-delete-attachments",
      reason: "manual kill",
    });

    expect(updated).toBe(1);
    await waitForFast(async () => {
      await expect(fs.access(attachmentsDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("removes attachments for released delete-mode runs", async () => {
    const attachmentsRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-release-attachments-"),
    );
    const attachmentsDir = path.join(attachmentsRootDir, "child");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact");

    mod.addSubagentRunForTests({
      runId: "run-release-delete",
      childSessionKey: "agent:main:subagent:release-delete",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: undefined,
      requesterDisplayKey: "main",
      task: "release attachments",
      cleanup: "delete",
      expectsCompletionMessage: undefined,
      spawnMode: "run",
      attachmentsDir,
      attachmentsRootDir,
      createdAt: 1,
      startedAt: 1,
      sessionStartedAt: 1,
      accumulatedRuntimeMs: 0,
      cleanupHandled: false,
    });

    mod.releaseSubagentRun("run-release-delete");

    await waitForFast(async () => {
      await expect(fs.access(attachmentsDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:release-delete",
        reason: "released",
        workspaceDir: undefined,
      });
    });
  });

  it("loads plugin and context-engine runtime before released end hooks", async () => {
    mod.addSubagentRunForTests({
      runId: "run-release-context-engine",
      childSessionKey: "agent:main:session:child",
      controllerSessionKey: "agent:main:session:parent",
      requesterSessionKey: "agent:main:session:parent",
      requesterOrigin: undefined,
      requesterDisplayKey: "parent",
      task: "task",
      cleanup: "keep",
      expectsCompletionMessage: undefined,
      spawnMode: "run",
      workspaceDir: "/tmp/workspace",
      createdAt: 1,
      startedAt: 1,
      sessionStartedAt: 1,
      accumulatedRuntimeMs: 0,
      cleanupHandled: false,
    });

    mod.releaseSubagentRun("run-release-context-engine");

    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:session:child",
        reason: "released",
        workspaceDir: "/tmp/workspace",
      });
    });
    expect(mocks.ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: {
        agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
        session: { mainKey: "main", scope: "per-sender" },
      },
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });
    expect(mocks.ensureContextEnginesInitialized).toHaveBeenCalledTimes(1);
  });
});
