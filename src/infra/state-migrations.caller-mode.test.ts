import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pluginDoctorContractRegistryLoaderState } from "../plugins/doctor-contract-registry-loader-state.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
  planLegacyStateMigrationsReadOnly,
  runLegacyStateMigrations,
} from "./state-migrations.doctor.js";
import {
  readLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";
import { resolveLegacyProfileWorkspaceMigrationPaths } from "./state-migrations.state-dir.js";
import type {
  LegacyStateMigrationCandidate,
  LegacyStateMigrationStepReceipt,
} from "./state-migrations.types.js";

const tempDirs = createTrackedTempDirs();

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function boundCandidate(root: string, version = "test"): LegacyStateMigrationCandidate {
  return {
    root,
    version,
    artifact: {
      outcome: "bound",
      owner: "staged-candidate",
      digest: `sha256:${"a".repeat(64)}`,
    },
  };
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

function writeLegacyStateSchemaV1(stateDatabasePath: string): void {
  fs.mkdirSync(path.dirname(stateDatabasePath), { recursive: true });
  const database = new DatabaseSync(stateDatabasePath);
  try {
    database.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL UNIQUE,
        source_sequence INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_key TEXT,
        session_id TEXT,
        run_id TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT
      );
    `);
  } finally {
    database.close();
  }
}

function snapshotFiles(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const pathname = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(pathname);
      } else {
        result[path.relative(root, pathname)] = sha256(fs.readFileSync(pathname));
      }
    }
  };
  visit(root);
  return result;
}

async function makeFixture() {
  const root = await tempDirs.make("openclaw-doctor-caller-mode-");
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "copied-state");
  const configPath = path.join(root, "copied-openclaw.json");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const cfg: OpenClawConfig = {
    plugins: { entries: { "candidate-plugin": { enabled: true } } },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(cfg)}\n`);
  const env = {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
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
      candidate: boundCandidate(path.join(fixture.root, "candidate"), "2026.9.2-candidate"),
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        stateDir: fixture.stateDir,
      },
      env: fixture.env,
    });

    expect(plan).toMatchObject({
      schemaVersion: "openclaw.legacyStateMigrationPlan.v1",
      mutationAllowed: false,
      outcome: "planned",
      warnings: [],
      mode: "doctor",
      candidate: {
        root: path.resolve(fixture.root, "candidate"),
        version: "2026.9.2-candidate",
        artifact: {
          outcome: "bound",
          owner: "staged-candidate",
          digest: `sha256:${"a".repeat(64)}`,
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
    expect(plan.steps.find((step) => step.id === "exec-approvals")).toMatchObject({
      source: [{ kind: "path", path: execPath }],
      target: [{ kind: "sqlite", path: resolveOpenClawStateSqlitePath(fixture.env) }],
      requiredness: "required",
      reversibility: "checkpoint-required",
      outcome: "planned",
    });
    expect(plan.steps.find((step) => step.id === "tui-last-session")).toMatchObject({
      source: [{ kind: "path", path: tuiPath }],
      requiredness: "required",
      outcome: "planned",
    });
    expect(plan.steps.find((step) => step.id === "legacy-main-session-keys")).toBeUndefined();
    expect(plan.steps.find((step) => step.id === "plugin-doctor-state")).toMatchObject({
      source: [{ kind: "owner", id: "plugin:candidate-plugin" }],
      target: [{ kind: "owner", id: "plugin:candidate-plugin:doctor-state" }],
      requiredness: "conditional",
      reversibility: "not-applicable",
      outcome: "deferred",
      refusal: { code: "plugin-planning-deferred" },
    });
    expect(pluginLoader).not.toHaveBeenCalled();
    expect(snapshotFiles(fixture.root)).toEqual(before);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath(fixture.env))).toBe(false);
  });

  it("binds plan targets and identity to every resolved copied config input", async () => {
    const fixture = await makeFixture();
    const includePath = path.join(fixture.root, "planner-agents.json");
    const configFor = (agentId: string): OpenClawConfig => ({
      agents: { ownership: "explicit", entries: { [agentId]: {} } },
    });
    fs.writeFileSync(fixture.configPath, '{"$include":"./planner-agents.json"}\n');
    fs.writeFileSync(includePath, `${JSON.stringify(configFor("atlas"))}\n`);

    const first = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: boundCandidate(fixture.root),
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        stateDir: fixture.stateDir,
      },
      env: fixture.env,
    });
    const firstAgentStep = first.steps.find((step) => step.id === "acp-session-metadata");
    expect.soft(firstAgentStep?.target).toEqual([
      {
        kind: "sqlite",
        path: path.join(fixture.stateDir, "agents", "atlas", "agent", "openclaw-agent.sqlite"),
      },
    ]);
    const firstConfigDigest = first.snapshot.configDigest;
    if (!firstConfigDigest) {
      throw new Error("expected the copied config inputs to have a bound digest");
    }

    fs.writeFileSync(includePath, `${JSON.stringify(configFor("beacon"))}\n`);
    const stale = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: boundCandidate(fixture.root),
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
      candidate: boundCandidate(fixture.root),
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        stateDir: fixture.stateDir,
      },
      env: fixture.env,
    });
    const secondAgentStep = second.steps.find((step) => step.id === "acp-session-metadata");
    expect.soft(second.snapshot.configDigest).not.toBe(firstConfigDigest);
    expect.soft(secondAgentStep?.target).toEqual([
      {
        kind: "sqlite",
        path: path.join(fixture.stateDir, "agents", "beacon", "agent", "openclaw-agent.sqlite"),
      },
    ]);
  });

  it("keeps the adjacent automatic-only step out of a Doctor plan", async () => {
    const fixture = await makeFixture();
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { planner: {} } },
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
    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "automatic",
      candidate: boundCandidate(fixture.root),
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        stateDir: fixture.stateDir,
      },
      env: fixture.env,
    });

    expect(plan.mode).toBe("automatic");
    expect(plan.steps.find((step) => step.id === "legacy-main-session-keys")).toMatchObject({
      source: [{ kind: "sqlite", path: agentDatabasePath }],
      target: [{ kind: "sqlite", path: agentDatabasePath }],
      requiredness: "conditional",
      outcome: "planned",
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
    expect(result.stepReceipts.find((receipt) => receipt.id === "shared-auth-store")).toMatchObject(
      {
        outcome: "skipped",
        changes: [],
        warnings: [],
      },
    );
  });

  it("refuses an invalid staged-candidate artifact digest", async () => {
    const fixture = await makeFixture();
    const candidate: LegacyStateMigrationCandidate = {
      root: fixture.root,
      version: "test",
      artifact: {
        outcome: "bound",
        owner: "staged-candidate",
        digest: "sha256:not-a-digest",
      },
    };

    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate,
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        stateDir: fixture.stateDir,
      },
      env: fixture.env,
    });

    expect(plan).toMatchObject({
      outcome: "refused",
      refusal: { code: "candidate-artifact-digest-invalid" },
      candidate: {
        artifact: {
          outcome: "deferred",
          refusal: { code: "candidate-artifact-digest-invalid" },
        },
      },
    });
  });

  it("returns a closed refusal when read-only detection cannot produce a safe plan", async () => {
    const fixture = await makeFixture();
    const before = snapshotFiles(fixture.root);
    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: boundCandidate(fixture.root),
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        stateDir: fixture.stateDir,
      },
      env: fixture.env,
      legacySessionSurfaces: { surfaces: [], failures: ["session surface unavailable"] },
    });

    expect(plan).toMatchObject({
      mutationAllowed: false,
      outcome: "refused",
      warnings: ["session surface unavailable"],
      refusal: { code: "migration-planning-warning" },
    });
    expect(snapshotFiles(fixture.root)).toEqual(before);
  });

  it("returns a closed refusal when copied-state detection throws", async () => {
    const fixture = await makeFixture();
    const before = snapshotFiles(fixture.root);
    const legacySessionSurfaces = Object.defineProperty({ surfaces: [] }, "failures", {
      get() {
        throw new Error("synthetic copied-state detection failure");
      },
    }) as typeof EMPTY_LEGACY_SESSION_SURFACES;

    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: boundCandidate(fixture.root),
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        stateDir: fixture.stateDir,
      },
      env: fixture.env,
      legacySessionSurfaces,
    });

    expect(plan).toMatchObject({
      mutationAllowed: false,
      outcome: "refused",
      refusal: { code: "migration-detection-failed" },
      steps: [],
    });
    expect(plan.warnings.join("\n")).toContain("synthetic copied-state detection failure");
    expect(snapshotFiles(fixture.root)).toEqual(before);
  });

  it("records named-profile workspace endpoints without authorizing unbound writes", async () => {
    const fixture = await makeFixture();
    fixture.env.OPENCLAW_PROFILE = "work";
    const source = path.join(fixture.homeDir, ".openclaw", "workspace-work");
    const target = path.join(fixture.homeDir, ".openclaw-work", "workspace");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "AGENTS.md"), "profile workspace\n");
    const before = snapshotFiles(fixture.root);

    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: boundCandidate(fixture.root),
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        stateDir: fixture.stateDir,
      },
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

  it.runIf(process.platform !== "win32")(
    "refuses a symlinked state snapshot before migration detection",
    async () => {
      const fixture = await makeFixture();
      const linkedStateDir = path.join(fixture.root, "linked-state");
      fs.symlinkSync(fixture.stateDir, linkedStateDir, "dir");
      const pluginLoader = vi.fn(() => {
        throw new Error("snapshot refusal must precede plugin detection");
      });
      pluginDoctorContractRegistryLoaderState.moduleLoaderFactory = pluginLoader;

      const plan = await planLegacyStateMigrationsReadOnly({
        mode: "doctor",
        candidate: boundCandidate(fixture.root),
        snapshot: {
          homeDir: fixture.homeDir,
          configPath: fixture.configPath,
          stateDir: linkedStateDir,
        },
        env: fixture.env,
      });

      expect(plan).toMatchObject({
        mutationAllowed: false,
        outcome: "refused",
        refusal: { code: "snapshot-identity-unavailable" },
        snapshot: { stateDir: linkedStateDir },
        steps: [],
      });
      expect(plan.snapshot.stateDigest).toBeUndefined();
      expect(pluginLoader).not.toHaveBeenCalled();
    },
  );

  it("refuses a caller-supplied snapshot digest that does not match observed bytes", async () => {
    const fixture = await makeFixture();

    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: boundCandidate(fixture.root),
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        stateDir: fixture.stateDir,
        stateDigest: `sha256:${"b".repeat(64)}`,
      },
      env: fixture.env,
    });

    expect(plan).toMatchObject({
      mutationAllowed: false,
      outcome: "refused",
      refusal: { code: "snapshot-identity-mismatch" },
      steps: [],
    });
    expect(plan.snapshot.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(plan.snapshot.stateDigest).not.toBe(`sha256:${"b".repeat(64)}`);
  });

  it("executes and receipts Doctor-owned exec and TUI migrations from the same mode", async () => {
    const fixture = await makeFixture();
    const cfg: OpenClawConfig = { meta: { lastTouchedAt: "2026-09-02T00:00:00.000Z" } };
    fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
    const { execPath, tuiPath } = writeLegacyDoctorSources(fixture.stateDir, {
      terminal: { sessionKey: "agent:main:tui:execute", updatedAt: 100 },
    });
    const deviceAuthPath = path.join(fixture.stateDir, "identity", "device-auth.json");
    fs.mkdirSync(path.dirname(deviceAuthPath), { recursive: true });
    fs.writeFileSync(
      deviceAuthPath,
      `${JSON.stringify({
        version: 1,
        deviceId: "candidate-device",
        tokens: {
          operator: {
            token: "candidate-token",
            role: "operator",
            scopes: ["operator.read"],
            updatedAtMs: 10,
          },
        },
      })}\n`,
    );
    const stateDatabasePath = resolveOpenClawStateSqlitePath(fixture.env);
    writeLegacyStateSchemaV1(stateDatabasePath);
    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: boundCandidate(fixture.root),
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        stateDir: fixture.stateDir,
      },
      env: fixture.env,
    });

    const result = await autoMigrateLegacyState({
      cfg,
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(result.mode).toBe("doctor");
    expect(result.warnings).toEqual([]);
    expect(result.stepReceipts.map((receipt) => receipt.id)).toEqual(
      plan.steps.map((step) => step.id),
    );
    expect(plan.steps.map((step) => step.phase)).toEqual(
      [...plan.steps]
        .toSorted((left, right) =>
          left.phase === right.phase ? 0 : left.phase === "shared" ? -1 : 1,
        )
        .map((step) => step.phase),
    );
    expect(plan.steps.findIndex((step) => step.id === "device-auth")).toBeLessThan(
      plan.steps.findIndex((step) => step.id === "tui-last-session"),
    );
    expect(plan.steps[0]).toMatchObject({
      id: "state-schema",
      phase: "shared",
      source: [{ kind: "sqlite", path: stateDatabasePath }],
      target: [{ kind: "sqlite", path: stateDatabasePath }],
      requiredness: "required",
      reversibility: "checkpoint-required",
      outcome: "planned",
    });
    expect(result.stepReceipts[0]).toMatchObject({
      id: "state-schema",
      source: [{ kind: "sqlite", path: stateDatabasePath }],
      target: [{ kind: "sqlite", path: stateDatabasePath }],
      outcome: "completed",
      warnings: [],
    });
    expect(plan.steps.find((step) => step.id === "config-machine-state")).toMatchObject({
      source: [{ kind: "path", path: fixture.configPath }],
      target: [{ kind: "sqlite", path: stateDatabasePath }],
      requiredness: "conditional",
      outcome: "planned",
    });
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "config-machine-state"),
    ).toMatchObject({
      source: [{ kind: "path", path: fixture.configPath }],
      target: [{ kind: "sqlite", path: stateDatabasePath }],
      outcome: "completed",
      warnings: [],
    });
    for (const stepId of ["media-persistence", "transcript-directives"] as const) {
      expect(plan.steps.find((step) => step.id === stepId)).toMatchObject({
        source: expect.arrayContaining([
          { kind: "sqlite", path: stateDatabasePath },
          { kind: "path", path: path.join(fixture.stateDir, "agents") },
        ]),
        target: expect.arrayContaining([
          { kind: "sqlite", path: stateDatabasePath },
          { kind: "path", path: path.join(fixture.stateDir, "agents") },
        ]),
        requiredness: "conditional",
        outcome: "deferred",
        refusal: { code: "agent-target-discovery-failed" },
      });
      expect(result.stepReceipts.find((receipt) => receipt.id === stepId)).toMatchObject({
        outcome: "skipped",
        warnings: [],
      });
    }
    expect(plan.steps.find((step) => step.id === "profile-workspace")).toMatchObject({
      source: [],
      target: [],
      requiredness: "not-required",
      outcome: "skipped",
    });
    expect(result.stepReceipts.find((receipt) => receipt.id === "profile-workspace")).toMatchObject(
      { outcome: "skipped", warnings: [] },
    );
    expect(plan.steps.find((step) => step.id === "orphan-session-keys")).toMatchObject({
      source: expect.arrayContaining([{ kind: "path", path: fixture.configPath }]),
      requiredness: "conditional",
      outcome: "deferred",
      refusal: { code: "session-target-discovery-failed" },
    });
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "orphan-session-keys"),
    ).toMatchObject({ outcome: "skipped", warnings: [] });
    expect(result.stepReceipts.find((receipt) => receipt.id === "device-auth")).toMatchObject({
      source: [{ kind: "path", path: deviceAuthPath }],
      outcome: "completed",
      warnings: [],
    });
    expect(result.stepReceipts.find((receipt) => receipt.id === "exec-approvals")).toMatchObject({
      source: [{ kind: "path", path: execPath }],
      outcome: "completed",
      warnings: [],
    });
    expect(result.stepReceipts.find((receipt) => receipt.id === "tui-last-session")).toMatchObject({
      source: [{ kind: "path", path: tuiPath }],
      outcome: "completed",
      warnings: [],
    });
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "legacy-main-session-keys"),
    ).toBeUndefined();
    expect(fs.existsSync(execPath)).toBe(false);
    expect(fs.existsSync(tuiPath)).toBe(false);
    expect(
      readLegacyMigrationReceipt(
        resolveLegacyMigrationSourceKey("exec-approvals-json", execPath),
        fixture.env,
      ),
    ).not.toBeNull();
  });

  it("returns an explicit refusal receipt when a required Doctor step cannot run", async () => {
    const fixture = await makeFixture();
    const { execPath, tuiPath } = writeLegacyDoctorSources(fixture.stateDir, {});
    fs.writeFileSync(tuiPath, "not json\n");
    const emittedReceipts: LegacyStateMigrationStepReceipt[] = [];

    const result = await autoMigrateLegacyState({
      cfg: {},
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      onStepReceipt: (receipt) => emittedReceipts.push(receipt),
    });

    const tuiReceipt = result.stepReceipts.find((receipt) => receipt.id === "tui-last-session");
    expect(tuiReceipt).toMatchObject({
      outcome: "refused",
      refusal: { code: "step-refused" },
    });
    expect(emittedReceipts.find((receipt) => receipt.id === "tui-last-session")).toEqual(
      tuiReceipt,
    );
    expect(result.warnings.join("\n")).toContain("Failed reading legacy TUI last-session state");
    expect(fs.readFileSync(tuiPath, "utf8")).toBe("not json\n");
    expect(result.stepReceipts.find((receipt) => receipt.id === "exec-approvals")).toBeUndefined();
    expect(fs.existsSync(execPath)).toBe(true);
  });

  it("returns thrown-step receipts and stops later Doctor mutations", async () => {
    const fixture = await makeFixture();
    const { execPath } = writeLegacyDoctorSources(fixture.stateDir, {});
    const pluginDoctorConfig = Object.defineProperty({}, "meta", {
      get() {
        throw new Error("synthetic config migration failure");
      },
    }) as OpenClawConfig;
    const emittedReceipts: LegacyStateMigrationStepReceipt[] = [];

    const result = await autoMigrateLegacyState({
      cfg: {},
      pluginDoctorConfig,
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      onStepReceipt: (receipt) => emittedReceipts.push(receipt),
    });

    expect(result.stepReceipts.map((receipt) => receipt.id)).toEqual([
      "state-schema",
      "config-machine-state",
    ]);
    expect(result.stepReceipts.at(-1)).toMatchObject({
      id: "config-machine-state",
      outcome: "refused",
      changes: [],
      warnings: ["synthetic config migration failure"],
      refusal: { code: "step-threw", message: "synthetic config migration failure" },
    });
    expect(emittedReceipts).toEqual(result.stepReceipts);
    expect(fs.existsSync(execPath)).toBe(true);
  });

  it("returns target-discovery refusal after a completed schema step", async () => {
    const fixture = await makeFixture();
    const { execPath } = writeLegacyDoctorSources(fixture.stateDir, {});
    writeLegacyStateSchemaV1(resolveOpenClawStateSqlitePath(fixture.env));
    const lastTouchedAt = "2026-09-02T00:00:00.000Z";
    const cfg = Object.defineProperty({ meta: { lastTouchedAt } }, "session", {
      get() {
        throw new Error("synthetic agent target discovery failure");
      },
    }) as OpenClawConfig;

    const result = await autoMigrateLegacyState({
      cfg,
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(result.stepReceipts.map((receipt) => receipt.id)).toEqual([
      "state-schema",
      "config-machine-state",
      "agent-migration-targets",
    ]);
    expect(result.stepReceipts.at(-1)).toMatchObject({
      id: "agent-migration-targets",
      outcome: "refused",
      refusal: { code: "step-refused" },
    });
    expect(result.warnings.join("\n")).toContain("synthetic agent target discovery failure");
    expect(result.stepReceipts[0]).toMatchObject({ outcome: "completed" });
    expect(result.stepReceipts[0]?.changes.length).toBeGreaterThan(0);
    expect(result.stepReceipts[1]).toMatchObject({
      id: "config-machine-state",
      outcome: "completed",
    });
    expect(readConfigMachineState("config.lastTouchedAt", { env: fixture.env })).toBe(
      lastTouchedAt,
    );
    expect(fs.existsSync(execPath)).toBe(true);
  });

  it("returns detection refusal after preludes and stops later Doctor mutations", async () => {
    const fixture = await makeFixture();
    const { execPath } = writeLegacyDoctorSources(fixture.stateDir, {});
    const params = Object.defineProperty(
      {
        cfg: {},
        doctorOnlyStateMigrations: true,
        env: fixture.env,
        homedir: () => fixture.homeDir,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      } as Parameters<typeof autoMigrateLegacyState>[0],
      "allowLegacyDeviceIdentityImport",
      {
        get() {
          throw new Error("synthetic execution detection failure");
        },
      },
    );

    const result = await autoMigrateLegacyState(params);

    expect(result.stepReceipts.at(-1)).toMatchObject({
      id: "migration-detection",
      outcome: "refused",
      refusal: { code: "step-threw" },
    });
    expect(result.warnings.join("\n")).toContain("synthetic execution detection failure");
    expect(result.stepReceipts.find((receipt) => receipt.id === "exec-approvals")).toBeUndefined();
    expect(fs.existsSync(execPath)).toBe(true);
  });

  it("reports a completed profile move when plugin preparation refuses", async () => {
    const fixture = await makeFixture();
    fixture.env.OPENCLAW_PROFILE = "work";
    const paths = resolveLegacyProfileWorkspaceMigrationPaths({
      env: fixture.env,
      homedir: () => fixture.homeDir,
    });
    if (!paths) {
      throw new Error("named profile did not resolve migration paths");
    }
    fs.mkdirSync(paths.source, { recursive: true });
    fs.writeFileSync(path.join(paths.source, "AGENTS.md"), "profile workspace");
    const legacySessionSurfaces = Object.defineProperty({ surfaces: [] }, "failures", {
      get() {
        throw new Error("synthetic plugin preparation failure");
      },
    }) as typeof EMPTY_LEGACY_SESSION_SURFACES;

    const result = await autoMigrateLegacyState({
      cfg: {},
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces,
    });

    const profileChange = `Profile workspace: ${paths.source} → ${paths.target}`;
    expect(result.migrated).toBe(true);
    expect(result.changes).toContain(profileChange);
    expect(result.stepReceipts.find((receipt) => receipt.id === "profile-workspace")).toMatchObject(
      {
        outcome: "completed",
        changes: [profileChange],
      },
    );
    expect(result.stepReceipts.at(-1)).toMatchObject({
      id: "plugin-migration-preparation",
      outcome: "refused",
      refusal: { code: "step-threw" },
    });
    expect(fs.existsSync(paths.source)).toBe(false);
    expect(fs.readFileSync(path.join(paths.target, "AGENTS.md"), "utf8")).toBe("profile workspace");
  });

  it("halts direct Doctor execution after an unanticipated state-schema refusal", async () => {
    const fixture = await makeFixture();
    const voiceWakePath = path.join(fixture.stateDir, "settings", "voicewake.json");
    fs.mkdirSync(path.dirname(voiceWakePath), { recursive: true });
    fs.writeFileSync(voiceWakePath, '{"triggers":["wake"]}\n');
    const detected = await detectLegacyStateMigrations({
      cfg: {},
      mode: "doctor",
      env: fixture.env,
      homedir: () => fixture.homeDir,
      doctorOnlyStateMigrations: true,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(detected.stateSchema.hasLegacy).toBe(false);
    const stateDatabasePath = resolveOpenClawStateSqlitePath(fixture.env);
    fs.mkdirSync(path.dirname(stateDatabasePath), { recursive: true });
    const database = new DatabaseSync(stateDatabasePath);
    try {
      database.exec("PRAGMA user_version = 999;");
    } finally {
      database.close();
    }

    const result = await runLegacyStateMigrations({
      detected,
      config: {},
      env: fixture.env,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(result.stepReceipts.map((receipt) => receipt.id)).toEqual(["state-schema"]);
    expect(result.stepReceipts[0]).toMatchObject({ outcome: "refused" });
    expect(result.warnings.join("\n")).toContain("uses newer schema version 999");
    expect(fs.existsSync(voiceWakePath)).toBe(true);
  });
});
