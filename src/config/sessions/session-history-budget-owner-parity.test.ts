// Budget deletion retains the logical owner while reusing the captured physical store.
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  insertRepositoryGitHubPublication,
  readRepositoryGitHubPublication,
  repositoryGitHubPublicationDigest,
  type RepositoryGitHubPublicationRow,
} from "../../gateway/github-repository-publication-store.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import {
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../../sessions/session-lifecycle-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { appendTranscriptMessage } from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
} from "./session-accessor.sqlite-scope.js";
import {
  appendTranscriptEventsInTransaction,
  ensureTranscriptHeader,
} from "./session-accessor.sqlite-transcript-store.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

const states: OpenClawTestState[] = [];
const pending: Promise<unknown>[] = [];
const listeners: Array<() => void> = [];
const workers: Worker[] = [];
const workerChannel = channel("worker_threads");
const recordWorker = (message: unknown) => workers.push((message as { worker: Worker }).worker);
beforeEach(() => workerChannel.subscribe(recordWorker));
afterEach(async () => {
  for (const unsubscribe of listeners.splice(0)) {
    unsubscribe();
  }
  await Promise.allSettled(pending.splice(0));
  try {
    for (const state of states) {
      await closeOpenClawAgentDatabasesAsync(state.root);
    }
    for (const state of states) {
      closeOpenClawAgentDatabasesForTest(state.root);
    }
  } finally {
    closeOpenClawStateDatabaseForTest();
    workerChannel.unsubscribe(recordWorker);
    // Real archive/reclamation calls settle their workers. Only this test's idle
    // measurement pool remains; join termination before removing the fixture.
    await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
    for (const state of states.splice(0).toReversed()) {
      await state.cleanup();
    }
  }
});

function row(databasePath: string, sql: string, ...values: SQLInputValue[]) {
  const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).get(...values);
  } finally {
    database.close();
  }
}

function retain<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  return promise;
}

