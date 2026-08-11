import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./subagents/registry/subagent-registry.mocks.shared.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { callGateway } from "../gateway/call.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagents/registry/subagent-lifecycle-events.js";
import { persistSubagentSessionTiming } from "./subagents/registry/subagent-registry-helpers.js";
import {
  createCanonicalSubagentRunFixture,
  createSubagentRegistryTestDeps,
  readSubagentSessionStore,
  writeSubagentSessionEntry,
} from "./subagents/registry/subagent-registry.persistence.test-support.js";
import { saveSubagentRegistryToSqlite } from "./subagents/registry/subagent-registry.store.sqlite.js";
import {
  registerSubagentRun,
  resetSubagentRegistryForTests,
  testing,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagents/registry/subagent-registry.types.js";

const { announceSpy } = vi.hoisted(() => ({
  announceSpy: vi.fn(async () => "delivered" as const),
}));
vi.mock("./subagents/announce/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));

describe("subagent registry persistence timing", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;

  const writeChildSessionEntry = async (params: {
    sessionKey: string;
    sessionId?: string;
    updatedAt?: number;
  }) => {
    if (!tempStateDir) {
      throw new Error("tempStateDir not initialized");
    }
    return await writeSubagentSessionEntry({
      stateDir: tempStateDir,
      agentId: "main",
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      updatedAt: params.updatedAt,
      defaultSessionId: `sess-main-${Date.now()}`,
    });
  };

  const waitForRegistryWork = async (predicate: () => boolean | Promise<boolean>) =>
    await vi.waitFor(async () => expect(await predicate()).toBe(true), {
      interval: 1,
      timeout: 5_000,
    });

  beforeEach(() => {
    announceSpy.mockReset();
    announceSpy.mockResolvedValue("delivered");
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      persistSubagentRunsToDisk: (runs: Map<string, SubagentRunRecord>) =>
        saveSubagentRegistryToSqlite(runs),
      runSubagentAnnounceFlow: announceSpy,
    });
    vi.mocked(callGateway).mockReset();
    vi.mocked(callGateway).mockResolvedValue({
      status: "ok",
      startedAt: 111,
      endedAt: 222,
    });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    testing.setDepsForTest();
    resetSubagentRegistryForTests({ persist: false });
    await cleanupSessionStateForTest();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
    envSnapshot.restore();
  });

  it("persists completed subagent timing into the child session entry", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);

    const now = Date.now();
    const startedAt = now;
    const endedAt = now + 500;

    const storePath = await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:timing",
      sessionId: "sess-timing",
      updatedAt: startedAt - 1,
    });
    await persistSubagentSessionTiming(
      createCanonicalSubagentRunFixture({
        runId: "run-session-timing",
        childSessionKey: "agent:main:subagent:timing",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "persist timing",
        cleanup: "keep",
        createdAt: startedAt,
        startedAt,
        sessionStartedAt: startedAt,
        accumulatedRuntimeMs: 0,
        endedAt,
        outcome: { status: "ok" },
      }),
    );

    const store = await readSubagentSessionStore(storePath);
    const persisted = store["agent:main:subagent:timing"];
    expect(persisted?.endedAt).toBe(endedAt);
    expect(persisted?.runtimeMs).toBe(500);
    expect(persisted?.status).toBe("done");
    expect(persisted?.startedAt).toBeGreaterThanOrEqual(startedAt);
    expect(persisted?.startedAt).toBeLessThanOrEqual(endedAt);
  });

  it("persists completed subagent timing through the lifecycle (registerSubagentRun → callGateway → persist)", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
    const now = Date.now();
    const startedAt = now;
    const endedAt = now + 500;
    vi.mocked(callGateway).mockResolvedValueOnce({
      status: "ok",
      startedAt,
      endedAt,
    });
    const storePath = await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:timing",
      sessionId: "sess-timing",
      updatedAt: startedAt - 1,
    });
    registerSubagentRun({
      runId: "run-session-timing",
      childSessionKey: "agent:main:subagent:timing",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persist timing",
      cleanup: "keep",
    });
    // registerSubagentRun stamps startedAt from the real clock, so bound the
    // upper edge by an observed timestamp rather than the mocked endedAt --
    // a loaded runner can take longer than the synthetic 500ms window.
    const registeredBy = Date.now();
    await waitForRegistryWork(async () => {
      const store = await readSubagentSessionStore(storePath);
      return store["agent:main:subagent:timing"]?.endedAt === endedAt;
    });
    const store = await readSubagentSessionStore(storePath);
    const persisted = store["agent:main:subagent:timing"];
    expect(persisted?.endedAt).toBe(endedAt);
    expect(persisted?.runtimeMs).toBe(500);
    expect(persisted?.status).toBe("done");
    expect(persisted?.startedAt).toBeGreaterThanOrEqual(startedAt);
    expect(persisted?.startedAt).toBeLessThanOrEqual(registeredBy);
  });

  it("rejects a stale timing write after session ownership changes", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);

    const startedAt = Date.now();
    const storePath = await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:stale-timing",
      sessionId: "sess-stale-timing",
      updatedAt: startedAt - 1,
    });
    await persistSubagentSessionTiming(
      createCanonicalSubagentRunFixture({
        runId: "run-stale-timing",
        childSessionKey: "agent:main:subagent:stale-timing",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "do not persist stale timing",
        cleanup: "keep",
        createdAt: startedAt,
        startedAt,
        endedAt: startedAt + 500,
        outcome: { status: "ok" },
      }),
      { isCurrentGeneration: () => false },
    );

    const persisted = (await readSubagentSessionStore(storePath))[
      "agent:main:subagent:stale-timing"
    ];
    expect(persisted).toMatchObject({
      sessionId: "sess-stale-timing",
      updatedAt: startedAt - 1,
    });
    expect(persisted?.startedAt).toBeUndefined();
    expect(persisted?.endedAt).toBeUndefined();
    expect(persisted?.status).toBeUndefined();
  });

  it("does not overwrite durable completion with a provisional killed status", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);

    const startedAt = Date.now();
    const completedAt = startedAt + 500;
    const storePath = await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:kill-race",
      sessionId: "sess-kill-race",
      updatedAt: completedAt,
    });
    const store = await readSubagentSessionStore(storePath);
    await replaceSessionEntry({ storePath, sessionKey: "agent:main:subagent:kill-race" }, {
      ...store["agent:main:subagent:kill-race"],
      status: "done",
      startedAt,
      endedAt: completedAt,
      runtimeMs: 500,
      abortedLastRun: true,
    } as SessionEntry);

    await persistSubagentSessionTiming(
      createCanonicalSubagentRunFixture({
        runId: "run-kill-race",
        childSessionKey: "agent:main:subagent:kill-race",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "preserve completion",
        cleanup: "keep",
        createdAt: startedAt,
        startedAt,
        endedAt: completedAt + 1,
        endedReason: SUBAGENT_ENDED_REASON_KILLED,
        outcome: { status: "error", error: "manual kill" },
      }),
    );

    const persisted = (await readSubagentSessionStore(storePath))["agent:main:subagent:kill-race"];
    expect(persisted).toMatchObject({
      status: "done",
      startedAt,
      endedAt: completedAt,
      runtimeMs: 500,
    });
    expect(persisted?.abortedLastRun).toBeUndefined();
  });
});
