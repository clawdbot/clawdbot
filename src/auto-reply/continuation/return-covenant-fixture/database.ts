import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../../infra/node-sqlite.js";
import { resolveSqliteDatabaseFilePaths } from "../../../infra/sqlite-files.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../../state/openclaw-agent-db-readonly.js";
import { listOpenClawRegisteredAgentDatabases } from "../../../state/openclaw-agent-db-registry-listing.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  disposeOpenClawAgentDatabaseByPath,
  ensureOpenClawAgentDatabaseSchema,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  withAgentDatabaseMaintenanceLease,
} from "../../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { stageRecipientAuthorityV18Fixture } from "../../../state/openclaw-agent-recipient-authority-fixture.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import type { ReturnCovenantGatewayBinding } from "./gateway-generation.js";
import {
  sha256ReturnCovenant,
  type ReturnCovenantForm,
  type ReturnCovenantPlan,
} from "./protocol.js";

export type ReturnCovenantDatabaseProfile = ReturnCovenantPlan["cases"][number]["databaseProfile"];

export type ReturnCovenantDatabaseReceipt = {
  profile: ReturnCovenantDatabaseProfile;
  sourceSchemaVersion: number | null;
  targetSchemaVersion: 19;
  fixtureShape: "fresh" | "covenant-v18" | "participant-v18" | "v19-reopen";
  productOwnedFixture: true;
  canonicalFixtureReceiptId: string;
  freshInstall: boolean;
  migrationApplied: boolean;
  reopenIdempotent: boolean;
};

export type ReturnCovenantProfileActivation = {
  caseId: string;
  databasePath: string;
  form: ReturnCovenantForm;
  profile: ReturnCovenantDatabaseProfile;
};

export type ReturnCovenantDatabaseProfilesSnapshot = {
  activeExecutionKey: string | null;
};

type ReturnCovenantDatabaseProfileReceipt = Omit<
  ReturnCovenantDatabaseReceipt,
  "canonicalFixtureReceiptId"
>;

type ReturnCovenantDatabaseAssignment = {
  caseId: string;
  databasePath: string;
  executionKey: string;
  form: ReturnCovenantForm;
  receipt: ReturnCovenantDatabaseProfileReceipt;
};

type ReturnCovenantSessionDatabase = Pick<OpenClawAgentKyselyDatabase, "session_nodes">;

const fixtureShapeByProfile = {
  "fresh-v19": "fresh",
  "covenant-v18-upgrade": "covenant-v18",
  "participant-v18-upgrade": "participant-v18",
  "idempotent-v19-reopen": "v19-reopen",
} as const satisfies Record<ReturnCovenantDatabaseProfile, string>;

function executionKey(caseId: string, form: ReturnCovenantForm): string {
  return `${caseId}:${form}`;
}

function readVersion(database: ReturnType<typeof openOpenClawAgentDatabase>["db"]): number {
  const row = asOptionalRecord(database.prepare("PRAGMA user_version").get());
  if (row?.user_version !== OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new Error("return-covenant fixture did not reach agent schema v19");
  }
  return OPENCLAW_AGENT_SCHEMA_VERSION;
}

function assertAgentDatabaseHealthy(
  database: ReturnType<typeof openOpenClawAgentDatabase>["db"],
): void {
  readVersion(database);
  const metadata = asOptionalRecord(
    database.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  );
  if (metadata?.schema_version !== OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new Error("return-covenant fixture agent schema metadata is not v19");
  }
  if (database.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error("return-covenant fixture agent database failed foreign-key validation");
  }
  const integrity = asOptionalRecord(database.prepare("PRAGMA integrity_check").get());
  if (integrity?.integrity_check !== "ok") {
    throw new Error("return-covenant fixture agent database failed integrity validation");
  }
}

function checkpointAgentDatabase(
  database: ReturnType<typeof openOpenClawAgentDatabase>["db"],
): void {
  const checkpoint = asOptionalRecord(database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get());
  if (checkpoint?.busy !== 0) {
    throw new Error("return-covenant fixture agent database checkpoint remained busy");
  }
}

