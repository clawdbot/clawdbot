import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db.js";
import { acquireOpenClawStateDatabaseFileExclusion } from "../state/openclaw-state-db-cache.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { inspectCheckpointFile } from "./update-checkpoint-files.js";
import { buildCheckpointReaderRuntime } from "./update-checkpoint-runtime.test-support.js";
import { captureUpdateCheckpoint } from "./update-checkpoint.js";
import { createUpdateRun } from "./update-run-ledger.js";
import { beginUpdateRecovery, recordUpdateRecoveryIntent } from "./update-run-recovery.js";

/** Physical owner only: unlike the lease capture adapter, this owner permits replacement.
 * Tests must leave all lexical lease callbacks before acquiring it. It does NOT
 * demonstrate the still-missing live-lease publication/rebind adapter.
 */
export async function withPublicationFiles<T>(
  files: readonly string[],
  operation: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  const owners: ReturnType<typeof acquireOpenClawStateDatabaseFileExclusion>[] = [];
  try {
    for (const file of files) {
      owners.push(acquireOpenClawStateDatabaseFileExclusion(file));
    }
    const assertCurrent = () => {
      for (const owner of owners) {
        owner.assertCurrent();
      }
    };
    const readScope = (index: number): Promise<T> => {
      const owner = owners[index];
      return owner
        ? owner.runWithSourceReads(() => readScope(index + 1))
        : operation(assertCurrent);
    };
    return await readScope(0);
  } finally {
    for (const owner of owners.toReversed()) {
      owner.release();
    }
  }
}

export async function publicationFixture(root: string, pauseReader = false) {
  const stateDir = path.join(root, "live");
  const options = { env: { HOME: root, OPENCLAW_STATE_DIR: stateDir } };
  const built = await buildCheckpointReaderRuntime(
    path.join(root, "previous"),
    false,
    pauseReader,
    {
      agentReader: !pauseReader,
    },
  );
  const runtime = { ...built.runtime, buildId: null };
  const run = createUpdateRun({ trigger: "cli" }, options);
  const sharedPath = path.join(stateDir, "state", "openclaw.sqlite");
  const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  const agent = new DatabaseSync(agentPath);
  try {
    agent.exec(`BEGIN; ${built.agentSchema}; PRAGMA user_version=${built.agentSchemaVersion};`);
    agent
      .prepare(
        "INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,created_at,updated_at) VALUES('primary','agent',?,'main',1,1)",
      )
      .run(built.agentSchemaVersion);
    agent.exec("COMMIT");
  } finally {
    agent.close();
  }
  const configPath = path.join(stateDir, "openclaw.json");
  const access = {
    artifactRoot: path.join(root, "artifacts"),
    binding: { runId: run.runId, stateDir, configPath, fromRuntime: built.runtime },
  };
  // Create and capture under the REAL nested plugin/maintenance owners. Their
  // workers are joined by capture and renewed only after unchanged-generation validation.
  const setup = await withPluginLifecycleLease({ env: options.env }, async (plugin) =>
    withAgentDatabaseMaintenanceLease({ env: options.env }, async (maintenance) => {
      const capture = maintenance.withDatabaseFileExclusion;
      if (!capture) {
        throw new Error("missing maintenance capture");
      }
      const fence = {
        assertCurrent: () => {
          plugin.assertOwned();
          maintenance.assertOwned();
        },
      };
      let record = beginUpdateRecovery(
        { runId: run.runId, from: runtime, to: runtime },
        fence,
        options,
      );
      const snapshot = async (content: string) => {
        await fs.writeFile(configPath, content);
        const state = await inspectCheckpointFile(configPath);
        return capture((assertCurrent) =>
          captureUpdateCheckpoint({
            ...access,
            assertQuiescent: assertCurrent,
            exclusions: [],
            expectedSources: [{ sourcePath: configPath, state }],
            resources: [
              { sourcePath: sharedPath, kind: "sqlite", restore: "replace" },
              { sourcePath: agentPath, kind: "sqlite", restore: "replace" },
              { sourcePath: configPath, kind: "config", restore: "replace" },
            ],
          }),
        );
      };
      const checkpointRef = await snapshot("previous config");
      const afterUpdateRef = await snapshot("candidate config");
      record = recordUpdateRecoveryIntent(
        record,
        {
          effectId: randomUUID(),
          kind: "checkpoint-restore",
          resourceId: checkpointRef.checkpointId,
          runtime: "previous",
        },
        fence,
        options,
      );
      return { record, checkpointRef, afterUpdateRef };
    }),
  );
  closeOpenClawStateDatabaseForTest();
  return {
    ...setup,
    access,
    options,
    sharedPath,
    agentPath,
    configPath,
    runtime,
    files: [sharedPath, agentPath],
  };
}
