import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { LegacyStateMigrationPlan } from "../infra/state-migrations.types.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../infra/update-control-plane-sentinel.js";
import { getUpdateRun } from "../infra/update-run-ledger.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { formatCliProcessFailure, runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function snapshotTree(root: string): Promise<string[]> {
  const snapshot: string[] = [];
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot.push(`d ${relativePath}`);
        await walk(absolutePath, relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        snapshot.push(`l ${relativePath} ${await fs.readlink(absolutePath)}`);
        continue;
      }
      snapshot.push(`f ${relativePath} ${await sha256File(absolutePath)}`);
    }
  };
  await walk(root, "");
  return snapshot;
}

async function sha256File(filePath: string): Promise<string> {
  const contents = await fs.readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

function runUpdateProcess(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const configPath = path.join(root, "config", "openclaw.json");
  const stateDir = path.join(root, "state");
  const entryPath = path.resolve("openclaw.mjs");
  return spawnSync(process.execPath, [entryPath, ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      ALL_PROXY: undefined,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      NODE_DISABLE_COMPILE_CACHE: "1",
      NODE_ENV: undefined,
      NODE_OPTIONS: undefined,
      NO_COLOR: "1",
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DEBUG_PROXY_ENABLED: undefined,
      OPENCLAW_DEBUG_PROXY_REQUIRE: undefined,
      OPENCLAW_HIDE_BANNER: "1",
      OPENCLAW_HOME: root,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      VITEST: undefined,
      VITEST_POOL_ID: undefined,
      VITEST_WORKER_ID: undefined,
      all_proxy: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
      ...env,
    },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  });
}

async function expectPreviewLedger(root: string, runId: string, before: string[]): Promise<void> {
  const after = await snapshotTree(root);
  const ledgerArtifacts = after.filter((entry) =>
    /^(?:d state\/state$|f state\/state\/openclaw\.sqlite(?:-(?:wal|shm))? )/.test(entry),
  );
  expect(ledgerArtifacts).toContain("d state/state");
  expect(ledgerArtifacts).toContainEqual(
    expect.stringMatching(/^f state\/state\/openclaw\.sqlite [a-f0-9]{64}$/),
  );
  expect(after.filter((entry) => !ledgerArtifacts.includes(entry))).toEqual(before);

  const status = runUpdateProcess(root, ["update", "status", "--json"]);
  expect(status.error).toBeUndefined();
  expect(status.status, status.stderr).toBe(0);
  const report = JSON.parse(status.stdout);
  expect(report.activeRun).toBeUndefined();
  expect(report.lastRun).toMatchObject({
    runId,
    trigger: "cli",
    phase: "finished",
    status: "skipped",
    reason: "dry-run",
  });
}

