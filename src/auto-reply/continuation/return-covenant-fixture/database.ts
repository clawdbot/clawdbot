import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { openNodeSqliteDatabase } from "../../../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  disposeOpenClawAgentDatabaseByPath,
  ensureOpenClawAgentDatabaseSchema,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  withAgentDatabaseMaintenanceLease,
} from "../../../state/openclaw-agent-db.js";
import { stageRecipientAuthorityV18Fixture } from "../../../state/openclaw-agent-recipient-authority-fixture.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { sha256ReturnCovenant, type ReturnCovenantPlan } from "./protocol.js";

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

export type PreparedReturnCovenantDatabaseProfiles = Map<
  ReturnCovenantDatabaseProfile,
  Omit<ReturnCovenantDatabaseReceipt, "canonicalFixtureReceiptId">
>;

const fixtureShapeByProfile = {
  "fresh-v19": "fresh",
  "covenant-v18-upgrade": "covenant-v18",
  "participant-v18-upgrade": "participant-v18",
  "idempotent-v19-reopen": "v19-reopen",
} as const satisfies Record<ReturnCovenantDatabaseProfile, string>;

function readVersion(database: ReturnType<typeof openOpenClawAgentDatabase>["db"]): number {
  const row = database.prepare("PRAGMA user_version").get() as
    | { user_version?: unknown }
    | undefined;
  if (row?.user_version !== OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new Error("return-covenant fixture did not reach agent schema v19");
  }
  return OPENCLAW_AGENT_SCHEMA_VERSION;
}

function assertAgentDatabaseHealthy(
  database: ReturnType<typeof openOpenClawAgentDatabase>["db"],
): void {
  readVersion(database);
  const metadata = database
    .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
    .get() as { schema_version?: unknown } | undefined;
  if (metadata?.schema_version !== OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new Error("return-covenant fixture agent schema metadata is not v19");
  }
  if (database.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error("return-covenant fixture agent database failed foreign-key validation");
  }
  const integrity = database.prepare("PRAGMA integrity_check").get() as
    | { integrity_check?: unknown }
    | undefined;
  if (integrity?.integrity_check !== "ok") {
    throw new Error("return-covenant fixture agent database failed integrity validation");
  }
}

