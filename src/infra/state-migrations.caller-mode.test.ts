import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pluginDoctorContractRegistryLoaderState } from "../plugins/doctor-contract-registry-loader-state.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  createCallerModeSnapshot,
  expectBlockedTailInPlanOrder,
  expectPlanReceiptDescriptorsToMatch,
  snapshotFiles,
} from "./state-migrations.caller-mode.test-helpers.js";
import {
  autoMigrateLegacyState,
  planLegacyStateMigrationsReadOnly,
} from "./state-migrations.doctor.js";
import {
  resolveLegacyFlowRunsSidecarPath,
  resolveLegacyTaskRunsSidecarPath,
} from "./state-migrations.storage.js";
import type { LegacyStateMigrationPlan } from "./state-migrations.types.js";

const tempDirs = createTrackedTempDirs();

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function candidateAt(
  root: string,
  version = "test",
): Pick<LegacyStateMigrationPlan["candidate"], "root" | "version"> {
  return { root, version };
}

function linkBundledCandidateRoot(candidateRoot: string): void {
  fs.mkdirSync(candidateRoot, { recursive: true });
  fs.symlinkSync(
    path.resolve("extensions"),
    path.join(candidateRoot, "extensions"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

function writeCandidateMigrationManifest(params: {
  candidateRoot: string;
  pluginId: string;
  migrationId: string;
}): void {
  const pluginRoot = path.join(params.candidateRoot, "extensions", params.pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    `${JSON.stringify({
      name: `@openclaw/${params.pluginId}`,
      version: "0.0.0-test",
      openclaw: { extensions: ["./index.js"] },
    })}\n`,
  );
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    `${JSON.stringify({
      id: params.pluginId,
      configSchema: {},
      doctorContract: { stateMigrations: [{ id: params.migrationId }] },
    })}\n`,
  );
  fs.writeFileSync(path.join(pluginRoot, "index.js"), "export default {};\n");
}

function writeLegacyDoctorSources(
  stateDir: string,
  tuiValue: unknown,
): {
  execPath: string;
  tuiPath: string;
} {
  const execPath = path.join(stateDir, "exec-approvals.json");
  const tuiPath = path.join(stateDir, "tui", "last-session.json");
  fs.mkdirSync(path.dirname(tuiPath), { recursive: true });
  fs.writeFileSync(
    execPath,
    `${JSON.stringify({
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss" },
      agents: { main: { allowlist: [{ pattern: "/usr/bin/rg" }] } },
    })}\n`,
  );
  fs.writeFileSync(tuiPath, `${JSON.stringify(tuiValue)}\n`);
  return { execPath, tuiPath };
}

function writeAgentScopedLegacySources(stateDir: string): {
  legacyAgentDir: string;
  legacySessionStorePath: string;
} {
  const legacyAgentDir = path.join(stateDir, "agent");
  const legacySessionStorePath = path.join(stateDir, "sessions", "sessions.json");
  fs.mkdirSync(legacyAgentDir, { recursive: true });
  fs.mkdirSync(path.dirname(legacySessionStorePath), { recursive: true });
  fs.writeFileSync(path.join(legacyAgentDir, "settings.json"), "{}\n");
  fs.writeFileSync(
    legacySessionStorePath,
    `${JSON.stringify({ main: { sessionId: "legacy-main", updatedAt: 1 } })}\n`,
  );
  return { legacyAgentDir, legacySessionStorePath };
}

async function makeFixture() {
  const root = await tempDirs.make("openclaw-doctor-caller-mode-");
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "copied-state");
  const configPath = path.join(root, "copied-openclaw.json");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  linkBundledCandidateRoot(root);
  linkBundledCandidateRoot(path.join(root, "candidate"));
  const cfg: OpenClawConfig = {
    plugins: { entries: { "candidate-plugin": { enabled: true } } },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(cfg)}\n`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
  };
  return { root, homeDir, stateDir, configPath, env };
}

afterEach(async () => {
  pluginDoctorContractRegistryLoaderState.moduleLoaderFactory = undefined;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
  vi.restoreAllMocks();
});

describe("legacy state migration caller mode", () => {
  it("derives bundled migration authority from the supplied candidate root", async () => {
    const fixture = await makeFixture();
    const candidateRoot = path.join(fixture.root, "isolated-candidate");
    writeCandidateMigrationManifest({
      candidateRoot,
      pluginId: "candidate-only",
      migrationId: "candidate-state",
    });

    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: candidateAt(candidateRoot),
      snapshot: createCallerModeSnapshot(fixture),
      env: fixture.env,
    });

    const pluginStep = plan.steps.find((step) => step.id === "plugin-doctor-state");
    expect(pluginStep).toMatchObject({
      source: expect.arrayContaining([
        { kind: "owner", id: "plugin:candidate-only:candidate-state" },
      ]),
      target: expect.arrayContaining([{ kind: "owner", id: "plugin:candidate-only:doctor-state" }]),
    });
    expect(pluginStep?.source).not.toContainEqual(
      expect.objectContaining({ id: expect.stringContaining("plugin:matrix:") }),
    );
  });

  it("plans Doctor-owned work against a copied snapshot without writes or plugin loading", async () => {
    const fixture = await makeFixture();
    const { execPath, tuiPath } = writeLegacyDoctorSources(fixture.stateDir, {
      terminal: { sessionKey: "agent:main:tui:plan", updatedAt: 100 },
    });
    const before = snapshotFiles(fixture.root);
    const pluginLoader = vi.fn(() => {
      throw new Error("candidate planning must not load plugins");
    });
    pluginDoctorContractRegistryLoaderState.moduleLoaderFactory = pluginLoader;

    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: candidateAt(path.join(fixture.root, "candidate"), "2026.9.2-candidate"),
      snapshot: createCallerModeSnapshot(fixture),
      env: fixture.env,
    });

    expect(plan).toMatchObject({
      schemaVersion: "openclaw.legacyStateMigrationPlan.v1",
      mutationAllowed: false,
      outcome: "refused",
      refusal: { code: "candidate-artifact-digest-required" },
      warnings: [],
      mode: "doctor",
      candidate: {
        root: path.resolve(fixture.root, "candidate"),
        version: "2026.9.2-candidate",
        artifact: {
          outcome: "deferred",
          refusal: { code: "candidate-artifact-digest-required" },
        },
      },
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        configDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        stateDir: fixture.stateDir,
        stateDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
    expect(plan.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(plan.steps.find((step) => step.id === "plugin-migration-preparation")).toMatchObject({
      outcome: "deferred",
      refusal: { code: "plugin-planning-deferred" },
    });
    expect(plan.steps.find((step) => step.id === "exec-approvals")).toMatchObject({
      source: [{ kind: "path", path: execPath }],
      target: [{ kind: "sqlite", path: resolveOpenClawStateSqlitePath(fixture.env) }],
      requiredness: "required",
      reversibility: "checkpoint-required",
      outcome: "deferred",
      refusal: { code: "blocked-by-prior-refusal" },
    });
    expect(plan.steps.find((step) => step.id === "tui-last-session")).toMatchObject({
      source: [{ kind: "path", path: tuiPath }],
      requiredness: "required",
      outcome: "deferred",
      refusal: { code: "blocked-by-prior-refusal" },
    });
    expect(plan.steps.find((step) => step.id === "legacy-main-session-keys")).toBeUndefined();
    expect(plan.steps.find((step) => step.id === "plugin-doctor-state")).toMatchObject({
      source: expect.arrayContaining([
        { kind: "owner", id: "plugin:matrix:matrix-inbound-dedupe-to-claimable-dedupe" },
        { kind: "owner", id: "plugin:candidate-plugin:state-migrations" },
      ]),
      target: expect.arrayContaining([
        { kind: "owner", id: "plugin:matrix:doctor-state" },
        { kind: "owner", id: "plugin:candidate-plugin:doctor-state" },
      ]),
      requiredness: "conditional",
      reversibility: "checkpoint-required",
      outcome: "deferred",
      refusal: { code: "blocked-by-prior-refusal" },
    });
    expect(pluginLoader).not.toHaveBeenCalled();
    expect(snapshotFiles(fixture.root)).toEqual(before);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath(fixture.env))).toBe(false);
  });

  it("binds an ordinary -shm file when its unsuffixed sibling is a directory", async () => {
    const fixture = await makeFixture();
    const ordinarySharedMemoryPath = path.join(fixture.stateDir, "cache-shm");
    fs.mkdirSync(path.join(fixture.stateDir, "cache"));
    fs.writeFileSync(ordinarySharedMemoryPath, "ordinary snapshot content\n");

    const first = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: candidateAt(fixture.root),
      snapshot: createCallerModeSnapshot(fixture),
      env: fixture.env,
    });
    expect(first.warnings).toEqual([]);
    expect(first.snapshot.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    fs.writeFileSync(ordinarySharedMemoryPath, "changed ordinary snapshot content\n");
    const second = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: candidateAt(fixture.root),
      snapshot: createCallerModeSnapshot(fixture),
      env: fixture.env,
    });
    expect(second.snapshot.stateDigest).not.toBe(first.snapshot.stateDigest);
  });

  it("keeps configured channel endpoints in the blocked Doctor tail", async () => {
    const fixture = await makeFixture();
    const cfg: OpenClawConfig = {
      channels: { telegram: { enabled: true } },
      plugins: { entries: { "candidate-plugin": { enabled: true } } },
    };
    fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
    const pairingPath = path.join(fixture.stateDir, "credentials", "telegram-allowFrom.json");
    fs.mkdirSync(path.dirname(pairingPath), { recursive: true });
    fs.writeFileSync(pairingPath, '["legacy-user"]\n');

    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: candidateAt(fixture.root),
      snapshot: createCallerModeSnapshot(fixture),
      env: fixture.env,
    });

    expect(plan.steps.find((step) => step.id === "channel-pairing")).toMatchObject({
      source: [{ kind: "path", path: pairingPath }],
      target: [{ kind: "sqlite", path: resolveOpenClawStateSqlitePath(fixture.env) }],
      outcome: "deferred",
      refusal: { code: "blocked-by-prior-refusal" },
    });
  });

  it("binds task sidecar databases as SQLite plan inputs", async () => {
    const fixture = await makeFixture();
    fs.writeFileSync(fixture.configPath, "{}\n");
    const taskRunsPath = resolveLegacyTaskRunsSidecarPath(fixture.stateDir);
    const flowRunsPath = resolveLegacyFlowRunsSidecarPath(fixture.stateDir);
    const databases = [taskRunsPath, flowRunsPath].map((databasePath) => {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const database = new DatabaseSync(databasePath);
      database.exec(
        "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('pending');",
      );
      return database;
    });

    try {
      const plan = await planLegacyStateMigrationsReadOnly({
        mode: "doctor",
        candidate: candidateAt(fixture.root),
        snapshot: createCallerModeSnapshot(fixture),
        env: fixture.env,
      });

      expect(plan.steps.find((step) => step.id === "task-state-sidecars")).toMatchObject({
        source: [
          { kind: "sqlite", path: taskRunsPath },
          { kind: "sqlite", path: flowRunsPath },
        ],
        target: [{ kind: "sqlite", path: resolveOpenClawStateSqlitePath(fixture.env) }],
        requiredness: "required",
        outcome: "planned",
      });

      databases[0]?.exec("INSERT INTO marker VALUES ('later-wal-row')");
      const updatedPlan = await planLegacyStateMigrationsReadOnly({
        mode: "doctor",
        candidate: candidateAt(fixture.root),
        snapshot: createCallerModeSnapshot(fixture),
        env: fixture.env,
      });
      expect(updatedPlan.snapshot.stateDigest).not.toBe(plan.snapshot.stateDigest);
    } finally {
      databases.forEach((database) => database.close());
    }
  });

  it("defers an absent named-profile workspace until its external path is bound", async () => {
    const fixture = await makeFixture();
    fixture.env.OPENCLAW_PROFILE = "work";
    const source = path.join(fixture.homeDir, ".openclaw", "workspace-work");
    const target = path.join(fixture.homeDir, ".openclaw-work", "workspace");
    const before = snapshotFiles(fixture.root);

    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: candidateAt(fixture.root),
      snapshot: createCallerModeSnapshot(fixture),
      env: fixture.env,
    });

    expect(plan.steps.find((step) => step.id === "profile-workspace")).toMatchObject({
      source: [{ kind: "path", path: source }],
      target: [{ kind: "path", path: target }],
      requiredness: "conditional",
      outcome: "deferred",
      refusal: { code: "profile-workspace-snapshot-deferred" },
    });
    expect(snapshotFiles(fixture.root)).toEqual(before);
  });

  it("retains an occupied named-profile workspace as explicit deferred work", async () => {
    const fixture = await makeFixture();
    fixture.env.OPENCLAW_PROFILE = "work";
    const source = path.join(fixture.homeDir, ".openclaw", "workspace-work");
    const target = path.join(fixture.homeDir, ".openclaw-work", "workspace");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    const before = snapshotFiles(fixture.root);

    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: candidateAt(fixture.root),
      snapshot: createCallerModeSnapshot(fixture),
      env: fixture.env,
    });

    expect(plan.steps.find((step) => step.id === "profile-workspace")).toMatchObject({
      source: [{ kind: "path", path: source }],
      target: [{ kind: "path", path: target }],
      requiredness: "conditional",
      outcome: "deferred",
      refusal: { code: "profile-workspace-snapshot-deferred" },
    });
    expect(snapshotFiles(fixture.root)).toEqual(before);
  });

  it("binds plan targets and identity to every resolved copied config input", async () => {
    const fixture = await makeFixture();
    const intermediatePath = path.join(fixture.root, "planner-base.json");
    const includePath = path.join(fixture.root, "planner-agents.json");
    const configFor = (agentId: string): OpenClawConfig => ({
      agents: { ownership: "explicit", entries: { [agentId]: {} } },
    });
    fs.writeFileSync(fixture.configPath, '{"$include":"./planner-base.json"}\n');
    fs.writeFileSync(intermediatePath, '{"$include":"./planner-agents.json"}\n');
    fs.writeFileSync(includePath, `${JSON.stringify(configFor("atlas"))}\n`);

    const first = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: candidateAt(fixture.root),
      snapshot: createCallerModeSnapshot(fixture),
      env: fixture.env,
    });
    expect(first.warnings).toEqual([]);
    const firstAgentStep = first.steps.find((step) => step.id === "acp-session-metadata");
    const configIncludedPaths = [
      ...new Set([
        includePath,
        intermediatePath,
        fs.realpathSync(includePath),
        fs.realpathSync(intermediatePath),
      ]),
    ].toSorted();
    const configSources = [fixture.configPath, ...configIncludedPaths].map((inputPath) => ({
      kind: "path" as const,
      path: inputPath,
    }));
    for (const stepId of [
      "config-machine-state",
      "agent-migration-targets",
      "plugin-migration-preparation",
      "orphan-session-keys",
      "migration-detection",
    ]) {
      expect
        .soft(first.steps.find((step) => step.id === stepId)?.source)
        .toEqual(expect.arrayContaining(configSources));
    }
    expect.soft(firstAgentStep?.target).toEqual([
      {
        kind: "path",
        path: path.join(fixture.stateDir, "agents", "atlas", "sessions", "sessions.json"),
      },
      { kind: "sqlite", path: resolveOpenClawStateSqlitePath(fixture.env) },
    ]);
    const firstConfigDigest = first.snapshot.configDigest;
    if (!firstConfigDigest) {
      throw new Error("expected the copied config inputs to have a bound digest");
    }

    fs.writeFileSync(includePath, `${JSON.stringify(configFor("beacon"))}\n`);
    const stale = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: candidateAt(fixture.root),
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        configDigest: firstConfigDigest,
        stateDir: fixture.stateDir,
      },
      env: fixture.env,
    });
    expect.soft(stale).toMatchObject({
      outcome: "refused",
      refusal: { code: "snapshot-identity-mismatch" },
      steps: [],
    });

    const second = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: candidateAt(fixture.root),
      snapshot: createCallerModeSnapshot(fixture),
      env: fixture.env,
    });
    const secondAgentStep = second.steps.find((step) => step.id === "acp-session-metadata");
    expect.soft(second.snapshot.configDigest).not.toBe(firstConfigDigest);
    expect.soft(secondAgentStep?.target).toEqual([
      {
        kind: "path",
        path: path.join(fixture.stateDir, "agents", "beacon", "sessions", "sessions.json"),
      },
      { kind: "sqlite", path: resolveOpenClawStateSqlitePath(fixture.env) },
    ]);

    const execution = await autoMigrateLegacyState({
      cfg: configFor("beacon"),
      configIncludedPaths,
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    for (const stepId of [
      "config-machine-state",
      "agent-migration-targets",
      "plugin-migration-preparation",
      "orphan-session-keys",
      "migration-detection",
    ]) {
      expect
        .soft(execution.stepReceipts.find((receipt) => receipt.id === stepId)?.source)
        .toEqual(second.steps.find((step) => step.id === stepId)?.source);
    }
  });

  it("keeps the adjacent automatic-only step out of a Doctor plan", async () => {
    const fixture = await makeFixture();
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { planner: {} } },
      plugins: { entries: { "candidate-plugin": { enabled: true } } },
    };
    const configBytes = `${JSON.stringify(cfg)}\n`;
    fs.writeFileSync(fixture.configPath, configBytes);
    const agentDatabasePath = path.join(
      fixture.stateDir,
      "agents",
      "planner",
      "agent",
      "openclaw-agent.sqlite",
    );
    const legacySessionStorePath = path.join(
      fixture.stateDir,
      "agents",
      "planner",
      "sessions",
      "sessions.json",
    );
    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "automatic",
      candidate: candidateAt(fixture.root),
      snapshot: createCallerModeSnapshot(fixture),
      env: fixture.env,
    });

    expect(plan.mode).toBe("automatic");
    expect(plan.steps.find((step) => step.id === "legacy-main-session-keys")).toMatchObject({
      source: [
        { kind: "path", path: legacySessionStorePath },
        { kind: "owner", id: "plugin:candidate-plugin:session-store" },
        { kind: "sqlite", path: agentDatabasePath },
      ],
      target: [
        { kind: "path", path: legacySessionStorePath },
        { kind: "owner", id: "plugin:candidate-plugin:session-store" },
        { kind: "sqlite", path: agentDatabasePath },
      ],
      requiredness: "conditional",
      outcome: "deferred",
      refusal: { code: "blocked-by-prior-refusal" },
    });
    expect(plan.steps.find((step) => step.id === "exec-approvals")).toBeUndefined();
    expect(plan.steps.find((step) => step.id === "tui-last-session")).toBeUndefined();

    const result = await autoMigrateLegacyState({
      cfg,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(result.mode).toBe("automatic");
    expect(result.stepReceipts.map((receipt) => receipt.id)).toEqual(
      plan.steps.map((step) => step.id),
    );
    // The copied planner cannot load this missing owner's contract. Live execution uses
    // the selected registry, not candidate-only placeholders or their refusal barrier.
    const candidateOnlyOwners = new Set([
      "plugin:candidate-plugin:state-migrations",
      "plugin:candidate-plugin:doctor-state",
      "plugin:candidate-plugin:session-store",
    ]);
    expectPlanReceiptDescriptorsToMatch({
      plan: {
        ...plan,
        steps: plan.steps.map((step) =>
          Object.assign({}, step, {
            source: step.source.filter(
              (endpoint) => endpoint.kind !== "owner" || !candidateOnlyOwners.has(endpoint.id),
            ),
            target: step.target.filter(
              (endpoint) => endpoint.kind !== "owner" || !candidateOnlyOwners.has(endpoint.id),
            ),
          }),
        ),
      },
      receipts: result.stepReceipts,
    });
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "legacy-main-session-keys"),
    ).toMatchObject({
      source: [
        { kind: "path", path: legacySessionStorePath },
        { kind: "sqlite", path: agentDatabasePath },
      ],
      target: [
        { kind: "path", path: legacySessionStorePath },
        { kind: "sqlite", path: agentDatabasePath },
      ],
      requiredness: "conditional",
      outcome: "skipped",
    });
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "legacy-main-session-keys")?.refusal,
    ).toBeUndefined();
    expect(result.stepReceipts.find((receipt) => receipt.id === "shared-auth-store")).toMatchObject(
      {
        outcome: "skipped",
        changes: [],
        warnings: [],
      },
    );
  });

  it.each(["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const)(
    "excludes copied %s agent inputs without overriding live shared-auth authority",
    async (overrideKey) => {
      const fixture = await makeFixture();
      const cfg: OpenClawConfig = { agents: { list: [{ id: "main", default: true }] } };
      fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
      const sources = writeAgentScopedLegacySources(fixture.stateDir);
      const externalAgentDir = path.join(fixture.root, `custom-${overrideKey.toLowerCase()}`);
      const externalDatabasePath = path.join(externalAgentDir, "openclaw-agent.sqlite");
      fs.mkdirSync(externalAgentDir, { recursive: true });
      for (const suffix of ["", "-wal", "-shm"]) {
        fs.writeFileSync(`${externalDatabasePath}${suffix}`, `external${suffix}\n`);
      }
      const env: NodeJS.ProcessEnv = {
        ...fixture.env,
        OPENCLAW_AGENT_DIR: undefined,
        PI_CODING_AGENT_DIR: undefined,
        [overrideKey]: externalAgentDir,
      };
      const plan = await planLegacyStateMigrationsReadOnly({
        mode: "doctor",
        candidate: candidateAt(fixture.root),
        snapshot: createCallerModeSnapshot(fixture),
        env,
      });
      for (const suffix of ["", "-wal", "-shm"]) {
        expect(fs.readFileSync(`${externalDatabasePath}${suffix}`, "utf8")).toBe(
          `external${suffix}\n`,
        );
        fs.writeFileSync(`${externalDatabasePath}${suffix}`, `changed${suffix}\n`);
      }
      const repeatedPlan = await planLegacyStateMigrationsReadOnly({
        mode: "doctor",
        candidate: candidateAt(fixture.root),
        snapshot: createCallerModeSnapshot(fixture),
        env,
      });

      for (const suffix of ["", "-wal", "-shm"]) {
        expect(fs.readFileSync(`${externalDatabasePath}${suffix}`, "utf8")).toBe(
          `changed${suffix}\n`,
        );
      }
      const externalAfterPlanning = snapshotFiles(externalAgentDir);
      let firstLiveRefusal: { id: string; files: Record<string, string> } | undefined;

      const result = await autoMigrateLegacyState({
        cfg,
        doctorOnlyStateMigrations: true,
        env,
        homedir: () => fixture.homeDir,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        onStepReceipt: (receipt) => {
          if (receipt.outcome === "refused" && firstLiveRefusal === undefined) {
            firstLiveRefusal = { id: receipt.id, files: snapshotFiles(externalAgentDir) };
          }
        },
      });

      if (overrideKey === "OPENCLAW_AGENT_DIR") {
        // This key also selects the shipped live shared-auth source. Its malformed
        // database refuses live discovery; the copied plan never authorized it.
        expect(
          result.stepReceipts.find((receipt) => receipt.id === "migration-detection"),
        ).toMatchObject({
          outcome: "refused",
          requiredness: "required",
          refusal: { code: "step-threw" },
          warnings: [expect.stringContaining(externalDatabasePath)],
        });
        expectBlockedTailInPlanOrder({
          plan,
          receipts: result.stepReceipts,
          blockerId: "migration-detection",
        });
        expect(result.postSessionPluginMigration).toBeUndefined();
        expect(result.skipped).toBe(false);
        expect(firstLiveRefusal?.id).toBe("migration-detection");
        expect(snapshotFiles(externalAgentDir)).toEqual(firstLiveRefusal?.files);
      } else {
        expect(result.postSessionPluginMigration?.step.id).toBe("plugin-doctor-post-session-state");
        expect([
          ...result.stepReceipts.map((receipt) => receipt.id),
          result.postSessionPluginMigration?.step.id,
        ]).toEqual(plan.steps.map((step) => step.id));
        expect(result.skipped).toBe(true);
        expect(firstLiveRefusal).toBeUndefined();
        expect(snapshotFiles(externalAgentDir)).toEqual(externalAfterPlanning);
      }
      expect(repeatedPlan.snapshot.stateDigest).toBe(plan.snapshot.stateDigest);
      expect(repeatedPlan.planDigest).toBe(plan.planDigest);
      for (const stepId of ["media-persistence", "transcript-directives", "shared-auth-store"]) {
        const plannedSource = plan.steps.find((step) => step.id === stepId)?.source;
        if (overrideKey === "PI_CODING_AGENT_DIR") {
          expect(plannedSource).toEqual(
            result.stepReceipts.find((receipt) => receipt.id === stepId)?.source,
          );
        }
        for (const suffix of ["", "-wal", "-shm"]) {
          expect(plannedSource).not.toContainEqual(
            expect.objectContaining({ path: `${externalDatabasePath}${suffix}` }),
          );
        }
        expect(
          plannedSource?.some(
            (endpoint) => endpoint.kind !== "owner" && endpoint.path.startsWith(externalAgentDir),
          ),
        ).toBe(false);
      }
      for (const stepId of ["sessions", "acp-session-metadata", "agent-dir"]) {
        expect(plan.steps.find((step) => step.id === stepId)).toBeUndefined();
        expect(result.stepReceipts.find((receipt) => receipt.id === stepId)).toBeUndefined();
      }
      expect(fs.existsSync(sources.legacyAgentDir)).toBe(true);
      expect(fs.existsSync(sources.legacySessionStorePath)).toBe(true);
    },
  );

  it("keeps an unbound configured agent database unopened during copied-state planning", async () => {
    const fixture = await makeFixture();
    const externalDatabasePath = path.join(fixture.root, "external", "sessions.sqlite");
    fs.mkdirSync(path.dirname(externalDatabasePath), { recursive: true });
    const database = new DatabaseSync(externalDatabasePath);
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE external_probe (value TEXT NOT NULL);
        INSERT INTO external_probe(value) VALUES ('initial');
      `);
      const cfg: OpenClawConfig = { session: { store: externalDatabasePath } };
      fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
      const snapshotExternalArtifacts = () =>
        Object.fromEntries(
          ["", "-wal", "-shm"].map((suffix) => {
            const pathname = `${externalDatabasePath}${suffix}`;
            const bytes = fs.existsSync(pathname) ? fs.readFileSync(pathname) : undefined;
            if (bytes && suffix === "-shm") {
              bytes.fill(0, 96, 120);
              bytes.fill(0, 128, 132);
            }
            return [suffix || "database", bytes ? sha256(bytes) : undefined];
          }),
        );
      const externalArtifactsBeforePlan = snapshotExternalArtifacts();
      expect(externalArtifactsBeforePlan["-wal"]).toBeDefined();
      expect(externalArtifactsBeforePlan["-shm"]).toBeDefined();
      // Preserve the native method so the spy can inspect each opened database before delegating.
      // oxlint-disable-next-line typescript/unbound-method
      const originalPrepare = DatabaseSync.prototype.prepare;
      const externalQueries: string[] = [];
      vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(
        function (this: DatabaseSync, sql) {
          const databases = originalPrepare.call(this, "PRAGMA database_list").all() as Array<{
            file?: unknown;
          }>;
          if (
            databases.some(
              (entry) =>
                typeof entry.file === "string" && path.resolve(entry.file) === externalDatabasePath,
            )
          ) {
            externalQueries.push(sql);
          }
          return originalPrepare.call(this, sql);
        },
      );
      const plan = await planLegacyStateMigrationsReadOnly({
        mode: "doctor",
        candidate: candidateAt(fixture.root),
        snapshot: createCallerModeSnapshot(fixture),
        env: fixture.env,
      });
      expect(snapshotExternalArtifacts()).toEqual(externalArtifactsBeforePlan);
      const plannedDiscovery = plan.steps.find((step) => step.id === "agent-migration-targets");
      expect(plannedDiscovery).toMatchObject({
        outcome: "deferred",
        refusal: { code: "session-target-outside-snapshot" },
      });
      expect(plannedDiscovery?.source).toContainEqual({
        kind: "path",
        path: externalDatabasePath,
      });
      const discoveryIndex = plan.steps.findIndex((step) => step.id === "agent-migration-targets");
      expect(plan.steps.slice(discoveryIndex + 1)).toEqual(
        plan.steps.slice(discoveryIndex + 1).map((step) =>
          expect.objectContaining({
            id: step.id,
            outcome: "deferred",
            refusal: expect.objectContaining({ code: "blocked-by-prior-refusal" }),
          }),
        ),
      );

      database.exec("INSERT INTO external_probe(value) VALUES ('wal-change')");
      const repeatedPlan = await planLegacyStateMigrationsReadOnly({
        mode: "doctor",
        candidate: candidateAt(fixture.root),
        snapshot: createCallerModeSnapshot(fixture),
        env: fixture.env,
      });
      expect(repeatedPlan.planDigest).toBe(plan.planDigest);
      expect(repeatedPlan.snapshot.stateDigest).toBe(plan.snapshot.stateDigest);
      expect(externalQueries).toEqual([]);
      const externalArtifactsBeforeExecution = snapshotExternalArtifacts();

      const result = await autoMigrateLegacyState({
        cfg,
        doctorOnlyStateMigrations: true,
        env: fixture.env,
        homedir: () => fixture.homeDir,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      const executionDiscovery = result.stepReceipts.find(
        (receipt) => receipt.id === "agent-migration-targets",
      );
      expect(executionDiscovery).toMatchObject({
        outcome: "skipped",
        changes: [],
        warnings: [],
      });
      expect(executionDiscovery?.refusal).toBeUndefined();
      expect(externalQueries.length).toBeGreaterThan(0);
      expect(snapshotExternalArtifacts()).toEqual(externalArtifactsBeforeExecution);
    } finally {
      database.close();
    }
  });

  it("keeps agent-scoped plan and receipt items for the standard state root", async () => {
    const fixture = await makeFixture();
    const cfg: OpenClawConfig = { agents: { list: [{ id: "main", default: true }] } };
    fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
    writeAgentScopedLegacySources(fixture.stateDir);
    const env: NodeJS.ProcessEnv = {
      ...fixture.env,
      OPENCLAW_AGENT_DIR: undefined,
      PI_CODING_AGENT_DIR: undefined,
    };
    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: candidateAt(fixture.root),
      snapshot: createCallerModeSnapshot(fixture),
      env,
    });

    const result = await autoMigrateLegacyState({
      cfg,
      doctorOnlyStateMigrations: true,
      env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect([
      ...result.stepReceipts.map((receipt) => receipt.id),
      result.postSessionPluginMigration?.step.id,
    ]).toEqual(plan.steps.map((step) => step.id));
    const standardAgentDatabasePath = path.join(
      fixture.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    expect(plan.steps.find((step) => step.id === "shared-auth-store")?.source).toEqual([
      { kind: "sqlite", path: standardAgentDatabasePath },
    ]);
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "shared-auth-store")?.source,
    ).toEqual(plan.steps.find((step) => step.id === "shared-auth-store")?.source);
    const plannedAcp = plan.steps.find((step) => step.id === "acp-session-metadata");
    expect(plannedAcp?.source).not.toContainEqual({
      kind: "sqlite",
      path: standardAgentDatabasePath,
    });
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "acp-session-metadata")?.source,
    ).toEqual(plannedAcp?.source);
    for (const stepId of ["media-persistence", "transcript-directives"]) {
      expect(plan.steps.find((step) => step.id === stepId)?.source).toContainEqual({
        kind: "sqlite",
        path: standardAgentDatabasePath,
      });
      expect(result.stepReceipts.find((receipt) => receipt.id === stepId)?.source).toEqual(
        plan.steps.find((step) => step.id === stepId)?.source,
      );
    }
    const stateDatabasePath = resolveOpenClawStateSqlitePath(env);
    expect(plan.steps.find((step) => step.id === "meeting-transcripts")?.source).toContainEqual({
      kind: "sqlite",
      path: stateDatabasePath,
    });
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "meeting-transcripts")?.source,
    ).toEqual(plan.steps.find((step) => step.id === "meeting-transcripts")?.source);
    for (const stepId of ["sessions", "acp-session-metadata", "agent-dir"]) {
      expect(plan.steps.find((step) => step.id === stepId)).toBeDefined();
      expect(result.stepReceipts.find((receipt) => receipt.id === stepId)).toBeDefined();
    }
  });
});