describe("update process state", () => {
  it("allows cleanup after an admitted updater dies without finishing its ledger", async () => {
    const root = tempDirs.make("openclaw-cleanup-orphan-");
    const configPath = path.join(root, "config", "openclaw.json");
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    };
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, '{"gateway":{"mode":"local"}}\n');
    const entry = path.join(root, "admit.mjs");
    const admissionModule = pathToFileURL(
      path.resolve("src/cli/update-cli/update-command-run.ts"),
    ).href;
    await fs.writeFile(
      entry,
      `import { admitUpdateCommandRun } from ${JSON.stringify(admissionModule)};
const run = await admitUpdateCommandRun({ opts: { dryRun: true }, root: ${JSON.stringify(path.resolve("."))} });
process.stdout.write(JSON.stringify({ runId: run.runId }) + "\\n");
process.stdin.resume();
`,
    );
    const admitted = await runCliProcessChild({
      nodeArgs: ["--import", path.resolve("scripts/tsx.mjs"), entry],
      env,
      interact: async (child) => {
        await once(child.stdout, "data");
        child.kill("SIGKILL");
      },
    });
    expect(admitted.signal, formatCliProcessFailure({ reason: "updater death", ...admitted })).toBe(
      "SIGKILL",
    );
    const { runId } = JSON.parse(admitted.stdout) as { runId: string };
    expect(getUpdateRun(runId, { env })).toMatchObject({ status: "running", finishedAtMs: null });

    const cleanup = runUpdateProcess(root, ["update", "cleanup", "--yes", "--json"]);

    expect(cleanup.error).toBeUndefined();
    expect(JSON.parse(cleanup.stdout)).toMatchObject({
      status: "complete",
      artifacts: [],
      totals: { removedFiles: 0 },
    });
    expect(cleanup.status, cleanup.stderr).toBe(0);
    expect(getUpdateRun(runId, { env })).toMatchObject({ status: "running", finishedAtMs: null });
  });

  it.each([true, false])(
    "keeps cleanup preview/refusal byte-identical (dryRun=%s)",
    async (dryRun) => {
      const root = tempDirs.make("openclaw-cleanup-process-");
      const config = path.join(root, "config", "openclaw.json");
      const runs = path.join(root, "state", "session-sqlite-migration-runs");
      const cache = path.join(root, "cache");
      const temporary = path.join(root, "tmp");
      await fs.mkdir(path.dirname(config), { recursive: true });
      await fs.mkdir(runs, { recursive: true });
      await fs.mkdir(cache);
      await fs.mkdir(temporary);
      await fs.writeFile(config, "{ invalid-config");
      await fs.writeFile(path.join(runs, "unknown.json"), "{ invalid-manifest");
      const before = await snapshotTree(root);
      const result = runUpdateProcess(
        root,
        dryRun ? ["update", "--json", "--dry-run", "cleanup"] : ["update", "cleanup", "--json"],
        { XDG_CACHE_HOME: cache, TMPDIR: temporary },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(dryRun ? 0 : 1);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: dryRun ? "preview" : "refused" });
      expect(await snapshotTree(root)).toEqual(before);
    },
  );

  it("keeps malformed config immutable while producing a best-effort preview", async () => {
    const root = tempDirs.make("openclaw-update-dry-run-malformed-");
    const configPath = path.join(root, "config", "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(path.join(root, "state"), { recursive: true });
    await fs.writeFile(configPath, "{ definitely-not-json\n");
    const configBefore = await fs.readFile(configPath);
    const treeBefore = await snapshotTree(root);

    const result = runUpdateProcess(root, ["update", "--dry-run", "--no-restart", "--json"]);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const preview = JSON.parse(result.stdout);
    expect(preview).toMatchObject({
      runId: expect.any(String),
      dryRun: true,
      actions: expect.arrayContaining([expect.any(String)]),
    });
    expect(await fs.readFile(configPath)).toEqual(configBefore);
    await expectPreviewLedger(root, preview.runId, treeBefore);
  });

  it("keeps migration-pending config and SQLite markers immutable for the shorthand", async () => {
    const root = tempDirs.make("openclaw-update-dry-run-migration-");
    const configPath = path.join(root, "config", "openclaw.json");
    const tasksDir = path.join(root, "state", "tasks");
    const migrationMarkerPath = path.join(tasksDir, "runs.sqlite.migrated");
    const walPath = path.join(tasksDir, "runs.sqlite-wal");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(
      configPath,
      '{ "heartbeat": { "model": "anthropic/claude-3-5-haiku-20241022", "every": "30m" } }\n',
    );
    await fs.writeFile(migrationMarkerPath, "legacy migration marker\n");
    await fs.writeFile(walPath, "legacy WAL marker\n");
    const configBefore = await fs.readFile(configPath);
    const markerHashesBefore = {
      migration: await sha256File(migrationMarkerPath),
      wal: await sha256File(walPath),
    };
    const treeBefore = await snapshotTree(root);

    const result = runUpdateProcess(root, ["--update", "--dry-run", "--no-restart", "--json"]);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const preview = JSON.parse(result.stdout);
    expect(preview).toMatchObject({ runId: expect.any(String), dryRun: true });
    expect(await fs.readFile(configPath)).toEqual(configBefore);
    await expectPreviewLedger(root, preview.runId, treeBefore);
    expect({
      migration: await sha256File(migrationMarkerPath),
      wal: await sha256File(walPath),
    }).toEqual(markerHashesBefore);
  });

  it.each([false, true])(
    "describes Doctor migrations but refuses without staged candidate identity (unknownPlugin=%s)",
    async (unknownPlugin) => {
      const root = tempDirs.make("openclaw-update-migration-plan-");
      const configPath = path.join(root, "config", "openclaw.json");
      const stateDir = path.join(root, "state");
      const execPath = path.join(stateDir, "exec-approvals.json");
      const tuiPath = path.join(stateDir, "tui", "last-session.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.mkdir(path.dirname(tuiPath), { recursive: true });
      await fs.writeFile(
        configPath,
        unknownPlugin ? '{ "plugins": { "entries": { "candidate": {} } } }\n' : "{}\n",
      );
      await fs.writeFile(
        execPath,
        '{ "version": 1, "defaults": { "security": "allowlist", "ask": "on-miss" } }\n',
      );
      await fs.writeFile(
        tuiPath,
        '{ "terminal": { "sessionKey": "agent:main:tui:plan", "updatedAt": 1 } }\n',
      );
      const before = await snapshotTree(root);

      const result = runUpdateProcess(root, [
        "update",
        "migration-plan",
        "--snapshot-home",
        root,
        "--snapshot-config",
        configPath,
        "--snapshot-state",
        stateDir,
        "--json",
      ]);

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      const plan = JSON.parse(result.stdout) as {
        mutationAllowed: boolean;
        outcome: string;
        refusal: { code: string };
        candidate: {
          root: string;
          version: string;
          artifact: { outcome: string; refusal: { code: string } };
        };
        snapshot: { configDigest: string; stateDigest: string };
        steps: LegacyStateMigrationPlan["steps"];
      };
      expect(plan).toMatchObject({
        mutationAllowed: false,
        outcome: "refused",
        refusal: { code: "candidate-artifact-digest-required" },
        candidate: {
          root: path.resolve("."),
          version: expect.any(String),
          artifact: {
            outcome: "deferred",
            refusal: { code: "candidate-artifact-digest-required" },
          },
        },
        snapshot: {
          configDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          stateDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
      });
      for (const [id, sourcePath] of [
        ["tui-last-session", tuiPath],
        ["exec-approvals", execPath],
      ]) {
        expect(plan.steps.find((step) => step.id === id)).toMatchObject({
          outcome: unknownPlugin ? "deferred" : "planned",
          requiredness: "required",
          source: [{ kind: "path", path: sourcePath }],
          target: [{ kind: "sqlite", path: path.join(stateDir, "state", "openclaw.sqlite") }],
          ...(unknownPlugin ? { refusal: { code: "blocked-by-prior-refusal" } } : {}),
        });
      }
      expect(plan.steps.findIndex((step) => step.id === "tui-last-session")).toBeLessThan(
        plan.steps.findIndex((step) => step.id === "exec-approvals"),
      );
      expect(plan.steps.find((step) => step.id === "plugin-doctor-state")).toMatchObject({
        outcome: "deferred",
        refusal: { code: "blocked-by-prior-refusal" },
      });
      if (unknownPlugin) {
        const preparationIndex = plan.steps.findIndex(
          (step) => step.id === "plugin-migration-preparation",
        );
        expect(preparationIndex).toBeGreaterThanOrEqual(0);
        expect(plan.steps[preparationIndex]).toMatchObject({
          outcome: "deferred",
          source: expect.arrayContaining([{ kind: "owner", id: "plugin:candidate" }]),
          refusal: { code: "plugin-planning-deferred" },
        });
        for (const step of plan.steps.slice(preparationIndex + 1)) {
          expect(step).toMatchObject({
            outcome: "deferred",
            refusal: { code: "blocked-by-prior-refusal" },
          });
        }
      }
      expect(await snapshotTree(root)).toEqual(before);
    },
  );

  it("preserves snapshot path bytes and rejects blank snapshot paths", async () => {
    const root = tempDirs.make("openclaw-update-migration-plan-paths-");
    const configPath = path.join(root, "config", "openclaw.json");
    const stateDir = path.join(root, " copied state ");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(configPath, "{}\n");
    const before = await snapshotTree(root);

    const runPlan = (snapshotState: string) =>
      runUpdateProcess(
        root,
        [
          "update",
          "migration-plan",
          "--snapshot-home",
          root,
          "--snapshot-config",
          configPath,
          "--snapshot-state",
          snapshotState,
          "--json",
        ],
        { OPENCLAW_STATE_DIR: snapshotState },
      );

    const valid = runPlan(stateDir);
    expect(valid.error).toBeUndefined();
    expect(valid.status, valid.stderr).toBe(1);
    expect(JSON.parse(valid.stdout)).toMatchObject({
      outcome: "refused",
      snapshot: { stateDir },
    });

    const blank = runPlan(" \t ");
    expect(blank.error).toBeUndefined();
    expect(blank.status).toBe(1);
    expect(blank.stderr).toContain("--snapshot-state must not be blank");
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("refuses configured session stores outside the copied state snapshot", async () => {
    const root = tempDirs.make("openclaw-update-migration-plan-session-root-");
    const configPath = path.join(root, "config", "openclaw.json");
    const stateDir = path.join(root, "state");
    const externalStore = path.join(root, "external", "sessions.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(path.dirname(externalStore), { recursive: true });
    await fs.writeFile(externalStore, "{}\n");
    const runPlan = () =>
      runUpdateProcess(root, [
        "update",
        "migration-plan",
        "--snapshot-home",
        root,
        "--snapshot-config",
        configPath,
        "--snapshot-state",
        stateDir,
        "--json",
      ]);

    await fs.writeFile(configPath, `${JSON.stringify({ session: { store: externalStore } })}\n`);
    const externalBefore = await snapshotTree(root);
    const external = runPlan();
    expect(external.error).toBeUndefined();
    expect(external.status, external.stderr).toBe(1);
    const externalPlan = JSON.parse(external.stdout) as LegacyStateMigrationPlan;
    expect(externalPlan).toMatchObject({
      outcome: "refused",
      refusal: { code: "session-target-outside-snapshot" },
    });
    expect(externalPlan.steps[3]).toMatchObject({
      id: "agent-migration-targets",
      source: expect.arrayContaining([{ kind: "path", path: externalStore }]),
      target: [],
      outcome: "deferred",
      refusal: { code: "session-target-outside-snapshot" },
    });
    expect(externalPlan.steps.slice(0, 4).map((step) => step.id)).toEqual([
      "state-schema",
      "plugin-install-index",
      "config-machine-state",
      "agent-migration-targets",
    ]);
    for (const step of externalPlan.steps.slice(4)) {
      expect(step).toMatchObject({
        outcome: "deferred",
        refusal: { code: "blocked-by-prior-refusal" },
      });
    }
    expect(await snapshotTree(root)).toEqual(externalBefore);

    const copiedStore = path.join(stateDir, "sessions.json");
    await fs.writeFile(copiedStore, "{}\n");
    await fs.writeFile(configPath, `${JSON.stringify({ session: { store: copiedStore } })}\n`);
    const copiedBefore = await snapshotTree(root);
    const copied = runPlan();
    expect(copied.error).toBeUndefined();
    expect(copied.status, copied.stderr).toBe(1);
    const copiedPlan = JSON.parse(copied.stdout) as LegacyStateMigrationPlan;
    expect(copiedPlan).toMatchObject({
      refusal: { code: "candidate-artifact-digest-required" },
      steps: expect.arrayContaining([expect.objectContaining({ id: "orphan-session-keys" })]),
    });
    expect(externalPlan.steps.map((step) => step.id)).toEqual(
      copiedPlan.steps.map((step) => step.id),
    );
    expect(await snapshotTree(root)).toEqual(copiedBefore);
  });

  it("rejects caller-supplied snapshot identity without touching the copy", async () => {
    const root = tempDirs.make("openclaw-update-migration-plan-identity-");
    const configPath = path.join(root, "config", "openclaw.json");
    const stateDir = path.join(root, "state");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(configPath, "{}\n");
    const before = await snapshotTree(root);

    const result = runUpdateProcess(root, [
      "update",
      "migration-plan",
      "--snapshot-home",
      root,
      "--snapshot-config",
      configPath,
      "--snapshot-state",
      stateDir,
      "--config-digest",
      "sha256:caller-claim",
      "--json",
    ]);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not recognize option "--config-digest"');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("refuses a copied state path that is not a directory", async () => {
    const root = tempDirs.make("openclaw-update-migration-plan-unbound-");
    const configPath = path.join(root, "config", "openclaw.json");
    const stateDir = path.join(root, "copied-state-file");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(path.join(root, "state"));
    await fs.writeFile(configPath, "{}\n");
    await fs.writeFile(stateDir, "not a state directory\n");
    const before = await snapshotTree(root);

    const result = runUpdateProcess(root, [
      "update",
      "migration-plan",
      "--snapshot-home",
      root,
      "--snapshot-config",
      configPath,
      "--snapshot-state",
      stateDir,
      "--json",
    ]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mutationAllowed: false,
      outcome: "refused",
      refusal: { code: "snapshot-identity-unavailable" },
      snapshot: { configDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) },
    });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it.each(["update", "repair"])(
    "keeps rejected %s arguments from touching legacy state",
    async (command) => {
      const root = tempDirs.make("openclaw-update-legacy-state-");
      const configPath = path.join(root, "config", "openclaw.json");
      const sessionsDir = path.join(root, "state", "sessions");
      const sessionId = "legacy-会議-session";
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(configPath, '{ "gateway": { "mode": "local" } }\n');
      await fs.writeFile(
        path.join(sessionsDir, "sessions.json"),
        `${JSON.stringify({
          "agent:main:discord:direct:user": {
            sessionId,
            sessionFile: path.join(sessionsDir, `${sessionId}.jsonl`),
            updatedAt: 1,
          },
        })}\n`,
      );
      await fs.writeFile(
        path.join(sessionsDir, `${sessionId}.jsonl`),
        `${JSON.stringify({ type: "session", id: sessionId })}\n`,
      );
      const before = await snapshotTree(root);

      const result = runUpdateProcess(root, [
        "update",
        ...(command === "repair" ? ["repair"] : []),
        "--timeout",
        "invalid",
        ...(command === "update" ? ["--no-restart"] : []),
        "--json",
      ]);

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(
        /--timeout must be a positive integer/iu,
      );
      expect(await snapshotTree(root)).toEqual(before);
    },
  );

  it("keeps an orphaned SQLite journal immutable when a managed handoff is refused", async () => {
    const root = tempDirs.make("openclaw-update-refused-handoff-");
    const configPath = path.join(root, "config", "openclaw.json");
    const stateDir = path.join(root, "state");
    const metaPath = path.join(root, "handoff.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(path.join(stateDir, "state"), { recursive: true });
    await fs.writeFile(configPath, '{ "gateway": { "mode": "local" } }\n');
    await fs.writeFile(path.join(stateDir, "state", "openclaw.sqlite-journal"), "orphan journal\n");
    await fs.writeFile(
      metaPath,
      `${JSON.stringify({ version: 1, meta: { root: path.join(root, "wrong-install") } })}\n`,
    );
    const before = await snapshotTree(root);

    const result = runUpdateProcess(root, ["update", "--no-restart", "--json"], {
      [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
    });

    expect(
      result.error,
      formatCliProcessFailure({ reason: "managed update handoff refusal", ...result }),
    ).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Managed update handoff root mismatch/iu);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it.each(["update", "repair", "cleanup"])(
    "fences the mutable %s path before observation or action",
    async (command) => {
      const root = tempDirs.make("openclaw-update-owned-state-");
      const configPath = path.join(root, "config", "openclaw.json");
      const stateDir = path.join(root, "state");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, '{ "gateway": { "mode": "local" } }\n');
      const externalEnv = {
        ...process.env,
        HOME: root,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_SUPERVISOR_MODE: "external",
      };
      claimOpenClawStateOwnership("gateway-supervisor", { env: externalEnv });
      const databasePath = openOpenClawStateDatabase({ env: externalEnv }).path;
      closeOpenClawStateDatabaseForTest();
      const before = await snapshotTree(root);
      const beforeDatabaseHash = await sha256File(databasePath);

      const refused = runUpdateProcess(
        root,
        command === "cleanup"
          ? ["update", "cleanup", "--yes", "--json"]
          : [
              "update",
              ...(command === "repair" ? ["repair"] : ["--no-restart"]),
              "--timeout",
              "1",
              "--json",
            ],
      );

      expect(refused.error).toBeUndefined();
      expect(refused.status).not.toBe(0);
      expect(`${refused.stdout}\n${refused.stderr}`).toMatch(/gateway-supervisor/u);
      expect(`${refused.stdout}\n${refused.stderr}`).toMatch(/OPENCLAW_SUPERVISOR_MODE=external/u);
      expect(await snapshotTree(root)).toEqual(before);
      expect(await sha256File(databasePath)).toBe(beforeDatabaseHash);
    },
  );
});

it("exits the node worker after a stop frame while the supervisor keeps stdin open", async () => {
  const root = tempDirs.make("openclaw-worker-exit-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify({ nodeHost: { skills: { enabled: false } } }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_STATE_DIR: stateDir,
  };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  const result = await runCliProcessChild({
    nodeArgs: [path.resolve("openclaw.mjs"), "node", "worker"],
    env,
    interact: async (child) => {
      let stdout = "";
      let stderr = "";
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      await new Promise<void>((resolve, reject) => {
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          reject(new Error(`worker exited before ready: ${code ?? signal}`));
        };
        const onData = (chunk: string) => {
          stdout += chunk;
          if (stdout.includes('"type":"ready"')) {
            child.stdout.off("data", onData);
            child.off("exit", onExit);
            resolve();
          }
        };
        child.stdout.on("data", onData);
        child.once("exit", onExit);
      });
      child.stdin.write('{"type":"stop"}\n');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              formatCliProcessFailure({
                reason: "worker stayed alive after stop while stdin remained open",
                stdout,
                stderr,
              }),
            ),
          );
        }, 2_500);
        timer.unref();
        void once(child, "exit").then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  });

  expect(result.code).toBe(0);
  expect(result.signal).toBeNull();
});