function profileReceipt(
  profile: ReturnCovenantDatabaseProfile,
): ReturnCovenantDatabaseProfileReceipt {
  const sourceSchemaVersion =
    profile === "fresh-v19" ? null : profile === "idempotent-v19-reopen" ? 19 : 18;
  return {
    profile,
    sourceSchemaVersion,
    targetSchemaVersion: 19,
    fixtureShape: fixtureShapeByProfile[profile],
    productOwnedFixture: true,
    freshInstall: sourceSchemaVersion === null,
    migrationApplied: sourceSchemaVersion === 18,
    reopenIdempotent: profile === "idempotent-v19-reopen",
  };
}

async function pathExists(pathname: string): Promise<boolean> {
  return (await stat(pathname).catch(() => undefined)) !== undefined;
}

async function moveSqliteDatabaseBundle(sourcePath: string, targetPath: string): Promise<void> {
  const sourceFiles = resolveSqliteDatabaseFilePaths(sourcePath);
  const targetFiles = resolveSqliteDatabaseFilePaths(targetPath);
  if (!(await pathExists(sourceFiles[0]!))) {
    throw new Error(`return-covenant database source is missing: ${sourcePath}`);
  }
  for (const targetFile of targetFiles) {
    if (await pathExists(targetFile)) {
      throw new Error(`return-covenant database target already exists: ${targetFile}`);
    }
  }
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const moved: Array<{ source: string; target: string }> = [];
  try {
    for (let index = 0; index < sourceFiles.length; index += 1) {
      const source = sourceFiles[index]!;
      const target = targetFiles[index]!;
      if (!(await pathExists(source))) {
        continue;
      }
      await rename(source, target);
      moved.push({ source, target });
    }
  } catch (error) {
    for (const entry of moved.toReversed()) {
      await rename(entry.target, entry.source).catch(() => undefined);
    }
    throw error;
  }
}

