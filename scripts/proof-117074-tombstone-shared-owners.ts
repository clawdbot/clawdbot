/**
 * Real-behavior proof for `openclaw sessions cleanup` cron-tombstone sweeping
 * across logical agents that share one physical SQLite session store.
 *
 * Real production code under test (nothing mocked):
 * - `resolveSessionStoreTargets` (src/config/sessions/targets.ts) including the
 *   physical-store dedupe in `dedupeSessionStoreTargetsBySqliteTarget`.
 * - `runSessionsCleanup` (src/config/sessions/cleanup-service.ts) end to end:
 *   preview, lifecycle admission, SQLite write transactions, archive
 *   materialization/publication, and disk-budget enforcement.
 * - `sweepTombstonedCronRunRemnantsForStore` (src/config/sessions/cleanup-tombstones.ts).
 * - Real on-disk SQLite agent databases created under a temp `OPENCLAW_STATE_DIR`.
 *
 * Stubbed: nothing. No vitest, no network, no channel sends. Only the
 * `OPENCLAW_STATE_DIR` env var and the config object are synthesized.
 *
 * Scenarios:
 * 1. `--all-agents` over an exact shared `.sqlite` locator: dedupe collapses
 *    `main` and `ops` onto ONE physical target; both agents' expired cron
 *    placeholders must be swept and archived. This is the regression the P2
 *    review finding described (pre-fix: only the store owner's row was swept).
 * 2. `--agent main` over the same shared store: single-agent isolation is
 *    preserved; `ops` rows survive untouched (the prior round's P1 fix).
 * 3. `--all-agents` over per-agent stores: two independent physical targets,
 *    each agent sweeps only its own store, no cross-store leakage.
 *
 * Run: pnpm tsx scripts/proof-117074-tombstone-shared-owners.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSessionsCleanup } from "../src/config/sessions/cleanup-service.js";
import { replaceSessionEntry } from "../src/config/sessions/session-accessor.js";
import { deleteSessionEntryRows } from "../src/config/sessions/session-accessor.sqlite-entry-store.js";
import { getSessionKysely } from "../src/config/sessions/session-accessor.sqlite-scope.js";
import { replaceTranscriptEventsSync } from "../src/config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "../src/config/sessions/session-sqlite-target.js";
import { resolveSessionStoreTargets } from "../src/config/sessions/targets.js";
import type { OpenClawConfig } from "../src/config/types.js";
import { executeSqliteQuerySync } from "../src/infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../src/state/openclaw-agent-db.js";

const HOUR_MS = 3_600_000;
let assertions = 0;
const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  assertions += 1;
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    failures.push(`${label}: expected ${expectedText}, got ${actualText}`);
    console.log(`  FAIL ${label}: expected ${expectedText}, got ${actualText}`);
    return;
  }
  console.log(`  ok   ${label} = ${actualText}`);
}

function makeStateDir(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "proof-117074-")));
}

function openStore(storePath: string, agentId: string) {
  const resolved = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
  if (!resolved.path) {
    throw new Error(`no sqlite path resolved for ${storePath}`);
  }
  return openOpenClawAgentDatabase({ agentId: resolved.agentId ?? agentId, path: resolved.path });
}

/**
 * Seeds one canonical expired cron retained-history placeholder: a real session
 * entry plus transcript is written through the accessor, then the readable
 * entry rows are deleted so only the intentionally empty placeholder remains.
 */
