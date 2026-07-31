import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type SessionAccessorModule = typeof import("../src/config/sessions/session-accessor.js");
type EntryCacheModule =
  typeof import("../src/config/sessions/session-accessor.sqlite-entry-cache.js");
type AgentDatabaseModule = typeof import("../src/state/openclaw-agent-db.js");
type ReadOnlyDatabaseModule = typeof import("../src/state/openclaw-agent-db-readonly.js");
type StateDatabaseModule = typeof import("../src/state/openclaw-state-db.js");

const repoRoot = process.env.PROOF_REPO_ROOT ?? process.cwd();
const expectation = process.env.PROOF_EXPECTATION ?? "released";
if (expectation !== "retained" && expectation !== "released") {
  throw new Error("PROOF_EXPECTATION must be retained or released");
}
const forceGc = globalThis.gc;
if (typeof forceGc !== "function") {
  throw new Error("run with node --expose-gc");
}

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-entry-cache-proof-"));
const importSource = async (relativePath: string) =>
  import(pathToFileURL(path.join(repoRoot, relativePath)).href);
const { upsertSessionEntry } = (await importSource(
  "src/config/sessions/session-accessor.js",
)) as SessionAccessorModule;
const { readSqliteSessionEntryCache } = (await importSource(
  "src/config/sessions/session-accessor.sqlite-entry-cache.js",
)) as EntryCacheModule;
const {
  OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP,
  closeOpenClawAgentDatabases,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
} = (await importSource("src/state/openclaw-agent-db.js")) as AgentDatabaseModule;
const { withOpenClawAgentDatabaseReadOnly } = (await importSource(
  "src/state/openclaw-agent-db-readonly.js",
)) as ReadOnlyDatabaseModule;
const { closeOpenClawStateDatabase } = (await importSource(
  "src/state/openclaw-state-db.js",
)) as StateDatabaseModule;

const readOnlyEntryCount = 20;
const readOnlyPayloadBytes = 1_000_000;
const lruHandleCount = OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP + 2;
const lruPayloadBytes = 100_000;

const createScope = (group: string, index: number) => ({
  agentId: "main",
  env: {
    ...process.env,
    OPENCLAW_STATE_DIR: path.join(dataRoot, group, `agent-${index}`),
  },
  sessionKey: `agent:main:${group}-${index}`,
});

const settleGc = async () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    forceGc();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

try {
  const readOnlyScopes = Array.from({ length: readOnlyEntryCount }, (_, index) =>
    createScope("read-only", index),
  );
  for (const [index, scope] of readOnlyScopes.entries()) {
    fs.mkdirSync(scope.env.OPENCLAW_STATE_DIR, { recursive: true });
    await upsertSessionEntry(scope, {
      label: `${index}:${"x".repeat(readOnlyPayloadBytes)}`,
      sessionId: `read-only-${index}`,
      updatedAt: index + 1,
    });
  }
  closeOpenClawAgentDatabases();
  closeOpenClawStateDatabase();

  await settleGc();
  const readOnlyBaselineHeap = process.memoryUsage().heapUsed;
  const readOnlyConnectionRefs: Array<WeakRef<object>> = [];

  for (const scope of readOnlyScopes) {
    const result = withOpenClawAgentDatabaseReadOnly((database) => {
      const snapshot = readSqliteSessionEntryCache(database, { cache: true });
      assert.deepEqual(snapshot.keys, [scope.sessionKey]);
      readOnlyConnectionRefs.push(new WeakRef(database.db));
      return snapshot.keys.length;
    }, scope);
    assert.equal(result.found, true);
  }

  await settleGc();
  const readOnlyHeapDeltaBytes = process.memoryUsage().heapUsed - readOnlyBaselineHeap;
  const readOnlyRetainedConnections = readOnlyConnectionRefs.filter((reference) =>
    reference.deref(),
  ).length;

  const lruConnectionRefs: Array<WeakRef<object>> = [];
  const lruPaths: string[] = [];
  for (let index = 0; index < lruHandleCount; index += 1) {
    const scope = createScope("lru", index);
    fs.mkdirSync(scope.env.OPENCLAW_STATE_DIR, { recursive: true });
    await upsertSessionEntry(scope, {
      label: `${index}:${"y".repeat(lruPayloadBytes)}`,
      sessionId: `lru-${index}`,
      updatedAt: index + 1,
    });
    const database = openOpenClawAgentDatabase(scope);
    const snapshot = readSqliteSessionEntryCache(database, { cache: true });
    assert.deepEqual(snapshot.keys, [scope.sessionKey]);
    lruConnectionRefs.push(new WeakRef(database.db));
    lruPaths.push(database.path);
  }

  const lruEvictedCount = lruHandleCount - OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP;
  assert.equal(isOpenClawAgentDatabaseOpen(lruPaths[0]!), false);
  assert.equal(isOpenClawAgentDatabaseOpen(lruPaths.at(-1)!), true);
  await settleGc();
  const lruEvictedRetainedConnections = lruConnectionRefs
    .slice(0, lruEvictedCount)
    .filter((reference) => reference.deref()).length;
  const lruLiveRetainedConnections = lruConnectionRefs
    .slice(lruEvictedCount)
    .filter((reference) => reference.deref()).length;

  const retained =
    readOnlyRetainedConnections === readOnlyEntryCount &&
    readOnlyHeapDeltaBytes > 6_000_000 &&
    lruEvictedRetainedConnections === lruEvictedCount &&
    lruLiveRetainedConnections === OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP;
  const released =
    readOnlyRetainedConnections <= 1 &&
    readOnlyHeapDeltaBytes < 6_000_000 &&
    lruEvictedRetainedConnections === 0 &&
    lruLiveRetainedConnections === OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP;
  const verdict = expectation === "released" ? released : retained;

  process.stdout.write(
    `${JSON.stringify({
      schema: "sqlite-session-entry-cache-lifetime-proof-v2",
      test_runner: "none",
      affected_owners: {
        database: "real-node-sqlite",
        read_only_lifecycle: "withOpenClawAgentDatabaseReadOnly",
        writable_lifecycle: "openOpenClawAgentDatabase LRU",
        cache: "readSqliteSessionEntryCache",
      },
      read_only_entry_count: readOnlyEntryCount,
      read_only_payload_bytes_per_entry: readOnlyPayloadBytes,
      read_only_retained_connections: readOnlyRetainedConnections,
      read_only_heap_delta_bytes: readOnlyHeapDeltaBytes,
      lru_handle_cap: OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP,
      lru_opened_handles: lruHandleCount,
      lru_evicted_connections: lruEvictedCount,
      lru_evicted_retained_connections: lruEvictedRetainedConnections,
      lru_live_retained_connections: lruLiveRetainedConnections,
      expectation,
      verdict: verdict ? "PASS" : "FAIL",
    })}\n`,
  );
  if (!verdict) {
    process.exitCode = 1;
  }
} finally {
  closeOpenClawAgentDatabases();
  closeOpenClawStateDatabase();
  fs.rmSync(dataRoot, { force: true, recursive: true });
}
