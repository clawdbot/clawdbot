import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import { appendTranscriptEventsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import { createUpdateRun, recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createUpdateProgress } from "./progress.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  continueMigratedUpdateInFreshProcess,
  inspectActivatedUpdateState,
} from "./update-command-migrated.js";
import { createUpdateRunProgress } from "./update-command-run.js";

// Model the already-running updater's older schema contract. The candidate
// worker is a real unmocked process with the checkout's current contract.
vi.mock("../../state/openclaw-state-db-contract.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-state-db-contract.js")>();
  return { ...actual, OPENCLAW_STATE_SCHEMA_VERSION: actual.OPENCLAW_STATE_SCHEMA_VERSION - 1 };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
let presentation: ReturnType<typeof createUpdateProgress> | undefined;
afterEach(() => {
  presentation?.suspend();
  presentation?.dispose();
  presentation = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each([
  { agentId: "main", changed: "none", blocked: undefined },
  { agentId: "verification", changed: "none", blocked: undefined },
  { agentId: "main", changed: "shared", blocked: "state-migrated-no-rollback" },
  { agentId: "main", changed: "agent", blocked: "state-migrated-no-rollback" },
])(
  "classifies activation after first-use database creation (agent=$agentId, changed=$changed)",
  async ({ agentId, changed, blocked }) => {
    const stateDir = await fs.realpath(dirs.make("update-first-serving-turn-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const shared = openOpenClawStateDatabase({ env });
    const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config: {}, env });
    const agentPath = path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
    expect(
      schemaVersions.find((entry) => entry.path === agentPath)?.userVersion ?? null,
    ).toBeNull();

    runOpenClawAgentWriteTransaction(
      (database) => {
        appendTranscriptEventsInTransaction(
          database,
          { agentId, sessionKey: `agent:${agentId}:update-check`, sessionId: "serving-check" },
          [
            {
              type: "message",
              id: "request",
              parentId: null,
              message: { role: "user", content: "Reply with update-verified-run" },
            },
            {
              type: "message",
              id: "reply",
              parentId: "request",
              message: {
                role: "assistant",
                content: "update-verified-run",
                provider: "openai",
                model: "gpt-4.1-mini",
                stopReason: "stop",
                __openclaw: { runId: "run" },
              },
            },
          ],
        );
      },
      { agentId, env },
    );
    closeOpenClawAgentDatabasesForTest();
    if (changed !== "none") {
      const db = new DatabaseSync(changed === "shared" ? shared.path : agentPath);
      try {
        db.exec(
          `PRAGMA user_version = ${changed === "shared" ? OPENCLAW_STATE_SCHEMA_VERSION + 1 : OPENCLAW_AGENT_SCHEMA_VERSION + 1}`,
        );
      } finally {
        db.close();
      }
    }
    const result = {
      status: "ok" as const,
      mode: "npm" as const,
      root: process.cwd(),
      steps: [],
      durationMs: 0,
    };
    await expect(
      inspectActivatedUpdateState({
        result,
        root: process.cwd(),
        schemaVersions,
        candidateSchemaVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION + Number(changed === "shared"),
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
        config: {},
        env,
      }),
    ).resolves.toBe(blocked);
  },
);

it("refuses state inspection when activation leaves no known runtime root", async () => {
  const result = { status: "error" as const, mode: "npm" as const, steps: [], durationMs: 0 };
  await expect(
    inspectActivatedUpdateState({
      result,
      root: process.cwd(),
      schemaVersions: [],
      config: {},
      env: { OPENCLAW_STATE_DIR: dirs.make("unknown-update-runtime-") },
    }),
  ).resolves.toBe("rollback-state-unverified");
  expect(result).toMatchObject({
    reason: "rollback-state-unverified",
    steps: [expect.objectContaining({ name: "state schema verification", exitCode: 1 })],
  });
});

it.each([
  { beforeContent: false, publish: false, blocked: "state-migrated-no-rollback" },
  { beforeContent: true, publish: false, blocked: undefined },
  { beforeContent: true, publish: true, blocked: undefined },
])(
  "accepts applied shared content through activation (alreadyApplied=$beforeContent, published=$publish)",
  async ({ beforeContent, publish, blocked }) => {
    const stateDir = await fs.realpath(dirs.make("update-deferred-content-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const shared = openOpenClawStateDatabase({ env });
    const contentVersion = OPENCLAW_STATE_SCHEMA_VERSION + 1;
    const markContentApplied = () =>
      shared.db
        .prepare(
          "INSERT OR REPLACE INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
        )
        .run("state.schema.contentVersion", JSON.stringify(contentVersion), Date.now());
    if (beforeContent) {
      markContentApplied();
    }
    const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config: {}, env });
    markContentApplied();
    if (publish) {
      shared.db.exec(`PRAGMA user_version = ${contentVersion};`);
    }
    const result = {
      status: "ok" as const,
      mode: "npm" as const,
      root: process.cwd(),
      steps: [],
      durationMs: 0,
    };
    await expect(
      inspectActivatedUpdateState({
        result,
        root: process.cwd(),
        schemaVersions,
        candidateSchemaVersions: { state: contentVersion, agent: OPENCLAW_AGENT_SCHEMA_VERSION },
        config: {},
        env,
      }),
    ).resolves.toBe(blocked);
    expect(result).toMatchObject({ status: "ok", steps: [] });
    expect(shared.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
      publish ? contentVersion : OPENCLAW_STATE_SCHEMA_VERSION,
    );
  },
);

it.each([
  { json: false, legacy: false },
  { json: true, legacy: false },
  { json: false, legacy: true },
])(
  "fences migrated candidate finalization (json=$json, legacy=$legacy)",
  async ({ json, legacy }) => {
    const stateDir = await fs.realpath(dirs.make("migrated-update-"));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_TEST_RUNTIME_LOG: "1",
    };
    const root = legacy ? path.join(stateDir, "legacy-runtime") : process.cwd();
    const legacyEffect = path.join(stateDir, "legacy-worker-effect");
    if (legacy) {
      const worker = path.join(root, "dist", "infra", "update-migrated-finalize.worker.js");
      await fs.mkdir(path.dirname(worker), { recursive: true });
      await fs.writeFile(
        worker,
        `
        const fs = require("node:fs");
        const { DatabaseSync } = require("node:sqlite");
        if (process.argv[2] === "--check") {
          process.stdout.write(JSON.stringify({state:${OPENCLAW_STATE_SCHEMA_VERSION + 1}, agent:${OPENCLAW_AGENT_SCHEMA_VERSION}}));
        } else {
          const input = JSON.parse(fs.readFileSync(0,"utf8"));
          fs.writeFileSync(${JSON.stringify(legacyEffect)}, "unfenced effect");
          const db = new DatabaseSync(${JSON.stringify(path.join(stateDir, "state", "openclaw.sqlite"))});
          db.prepare("UPDATE update_runs SET status = 'failed', phase = 'finished', finished_at_ms = 1 WHERE run_id = ?").run(input.params.opts.run.runId);
          db.close();
          fs.writeFileSync(input.resultPath, JSON.stringify({result:{...input.params.result,runId:input.params.opts.run.runId},exitCode:1,terminalRunId:input.params.opts.run.runId}));
        }
      `,
      );
    }
    const created = createUpdateRun({ trigger: "cli" }, { env });
    const run = { runId: created.runId, env };
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    presentation = createUpdateProgress(!json, run);
    const progress = createUpdateRunProgress(run, presentation.progress);
    presentation.suspend();
    progress.deferLedgerWrites();
    const migrationStep = { name: "core migrations", command: "doctor --fix", index: 0, total: 1 };
    progress.onStepStart?.(migrationStep);
    const database = openOpenClawStateDatabase({ env });
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    const migrated = new DatabaseSync(database.path);
    try {
      migrated.exec(`
      BEGIN IMMEDIATE;
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};
      UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1} WHERE meta_key = 'primary';
      COMMIT;
    `);
    } finally {
      migrated.close();
    }
    expect(() =>
      recordUpdateRunStep(created.runId, { step: "old writer", status: "completed" }, { env }),
    ).toThrow(/newer schema version/);
    expect(() =>
      progress.onStepComplete?.({ ...migrationStep, durationMs: 100, exitCode: 1 }),
    ).not.toThrow();
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(() => presentation?.dispose()).not.toThrow();
    presentation = undefined;
    vi.useRealTimers();
    const rollback = vi.fn();
    let terminalAtCleanup: unknown;
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });

    const control = path.join(stateDir, "executor-control");
    await fs.mkdir(control);
    vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const family = async () =>
      Promise.all(
        [database.path, database.path + "-wal", database.path + "-shm"].map((file) =>
          fs.readFile(file).catch((error: unknown) => {
            if (hasNodeErrorCode(error, "ENOENT")) {
              return null;
            }
            throw new Error("Could not inspect the isolated database family.", { cause: error });
          }),
        ),
      );
    const before = legacy ? await family() : undefined;
    const work = withUpdateCommandExecutor(run.runId, async (executor) => {
      const executorFence = await executor.enter(root);
      return await continueMigratedUpdateInFreshProcess(
        {
          mutationStarted: true,
          result: {
            status: "error",
            reason: "doctor-failed",
            mode: "npm",
            root,
            steps: [],
            durationMs: 0,
          },
          root,
          installKindChanged: false,
          configSnapshot: {
            path: path.join(stateDir, "openclaw.json"),
            exists: false,
            raw: null,
            parsed: {},
            sourceConfig: asResolvedSourceConfig({}),
            resolved: asResolvedSourceConfig({}),
            valid: true,
            runtimeConfig: asRuntimeConfig({}),
            config: asRuntimeConfig({}),
            issues: [],
            warnings: [],
            legacyIssues: [],
          },
          requestedChannel: null,
          storedChannel: "stable",
          channel: "stable",
          downgradeRisk: false,
          shouldRestart: false,
          opts: { json, run: { ...run, executorFence } },
          packageTransaction: {
            backupRoot: path.join(stateDir, "retained-package"),
            rollback,
            complete: async () => {
              const inspected = new DatabaseSync(database.path, { readOnly: true });
              try {
                terminalAtCleanup = inspected
                  .prepare("SELECT status, reason FROM update_runs WHERE run_id = ?")
                  .get(created.runId);
              } finally {
                inspected.close();
              }
            },
          },
          controlPlaneUpdateSentinelMeta: null,
          preUpdatePluginInstallRecords: {},
          startedAt: Date.now(),
          packageUpdateNodeRunner: process.execPath,
          updateStepTimeoutMs: 1_000,
          rollbackBlockedReason: "state-migrated-no-rollback",
        },
        progress.pendingSteps,
      );
    });
    if (legacy) {
      await expect(work).rejects.toThrow(/live executor delegation/);
      await expect(fs.access(legacyEffect)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await family()).toEqual(before);
      expect(terminalAtCleanup).toBeUndefined();
      return;
    }
    const result = await work;
    expect(result.automaticTriage).toMatchObject({
      kind: "update",
      phase: "state-migrated-no-rollback",
      installationRoot: root,
      gateway: "preserve",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result).toMatchObject({
      runId: created.runId,
      status: "error",
      reason: "state-migrated-no-rollback",
    });
    expect(rollback).not.toHaveBeenCalled();
    expect(terminalAtCleanup).toEqual({ status: "failed", reason: "state-migrated-no-rollback" });
    if (json) {
      expect(log).not.toHaveBeenCalled();
      expect(JSON.parse(stdout)).toMatchObject({
        runId: created.runId,
        run: { runId: created.runId, status: "failed", reason: "state-migrated-no-rollback" },
      });
    } else {
      expect(stdout).toMatch(/update failed/iu);
    }
    const inspected = new DatabaseSync(database.path, { readOnly: true });
    try {
      const row = inspected
        .prepare("SELECT status, reason, steps_json FROM update_runs WHERE run_id = ?")
        .get(created.runId);
      expect(row).toMatchObject({ status: "failed", reason: "state-migrated-no-rollback" });
      expect(JSON.parse(String(row?.steps_json))).toEqual(
        expect.arrayContaining([progress.pendingSteps.at(-1)]),
      );
    } finally {
      inspected.close();
    }
  },
  30_000,
);
