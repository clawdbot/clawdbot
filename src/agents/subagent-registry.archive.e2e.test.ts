import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callGateway } from "../gateway/call.js";

const noop = () => {};
let currentConfig = {
  agents: { defaults: { subagents: { archiveAfterMinutes: 60 } } },
};
const loadConfigMock = vi.fn(() => currentConfig);
const flushSweepMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (request: unknown) => {
    const method = (request as { method?: string }).method;
    if (method === "agent.wait") {
      // Keep lifecycle unsettled so register/replace assertions can inspect stored state.
      return { status: "pending" };
    }
    return {};
  }),
}));

vi.mock("../infra/agent-events.js", () => ({
  getAgentRunContext: vi.fn(() => undefined),
  onAgentEvent: vi.fn((_handler: unknown) => noop),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: loadConfigMock,
  };
});

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(async () => true),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

describe("subagent registry archive behavior", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 60 } } },
    };
    vi.mocked(callGateway).mockReset();
    vi.mocked(callGateway).mockImplementation(async (request: unknown) => {
      const method = (request as { method?: string }).method;
      if (method === "agent.wait") {
        // Keep lifecycle unsettled so register/replace assertions can inspect stored state.
        return { status: "pending" };
      }
      return {};
    });
    loadConfigMock.mockClear();
    mod.__testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    mod.__testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
  });

  it("does not set archiveAtMs for keep-mode run subagents", () => {
    mod.registerSubagentRun({
      runId: "run-keep-1",
      childSessionKey: "agent:main:subagent:keep-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persistent-run",
      cleanup: "keep",
    });

    const run = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(run?.runId).toBe("run-keep-1");
    expect(run?.spawnMode).toBe("run");
    expect(run?.archiveAtMs).toBeUndefined();
  });

  it("sets archiveAtMs and sweeps delete-mode run subagents", async () => {
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
    };

    mod.registerSubagentRun({
      runId: "run-delete-1",
      childSessionKey: "agent:main:subagent:delete-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "ephemeral-run",
      cleanup: "delete",
    });

    const initialRun = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(initialRun?.archiveAtMs).toBe(Date.now() + 60_000);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });

  it("keeps archived delete-mode runs for retry when sessions.delete fails", async () => {
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
    };
    const onSubagentEnded = vi.fn(async () => undefined);
    const attachmentsRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sweep-retry-"));
    const attachmentsDir = path.join(attachmentsRootDir, "child");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact", "utf8");
    let deleteAttempts = 0;
    vi.mocked(callGateway).mockImplementation(async (request: unknown) => {
      const method = (request as { method?: string }).method;
      if (method === "agent.wait") {
        return { status: "pending" };
      }
      if (method === "sessions.delete") {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          throw new Error("delete failed");
        }
      }
      return {};
    });
    mod.__testing.setDepsForTest({
      ensureContextEnginesInitialized: vi.fn(),
      ensureRuntimePluginsLoaded: vi.fn(),
      resolveContextEngine: vi.fn(async () => ({ onSubagentEnded }) as never),
    });

    mod.addSubagentRunForTests({
      runId: "run-delete-retry",
      childSessionKey: "agent:main:subagent:delete-retry",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "retry delete",
      cleanup: "delete",
      createdAt: Date.now() - 60_000,
      endedAt: Date.now() - 1,
      archiveAtMs: Date.now(),
      attachmentsDir,
      attachmentsRootDir,
    });

    await mod.__testing.sweepOnceForTests();
    await flushSweepMicrotasks();

    expect(deleteAttempts).toBe(1);
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(1);
    expect(onSubagentEnded).not.toHaveBeenCalled();
    await expect(fs.access(attachmentsDir)).resolves.toBeUndefined();

    await mod.__testing.sweepOnceForTests();
    await flushSweepMicrotasks();

    expect(deleteAttempts).toBe(2);
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });

  it("does not overlap archive sweep retries while sessions.delete is still in flight", async () => {
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
    };
    let resolveDelete: (() => void) | undefined;
    const deletePromise = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    vi.mocked(callGateway).mockImplementation(async (request: unknown) => {
      const method = (request as { method?: string }).method;
      if (method === "agent.wait") {
        return { status: "pending" };
      }
      if (method === "sessions.delete") {
        await deletePromise;
      }
      return {};
    });

    mod.addSubagentRunForTests({
      runId: "run-delete-inflight",
      childSessionKey: "agent:main:subagent:delete-inflight",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "inflight delete",
      cleanup: "delete",
      createdAt: Date.now() - 60_000,
      endedAt: Date.now() - 1,
      archiveAtMs: Date.now(),
    });

    const firstSweep = mod.__testing.sweepOnceForTests();
    await flushSweepMicrotasks();
    expect(
      vi
        .mocked(callGateway)
        .mock.calls.filter(
          ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
        ),
    ).toHaveLength(1);

    await mod.__testing.sweepOnceForTests();
    expect(
      vi
        .mocked(callGateway)
        .mock.calls.filter(
          ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
        ),
    ).toHaveLength(1);
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(1);

    if (!resolveDelete) {
      throw new Error("expected delete resolver");
    }
    resolveDelete();
    await firstSweep;
    await flushSweepMicrotasks();
    await vi.waitFor(() => {
      expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
    });
  });

  it("does not set archiveAtMs for persistent session-mode runs", () => {
    mod.registerSubagentRun({
      runId: "run-session-1",
      childSessionKey: "agent:main:subagent:session-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persistent-session",
      cleanup: "keep",
      spawnMode: "session",
    });

    const run = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(run?.runId).toBe("run-session-1");
    expect(run?.spawnMode).toBe("session");
    expect(run?.archiveAtMs).toBeUndefined();
  });

  it("keeps archiveAtMs unset when replacing a keep-mode run after steer restart", () => {
    mod.registerSubagentRun({
      runId: "run-old",
      childSessionKey: "agent:main:subagent:run-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persistent-run",
      cleanup: "keep",
    });

    const replaced = mod.replaceSubagentRunAfterSteer({
      previousRunId: "run-old",
      nextRunId: "run-new",
    });

    expect(replaced).toBe(true);
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-new");
    expect(run?.spawnMode).toBe("run");
    expect(run?.archiveAtMs).toBeUndefined();
  });

  it("recomputes archiveAtMs when replacing a delete-mode run after steer restart", async () => {
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
    };

    mod.registerSubagentRun({
      runId: "run-delete-old",
      childSessionKey: "agent:main:subagent:delete-old",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "ephemeral-run",
      cleanup: "delete",
    });

    await vi.advanceTimersByTimeAsync(5_000);

    const replaced = mod.replaceSubagentRunAfterSteer({
      previousRunId: "run-delete-old",
      nextRunId: "run-delete-new",
    });

    expect(replaced).toBe(true);
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-delete-new");
    expect(run?.archiveAtMs).toBe(Date.now() + 60_000);
  });

  it("removes attachments for the replaced run after steer restart", async () => {
    const attachmentsRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-replace-attachments-"),
    );
    const attachmentsDir = path.join(attachmentsRootDir, "old");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact", "utf8");

    mod.registerSubagentRun({
      runId: "run-delete-attachments-old",
      childSessionKey: "agent:main:subagent:delete-attachments-old",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "replace attachments",
      cleanup: "delete",
      attachmentsRootDir,
      attachmentsDir,
    });

    const replaced = mod.replaceSubagentRunAfterSteer({
      previousRunId: "run-delete-attachments-old",
      nextRunId: "run-delete-attachments-new",
    });

    expect(replaced).toBe(true);
    await vi.waitFor(async () => {
      await expect(fs.access(attachmentsDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("treats archiveAfterMinutes=0 as never archive", () => {
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
    };

    mod.registerSubagentRun({
      runId: "run-no-archive",
      childSessionKey: "agent:main:subagent:no-archive",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "never archive",
      cleanup: "delete",
    });

    const run = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(run?.archiveAtMs).toBeUndefined();
  });
});
