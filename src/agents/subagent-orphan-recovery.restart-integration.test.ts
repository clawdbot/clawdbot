// Faithful restart-path integration proof for stale-aborted subagent orphan
// recovery. Unlike subagent-orphan-recovery.test.ts (which stubs the session
// store and finalize), this drives the REAL recovery pass against the REAL
// subagent registry, the REAL liveness policy, and a REAL on-disk session
// store. Only the outbound gateway transport and the transcript file reader are
// mocked, because they are the genuine process boundaries a single-process test
// cannot stand up. It exists to prove that finalize actually ends the real
// registry run (not a stubbed counter) and that the fresh run still resumes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { createRunningTaskRun } from "../tasks/detached-task-runtime.js";
import { findTaskByRunId } from "../tasks/task-registry.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-runtime.test-helpers.js";
import { captureEnv } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { recoverOrphanedSubagentSessions } from "./subagent-orphan-recovery.js";
import {
  createSubagentRegistryTestDeps,
  readSubagentSessionStore,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  finalizeInterruptedSubagentRun,
  getSubagentRunByChildSessionKey,
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "resumed-run-id" })),
}));

vi.mock("../gateway/session-utils.fs.js", () => ({
  readSessionMessagesAsync: vi.fn(async () => []),
}));

const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;

function makeRunRecord(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  return {
    runId: "run",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "restart-recoverable work",
    cleanup: "keep",
    createdAt: Date.now(),
    startedAt: Date.now(),
    ...overrides,
  } as SubagentRunRecord;
}

describe("subagent orphan recovery — faithful restart path", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;

  beforeEach(async () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-orphan-integ-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    setRuntimeConfigSnapshot({ session: { store: undefined } } as never);
    // Real registry wiring: only the delivery/announce/cleanup seams (true
    // external side effects) are recorded so completeSubagentRun runs in-process.
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      runSubagentAnnounceFlow: vi.fn(async () => true),
      onAgentEvent: vi.fn(() => () => undefined),
    });
    vi.mocked(callGateway).mockClear();
    vi.mocked(callGateway).mockResolvedValue({ runId: "resumed-run-id" } as never);
  });

  afterEach(async () => {
    testing.setDepsForTest();
    resetSubagentRegistryForTests({ persist: false });
    await cleanupSessionStateForTest();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
    envSnapshot.restore();
  });

  it("finalizes a stale (>2h) aborted run instead of resuming it", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:stale-aborted";
    const runId = "run-stale-aborted";
    const storePath = await writeSubagentSessionEntry({
      stateDir: tempStateDir!,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-stale-aborted",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-stale-aborted",
    });
    const record = makeRunRecord({
      runId,
      childSessionKey,
      createdAt: now - 3 * TWO_HOURS_MS,
      startedAt: now - 3 * TWO_HOURS_MS,
    });
    expect(
      createRunningTaskRun({
        runtime: "subagent",
        sourceId: runId,
        ownerKey: record.requesterSessionKey,
        scopeKind: "session",
        childSessionKey,
        runId,
        task: record.task,
        deliveryStatus: "pending",
        startedAt: record.startedAt,
        lastEventAt: record.startedAt,
      }),
    ).not.toBeNull();
    addSubagentRunForTests(record);

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => new Map([[runId, record]]),
    });

    const after = getSubagentRunByChildSessionKey(childSessionKey);
    expect(vi.mocked(callGateway)).not.toHaveBeenCalled();
    expect(after?.endedAt).toBeTypeOf("number");
    expect(after?.outcome?.status).toBe("error");
    expect(result.recovered).toBe(0);
    expect(findTaskByRunId(runId)).toMatchObject({
      status: "failed",
      endedAt: expect.any(Number),
      error: expect.stringContaining("stale aborted subagent run not resumed"),
    });

    resetTaskRegistryForTests({ persist: false });
    expect(findTaskByRunId(runId)).toMatchObject({ status: "failed" });
    await cleanupSessionStateForTest();
    const persistedSession = (await readSubagentSessionStore(storePath))[childSessionKey];
    expect(persistedSession).toMatchObject({
      status: "failed",
      endedAt: expect.any(Number),
    });
    expect(persistedSession?.abortedLastRun).toBeUndefined();
  });

  it("resumes a fresh (<2h) aborted run through the real recovery pass", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:fresh-aborted";
    const runId = "run-fresh-aborted";
    await writeSubagentSessionEntry({
      stateDir: tempStateDir!,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-fresh-aborted",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-fresh-aborted",
    });
    const record = makeRunRecord({
      runId,
      childSessionKey,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
    });
    addSubagentRunForTests(record);

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => new Map([[runId, record]]),
    });

    console.log(
      `[proof] fresh recovery: result=${JSON.stringify(result)} gatewayCalls=${
        vi.mocked(callGateway).mock.calls.length
      }`,
    );

    // Fresh aborted run passed the stale gate and reached a real resume call.
    const agentCalls = vi
      .mocked(callGateway)
      .mock.calls.filter((args) => (args[0] as { method?: string })?.method === "agent");
    expect(agentCalls).toHaveLength(1);
    expect(result.recovered).toBe(1);
  });

  it("finalizes only a stale predecessor when a fresh generation shares its child session", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:shared-generation";
    const staleRecord = makeRunRecord({
      runId: "run-stale-generation",
      childSessionKey,
      generation: 1,
      createdAt: now - 3 * 60 * 60 * 1_000,
      startedAt: now - 3 * 60 * 60 * 1_000,
      sessionStartedAt: now - 3 * 60 * 60 * 1_000,
    });
    const freshRecord = makeRunRecord({
      runId: "run-fresh-generation",
      childSessionKey,
      generation: 2,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
      sessionStartedAt: now - 60_000,
    });
    for (const record of [staleRecord, freshRecord]) {
      expect(
        createRunningTaskRun({
          runtime: "subagent",
          sourceId: record.runId,
          ownerKey: record.requesterSessionKey,
          scopeKind: "session",
          childSessionKey,
          runId: record.runId,
          task: record.task,
          deliveryStatus: "pending",
          startedAt: record.startedAt,
          lastEventAt: record.startedAt,
        }),
      ).not.toBeNull();
    }
    addSubagentRunForTests(staleRecord);
    addSubagentRunForTests(freshRecord);

    const updated = await finalizeInterruptedSubagentRun({
      runId: staleRecord.runId,
      error: "stale predecessor interrupted by restart",
      endedAt: now,
    });

    const runs = listSubagentRunsForRequester("agent:main:main");
    expect(updated).toBe(1);
    expect(callGateway).not.toHaveBeenCalled();
    expect(runs.some((entry) => entry.runId === staleRecord.runId)).toBe(false);
    expect(runs).toContainEqual(expect.objectContaining({ runId: freshRecord.runId }));
    expect(runs.find((entry) => entry.runId === freshRecord.runId)?.endedAt).toBeUndefined();
    expect(findTaskByRunId(staleRecord.runId)).toMatchObject({ status: "failed" });
    expect(findTaskByRunId(freshRecord.runId)).toMatchObject({ status: "running" });
  });
});
