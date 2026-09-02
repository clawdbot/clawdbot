import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pluginDoctorContractRegistryLoaderState } from "../plugins/doctor-contract-registry-loader-state.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  autoMigrateLegacyState,
  planLegacyStateMigrationsReadOnly,
} from "./state-migrations.doctor.js";
import {
  readLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";
import type { LegacyStateMigrationStepReceipt } from "./state-migrations.types.js";

const tempDirs = createTrackedTempDirs();

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
  const configBytes = `${JSON.stringify(cfg)}\n`;
  fs.writeFileSync(configPath, configBytes);
  const env = { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir };
  return { root, homeDir, stateDir, configPath, configBytes, cfg, env };
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
      cfg: fixture.cfg,
      mode: "doctor",
      candidate: {
        root: path.join(fixture.root, "candidate"),
        version: "2026.9.2-candidate",
        digest: "sha256:candidate",
      },
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        configDigest: sha256(fixture.configBytes),
        stateDir: fixture.stateDir,
        stateDigest: "sha256:copied-state",
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
        digest: "sha256:candidate",
      },
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        configDigest: sha256(fixture.configBytes),
        stateDir: fixture.stateDir,
        stateDigest: "sha256:copied-state",
      },
    });
    expect(plan.planIntegrity).toMatch(/^sha256:[0-9a-f]{64}$/u);
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
      cfg,
      mode: "automatic",
      candidate: { root: fixture.root, version: "test", digest: "sha256:candidate" },
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        configDigest: sha256(configBytes),
        stateDir: fixture.stateDir,
        stateDigest: "sha256:copied-state",
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
  });

  it("returns a closed refusal when read-only detection cannot produce a safe plan", async () => {
    const fixture = await makeFixture();
    const before = snapshotFiles(fixture.root);
    const plan = await planLegacyStateMigrationsReadOnly({
      cfg: fixture.cfg,
      mode: "doctor",
      candidate: { root: fixture.root, version: "test", digest: "sha256:candidate" },
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        configDigest: sha256(fixture.configBytes),
        stateDir: fixture.stateDir,
        stateDigest: "sha256:copied-state",
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

  it("executes and receipts Doctor-owned exec and TUI migrations from the same mode", async () => {
    const fixture = await makeFixture();
    const { execPath, tuiPath } = writeLegacyDoctorSources(fixture.stateDir, {
      terminal: { sessionKey: "agent:main:tui:execute", updatedAt: 100 },
    });

    const result = await autoMigrateLegacyState({
      cfg: {},
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(result.mode).toBe("doctor");
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
    const tuiPath = path.join(fixture.stateDir, "tui", "last-session.json");
    fs.mkdirSync(path.dirname(tuiPath), { recursive: true });
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
  });
});