async function seedExpiredCronPlaceholder(params: {
  storePath: string;
  ownerAgentId: string;
  sessionKey: string;
  sessionId: string;
  ageMs: number;
}): Promise<void> {
  await replaceSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    { sessionId: params.sessionId, updatedAt: Date.now() },
  );
  replaceTranscriptEventsSync(
    { sessionKey: params.sessionKey, sessionId: params.sessionId, storePath: params.storePath },
    [{ type: "session", id: params.sessionId, content: "cron run transcript" }],
  );
  const database = openStore(params.storePath, params.ownerAgentId);
  deleteSessionEntryRows(database, params.sessionKey);
  const updatedAt = Date.now() - params.ageMs;
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_windows")
      .set({ updated_at: updatedAt })
      .where("session_key", "=", params.sessionKey),
  );
  // Separate statements on purpose: one combined `.set({ updated_at, entry_valid })`
  // does not persist `entry_valid`, and the canonical placeholder predicate
  // requires `entry_valid === -1`.
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_nodes")
      .set({ updated_at: updatedAt })
      .where("session_key", "=", params.sessionKey),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_nodes")
      .set({ entry_valid: -1 })
      .where("session_key", "=", params.sessionKey),
  );
}

function countNodes(storePath: string, ownerAgentId: string, sessionKey: string): number {
  const database = openStore(storePath, ownerAgentId);
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select("session_key").where("session_key", "=", sessionKey),
  ).rows.length;
}

function countTranscriptEvents(storePath: string, ownerAgentId: string, sessionId: string): number {
  const database = openStore(storePath, ownerAgentId);
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db.selectFrom("transcript_events").select("session_id").where("session_id", "=", sessionId),
  ).rows.length;
}

function countArchives(storePath: string, ownerAgentId: string, sessionId: string): number {
  const database = openStore(storePath, ownerAgentId);
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_transcript_archives")
      .select("archive_name")
      .where("session_id", "=", sessionId),
  ).rows.length;
}

function twoAgentConfig(store?: string): OpenClawConfig {
  return {
    agents: { list: [{ id: "main" }, { id: "ops" }] },
    ...(store ? { session: { store } } : {}),
  } as unknown as OpenClawConfig;
}

function totalSweptRemnants(
  summaries: readonly { tombstoneRemnants?: { removedNodes: number } | null }[],
): number {
  return summaries.reduce(
    (total, summary) => total + (summary.tombstoneRemnants?.removedNodes ?? 0),
    0,
  );
}

async function scenarioAllAgentsSharedStore(): Promise<void> {
  console.log("\n[1] --all-agents over an exact shared .sqlite locator");
  const stateDir = makeStateDir();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const storePath = path.join(stateDir, "shared.sqlite");
  const cfg = twoAgentConfig(storePath);

  await seedExpiredCronPlaceholder({
    storePath,
    ownerAgentId: "main",
    sessionKey: "agent:main:cron:job-1:run:run-1",
    sessionId: "main-cron-session",
    ageMs: 48 * HOUR_MS,
  });
  await seedExpiredCronPlaceholder({
    storePath,
    ownerAgentId: "main",
    sessionKey: "agent:ops:cron:job-2:run:run-2",
    sessionId: "ops-cron-session",
    ageMs: 48 * HOUR_MS,
  });

  const targets = resolveSessionStoreTargets(cfg, { allAgents: true });
  check("dedupe collapses both agents to one physical target", targets.length, 1);
  check("selected target owner", targets[0]?.agentId, "main");

  check(
    "main placeholder seeded",
    countNodes(storePath, "main", "agent:main:cron:job-1:run:run-1"),
    1,
  );
  check(
    "ops placeholder seeded",
    countNodes(storePath, "main", "agent:ops:cron:job-2:run:run-2"),
    1,
  );

  const result = await runSessionsCleanup({
    cfg,
    opts: { allAgents: true, enforce: true },
  });
  check("applied one store summary", result.appliedSummaries.length, 1);
  check("swept remnants across selected owners", totalSweptRemnants(result.appliedSummaries), 2);
  check(
    "main placeholder removed",
    countNodes(storePath, "main", "agent:main:cron:job-1:run:run-1"),
    0,
  );
  check(
    "ops placeholder removed",
    countNodes(storePath, "main", "agent:ops:cron:job-2:run:run-2"),
    0,
  );
  check("main transcript swept", countTranscriptEvents(storePath, "main", "main-cron-session"), 0);
  check("ops transcript swept", countTranscriptEvents(storePath, "main", "ops-cron-session"), 0);
  check("main transcript archived", countArchives(storePath, "main", "main-cron-session"), 1);
  check("ops transcript archived", countArchives(storePath, "main", "ops-cron-session"), 1);

  closeOpenClawAgentDatabasesForTest();
  fs.rmSync(stateDir, { recursive: true, force: true });
}