async function prepareAssignment(params: {
  assignment: ReturnCovenantDatabaseAssignment;
  env: NodeJS.ProcessEnv;
  runId: string;
}): Promise<void> {
  const { assignment, env, runId } = params;
  const options = { agentId: "proof", env, path: assignment.databasePath };
  const assignmentFingerprint = sha256ReturnCovenant(assignment.executionKey).slice(0, 24);
  const validSessionKey = `agent:proof:${runId}:${assignmentFingerprint}-valid`;
  const malformedSessionKey = `agent:proof:${runId}:${assignmentFingerprint}-malformed`;
  await mkdir(path.dirname(assignment.databasePath), { recursive: true, mode: 0o700 });
  const initial = openOpenClawAgentDatabase(options);
  assertAgentDatabaseHealthy(initial.db);
  await upsertSessionEntryCore(
    {
      agentId: "proof",
      env,
      sessionKey: validSessionKey,
      storePath: assignment.databasePath,
    },
    { sessionId: `${assignment.executionKey}-valid`, updatedAt: 10, createdVia: "internal" },
  );
  await upsertSessionEntryCore(
    {
      agentId: "proof",
      env,
      sessionKey: malformedSessionKey,
      storePath: assignment.databasePath,
    },
    { sessionId: `${assignment.executionKey}-malformed`, updatedAt: 20, createdVia: "internal" },
  );

  if (
    assignment.receipt.profile === "covenant-v18-upgrade" ||
    assignment.receipt.profile === "participant-v18-upgrade"
  ) {
    const staged = stageRecipientAuthorityV18Fixture({
      database: initial.db,
      importedEpoch: "11111111-1111-4111-8111-111111111111",
      lineage: assignment.receipt.profile === "covenant-v18-upgrade" ? "covenant" : "upstream",
      malformedSessionKey,
      retainedEpoch: "22222222-2222-4222-8222-222222222222",
      validSessionKey,
    });
    if (!disposeOpenClawAgentDatabaseByPath(assignment.databasePath, { env })) {
      throw new Error(`could not close staged ${assignment.executionKey} fixture`);
    }

    const migrationDatabase = openNodeSqliteDatabase(assignment.databasePath);
    try {
      await withAgentDatabaseMaintenanceLease({ env }, async () => {
        ensureOpenClawAgentDatabaseSchema(migrationDatabase, options);
      });
      assertAgentDatabaseHealthy(migrationDatabase);
      const migrated = asOptionalRecord(
        migrationDatabase
          .prepare("SELECT epoch FROM session_recipient_authority WHERE session_key = ?")
          .get(validSessionKey),
      );
      if (migrated?.epoch !== staged.expectedEpoch) {
        throw new Error(`${assignment.executionKey} did not preserve its accepted authority epoch`);
      }
      const malformed = migrationDatabase
        .prepare("SELECT epoch FROM session_recipient_authority WHERE session_key = ?")
        .get(malformedSessionKey);
      if (malformed !== undefined) {
        throw new Error(`${assignment.executionKey} imported a malformed authority epoch`);
      }
    } finally {
      migrationDatabase.close();
    }
  } else if (assignment.receipt.profile === "idempotent-v19-reopen") {
    const before = asOptionalRecord(
      initial.db.prepare("SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'").get(),
    );
    if (!disposeOpenClawAgentDatabaseByPath(assignment.databasePath, { env })) {
      throw new Error("could not close the v19 reopen fixture");
    }
    const reopened = openOpenClawAgentDatabase(options);
    assertAgentDatabaseHealthy(reopened.db);
    const after = asOptionalRecord(
      reopened.db.prepare("SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'").get(),
    );
    if (before?.updated_at !== after?.updated_at) {
      throw new Error("idempotent v19 reopen rewrote schema ownership metadata");
    }
  }

  const prepared = openOpenClawAgentDatabase(options);
  assertAgentDatabaseHealthy(prepared.db);
  checkpointAgentDatabase(prepared.db);
  if (!disposeOpenClawAgentDatabaseByPath(assignment.databasePath, { env })) {
    throw new Error(`could not retain prepared ${assignment.executionKey} fixture`);
  }
}

function countTemporarySessionsInDatabase(params: {
  databasePath: string;
  env: NodeJS.ProcessEnv;
  runSessionPrefix: string;
}): number {
  const result = withOpenClawAgentDatabaseReadOnly(
    ({ db: database }) => {
      const db = getNodeSqliteKysely<ReturnCovenantSessionDatabase>(database);
      return executeSqliteQuerySync(
        database,
        db
          .selectFrom("session_nodes")
          .select(["parent_session_key", "spawned_by"])
          .where("created_via", "=", "spawn"),
      ).rows.filter(
        (row) =>
          row.parent_session_key?.startsWith(params.runSessionPrefix) ||
          row.spawned_by?.startsWith(params.runSessionPrefix),
      ).length;
    },
    {
      agentId: "proof",
      env: params.env,
      path: params.databasePath,
    },
  );
  if (!result.found) {
    throw new Error(`return-covenant session database is unavailable: ${params.databasePath}`);
  }
  return result.value;
}

function buildAssignments(params: {
  fixtureRoot: string;
  plan: ReturnCovenantPlan;
}): Map<string, ReturnCovenantDatabaseAssignment> {
  const assignments = new Map<string, ReturnCovenantDatabaseAssignment>();
  for (const casePlan of params.plan.cases) {
    for (const form of casePlan.forms) {
      const key = executionKey(casePlan.id, form);
      assignments.set(key, {
        caseId: casePlan.id,
        databasePath: path.join(params.fixtureRoot, key, "openclaw-agent.sqlite"),
        executionKey: key,
        form,
        receipt: profileReceipt(casePlan.databaseProfile),
      });
    }
  }
  return assignments;
}

function assertGlobalDatabaseHealthy(env: NodeJS.ProcessEnv): void {
  const stateDatabase = openOpenClawStateDatabase({ env });
  const globalVersion = asOptionalRecord(stateDatabase.db.prepare("PRAGMA user_version").get());
  if (globalVersion?.user_version !== OPENCLAW_STATE_SCHEMA_VERSION) {
    throw new Error("return-covenant fixture did not create global schema v15");
  }
}

