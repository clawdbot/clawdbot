import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pluginDoctorContractRegistryLoaderState } from "../plugins/doctor-contract-registry-loader-state.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  autoMigrateLegacyState,
  planLegacyStateMigrationsReadOnly,
} from "./state-migrations.doctor.js";
import type { LegacyStateMigrationPlan } from "./state-migrations.types.js";

const tempDirs = createTrackedTempDirs();

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

describe("legacy state migration caller storage", () => {
  it("binds WAL-backed shared-auth and meeting-transcript inputs as SQLite", async () => {
    const fixture = await makeFixture();
    const cfg: OpenClawConfig = { agents: { list: [{ id: "main", default: true }] } };
    fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
    const agentDatabasePath = path.join(
      fixture.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    const stateDatabasePath = resolveOpenClawStateSqlitePath(fixture.env);
    openOpenClawStateDatabase({ env: fixture.env });
    openOpenClawAgentDatabase({
      agentId: "main",
      env: fixture.env,
      path: agentDatabasePath,
    });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const agentDatabase = new DatabaseSync(agentDatabasePath);
    const stateDatabase = new DatabaseSync(stateDatabasePath);
    let plan: LegacyStateMigrationPlan | undefined;
    try {
      agentDatabase.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      agentDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      agentDatabase
        .prepare(
          "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)",
        )
        .run(
          "primary",
          JSON.stringify({
            version: 1,
            profiles: {
              "openai:wal": { type: "api_key", provider: "openai", key: "wal-key" },
            },
          }),
          1,
        );
      stateDatabase.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      stateDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const historicalSlug = `meeting-${"x".repeat(2200)}`;
      stateDatabase
        .prepare(
          `INSERT INTO meeting_transcript_sessions
             (session_id, started_at, selector, export_key, session_slug, provider_id,
              source_json, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "wal-meeting",
          "2026-09-03T00:00:00.000Z",
          `2026-09-03/${historicalSlug}`,
          `2026-09-03/${historicalSlug}`,
          historicalSlug,
          "manual-transcript",
          JSON.stringify({ providerId: "manual-transcript", channelId: "room" }),
          1,
          1,
        );
      expect(fs.existsSync(`${agentDatabasePath}-wal`)).toBe(true);
      expect(fs.existsSync(`${stateDatabasePath}-wal`)).toBe(true);

      plan = await planLegacyStateMigrationsReadOnly({
        mode: "doctor",
        candidate: candidateAt(fixture.root),
        snapshot: {
          homeDir: fixture.homeDir,
          configPath: fixture.configPath,
          stateDir: fixture.stateDir,
        },
        env: fixture.env,
      });
    } finally {
      agentDatabase.close();
      stateDatabase.close();
    }
    if (!plan) {
      throw new Error("expected WAL-backed migration plan");
    }
    const sharedAuthPlan = plan.steps.find((step) => step.id === "shared-auth-store");
    const meetingPlan = plan.steps.find((step) => step.id === "meeting-transcripts");
    expect(sharedAuthPlan).toMatchObject({
      requiredness: "conditional",
      source: [{ kind: "sqlite", path: agentDatabasePath }],
    });
    expect(meetingPlan).toMatchObject({ requiredness: "required" });
    expect(meetingPlan?.source).toContainEqual({ kind: "sqlite", path: stateDatabasePath });

    const result = await autoMigrateLegacyState({
      cfg,
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(result.stepReceipts.find((receipt) => receipt.id === "shared-auth-store")).toMatchObject(
      {
        outcome: "completed",
        source: sharedAuthPlan?.source,
        requiredness: "conditional",
      },
    );
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "meeting-transcripts"),
    ).toMatchObject({
      outcome: "completed",
      source: meetingPlan?.source,
    });
  });

  it("plans managed-worktree owners that remain after state-schema repair", async () => {
    const fixture = await makeFixture();
    const stateDatabase = openOpenClawStateDatabase({ env: fixture.env });
    stateDatabase.db
      .prepare(`
        INSERT INTO worktrees (
          id, repo_fingerprint, repo_root, path, branch, base_ref, owner_kind,
          created_at, last_active_at, provisioned_paths_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `)
      .run(
        "legacy-after-schema",
        "legacy-fingerprint",
        fixture.root,
        path.join(fixture.stateDir, "worktrees", "legacy-after-schema"),
        "openclaw/legacy-after-schema",
        "HEAD",
        "session",
        1,
        1,
      );
    const stateDatabasePath = stateDatabase.path;
    closeOpenClawStateDatabaseForTest();
    const legacy = new DatabaseSync(stateDatabasePath);
    try {
      legacy.exec("PRAGMA user_version = 1;");
    } finally {
      legacy.close();
    }

    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: candidateAt(fixture.root),
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        stateDir: fixture.stateDir,
      },
      env: fixture.env,
    });

    expect(plan.steps[0]).toMatchObject({ id: "state-schema", requiredness: "required" });
    expect(plan.steps.find((step) => step.id === "managed-worktrees")).toMatchObject({
      source: [
        { kind: "sqlite", path: stateDatabasePath },
        { kind: "owner", id: "core:managed-worktree:legacy-after-schema" },
      ],
      requiredness: "required",
    });
  });
});