function seedReceipt(agentId: string, sessionKey: string, sessionId: string): string {
  // This is the real persistence/digest owner, with a synthetic system identity.
  // No coordinator, OAuth account, repository checkout, push, or external API runs.
  const requestId = randomUUID();
  const now = Date.now();
  const receipt: RepositoryGitHubPublicationRow = {
    request_id: requestId,
    idempotency_key: `owner-parity-${requestId}`,
    request_digest: "",
    session_id: sessionId,
    session_lifecycle_revision: null,
    session_key: sessionKey,
    agent_id: agentId,
    workspace_id: `workspace-${requestId}`,
    owner_profile_id: null,
    connection_generation: null,
    identity_source: "system-detected",
    identity_profile_id: null,
    identity_account_id: 12345,
    identity_login: "synthetic-owner",
    title: null,
    body: null,
    push_repository: "example/synthetic-owner-proof",
    repository: "example/synthetic-owner-proof",
    base_branch: "main",
    branch: "proof/owner-parity",
    previous_head_commit: null,
    claim_id: null,
    run_id: null,
    environment_id: null,
    owner_epoch: null,
    placement_generation: null,
    checkpoint_ref: null,
    checkpoint_digest: null,
    source_head_commit: null,
    source_index_tree: null,
    workspace_tree: null,
    status: "requested",
    execution_id: null,
    gateway_instance_id: null,
    head_commit: null,
    pushed_head_commit: null,
    pull_request_url: null,
    last_effect: null,
    effect_state: null,
    error_code: null,
    next_action: null,
    created_at_ms: now,
    updated_at_ms: now,
    reported_at_ms: null,
  };
  receipt.request_digest = repositoryGitHubPublicationDigest(receipt);
  insertRepositoryGitHubPublication(receipt, () => {});
  expect(readRepositoryGitHubPublication(requestId)).toMatchObject({
    agent_id: agentId,
    session_key: sessionKey,
    session_id: sessionId,
  });
  return requestId;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(kind: "shared" | "canonical-nonshared" | "custom-nonshared", bare = false) {
  const state = await createOpenClawTestState({
    prefix: "omitted-budget-owner-",
    layout: "state-only",
    scenario: "minimal",
  });
  states.push(state);
  const storePath =
    kind === "canonical-nonshared"
      ? path.join(state.sessionsDir("main"), "sessions.json")
      : state.path("custom", kind === "shared" ? "shared.sqlite" : "sessions.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const databasePath =
    kind === "shared"
      ? storePath
      : resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main", env: state.env })
          .path;
  openOpenClawAgentDatabase({ agentId: "main", env: state.env, path: databasePath });
  const victimKey = bare ? "unknown" : "agent:secondary:explicit:owner-parity";
  const victimAgent = bare ? "main" : "secondary";
  const victimId = "owner-parity-victim";
  const survivorKey = "agent:main:main";
  const survivorId = "owner-parity-survivor";
  const marker = "retained owner parity transcript";
  const archived = {
    sessionId: victimId,
    updatedAt: 1,
    archivedAt: 1,
    archiveReason: "active-session-cap" as const,
  };
  if (kind === "shared") {
    const victimScope = { agentId: victimAgent, env: state.env, storePath, sessionKey: victimKey };
    replaceSessionEntrySync(victimScope, { sessionId: victimId, updatedAt: 1 });
    await retain(
      appendTranscriptMessage(
        { ...victimScope, sessionId: victimId },
        {
          message: { role: "user", content: marker + "x".repeat(64 * 1024) },
        },
      ),
    );
    replaceSessionEntrySync(victimScope, archived);
  } else {
    // Deliberately model a foreign qualified row in a nonshared physical store.
    // Public scope resolution refuses this mismatch. Existing low-level canonical
    // writers construct the fixture without weakening or mocking that validator.
    runOpenClawAgentWriteTransaction(
      (database) => {
        writeSessionEntry(database, victimKey, archived);
        const transcript = {
          agentId: "main",
          env: state.env,
          path: databasePath,
          sessionKey: victimKey,
          sessionId: victimId,
        };
        ensureTranscriptHeader(database, transcript, state.root);
        expect(
          appendTranscriptEventsInTransaction(database, transcript, [
            {
              type: "message",
              id: "owner-parity-message",
              message: { role: "user", content: marker + "x".repeat(64 * 1024) },
            },
          ]),
        ).toBe(1);
      },
      { agentId: "main", env: state.env, path: databasePath },
    );
  }
  replaceSessionEntrySync(
    { agentId: "main", env: state.env, storePath, sessionKey: survivorKey },
    {
      sessionId: survivorId,
      updatedAt: Date.now(),
    },
  );
  // Join real seed maintenance with unchanged defaults, rather than disabling it.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await retain(
    runExclusiveSqliteSessionWrite(
      resolveSqliteScope({
        agentId: "main",
        env: state.env,
        storePath,
        sessionKey: "",
      }),
      async () => {},
    ),
  );
  await retain(
    enforceSqliteSessionHistoryDiskBudget({
      agentId: "main",
      storePath,
      mode: "enforce",
      maintenance: resolveMaintenanceConfigFromInput(),
    }),
  );
  const victimReceipt = seedReceipt(victimAgent, victimKey, victimId);
  const survivorReceipt = seedReceipt("main", survivorKey, survivorId);
  expect(row(databasePath, "SELECT agent_id FROM schema_meta")).toEqual({ agent_id: "main" });
  expect(
    row(
      databasePath,
      "SELECT current_session_id FROM session_nodes WHERE session_key = ?",
      victimKey,
    ),
  ).toEqual({ current_session_id: victimId });
  expect(
    Number(
      row(
        databasePath,
        "SELECT count(*) AS count FROM transcript_events WHERE session_id = ?",
        victimId,
      )?.count,
    ),
  ).toBeGreaterThan(0);
  const secondaryCanonicalPath = resolveOpenClawAgentSqlitePath({
    agentId: "secondary",
    env: state.env,
  });
  expect(fs.existsSync(secondaryCanonicalPath)).toBe(false);
  const registryBefore = listOpenClawRegisteredAgentDatabases({ env: state.env }).map(
    ({ agentId, path: registeredPath }) => ({ agentId, path: registeredPath }),
  );
  expect(registryBefore).toContainEqual({ agentId: "main", path: databasePath });
  await closeOpenClawAgentDatabasesAsync(state.root);
  closeOpenClawAgentDatabasesForTest(state.root);
  expect(
    row(
      resolveOpenClawStateSqlitePath(state.env),
      "SELECT count(*) AS count FROM agent_database_leases",
    ),
  ).toEqual({ count: 0 });
  return {
    state,
    storePath,
    databasePath,
    victimKey,
    victimAgent,
    victimId,
    survivorKey,
    survivorId,
    victimReceipt,
    survivorReceipt,
    secondaryCanonicalPath,
    registryBefore,
  };
}

function observeVictim(f: Fixture) {
  const facts: Array<{
    mutation: SessionIdentityMutation;
    rowExists: boolean;
    receiptExists: boolean;
  }> = [];
  listeners.push(
    onSessionIdentityMutation((mutation) => {
      if (mutation.kind === "delete" && mutation.previous.sessionKeys.includes(f.victimKey)) {
        facts.push({
          mutation,
          rowExists:
            row(
              f.databasePath,
              "SELECT session_key FROM session_nodes WHERE session_key = ?",
              f.victimKey,
            ) !== undefined,
          receiptExists: readRepositoryGitHubPublication(f.victimReceipt) !== undefined,
        });
      }
    }),
  );
  return facts;
}

function enforce(f: Fixture, agentId?: string) {
  expect(process.env.OPENCLAW_STATE_DIR).toBe(f.state.stateDir);
  return retain(
    enforceSqliteSessionHistoryDiskBudget({
      ...(agentId !== undefined ? { agentId } : {}),
      storePath: f.storePath,
      mode: "enforce",
      maintenance: resolveMaintenanceConfigFromInput({
        mode: "enforce",
        maxDiskBytes: 1,
        highWaterBytes: 1,
      }),
    }),
  );
}

async function assertCustody(f: Fixture) {
  expect(process.env.OPENCLAW_STATE_DIR).toBe(f.state.stateDir);
  expect(row(f.databasePath, "SELECT agent_id FROM schema_meta")).toEqual({ agent_id: "main" });
  expect(
    row(
      f.databasePath,
      "SELECT current_session_id FROM session_nodes WHERE session_key = ?",
      f.survivorKey,
    ),
  ).toEqual({ current_session_id: f.survivorId });
  expect(readRepositoryGitHubPublication(f.survivorReceipt)).toMatchObject({
    agent_id: "main",
    session_key: f.survivorKey,
  });
  expect(fs.existsSync(f.secondaryCanonicalPath)).toBe(false);
  const registry = listOpenClawRegisteredAgentDatabases({ env: f.state.env }).map(
    ({ agentId, path: registeredPath }) => ({ agentId, path: registeredPath }),
  );
  const sorted = (rows: Array<{ agentId: string; path: string }>) =>
    rows.toSorted((a, b) => a.path.localeCompare(b.path));
  expect(sorted(registry)).toEqual(sorted(f.registryBefore));
  await closeOpenClawAgentDatabasesAsync(f.state.root);
  closeOpenClawAgentDatabasesForTest(f.state.root);
  expect(
    row(
      resolveOpenClawStateSqlitePath(f.state.env),
      "SELECT count(*) AS count FROM agent_database_leases",
    ),
  ).toEqual({ count: 0 });
}

describe("budget cap-entry logical ownership", () => {
  it.each([
    { name: "omitted qualified owner", explicit: false, bare: false, expectedAgent: "secondary" },
    { name: "explicit secondary owner", explicit: true, bare: false, expectedAgent: "secondary" },
    { name: "omitted canonical bare unknown", explicit: false, bare: true, expectedAgent: "main" },
  ] as const)(
    "deletes the matching receipt for $name in a shared physical main store",
    async (scenario) => {
      const f = await fixture("shared", scenario.bare);
      const facts = observeVictim(f);
      await expect(enforce(f, scenario.explicit ? "secondary" : undefined)).resolves.toMatchObject({
        removedEntries: 1,
      });
      expect(
        row(
          f.databasePath,
          "SELECT session_key FROM session_nodes WHERE session_key = ?",
          f.victimKey,
        ),
      ).toBeUndefined();
      expect(
        row(
          f.databasePath,
          "SELECT session_id FROM session_windows WHERE session_id = ?",
          f.victimId,
        ),
      ).toBeUndefined();
      expect(
        readRepositoryGitHubPublication(f.victimReceipt),
        "deleted logical owner must lose its retained publication receipt",
      ).toBeUndefined();
      // agentId is fallback metadata for qualified keys, not authorization evidence.
      expect(facts).toEqual([
        {
          mutation: {
            agentId: scenario.expectedAgent,
            kind: "delete",
            previous: { sessionId: f.victimId, sessionKeys: [f.victimKey] },
          },
          rowExists: false,
          receiptExists: true,
        },
      ]);
      await assertCustody(f);
    },
  );

  it.each(["canonical-nonshared", "custom-nonshared"] as const)(
    "rejects a foreign candidate in a %s store without retargeting cleanup",
    async (kind) => {
      const f = await fixture(kind);
      const facts = observeVictim(f);
      const suffixPath =
        kind === "custom-nonshared"
          ? resolveSqliteTargetFromSessionStorePath(f.storePath, {
              agentId: "secondary",
              env: f.state.env,
            }).path
          : undefined;
      if (suffixPath) {
        expect(suffixPath).not.toBe(f.databasePath);
        expect(fs.existsSync(suffixPath)).toBe(false);
      }
      await expect(enforce(f)).rejects.toThrow(
        "SQLite session store path belongs to agent main; requested agent secondary.",
      );
      expect(
        row(
          f.databasePath,
          "SELECT current_session_id FROM session_nodes WHERE session_key = ?",
          f.victimKey,
        ),
      ).toEqual({ current_session_id: f.victimId });
      expect(
        Number(
          row(
            f.databasePath,
            "SELECT count(*) AS count FROM transcript_events WHERE session_id = ?",
            f.victimId,
          )?.count,
        ),
      ).toBeGreaterThan(0);
      expect(readRepositoryGitHubPublication(f.victimReceipt)).toMatchObject({
        agent_id: "secondary",
        session_key: f.victimKey,
      });
      expect(facts).toEqual([]);
      if (suffixPath) {
        expect(fs.existsSync(suffixPath)).toBe(false);
      }
      await assertCustody(f);
    },
  );
});
