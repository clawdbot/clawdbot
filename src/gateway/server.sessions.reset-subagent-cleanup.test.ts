import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { listRegisteredAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import { subagentRegistryDeps } from "../agents/subagents/registry/subagent-registry-deps.js";
import * as completionOwner from "../agents/subagents/registry/subagent-registry-lifecycle-completion.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { onSubagentRegistryPersisted } from "../agents/subagents/registry/subagent-registry-state.js";
import {
  cleanupSubagentRegistryPersistenceTest,
  settleSubagentRegistryPersistenceWork,
} from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  registerSubagentRun,
  claimSubagentRunKill,
  initSubagentRegistry,
  settleFailedQueuedSubagentLaunch,
  resetSubagentRegistryForTests,
  testing,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { waitForCollectorCompletion } from "../agents/tools/agents-wait-tool.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.test-support.js";
import { findTaskByRunIdForStatus } from "../tasks/task-status-access.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { sessionDeleteHandlers } from "./server-methods/sessions-delete.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import { performGatewaySessionReset } from "./session-reset-service.js";

let stateDir: string;
let cfg: OpenClawConfig;
const env = captureEnv(["OPENCLAW_STATE_DIR"]);
const key = "agent:main:subagent:reset-cleanup";
const runId = "reset-cleanup-run";
let attempts = 0;
let harnesses: ReturnType<typeof listRegisteredAgentHarnesses>;

async function request(
  method: "sessions.reset" | "sessions.delete",
  params: Record<string, unknown>,
) {
  const handler = expectDefined(
    (method === "sessions.reset" ? sessionMutationHandlers : sessionDeleteHandlers)[method],
    "session handler",
  );
  let result: unknown;
  await handler({
    req: { type: "req", id: method, method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
    respond: (ok, payload, error) => {
      if (!ok) {
        throw new Error(error?.message ?? "request failed");
      }
      result = payload;
    },
  });
  return result;
}

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reset-cleanup-"));
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  cfg = { agents: { list: [{ id: "main", default: true, workspace: stateDir }] } };
  setRuntimeConfigSnapshot(cfg);
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  attempts = 0;
  harnesses = listRegisteredAgentHarnesses();
  testing.setDepsForTest({
    callGateway: async <T>(options: { method: string; params?: unknown }) => {
      expect(options.method).toBe("sessions.delete");
      if (++attempts === 1) {
        throw new Error("first delete transport unavailable");
      }
      return (await request("sessions.delete", options.params as Record<string, unknown>)) as T;
    },
  });
  replaceSessionEntrySync(
    { sessionKey: key, agentId: "main" },
    {
      sessionId: "reset-cleanup-session",
      lifecycleRevision: "original",
      updatedAt: Date.now(),
    },
  );
  registerCollector(runId);
  expect(findTaskByRunIdForStatus(runId)?.status).toBe("queued");
  expect(settleFailedQueuedSubagentLaunch(runId, "launch failed")).toBe(true);
  expect(findTaskByRunIdForStatus(runId)?.status).toBe("failed");
  await testing.sweepOnceForTests();
  expect(attempts).toBe(1);
  expect(loadSubagentRegistryFromSqlite().get(runId)?.collectorLaunchCleanupPending).toBe(true);
  expect(loadSessionEntry({ sessionKey: key })?.lifecycleRevision).toBe("original");
});

