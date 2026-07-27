import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
  readWorkspaceStateSnapshot,
  resolveWorkspaceStateIdentity,
} from "../agents/workspace-state-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "./state-migrations.workspace-setup.js";

const HASH = "a".repeat(64);

describe("legacy workspace Doctor migration", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      envSnapshot?.restore();
      envSnapshot = undefined;
      cleanup();
    });
  });

  function setup() {
    const homeDir = tempDirs.make("openclaw-workspace-migration-home-");
    const stateDir = path.join(homeDir, ".openclaw");
    const workspaceDir = path.join(homeDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    envSnapshot ??= captureEnv(["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    setTestEnvValue("HOME", homeDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const cfg = {
      agents: { defaults: { workspace: workspaceDir } },
    } satisfies OpenClawConfig;
    return {
      cfg,
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir },
      homeDir,
      stateDir,
      workspaceDir,
    };
  }

  function detect(context: ReturnType<typeof setup>) {
    return detectLegacyWorkspaceState({
      cfg: context.cfg,
      stateDir: context.stateDir,
      env: context.env,
      homedir: () => context.homeDir,
      doctorOnlyStateMigrations: true,
    });
  }

  async function migrate(context: ReturnType<typeof setup>) {
    return await migrateLegacyWorkspaceState({
      detected: detect(context),
      env: context.env,
      stateDir: context.stateDir,
    });
  }

  it("detects configured and orphan sources only for explicit Doctor repair", async () => {
    const context = setup();
    const setupPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    const canonicalSetupPath = path.join(
      resolveWorkspaceStateIdentity(context.workspaceDir).workspacePath,
      "openclaw-workspace-state.json",
    );
    await fsp.writeFile(setupPath, JSON.stringify({ version: 1 }), "utf8");
    const orphanKey = "b".repeat(64);
    const orphanPath = path.join(
      context.stateDir,
      "workspace-attestations",
      `${orphanKey}.attested`,
    );
    await fsp.mkdir(path.dirname(orphanPath), { recursive: true });
    await fsp.writeFile(
      orphanPath,
      "openclaw-workspace-attestation:v1\n2026-07-16T00:00:00.000Z\n",
      "utf8",
    );

    expect(
      detectLegacyWorkspaceState({
        cfg: context.cfg,
        stateDir: context.stateDir,
        env: context.env,
        homedir: () => context.homeDir,
      }),
    ).toEqual({ sources: [], hasLegacy: false });
    expect(detect(context)).toMatchObject({
      hasLegacy: true,
      sources: expect.arrayContaining([
        expect.objectContaining({ kind: "setup", sourcePath: canonicalSetupPath }),
        expect.objectContaining({ kind: "attestation", workspaceKey: orphanKey }),
      ]),
    });
  });

  it("imports setup and attestation state, records receipts, and removes files", async () => {
    const context = setup();
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const seededAt = "2026-07-15T10:00:00.000Z";
    const completedAt = "2026-07-15T10:01:00.000Z";
    const setupPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    await fsp.writeFile(
      setupPath,
      JSON.stringify({ version: 1, bootstrapSeededAt: seededAt, setupCompletedAt: completedAt }),
      "utf8",
    );
    const attestationPath = path.join(
      context.stateDir,
      "workspace-attestations",
      `${identity.workspaceKey}.attested`,
    );
    await fsp.mkdir(path.dirname(attestationPath), { recursive: true });
    await fsp.writeFile(
      attestationPath,
      `openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\ngenerated:AGENTS.md:${HASH}\n`,
      "utf8",
    );
    const mtime = new Date("2026-07-15T11:02:03.456Z");
    await fsp.utimes(attestationPath, mtime, mtime);

    const result = await migrate(context);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(2);
    expect(fs.existsSync(setupPath)).toBe(false);
    expect(fs.existsSync(attestationPath)).toBe(false);
    const db = openOpenClawStateDatabase({ env: context.env }).db;
    expect(
      db
        .prepare(
          "SELECT workspace_path, bootstrap_seeded_at, setup_completed_at FROM workspace_setup_state WHERE workspace_key = ?",
        )
        .get(identity.workspaceKey),
    ).toEqual({
      workspace_path: identity.workspacePath,
      bootstrap_seeded_at: seededAt,
      setup_completed_at: completedAt,
    });
    expect(
      db
        .prepare("SELECT attested_at_ms FROM workspace_attestations WHERE workspace_key = ?")
        .get(identity.workspaceKey),
    ).toEqual({ attested_at_ms: mtime.getTime() });
    expect(
      db
        .prepare(
          "SELECT filename, sha256 FROM workspace_generated_bootstrap_hashes WHERE workspace_key = ?",
        )
        .get(identity.workspaceKey),
    ).toEqual({ filename: "AGENTS.md", sha256: HASH });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count, SUM(removed_source) AS removed FROM migration_sources WHERE migration_kind = ?",
        )
        .get("legacy-workspace-setup-files"),
    ).toEqual({ count: 2, removed: 2 });
  });

  it("imports the legacy onboarding completion alias", async () => {
    const context = setup();
    const completedAt = "2026-07-15T10:01:00.000Z";
    const setupPath = path.join(context.workspaceDir, ".openclaw", "workspace-state.json");
    await fsp.mkdir(path.dirname(setupPath), { recursive: true });
    await fsp.writeFile(setupPath, JSON.stringify({ onboardingCompletedAt: completedAt }), "utf8");

    const result = await migrate(context);

    expect(result.warnings).toEqual([]);
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    expect(
      openOpenClawStateDatabase({ env: context.env })
        .db.prepare("SELECT setup_completed_at FROM workspace_setup_state WHERE workspace_key = ?")
        .get(identity.workspaceKey),
    ).toEqual({ setup_completed_at: completedAt });
  });

  it("persists the configured symlink alias during Doctor import", async () => {
    const context = setup();
    const workspaceAlias = path.join(context.homeDir, "workspace-link");
    fs.symlinkSync(
      context.workspaceDir,
      workspaceAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const aliasContext = {
      ...context,
      cfg: { agents: { defaults: { workspace: workspaceAlias } } } satisfies OpenClawConfig,
      workspaceDir: workspaceAlias,
    };
    const completedAt = "2026-07-15T10:01:00.000Z";
    await fsp.writeFile(
      path.join(workspaceAlias, "openclaw-workspace-state.json"),
      JSON.stringify({ setupCompletedAt: completedAt }),
      "utf8",
    );
    const canonicalSiblingPath = `${resolveWorkspaceStateIdentity(context.workspaceDir).workspacePath}.attested`;
    await fsp.writeFile(
      canonicalSiblingPath,
      `openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n`,
      "utf8",
    );

    expect((await migrate(aliasContext)).warnings).toEqual([]);
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    expect(fs.existsSync(canonicalSiblingPath)).toBe(false);
    fs.unlinkSync(workspaceAlias);

    expect(readWorkspaceStateSnapshot(workspaceAlias)).toMatchObject({
      identity,
      setup: { setupCompletedAt: completedAt },
    });
  });

  it("preserves configured metadata when orphan discovery finds the same marker", async () => {
    const context = setup();
    const workspaceAlias = path.join(context.homeDir, "workspace-link");
    fs.symlinkSync(
      context.workspaceDir,
      workspaceAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const aliasContext = {
      ...context,
      cfg: { agents: { defaults: { workspace: workspaceAlias } } } satisfies OpenClawConfig,
      workspaceDir: workspaceAlias,
    };
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const attestationPath = path.join(
      context.stateDir,
      "workspace-attestations",
      `${identity.workspaceKey}.attested`,
    );
    await fsp.mkdir(path.dirname(attestationPath), { recursive: true });
    await fsp.writeFile(
      attestationPath,
      "openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n",
      "utf8",
    );
    const attestedAt = new Date("2026-07-15T11:00:00.000Z");
    await fsp.utimes(attestationPath, attestedAt, attestedAt);

    const detected = detect(aliasContext);
    expect(detected.sources.find((source) => source.sourcePath === attestationPath)).toMatchObject({
      workspaceDir: identity.workspacePath,
      workspaceAliasPath: path.resolve(workspaceAlias),
      priority: 1,
    });
    expect((await migrate(aliasContext)).warnings).toEqual([]);
    fs.unlinkSync(workspaceAlias);

    expect(readWorkspaceStateSnapshot(workspaceAlias)).toMatchObject({
      identity,
      attestation: { attestedAtMs: attestedAt.getTime() },
    });
  });

  it("isolates receipts when a configured alias is repointed", async () => {
    const context = setup();
    const targetB = path.join(context.homeDir, "workspace-b");
    const workspaceAlias = path.join(context.homeDir, "workspace-link");
    fs.mkdirSync(targetB, { recursive: true });
    fs.symlinkSync(
      context.workspaceDir,
      workspaceAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const aliasContext = {
      ...context,
      cfg: { agents: { defaults: { workspace: workspaceAlias } } } satisfies OpenClawConfig,
      workspaceDir: workspaceAlias,
    };
    const sourcePath = `${workspaceAlias}.attested`;
    const identityA = resolveWorkspaceStateIdentity(context.workspaceDir);
    await fsp.writeFile(
      sourcePath,
      "openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n",
      "utf8",
    );
    const attestedAtA = new Date("2026-07-15T11:00:00.000Z");
    await fsp.utimes(sourcePath, attestedAtA, attestedAtA);
    expect((await migrate(aliasContext)).warnings).toEqual([]);

    fs.unlinkSync(workspaceAlias);
    fs.symlinkSync(targetB, workspaceAlias, process.platform === "win32" ? "junction" : "dir");
    deleteWorkspaceState(prepareWorkspaceStateDeletion(workspaceAlias));
    const identityB = resolveWorkspaceStateIdentity(targetB);
    await fsp.writeFile(
      sourcePath,
      "openclaw-workspace-attestation:v1\n2026-07-15T12:00:00.000Z\n",
      "utf8",
    );
    const attestedAtB = new Date("2026-07-15T12:00:00.000Z");
    await fsp.utimes(sourcePath, attestedAtB, attestedAtB);

    expect((await migrate(aliasContext)).warnings).toEqual([]);
    const db = openOpenClawStateDatabase({ env: context.env }).db;
    expect(
      db
        .prepare(
          "SELECT workspace_key, attested_at_ms FROM workspace_attestations ORDER BY workspace_key",
        )
        .all(),
    ).toEqual(
      [
        {
          workspace_key: identityA.workspaceKey,
          attested_at_ms: attestedAtA.getTime(),
        },
        {
          workspace_key: identityB.workspaceKey,
          attested_at_ms: attestedAtB.getTime(),
        },
      ].toSorted((left, right) => left.workspace_key.localeCompare(right.workspace_key)),
    );
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM migration_sources WHERE source_path = ?")
        .get(sourcePath),
    ).toEqual({ count: 2 });
  });

  it("rejects a configured workspace identity change before claiming a source", async () => {
    const context = setup();
    const targetB = path.join(context.homeDir, "workspace-b");
    const workspaceAlias = path.join(context.homeDir, "workspace-link");
    fs.mkdirSync(targetB, { recursive: true });
    fs.symlinkSync(
      context.workspaceDir,
      workspaceAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const aliasContext = {
      ...context,
      cfg: { agents: { defaults: { workspace: workspaceAlias } } } satisfies OpenClawConfig,
      workspaceDir: workspaceAlias,
    };
    const identityA = resolveWorkspaceStateIdentity(context.workspaceDir);
    const attestationPath = path.join(
      context.stateDir,
      "workspace-attestations",
      `${identityA.workspaceKey}.attested`,
    );
    await fsp.mkdir(path.dirname(attestationPath), { recursive: true });
    await fsp.writeFile(
      attestationPath,
      "openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n",
      "utf8",
    );
    const detected = detect(aliasContext);

    const result = await migrateLegacyWorkspaceState({
      detected,
      env: context.env,
      stateDir: context.stateDir,
      beforeClaim: () => {
        fs.unlinkSync(workspaceAlias);
        fs.symlinkSync(targetB, workspaceAlias, process.platform === "win32" ? "junction" : "dir");
      },
    });

    expect(result.warnings[0]).toContain("configured workspace identity changed");
    expect(fs.existsSync(attestationPath)).toBe(true);
    expect(fs.existsSync(`${attestationPath}.doctor-importing`)).toBe(false);
    const db = openOpenClawStateDatabase({ env: context.env }).db;
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_attestations").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM migration_sources").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_path_aliases").get()).toEqual({
      count: 0,
    });
  });

  it("removes a stale nested setup marker after the root marker wins", async () => {
    const context = setup();
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const rootPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    const nestedPath = path.join(context.workspaceDir, ".openclaw", "workspace-state.json");
    const rootSeededAt = "2026-07-15T10:00:00.000Z";
    const completedAt = "2026-07-15T10:01:00.000Z";
    await fsp.mkdir(path.dirname(nestedPath), { recursive: true });
    await fsp.writeFile(
      rootPath,
      JSON.stringify({
        version: 1,
        bootstrapSeededAt: rootSeededAt,
        setupCompletedAt: completedAt,
      }),
      "utf8",
    );
    await fsp.writeFile(
      nestedPath,
      JSON.stringify({ version: 1, bootstrapSeededAt: "2026-07-14T09:00:00.000Z" }),
      "utf8",
    );

    const result = await migrate(context);

    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(rootPath)).toBe(false);
    expect(fs.existsSync(nestedPath)).toBe(false);
    expect(
      openOpenClawStateDatabase({ env: context.env })
        .db.prepare(
          "SELECT bootstrap_seeded_at, setup_completed_at FROM workspace_setup_state WHERE workspace_key = ?",
        )
        .get(identity.workspaceKey),
    ).toEqual({ bootstrap_seeded_at: rootSeededAt, setup_completed_at: completedAt });
  });

  it("imports an orphan state-directory attestation by its hashed workspace key", async () => {
    const context = setup();
    const orphanKey = "c".repeat(64);
    const attestationPath = path.join(
      context.stateDir,
      "workspace-attestations",
      `${orphanKey}.attested`,
    );
    await fsp.mkdir(path.dirname(attestationPath), { recursive: true });
    await fsp.writeFile(
      attestationPath,
      `openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\ngenerated:TOOLS.md:${HASH}\n`,
      "utf8",
    );

    const result = await migrate(context);

    expect(result.warnings).toEqual([]);
    expect(
      openOpenClawStateDatabase({ env: context.env })
        .db.prepare(
          "SELECT filename, sha256 FROM workspace_generated_bootstrap_hashes WHERE workspace_key = ?",
        )
        .get(orphanKey),
    ).toEqual({ filename: "TOOLS.md", sha256: HASH });
    expect(fs.existsSync(attestationPath)).toBe(false);
  });

  it("imports an owned sibling attestation", async () => {
    const context = setup();
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const attestationPath = `${context.workspaceDir}.attested`;
    await fsp.writeFile(
      attestationPath,
      `openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\ngenerated:USER.md:${HASH}\n`,
      "utf8",
    );

    const result = await migrate(context);

    expect(result.warnings).toEqual([]);
    expect(
      openOpenClawStateDatabase({ env: context.env })
        .db.prepare(
          "SELECT filename FROM workspace_generated_bootstrap_hashes WHERE workspace_key = ?",
        )
        .get(identity.workspaceKey),
    ).toEqual({ filename: "USER.md" });
    expect(fs.existsSync(attestationPath)).toBe(false);
  });

  it("consolidates attestation paths using newest modification time", async () => {
    const context = setup();
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const currentPath = path.join(
      context.stateDir,
      "workspace-attestations",
      `${identity.workspaceKey}.attested`,
    );
    const siblingPath = `${context.workspaceDir}.attested`;
    await fsp.mkdir(path.dirname(currentPath), { recursive: true });
    await fsp.writeFile(
      currentPath,
      `openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\ngenerated:AGENTS.md:${HASH}\n`,
      "utf8",
    );
    await fsp.writeFile(
      siblingPath,
      `openclaw-workspace-attestation:v1\n2026-07-15T12:00:00.000Z\ngenerated:USER.md:${"b".repeat(64)}\n`,
      "utf8",
    );
    const currentMtime = new Date("2026-07-15T11:00:00.000Z");
    const siblingMtime = new Date("2026-07-15T12:00:00.000Z");
    await fsp.utimes(currentPath, currentMtime, currentMtime);
    await fsp.utimes(siblingPath, siblingMtime, siblingMtime);

    const result = await migrate(context);

    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(currentPath)).toBe(false);
    expect(fs.existsSync(siblingPath)).toBe(false);
    expect(
      openOpenClawStateDatabase({ env: context.env })
        .db.prepare(
          "SELECT filename, sha256 FROM workspace_generated_bootstrap_hashes WHERE workspace_key = ?",
        )
        .all(identity.workspaceKey),
    ).toEqual([{ filename: "USER.md", sha256: "b".repeat(64) }]);
  });

  it("uses source priority for equal-time attestation snapshots", async () => {
    const context = setup();
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const currentPath = path.join(
      context.stateDir,
      "workspace-attestations",
      `${identity.workspaceKey}.attested`,
    );
    const siblingPath = `${context.workspaceDir}.attested`;
    await fsp.mkdir(path.dirname(currentPath), { recursive: true });
    await fsp.writeFile(
      currentPath,
      `openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\ngenerated:AGENTS.md:${HASH}\n`,
      "utf8",
    );
    await fsp.writeFile(
      siblingPath,
      `openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\ngenerated:USER.md:${"b".repeat(64)}\n`,
      "utf8",
    );
    const sameMtime = new Date("2026-07-15T11:00:00.000Z");
    await fsp.utimes(currentPath, sameMtime, sameMtime);
    await fsp.utimes(siblingPath, sameMtime, sameMtime);

    const result = await migrate(context);

    expect(result.warnings).toEqual([]);
    expect(
      openOpenClawStateDatabase({ env: context.env })
        .db.prepare(
          "SELECT filename, sha256 FROM workspace_generated_bootstrap_hashes WHERE workspace_key = ?",
        )
        .all(identity.workspaceKey),
    ).toEqual([{ filename: "AGENTS.md", sha256: HASH }]);
  });

  it("lets a later higher-priority marker replace an equal-time attestation", async () => {
    const context = setup();
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const currentPath = path.join(
      context.stateDir,
      "workspace-attestations",
      `${identity.workspaceKey}.attested`,
    );
    const siblingPath = `${context.workspaceDir}.attested`;
    const sameMtime = new Date("2026-07-15T11:00:00.000Z");
    await fsp.writeFile(
      siblingPath,
      `openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\ngenerated:USER.md:${"b".repeat(64)}\n`,
      "utf8",
    );
    await fsp.utimes(siblingPath, sameMtime, sameMtime);
    expect((await migrate(context)).warnings).toEqual([]);

    await fsp.mkdir(path.dirname(currentPath), { recursive: true });
    await fsp.writeFile(
      currentPath,
      `openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\ngenerated:AGENTS.md:${HASH}\n`,
      "utf8",
    );
    await fsp.utimes(currentPath, sameMtime, sameMtime);

    const result = await migrate(context);

    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(currentPath)).toBe(false);
    expect(
      openOpenClawStateDatabase({ env: context.env })
        .db.prepare(
          "SELECT filename, sha256 FROM workspace_generated_bootstrap_hashes WHERE workspace_key = ?",
        )
        .all(identity.workspaceKey),
    ).toEqual([{ filename: "AGENTS.md", sha256: HASH }]);
  });

  it("resumes an interrupted unreceipted claim", async () => {
    const context = setup();
    const setupPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    const claimPath = `${setupPath}.doctor-importing`;
    await fsp.writeFile(
      setupPath,
      JSON.stringify({ version: 1, setupCompletedAt: "2026-07-15T10:01:00.000Z" }),
      "utf8",
    );
    await fsp.rename(setupPath, claimPath);

    const result = await migrate(context);

    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(claimPath)).toBe(false);
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    expect(
      openOpenClawStateDatabase({ env: context.env })
        .db.prepare("SELECT setup_completed_at FROM workspace_setup_state WHERE workspace_key = ?")
        .get(identity.workspaceKey),
    ).toEqual({ setup_completed_at: "2026-07-15T10:01:00.000Z" });
  });

  it.each(["hardlink", "oversized"] as const)(
    "detects but retains an owned %s sibling attestation",
    async (kind) => {
      const context = setup();
      const attestationPath = `${context.workspaceDir}.attested`;
      const content = `openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n${kind === "oversized" ? "x".repeat(3_000) : ""}`;
      if (kind === "hardlink") {
        const targetPath = path.join(context.homeDir, "attestation-target");
        await fsp.writeFile(targetPath, content, "utf8");
        await fsp.link(targetPath, attestationPath);
      } else {
        await fsp.writeFile(attestationPath, content, "utf8");
      }

      expect(detect(context).hasLegacy).toBe(true);
      const result = await migrate(context);

      expect(result.warnings[0]).toMatch(/legacy workspace/i);
      expect(fs.existsSync(attestationPath)).toBe(true);
      expect(fs.existsSync(`${attestationPath}.doctor-importing`)).toBe(false);
    },
  );

  it.each([
    "symlink",
    "hardlink",
    "invalid-json",
    "invalid-attestation",
    "oversized-attestation",
  ] as const)("rejects %s without changing canonical state", async (kind) => {
    const context = setup();
    const setupPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    let sourcePath = setupPath;
    if (kind === "invalid-attestation" || kind === "oversized-attestation") {
      const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
      const attestationPath = path.join(
        context.stateDir,
        "workspace-attestations",
        `${identity.workspaceKey}.attested`,
      );
      await fsp.mkdir(path.dirname(attestationPath), { recursive: true });
      sourcePath = attestationPath;
      await fsp.writeFile(
        attestationPath,
        kind === "invalid-attestation"
          ? "openclaw-workspace-attestation:v1\nnot-a-date\n"
          : `openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n${"x".repeat(3_000)}`,
        "utf8",
      );
    } else {
      const targetPath = path.join(context.workspaceDir, "target.json");
      await fsp.writeFile(targetPath, JSON.stringify({ version: 1 }), "utf8");
      if (kind === "symlink") {
        await fsp.symlink(targetPath, setupPath);
      } else if (kind === "hardlink") {
        await fsp.link(targetPath, setupPath);
      } else {
        await fsp.writeFile(setupPath, "{invalid", "utf8");
      }
    }

    const result = await migrate(context);

    expect(result.warnings[0]).toMatch(/legacy workspace/i);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    expect(
      openOpenClawStateDatabase({ env: context.env })
        .db.prepare("SELECT workspace_key FROM workspace_setup_state WHERE workspace_key = ?")
        .get(identity.workspaceKey),
    ).toBeUndefined();
  });

  it("rejects a setup source beneath a symlinked workspace subdirectory", async () => {
    const context = setup();
    const externalDir = path.join(context.homeDir, "external-workspace-state");
    const externalSource = path.join(externalDir, "workspace-state.json");
    await fsp.mkdir(externalDir, { recursive: true });
    await fsp.writeFile(externalSource, JSON.stringify({ version: 1 }), "utf8");
    await fsp.symlink(externalDir, path.join(context.workspaceDir, ".openclaw"));

    expect(detect(context).hasLegacy).toBe(true);
    const result = await migrate(context);

    expect(result.warnings[0]).toMatch(/legacy workspace/i);
    await expect(fsp.readFile(externalSource, "utf8")).resolves.toBe(
      JSON.stringify({ version: 1 }),
    );
    expect(fs.existsSync(`${externalSource}.doctor-importing`)).toBe(false);
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    expect(
      openOpenClawStateDatabase({ env: context.env })
        .db.prepare("SELECT workspace_key FROM workspace_setup_state WHERE workspace_key = ?")
        .get(identity.workspaceKey),
    ).toBeUndefined();
  });

  it("rejects attestations beneath a symlinked state subdirectory", async () => {
    const context = setup();
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const externalDir = path.join(context.homeDir, "external-attestations");
    const externalSource = path.join(externalDir, `${identity.workspaceKey}.attested`);
    await fsp.mkdir(externalDir, { recursive: true });
    await fsp.writeFile(
      externalSource,
      "openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n",
      "utf8",
    );
    await fsp.mkdir(context.stateDir, { recursive: true });
    await fsp.symlink(externalDir, path.join(context.stateDir, "workspace-attestations"));

    expect(detect(context).hasLegacy).toBe(true);
    const result = await migrate(context);

    expect(result.warnings[0]).toMatch(/legacy workspace/i);
    await expect(fsp.readFile(externalSource, "utf8")).resolves.toContain(
      "openclaw-workspace-attestation:v1",
    );
    expect(fs.existsSync(`${externalSource}.doctor-importing`)).toBe(false);
    expect(
      openOpenClawStateDatabase({ env: context.env })
        .db.prepare("SELECT workspace_key FROM workspace_attestations WHERE workspace_key = ?")
        .get(identity.workspaceKey),
    ).toBeUndefined();
  });

  it("retains a setup source that changes before Doctor claims it", async () => {
    const context = setup();
    const setupPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    await fsp.writeFile(setupPath, JSON.stringify({ version: 1 }), "utf8");

    const result = await migrateLegacyWorkspaceState({
      detected: detect(context),
      env: context.env,
      stateDir: context.stateDir,
      beforeClaim: () => {
        fs.writeFileSync(
          setupPath,
          JSON.stringify({ version: 1, setupCompletedAt: "2026-07-16T00:00:00.000Z" }),
          "utf8",
        );
      },
    });

    expect(result.warnings[0]).toContain("changed before Doctor could claim it");
    expect(fs.existsSync(setupPath)).toBe(true);
    expect(fs.existsSync(`${setupPath}.doctor-importing`)).toBe(false);
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    expect(
      openOpenClawStateDatabase({ env: context.env })
        .db.prepare("SELECT workspace_key FROM workspace_setup_state WHERE workspace_key = ?")
        .get(identity.workspaceKey),
    ).toBeUndefined();
  });

  it("keeps a conflicting source and preserves canonical SQLite state", async () => {
    const context = setup();
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const db = openOpenClawStateDatabase({ env: context.env }).db;
    db.prepare(
      `INSERT INTO workspace_setup_state (
         workspace_key, workspace_path, version, bootstrap_seeded_at, setup_completed_at, updated_at
       ) VALUES (?, ?, 1, ?, NULL, 1)`,
    ).run(identity.workspaceKey, identity.workspacePath, "2026-07-15T00:00:00.000Z");
    const setupPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    await fsp.writeFile(
      setupPath,
      JSON.stringify({ version: 1, bootstrapSeededAt: "2026-07-16T00:00:00.000Z" }),
      "utf8",
    );

    const result = await migrate(context);

    expect(result.warnings[0]).toContain("conflicts with canonical SQLite state");
    expect(fs.existsSync(setupPath)).toBe(true);
    expect(fs.existsSync(`${setupPath}.doctor-importing`)).toBe(false);
    expect(
      db
        .prepare("SELECT bootstrap_seeded_at FROM workspace_setup_state WHERE workspace_key = ?")
        .get(identity.workspaceKey),
    ).toEqual({ bootstrap_seeded_at: "2026-07-15T00:00:00.000Z" });
  });

  it("merges complementary legacy milestones into unowned SQLite setup state", async () => {
    const context = setup();
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const seededAt = "2026-07-15T00:00:00.000Z";
    const completedAt = "2026-07-15T00:01:00.000Z";
    const db = openOpenClawStateDatabase({ env: context.env }).db;
    db.prepare(
      `INSERT INTO workspace_setup_state (
         workspace_key, workspace_path, version, bootstrap_seeded_at, setup_completed_at, updated_at
       ) VALUES (?, ?, 1, ?, NULL, 1)`,
    ).run(identity.workspaceKey, identity.workspacePath, seededAt);
    const setupPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    await fsp.writeFile(
      setupPath,
      JSON.stringify({ version: 1, setupCompletedAt: completedAt }),
      "utf8",
    );

    const result = await migrate(context);

    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(setupPath)).toBe(false);
    expect(
      db
        .prepare(
          "SELECT bootstrap_seeded_at, setup_completed_at FROM workspace_setup_state WHERE workspace_key = ?",
        )
        .get(identity.workspaceKey),
    ).toEqual({ bootstrap_seeded_at: seededAt, setup_completed_at: completedAt });
    const receipt = db
      .prepare("SELECT report_json FROM migration_sources WHERE source_path = ?")
      .get(path.join(identity.workspacePath, "openclaw-workspace-state.json")) as {
      report_json: string;
    };
    expect(JSON.parse(receipt.report_json)).toMatchObject({
      authoritative: false,
      imported: true,
      resolution: "merged",
    });
  });

  it("uses receipts for idempotent cleanup-only retries", async () => {
    const context = setup();
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const setupPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    const seededAt = "2026-07-15T00:00:00.000Z";
    await fsp.writeFile(
      setupPath,
      JSON.stringify({ version: 1, bootstrapSeededAt: seededAt }),
      "utf8",
    );
    const first = await migrateLegacyWorkspaceState({
      detected: detect(context),
      env: context.env,
      stateDir: context.stateDir,
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings[0]).toContain("legacy cleanup failed");
    expect(fs.existsSync(`${setupPath}.doctor-importing`)).toBe(true);
    const db = openOpenClawStateDatabase({ env: context.env }).db;

    const retry = await migrate(context);

    expect(retry.warnings).toEqual([]);
    expect(fs.existsSync(`${setupPath}.doctor-importing`)).toBe(false);
    expect(
      db
        .prepare("SELECT bootstrap_seeded_at FROM workspace_setup_state WHERE workspace_key = ?")
        .get(identity.workspaceKey),
    ).toEqual({ bootstrap_seeded_at: seededAt });
    expect(
      db
        .prepare(
          "SELECT source_sha256, removed_source FROM migration_sources WHERE source_path = ?",
        )
        .get(path.join(identity.workspacePath, "openclaw-workspace-state.json")),
    ).toEqual({
      source_sha256: createHash("sha256")
        .update(JSON.stringify({ version: 1, bootstrapSeededAt: seededAt }))
        .digest("hex"),
      removed_source: 1,
    });
  });

  it("cleans receipt-covered superseded setup markers after an interrupted delete", async () => {
    const context = setup();
    const rootPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    const nestedPath = path.join(context.workspaceDir, ".openclaw", "workspace-state.json");
    await fsp.mkdir(path.dirname(nestedPath), { recursive: true });
    await fsp.writeFile(
      rootPath,
      JSON.stringify({
        version: 1,
        bootstrapSeededAt: "2026-07-15T10:00:00.000Z",
        setupCompletedAt: "2026-07-15T10:01:00.000Z",
      }),
      "utf8",
    );
    await fsp.writeFile(
      nestedPath,
      JSON.stringify({ version: 1, bootstrapSeededAt: "2026-07-14T09:00:00.000Z" }),
      "utf8",
    );
    const first = await migrateLegacyWorkspaceState({
      detected: detect(context),
      env: context.env,
      stateDir: context.stateDir,
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings).toHaveLength(2);

    const retry = await migrate(context);

    expect(retry.warnings).toEqual([]);
    expect(fs.existsSync(`${rootPath}.doctor-importing`)).toBe(false);
    expect(fs.existsSync(`${nestedPath}.doctor-importing`)).toBe(false);
  });

  it("retains a receipt-covered attestation when only its modification time changed", async () => {
    const context = setup();
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const attestationPath = path.join(
      context.stateDir,
      "workspace-attestations",
      `${identity.workspaceKey}.attested`,
    );
    await fsp.mkdir(path.dirname(attestationPath), { recursive: true });
    await fsp.writeFile(
      attestationPath,
      "openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n",
      "utf8",
    );
    const originalMtime = new Date("2026-07-15T11:01:00.000Z");
    await fsp.utimes(attestationPath, originalMtime, originalMtime);
    const first = await migrateLegacyWorkspaceState({
      detected: detect(context),
      env: context.env,
      stateDir: context.stateDir,
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings[0]).toContain("legacy cleanup failed");
    const claimPath = `${attestationPath}.doctor-importing`;
    const changedMtime = new Date("2026-07-15T11:02:00.000Z");
    await fsp.utimes(claimPath, changedMtime, changedMtime);

    const retry = await migrate(context);

    expect(retry.warnings[0]).toContain("retired source now conflicts");
    expect(fs.existsSync(claimPath)).toBe(true);
    expect(
      openOpenClawStateDatabase({ env: context.env })
        .db.prepare("SELECT attested_at_ms FROM workspace_attestations WHERE workspace_key = ?")
        .get(identity.workspaceKey),
    ).toEqual({ attested_at_ms: originalMtime.getTime() });
  });
});