async function scenarioSingleAgentSharedStore(): Promise<void> {
  console.log("\n[2] --agent main over the same shared store keeps ops isolated");
  const stateDir = makeStateDir();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const storePath = path.join(stateDir, "shared.sqlite");
  const cfg = twoAgentConfig(storePath);

  await seedExpiredCronPlaceholder({
    storePath,
    ownerAgentId: "main",
    sessionKey: "agent:main:cron:job-1:run:run-1",
    sessionId: "main-cron-session",
    ageMs: 48 * HOUR_MS,
  });
  await seedExpiredCronPlaceholder({
    storePath,
    ownerAgentId: "main",
    sessionKey: "agent:ops:cron:job-2:run:run-2",
    sessionId: "ops-cron-session",
    ageMs: 48 * HOUR_MS,
  });

  const result = await runSessionsCleanup({
    cfg,
    opts: { agent: "main", enforce: true },
  });
  check("swept exactly the requested owner", totalSweptRemnants(result.appliedSummaries), 1);
  check(
    "main placeholder removed",
    countNodes(storePath, "main", "agent:main:cron:job-1:run:run-1"),
    0,
  );
  check(
    "ops placeholder preserved",
    countNodes(storePath, "main", "agent:ops:cron:job-2:run:run-2"),
    1,
  );
  check(
    "ops transcript preserved",
    countTranscriptEvents(storePath, "main", "ops-cron-session"),
    1,
  );
  check("ops not archived", countArchives(storePath, "main", "ops-cron-session"), 0);

  closeOpenClawAgentDatabasesForTest();
  fs.rmSync(stateDir, { recursive: true, force: true });
}

async function scenarioAllAgentsPerAgentStores(): Promise<void> {
  console.log("\n[3] --all-agents over per-agent stores sweeps each store once");
  const stateDir = makeStateDir();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const cfg = twoAgentConfig();
  const mainStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  const opsStorePath = path.join(stateDir, "agents", "ops", "sessions", "sessions.json");

  await seedExpiredCronPlaceholder({
    storePath: mainStorePath,
    ownerAgentId: "main",
    sessionKey: "agent:main:cron:job-1:run:run-1",
    sessionId: "main-cron-session",
    ageMs: 48 * HOUR_MS,
  });
  await seedExpiredCronPlaceholder({
    storePath: opsStorePath,
    ownerAgentId: "ops",
    sessionKey: "agent:ops:cron:job-2:run:run-2",
    sessionId: "ops-cron-session",
    ageMs: 48 * HOUR_MS,
  });

  const targets = resolveSessionStoreTargets(cfg, { allAgents: true });
  check("per-agent stores stay distinct targets", targets.length, 2);

  const result = await runSessionsCleanup({
    cfg,
    opts: { allAgents: true, enforce: true },
  });
  check("applied two store summaries", result.appliedSummaries.length, 2);
  check("swept one remnant per store", totalSweptRemnants(result.appliedSummaries), 2);
  check(
    "main placeholder removed",
    countNodes(mainStorePath, "main", "agent:main:cron:job-1:run:run-1"),
    0,
  );
  check(
    "ops placeholder removed",
    countNodes(opsStorePath, "ops", "agent:ops:cron:job-2:run:run-2"),
    0,
  );

  closeOpenClawAgentDatabasesForTest();
  fs.rmSync(stateDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  await scenarioAllAgentsSharedStore();
  await scenarioSingleAgentSharedStore();
  await scenarioAllAgentsPerAgentStores();
  console.log(`\nassertions: ${assertions}, failures: ${failures.length}`);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.log(`FAILED: ${failure}`);
    }
    throw new Error(`${failures.length} runtime assertion(s) failed`);
  }
  console.log("All runtime assertions passed.");
}

await main();