function profileReceipt(
  profile: ReturnCovenantDatabaseProfile,
): Omit<ReturnCovenantDatabaseReceipt, "canonicalFixtureReceiptId"> {
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

async function prepareProfile(params: {
  env: NodeJS.ProcessEnv;
  fixtureRoot: string;
  profile: ReturnCovenantDatabaseProfile;
  runId: string;
}): Promise<void> {
  const agentId = "main";
  const profileRoot = path.resolve(params.fixtureRoot, params.profile);
  const databasePath = path.join(profileRoot, "openclaw-agent.sqlite");
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  const options = { agentId, env: params.env, path: databasePath };
  const validSessionKey = `agent:main:${params.runId}:${params.profile}:valid`;
  const malformedSessionKey = `agent:main:${params.runId}:${params.profile}:malformed`;
  await upsertSessionEntryCore(
    {
      agentId,
      env: params.env,
      sessionKey: validSessionKey,
      storePath: databasePath,
    },
    { sessionId: `${params.profile}-valid`, updatedAt: 10, createdVia: "internal" },
  );
  await upsertSessionEntryCore(
    {
      agentId,
      env: params.env,
      sessionKey: malformedSessionKey,
      storePath: databasePath,
    },
    { sessionId: `${params.profile}-malformed`, updatedAt: 20, createdVia: "internal" },
  );
  const initial = openOpenClawAgentDatabase(options);
  assertAgentDatabaseHealthy(initial.db);

  if (params.profile === "covenant-v18-upgrade" || params.profile === "participant-v18-upgrade") {
    const staged = stageRecipientAuthorityV18Fixture({
      database: initial.db,
      importedEpoch: "11111111-1111-4111-8111-111111111111",
      lineage: params.profile === "covenant-v18-upgrade" ? "covenant" : "upstream",
      malformedSessionKey,
      retainedEpoch: "22222222-2222-4222-8222-222222222222",
      validSessionKey,
    });
    if (!disposeOpenClawAgentDatabaseByPath(databasePath, { env: params.env })) {
      throw new Error(`could not close staged ${params.profile} fixture`);
    }
    const migrationDatabase = openNodeSqliteDatabase(databasePath);
    try {
      await withAgentDatabaseMaintenanceLease({ env: params.env }, async () => {
        ensureOpenClawAgentDatabaseSchema(migrationDatabase, options);
      });
      assertAgentDatabaseHealthy(migrationDatabase);
      const migrated = migrationDatabase
        .prepare("SELECT epoch FROM session_recipient_authority WHERE session_key = ?")
        .get(validSessionKey) as { epoch?: unknown } | undefined;
      if (migrated?.epoch !== staged.expectedEpoch) {
        throw new Error(`${params.profile} did not preserve its accepted authority epoch`);
      }
      const malformed = migrationDatabase
        .prepare("SELECT epoch FROM session_recipient_authority WHERE session_key = ?")
        .get(malformedSessionKey);
      if (malformed !== undefined) {
        throw new Error(`${params.profile} imported a malformed authority epoch`);
      }
    } finally {
      migrationDatabase.close();
    }
    const reopened = openOpenClawAgentDatabase(options);
    assertAgentDatabaseHealthy(reopened.db);
  } else if (params.profile === "idempotent-v19-reopen") {
    const before = initial.db
      .prepare("SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'")
      .get() as { updated_at?: unknown } | undefined;
    if (!closeOpenClawAgentDatabaseByPath(databasePath)) {
      throw new Error("could not close the v19 reopen fixture");
    }
    const reopened = openOpenClawAgentDatabase(options);
    assertAgentDatabaseHealthy(reopened.db);
    const after = reopened.db
      .prepare("SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'")
      .get() as { updated_at?: unknown } | undefined;
    if (before?.updated_at !== after?.updated_at) {
      throw new Error("idempotent v19 reopen rewrote schema ownership metadata");
    }
  }

  if (!disposeOpenClawAgentDatabaseByPath(databasePath, { env: params.env })) {
    throw new Error(`could not dispose ${params.profile} fixture`);
  }
  await rm(profileRoot, { recursive: true, force: true });
}

export async function prepareReturnCovenantDatabaseProfiles(params: {
  env: NodeJS.ProcessEnv;
  plan: ReturnCovenantPlan;
}): Promise<PreparedReturnCovenantDatabaseProfiles> {
  const stateDatabase = openOpenClawStateDatabase({ env: params.env });
  const globalVersion = stateDatabase.db.prepare("PRAGMA user_version").get() as
    | { user_version?: unknown }
    | undefined;
  if (globalVersion?.user_version !== OPENCLAW_STATE_SCHEMA_VERSION) {
    throw new Error("return-covenant fixture did not create global schema v15");
  }
  const stateDir = params.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("return-covenant fixture requires an isolated state directory");
  }
  const fixtureRoot = path.resolve(stateDir, "return-covenant-migration-fixtures");
  await mkdir(fixtureRoot, { recursive: false, mode: 0o700 });
  try {
    const profiles = [
      "fresh-v19",
      "covenant-v18-upgrade",
      "participant-v18-upgrade",
      "idempotent-v19-reopen",
    ] as const satisfies readonly ReturnCovenantDatabaseProfile[];
    for (const profile of profiles) {
      await prepareProfile({
        env: params.env,
        fixtureRoot,
        profile,
        runId: params.plan.runId,
      });
    }
    return new Map(profiles.map((profile) => [profile, profileReceipt(profile)]));
  } finally {
    closeOpenClawAgentDatabasesForTest();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

export function bindReturnCovenantDatabaseReceipt(params: {
  caseHandle: string;
  profiles: PreparedReturnCovenantDatabaseProfiles;
  profile: ReturnCovenantDatabaseProfile;
  runId: string;
}): ReturnCovenantDatabaseReceipt {
  const receipt = params.profiles.get(params.profile);
  if (!receipt) {
    throw new Error(`return-covenant database profile was not prepared: ${params.profile}`);
  }
  return {
    ...receipt,
    canonicalFixtureReceiptId: `fixture-${sha256ReturnCovenant(
      stableStringify({
        caseHandle: params.caseHandle,
        profile: params.profile,
        runId: params.runId,
      }),
    ).slice(0, 32)}`,
  };
}

export function openReturnCovenantProductStores(env: NodeJS.ProcessEnv): {
  agentDatabasePath: string;
  stateDatabasePath: string;
} {
  const stateDatabase = openOpenClawStateDatabase({ env });
  const agentDatabase = openOpenClawAgentDatabase({ agentId: "proof", env });
  assertAgentDatabaseHealthy(agentDatabase.db);
  return {
    agentDatabasePath: agentDatabase.path,
    stateDatabasePath: stateDatabase.path,
  };
}

export function closeReturnCovenantProductStores(): void {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}