function registerCollector(id: string, childSessionKey = key, agentId = "main") {
  registerSubagentRun({
    runId: id,
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    agentId,
    requesterDisplayKey: "main",
    task: "failed collector launch",
    cleanup: "delete",
    collect: true,
    groupId: "reset-cleanup-group",
    swarmRequesterSessionKey: "agent:main:main",
    queued: true,
    expectsCompletionMessage: false,
    taskRowOwnership: "required",
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  restoreRegisteredAgentHarnesses(harnesses);
  await cleanupSubagentRegistryPersistenceTest({
    stateDir,
    resetRegistry: () => resetSubagentRegistryForTests({ persist: false }),
    resetDeps: () => testing.setDepsForTest(),
    closeDatabases: () => {
      resetTaskRegistryForTests({ persist: false });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
    },
  });
  clearRuntimeConfigSnapshot();
  env.restore();
});

test.each(["unchanged", "reset", "reset-reopen", "reopen-reset-reopen"])(
  "collector cleanup retry: %s",
  async (mode) => {
    const reset = mode !== "unchanged";
    if (mode === "reopen-reset-reopen") {
      reopen();
    }
    if (reset) {
      await request("sessions.reset", { key });
      expect(loadSessionEntry({ sessionKey: key })?.lifecycleRevision).not.toBe("original");
    }
    const beforeRetry = loadSessionEntry({ sessionKey: key });
    if (mode.endsWith("reopen")) {
      reopen();
    }
    await testing.sweepOnceForTests();
    expect(loadSessionEntry({ sessionKey: key })).toEqual(reset ? beforeRetry : undefined);
    expect(attempts).toBe(reset ? 1 : 2);
    await expectResultRetained();
  },
);

function reopen() {
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  initSubagentRegistry();
}

async function expectResultRetained() {
  expect(loadSubagentRegistryFromSqlite().get(runId)?.collectorLaunchCleanupPending).toBe(false);
  await expect(
    waitForCollectorCompletion({
      runId,
      currentSessionKeys: new Set(["agent:main:main"]),
      currentAgentId: "main",
      config: cfg,
    }),
  ).resolves.toMatchObject({ runId, status: "failed", result: "launch failed" });
  expect(findTaskByRunIdForStatus(runId)).toMatchObject({
    status: "failed",
    error: "launch failed",
  });
}

function agentDatabase() {
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
  return openOpenClawAgentDatabase({
    agentId: "main",
    path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
  });
}

test("a real registry write failure blocks reset publication and leaves cleanup retryable", async () => {
  const database = openOpenClawStateDatabase();
  database.db.exec(`CREATE TEMP TRIGGER reject_revocation BEFORE UPDATE ON subagent_runs
    WHEN json_extract(NEW.payload_json, '$.execution.suppressSessionEffects') = 1
    BEGIN SELECT RAISE(ABORT, 'revocation write rejected'); END`);
  const before = loadSessionEntry({ sessionKey: key });
  await expect(request("sessions.reset", { key })).rejects.toThrow("revocation write rejected");
  expect(loadSessionEntry({ sessionKey: key })).toEqual(before);
  expect(subagentRuns.get(runId)?.execution.suppressSessionEffects).not.toBe(true);
  expect(loadSubagentRegistryFromSqlite().get(runId)?.execution.suppressSessionEffects).not.toBe(
    true,
  );
  database.db.exec("DROP TRIGGER reject_revocation");
  reopen();
  await testing.sweepOnceForTests();
  expect(loadSessionEntry({ sessionKey: key })).toBeUndefined();
  expect(attempts).toBe(2);
  await expectResultRetained();
});

test("durable revocation survives reset-store failure and reopen without reviving deletion", async () => {
  agentDatabase().db.exec(`CREATE TEMP TRIGGER reject_reset BEFORE UPDATE ON session_nodes
    WHEN json_extract(NEW.entry_json, '$.lifecycleRevision') != json_extract(OLD.entry_json, '$.lifecycleRevision')
    BEGIN SELECT RAISE(ABORT, 'reset store rejected'); END`);
  const before = loadSessionEntry({ sessionKey: key });
  await expect(request("sessions.reset", { key })).rejects.toThrow("reset store rejected");
  expect(loadSubagentRegistryFromSqlite().get(runId)?.execution.suppressSessionEffects).toBe(true);
  reopen();
  await testing.sweepOnceForTests();
  expect(loadSessionEntry({ sessionKey: key })).toEqual(before);
  expect(attempts).toBe(1);
  await expectResultRetained();
});

test("postcommit failure cannot restore cleanup authority after a successful reset", async () => {
  await expect(
    performGatewaySessionReset({
      key,
      reason: "reset",
      commandSource: "test",
      workerPlacementContext: {},
      onCommitted: () => {
        throw new Error("reset response lost");
      },
    }),
  ).rejects.toThrow("reset response lost");
  const successor = loadSessionEntry({ sessionKey: key });
  expect(successor?.lifecycleRevision).not.toBe("original");
  reopen();
  await testing.sweepOnceForTests();
  expect(loadSessionEntry({ sessionKey: key })).toEqual(successor);
  expect(attempts).toBe(1);
  await expectResultRetained();
});

function startCollector(id: string) {
  registerCollector(id);
  emitAgentEvent({
    runId: id,
    stream: "lifecycle",
    data: { phase: "start", startedAt: Date.now() },
  });
  expect(subagentRuns.get(id)?.execution.status).toBe("running");
}

test("same-turn reset keeps its active continuation and task unsuppressed", async () => {
  const activeId = "active-continuation";
  startCollector(activeId);
  const interrupt = vi.fn();
  const admission = await beginSessionWorkAdmission({
    scope: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    identities: [key, "reset-cleanup-session"],
    assertAllowed: () => {},
    onInterrupt: interrupt,
  });
  try {
    await admission.run(() => request("sessions.reset", { key }));
    expect(admission.isActive()).toBe(true);
    expect(interrupt).not.toHaveBeenCalled();
    expect(subagentRuns.get(activeId)?.execution).toMatchObject({ status: "running" });
    expect(
      loadSubagentRegistryFromSqlite().get(activeId)?.execution.suppressSessionEffects,
    ).not.toBe(true);
    expect(findTaskByRunIdForStatus(activeId)?.status).toBe("running");
    expect(loadSubagentRegistryFromSqlite().get(runId)?.execution.suppressSessionEffects).toBe(
      true,
    );
  } finally {
    admission.release();
  }
});

test.each(["new", "replacement"])(
  "reset preparation does not revoke a %s active owner",
  async (mode) => {
    const original = expectDefined(subagentRuns.get(runId), "registered collector");
    const activeId = mode === "replacement" ? runId : "new-active-owner";
    registerAgentHarness({
      id: "reset-cleanup-race",
      label: "Reset cleanup race",
      supports: () => ({ supported: false }),
      runAttempt: async () => {
        throw new Error("not used");
      },
      reset: async () => {
        startCollector(activeId);
      },
    });
    await request("sessions.reset", { key });
    expect(subagentRuns.get(activeId)?.execution.status).toBe("running");
    expect(
      loadSubagentRegistryFromSqlite().get(activeId)?.execution.suppressSessionEffects,
    ).not.toBe(true);
    if (mode === "replacement") {
      expect(subagentRuns.get(runId)).not.toBe(original);
      expect(original.execution.suppressSessionEffects).not.toBe(true);
    }
  },
);

test("a changed session generation skips revocation together with reset", async () => {
  registerAgentHarness({
    id: "reset-cleanup-replacement",
    label: "Reset cleanup replacement",
    supports: () => ({ supported: false }),
    runAttempt: async () => {
      throw new Error("not used");
    },
    reset: async () => {
      replaceSessionEntrySync(
        { sessionKey: key },
        {
          sessionId: "reset-cleanup-session",
          lifecycleRevision: "replacement",
          updatedAt: Date.now(),
        },
      );
    },
  });
  await request("sessions.reset", { key });
  expect(loadSessionEntry({ sessionKey: key })?.lifecycleRevision).toBe("replacement");
  expect(loadSubagentRegistryFromSqlite().get(runId)?.execution.suppressSessionEffects).not.toBe(
    true,
  );
});

test("revocation rechecks terminal owners after awaited entry planning", async () => {
  const id = "late-terminal-owner";
  registerCollector(id);
  let settled = false;
  const unsubscribe = onSubagentRegistryPersisted(() => {
    if (!settled && subagentRuns.get(runId)?.execution.suppressSessionEffects) {
      settled = true;
      queueMicrotask(() => {
        settleFailedQueuedSubagentLaunch(id, "late launch failed");
      });
    }
  });
  try {
    await request("sessions.reset", { key });
    expect(settled).toBe(true);
    expect(loadSubagentRegistryFromSqlite().get(id)?.execution.suppressSessionEffects).toBe(true);
  } finally {
    unsubscribe();
  }
});

test.each([
  { agentId: "main", incognito: false },
  { agentId: "worker", incognito: false },
  { agentId: "main", incognito: true },
  { agentId: "worker", incognito: true },
])(
  "custom-store reset revokes only its $agentId child (incognito: $incognito)",
  async ({ agentId, incognito }) => {
    cfg = {
      agents: {
        list: [
          { id: "main", default: true, workspace: stateDir },
          { id: "worker", workspace: stateDir },
        ],
      },
      session: { store: path.join(stateDir, "custom-sessions.json") },
    };
    setRuntimeConfigSnapshot(cfg);
    const childSessionKey = `agent:${agentId}:${incognito ? "incognito" : "subagent"}:scoped-cleanup`;
    const scope = {
      agentId,
      sessionKey: childSessionKey,
      storePath: expectDefined(cfg.session?.store, "custom store"),
    };
    const id = "scoped-collector";
    const siblingKey = `agent:${agentId === "main" ? "worker" : "main"}:subagent:scoped-cleanup`;
    replaceSessionEntrySync(scope, {
      sessionId: "scoped-original",
      lifecycleRevision: "scoped-original",
      updatedAt: Date.now(),
      ...(incognito ? { incognito: true } : {}),
    });
    replaceSessionEntrySync(
      { ...scope, agentId: agentId === "main" ? "worker" : "main", sessionKey: siblingKey },
      { sessionId: "sibling", lifecycleRevision: "sibling", updatedAt: Date.now() },
    );
    registerCollector(id, childSessionKey, agentId);
    expect(settleFailedQueuedSubagentLaunch(id, "scoped launch failed")).toBe(true);
    attempts = 0;
    await testing.sweepOnceForTests();
    expect(attempts).toBe(1);
    await request("sessions.reset", { key: childSessionKey, agentId });
    expect(loadSubagentRegistryFromSqlite().get(id)?.execution.suppressSessionEffects).toBe(true);
    if (incognito) {
      expect(loadSessionEntry(scope)).toBeUndefined();
      replaceSessionEntrySync(scope, {
        sessionId: "private-successor",
        lifecycleRevision: "private-successor",
        updatedAt: Date.now(),
        incognito: true,
      });
    }
    const successor = loadSessionEntry(scope);
    expect(successor?.lifecycleRevision).not.toBe("scoped-original");
    await testing.sweepOnceForTests();
    expect(loadSessionEntry(scope)).toEqual(successor);
    expect(attempts).toBe(1);
    expect(
      loadSessionEntry({
        ...scope,
        agentId: agentId === "main" ? "worker" : "main",
        sessionKey: siblingKey,
      })?.sessionId,
    ).toBe("sibling");
  },
);

test("reset cannot publish while a terminal completion owns an awaited capture", async () => {
  const completion = vi.spyOn(completionOwner, "completeSubagentRunAttempt");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const capture = subagentRegistryDeps.captureSubagentCompletionReply;
  testing.setDepsForTest({
    ...subagentRegistryDeps,
    captureSubagentCompletionReply: async (...args) => {
      entered.resolve();
      await release.promise;
      return await capture(...args);
    },
  });
  const id = "completing-owner";
  startCollector(id);
  emitAgentEvent({ runId: id, stream: "lifecycle", data: { phase: "end", endedAt: Date.now() } });
  await entered.promise;
  const original = loadSessionEntry({ sessionKey: key });
  try {
    await expect(request("sessions.reset", { key })).rejects.toThrow(/completion.*settling/i);
    expect(loadSessionEntry({ sessionKey: key })).toEqual(original);
    expect(loadSubagentRegistryFromSqlite().get(id)?.execution.suppressSessionEffects).not.toBe(
      true,
    );
  } finally {
    release.resolve();
    await expectDefined(completion.mock.results[0]?.value, "completion attempt");
    await settleSubagentRegistryPersistenceWork();
  }
});

test("a retained kill claim cannot revive durably revoked session cleanup", async () => {
  const id = "kill-claim-owner";
  registerCollector(id);
  expect(
    claimSubagentRunKill({
      runId: id,
      expected: expectDefined(subagentRuns.get(id), "registered collector"),
      sessionId: "reset-cleanup-session",
      sessionLifecycleRevision: "original",
    }),
  ).toBeDefined();
  expect(settleFailedQueuedSubagentLaunch(id, "launch failed during cancellation")).toBe(true);
  await request("sessions.reset", { key });
  const successor = loadSessionEntry({ sessionKey: key });
  emitAgentEvent({
    runId: id,
    stream: "lifecycle",
    data: { phase: "end", aborted: true, stopReason: "aborted", endedAt: Date.now() },
  });
  await settleSubagentRegistryPersistenceWork();
  expect(loadSubagentRegistryFromSqlite().get(id)?.execution.suppressSessionEffects).toBe(true);
  await testing.sweepOnceForTests();
  expect(loadSessionEntry({ sessionKey: key })).toEqual(successor);
});

test.each([false, true])(
  "reset persists earlier best-effort suppression (existing row: %s)",
  async (resetAgain) => {
    await request("sessions.delete", { key });
    const database = openOpenClawStateDatabase();
    database.db.exec(`CREATE TEMP TRIGGER reject_best_effort BEFORE UPDATE ON subagent_runs
    WHEN json_extract(NEW.payload_json, '$.execution.suppressSessionEffects') = 1
    BEGIN SELECT RAISE(ABORT, 'best effort write rejected'); END`);
    await testing.sweepOnceForTests();
    expect(subagentRuns.get(runId)?.execution.suppressSessionEffects).toBe(true);
    expect(loadSubagentRegistryFromSqlite().get(runId)?.execution.suppressSessionEffects).not.toBe(
      true,
    );
    database.db.exec("DROP TRIGGER reject_best_effort");
    await request("sessions.reset", { key });
    if (resetAgain) {
      await request("sessions.reset", { key });
    }
    const successor = loadSessionEntry({ sessionKey: key });
    expect(successor).toBeDefined();
    reopen();
    await testing.sweepOnceForTests();
    expect(loadSessionEntry({ sessionKey: key })).toEqual(successor);
  },
);

test("reset preserves a yielded continuation instead of revoking it as completed cleanup", async () => {
  const id = "yielded-continuation";
  startCollector(id);
  emitAgentEvent({
    runId: id,
    stream: "lifecycle",
    data: { phase: "end", yielded: true, endedAt: Date.now() },
  });
  expect(subagentRuns.get(id)?.pauseReason).toBe("sessions_yield");
  await request("sessions.reset", { key });
  expect(loadSubagentRegistryFromSqlite().get(id)).toMatchObject({ pauseReason: "sessions_yield" });
  expect(loadSubagentRegistryFromSqlite().get(id)?.execution.suppressSessionEffects).not.toBe(true);
});