export class PreparedReturnCovenantDatabaseProfiles {
  readonly #assignments: Map<string, ReturnCovenantDatabaseAssignment>;
  readonly #canonicalDatabasePath: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #fixtureRoot: string;
  #activeExecutionKey: string | undefined;

  constructor(params: {
    activeExecutionKey?: string;
    assignments: Map<string, ReturnCovenantDatabaseAssignment>;
    canonicalDatabasePath: string;
    env: NodeJS.ProcessEnv;
    fixtureRoot: string;
  }) {
    this.#activeExecutionKey = params.activeExecutionKey;
    this.#assignments = params.assignments;
    this.#canonicalDatabasePath = params.canonicalDatabasePath;
    this.#env = params.env;
    this.#fixtureRoot = params.fixtureRoot;
  }

  get canonicalDatabasePath(): string {
    return this.#canonicalDatabasePath;
  }

  async activate(params: {
    caseId: string;
    form: ReturnCovenantForm;
    onActivated?: (activation: ReturnCovenantProfileActivation) => Promise<void> | void;
  }): Promise<ReturnCovenantDatabaseReceipt> {
    const key = executionKey(params.caseId, params.form);
    if (this.#activeExecutionKey) {
      throw new Error(
        `return-covenant database ${this.#activeExecutionKey} is still active before ${key}`,
      );
    }
    const assignment = this.#assignments.get(key);
    if (!assignment) {
      throw new Error(`return-covenant database assignment is missing: ${key}`);
    }
    closeOpenClawAgentDatabasesForTest();
    await moveSqliteDatabaseBundle(assignment.databasePath, this.#canonicalDatabasePath);
    this.#activeExecutionKey = key;
    try {
      await params.onActivated?.({
        caseId: assignment.caseId,
        databasePath: this.#canonicalDatabasePath,
        form: assignment.form,
        profile: assignment.receipt.profile,
      });
      const database = openOpenClawAgentDatabase({
        agentId: "proof",
        env: this.#env,
        path: this.#canonicalDatabasePath,
      });
      assertAgentDatabaseHealthy(database.db);
      return {
        ...assignment.receipt,
        canonicalFixtureReceiptId: `fixture-${sha256ReturnCovenant(
          stableStringify({
            caseId: assignment.caseId,
            executionKey: assignment.executionKey,
            form: assignment.form,
            profile: assignment.receipt.profile,
          }),
        ).slice(0, 32)}`,
      };
    } catch (error) {
      await this.deactivate({ caseId: params.caseId, form: params.form }).catch(() => undefined);
      throw error;
    }
  }

  assertActive(caseId: string, form: ReturnCovenantForm): void {
    const key = executionKey(caseId, form);
    if (this.#activeExecutionKey !== key) {
      throw new Error(`return-covenant case ${key} does not own the active migrated database`);
    }
  }

  async deactivate(params: { caseId: string; form: ReturnCovenantForm }): Promise<void> {
    const key = executionKey(params.caseId, params.form);
    if (this.#activeExecutionKey !== key) {
      throw new Error(`return-covenant database ${key} is not active`);
    }
    const assignment = this.#assignments.get(key);
    if (!assignment) {
      throw new Error(`return-covenant database assignment is missing: ${key}`);
    }
    const database = openOpenClawAgentDatabase({
      agentId: "proof",
      env: this.#env,
      path: this.#canonicalDatabasePath,
    });
    checkpointAgentDatabase(database.db);
    closeOpenClawAgentDatabasesForTest();
    await moveSqliteDatabaseBundle(this.#canonicalDatabasePath, assignment.databasePath);
    this.#activeExecutionKey = undefined;
  }

  async retainCanonical(params: { caseId: string; form: ReturnCovenantForm }): Promise<void> {
    const key = executionKey(params.caseId, params.form);
    this.assertActive(params.caseId, params.form);
    const database = openOpenClawAgentDatabase({
      agentId: "proof",
      env: this.#env,
      path: this.#canonicalDatabasePath,
    });
    checkpointAgentDatabase(database.db);
    closeOpenClawAgentDatabasesForTest();
    if (!(await pathExists(this.#canonicalDatabasePath))) {
      throw new Error(`return-covenant canonical database disappeared: ${key}`);
    }
  }

  async completeActiveCase(params: {
    caseId: string;
    form: ReturnCovenantForm;
    retainCanonical: boolean;
  }): Promise<void> {
    if (params.retainCanonical) {
      await this.retainCanonical(params);
      return;
    }
    await this.deactivate(params);
  }

  snapshot(): ReturnCovenantDatabaseProfilesSnapshot {
    return { activeExecutionKey: this.#activeExecutionKey ?? null };
  }

  receiptFor(params: {
    caseHandle: string;
    caseId: string;
    form: ReturnCovenantForm;
    gateway: ReturnCovenantGatewayBinding;
    runId: string;
  }): ReturnCovenantDatabaseReceipt {
    const key = executionKey(params.caseId, params.form);
    this.assertActive(params.caseId, params.form);
    const assignment = this.#assignments.get(key);
    if (!assignment) {
      throw new Error(`return-covenant database assignment is missing: ${key}`);
    }
    return {
      ...assignment.receipt,
      canonicalFixtureReceiptId: `fixture-${sha256ReturnCovenant(
        stableStringify({
          caseHandle: params.caseHandle,
          executionKey: assignment.executionKey,
          gateway: params.gateway,
          profile: assignment.receipt.profile,
          runId: params.runId,
        }),
      ).slice(0, 32)}`,
    };
  }

  countTemporarySessions(runSessionPrefix: string): number {
    let count = 0;
    for (const assignment of this.#assignments.values()) {
      const active = assignment.executionKey === this.#activeExecutionKey;
      const storePath = active ? this.#canonicalDatabasePath : assignment.databasePath;
      count += countTemporarySessionsInDatabase({
        databasePath: storePath,
        env: this.#env,
        runSessionPrefix,
      });
    }
    return count;
  }

  async assertCanonicalObservationStore(): Promise<void> {
    const stateDir = this.#env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("return-covenant fixture lost its isolated state directory");
    }
    const directories = await readdir(path.join(stateDir, "agents"), {
      withFileTypes: true,
    });
    const registered = listOpenClawRegisteredAgentDatabases({
      env: this.#env,
      includeIncompatibleSchemaVersions: true,
    });
    const directoryNames = directories.map((directory) => directory.name).toSorted();
    const registeredAgentIds = registered.map((database) => database.agentId).toSorted();
    if (
      directories.some((directory) => !directory.isDirectory() || directory.isSymbolicLink()) ||
      stableStringify(directoryNames) !== stableStringify(registeredAgentIds) ||
      !registered.some(
        (database) =>
          database.agentId === "proof" &&
          path.resolve(database.path) === this.#canonicalDatabasePath,
      )
    ) {
      throw new Error("return-covenant final agent database is not canonical");
    }
    for (const database of registered) {
      const canonicalPath = resolveOpenClawAgentSqlitePath({
        agentId: database.agentId,
        env: this.#env,
      });
      if (
        database.schemaVersion !== OPENCLAW_AGENT_SCHEMA_VERSION ||
        path.resolve(database.path) !== canonicalPath ||
        !(await pathExists(canonicalPath))
      ) {
        throw new Error("return-covenant final agent database is not canonical");
      }
    }
  }

  async close(mode?: "preserve-active" | "retain-canonical"): Promise<void> {
    closeOpenClawAgentDatabasesForTest();
    if (mode === "preserve-active") {
      return;
    }
    if (mode === "retain-canonical") {
      if (!this.#activeExecutionKey || !(await pathExists(this.#canonicalDatabasePath))) {
        throw new Error("return-covenant final canonical database is missing");
      }
      this.#activeExecutionKey = undefined;
      await rm(this.#fixtureRoot, { recursive: true, force: true });
      await this.assertCanonicalObservationStore();
      return;
    }
    if (this.#activeExecutionKey) {
      const separator = this.#activeExecutionKey.lastIndexOf(":");
      const caseId = this.#activeExecutionKey.slice(0, separator);
      const form = this.#activeExecutionKey.slice(separator + 1);
      if (!caseId || (form !== "typed-tool" && form !== "bracket-token")) {
        throw new Error("return-covenant active database assignment is malformed");
      }
      await this.deactivate({ caseId, form });
    }
    closeOpenClawAgentDatabasesForTest();
    await rm(this.#fixtureRoot, { recursive: true, force: true });
  }
}

export async function prepareReturnCovenantDatabaseProfiles(params: {
  env: NodeJS.ProcessEnv;
  plan: ReturnCovenantPlan;
}): Promise<PreparedReturnCovenantDatabaseProfiles> {
  assertGlobalDatabaseHealthy(params.env);
  const stateDir = params.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("return-covenant fixture requires an isolated state directory");
  }
  const fixtureRoot = path.resolve(stateDir, "return-covenant-migration-fixtures");
  const canonicalDatabasePath = resolveOpenClawAgentSqlitePath({
    agentId: "proof",
    env: params.env,
  });
  await mkdir(fixtureRoot, { recursive: false, mode: 0o700 });
  const assignments = buildAssignments({ fixtureRoot, plan: params.plan });
  try {
    for (const assignment of assignments.values()) {
      await prepareAssignment({
        assignment,
        env: params.env,
        runId: params.plan.runId,
      });
    }
    return new PreparedReturnCovenantDatabaseProfiles({
      assignments,
      canonicalDatabasePath,
      env: params.env,
      fixtureRoot,
    });
  } catch (error) {
    closeOpenClawAgentDatabasesForTest();
    await rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreReturnCovenantDatabaseProfiles(params: {
  env: NodeJS.ProcessEnv;
  plan: ReturnCovenantPlan;
  snapshot: ReturnCovenantDatabaseProfilesSnapshot;
}): Promise<PreparedReturnCovenantDatabaseProfiles> {
  assertGlobalDatabaseHealthy(params.env);
  const stateDir = params.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("return-covenant fixture requires an isolated state directory");
  }
  const fixtureRoot = path.resolve(stateDir, "return-covenant-migration-fixtures");
  const canonicalDatabasePath = resolveOpenClawAgentSqlitePath({
    agentId: "proof",
    env: params.env,
  });
  const assignments = buildAssignments({ fixtureRoot, plan: params.plan });
  const activeExecutionKey = params.snapshot.activeExecutionKey ?? undefined;
  if (activeExecutionKey && !assignments.has(activeExecutionKey)) {
    throw new Error("return-covenant restored an unknown active database assignment");
  }
  for (const assignment of assignments.values()) {
    const expectedPath =
      assignment.executionKey === activeExecutionKey
        ? canonicalDatabasePath
        : assignment.databasePath;
    if (!(await pathExists(expectedPath))) {
      throw new Error(`return-covenant restored database is missing: ${assignment.executionKey}`);
    }
  }
  if (!activeExecutionKey && (await pathExists(canonicalDatabasePath))) {
    throw new Error("return-covenant restored an unowned canonical database");
  }
  const profiles = new PreparedReturnCovenantDatabaseProfiles({
    ...(activeExecutionKey ? { activeExecutionKey } : {}),
    assignments,
    canonicalDatabasePath,
    env: params.env,
    fixtureRoot,
  });
  if (activeExecutionKey) {
    const database = openOpenClawAgentDatabase({
      agentId: "proof",
      env: params.env,
      path: canonicalDatabasePath,
    });
    assertAgentDatabaseHealthy(database.db);
  }
  return profiles;
}

export function closeReturnCovenantGlobalStore(): void {
  closeOpenClawStateDatabaseForTest();
}
