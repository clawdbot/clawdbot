// Workspace tests cover bootstrap seeding, attestation safety, bootstrap file
// filtering, and setup-completion state for agent workspaces.
import { createHash } from "node:crypto";
import syncFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  LEGACY_WORKSPACE_ATTESTATION_HEADER,
  LEGACY_WORKSPACE_STATE_CURRENT_FILENAME,
  LEGACY_WORKSPACE_STATE_DIRNAME,
} from "./workspace-legacy-state.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import {
  mergeWorkspaceSetupState,
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
  resolveWorkspaceStateIdentity,
} from "./workspace-state-store.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
  filterBootstrapFilesForSession,
  isWorkspaceBootstrapPending,
  loadWorkspaceBootstrapFiles,
  resolveWorkspaceBootstrapStatus,
  resolveDefaultAgentWorkspaceDir,
  WORKSPACE_VANISHED_ERROR_CODE,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

let testState: OpenClawTestState | undefined;

beforeEach(async () => {
  resetLegacyWorkspaceStateCheckForTest();
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workspace-state-",
  });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  resetLegacyWorkspaceStateCheckForTest();
  await testState?.cleanup();
  testState = undefined;
});

describe("resolveDefaultAgentWorkspaceDir", () => {
  it("uses OPENCLAW_HOME for default workspace resolution", () => {
    const dir = resolveDefaultAgentWorkspaceDir({
      OPENCLAW_HOME: "/srv/openclaw-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv);

    expect(dir).toBe(path.join(path.resolve("/srv/openclaw-home"), ".openclaw", "workspace"));
  });

  it("prefers OPENCLAW_WORKSPACE_DIR for default workspace resolution", () => {
    const dir = resolveDefaultAgentWorkspaceDir({
      OPENCLAW_WORKSPACE_DIR: "/srv/openclaw-workspace",
      OPENCLAW_HOME: "/srv/openclaw-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv);

    expect(dir).toBe(path.resolve("/srv/openclaw-workspace"));
  });
});

const LEGACY_WORKSPACE_STATE_PATH_SEGMENTS = [
  LEGACY_WORKSPACE_STATE_DIRNAME,
  "workspace-state.json",
] as const;

async function readWorkspaceState(dir: string): Promise<{
  version: number;
  bootstrapSeededAt?: string;
  setupCompletedAt?: string;
}> {
  return readWorkspaceStateSnapshot(dir).setup;
}

async function writeLegacyWorkspaceState(dir: string, state: unknown): Promise<void> {
  await fs.mkdir(path.join(dir, LEGACY_WORKSPACE_STATE_PATH_SEGMENTS[0]), { recursive: true });
  await fs.writeFile(
    path.join(dir, ...LEGACY_WORKSPACE_STATE_PATH_SEGMENTS),
    `${JSON.stringify(state)}\n`,
  );
}

async function expectBootstrapSeeded(dir: string) {
  await expect(fs.access(path.join(dir, DEFAULT_BOOTSTRAP_FILENAME))).resolves.toBeUndefined();
  const state = await readWorkspaceState(dir);
  expect(state.bootstrapSeededAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
}

async function expectPathMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toHaveProperty("code", "ENOENT");
}

async function expectWorkspaceVanished(action: Promise<unknown>): Promise<void> {
  // Recently attested generated workspaces must not be silently recreated after
  // deletion or wipe; that could hide user data loss.
  await expect(action).rejects.toMatchObject({
    code: WORKSPACE_VANISHED_ERROR_CODE,
    name: "WorkspaceVanishedError",
  });
}

async function expectNoLegacyWorkspaceStateWrites(dir: string): Promise<void> {
  const { workspaceKey } = resolveWorkspaceStateIdentity(dir);
  const paths = [
    path.join(dir, LEGACY_WORKSPACE_STATE_CURRENT_FILENAME),
    path.join(dir, ...LEGACY_WORKSPACE_STATE_PATH_SEGMENTS),
    `${dir}.attested`,
    path.join(testState?.stateDir ?? "", "workspace-attestations", `${workspaceKey}.attested`),
  ];
  for (const filePath of paths) {
    await expectPathMissing(filePath);
  }
}

async function expectCompletedWithoutBootstrap(dir: string) {
  await expect(fs.access(path.join(dir, DEFAULT_IDENTITY_FILENAME))).resolves.toBeUndefined();
  await expectPathMissing(path.join(dir, DEFAULT_BOOTSTRAP_FILENAME));
  const state = await readWorkspaceState(dir);
  expect(state.setupCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
}

function expectSubagentAllowedBootstrapNames(files: WorkspaceBootstrapFile[]) {
  const names = files.map((file) => file.name);
  expect(names).toStrictEqual(["AGENTS.md", "TOOLS.md"]);
}

function expectCronAllowedBootstrapNames(files: WorkspaceBootstrapFile[]) {
  const names = files.map((file) => file.name);
  expect(names).toStrictEqual(["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md"]);
}

describe("ensureAgentWorkspace", () => {
  it("creates BOOTSTRAP.md and records a seeded marker for brand new workspaces", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expectBootstrapSeeded(tempDir);
    await expectNoLegacyWorkspaceStateWrites(tempDir);
    expect((await readWorkspaceState(tempDir)).setupCompletedAt).toBeUndefined();
    expect(readWorkspaceStateSnapshot(tempDir).attestation).toBeDefined();
  });

  it("does not overwrite a foreign root workspace-state.json file", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const foreignStatePath = path.join(tempDir, "workspace-state.json");
    const foreignState = "not openclaw state\n";
    await fs.writeFile(foreignStatePath, foreignState);

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    expect(await fs.readFile(foreignStatePath, "utf-8")).toBe(foreignState);
    await expectBootstrapSeeded(tempDir);
  });

  it("requires Doctor before using legacy JSON setup state", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeLegacyWorkspaceState(tempDir, {
      version: 1,
      onboardingCompletedAt: "2026-03-15T02:30:00.000Z",
    });

    await expect(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    ).rejects.toThrow(/run openclaw doctor --fix/u);
    await expect(
      fs.access(path.join(tempDir, ...LEGACY_WORKSPACE_STATE_PATH_SEGMENTS)),
    ).resolves.toBeUndefined();
    expect(readWorkspaceStateSnapshot(tempDir).setupExists).toBe(false);
  });

  it("requires Doctor when partial SQLite state coexists with legacy setup state", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const seededAt = "2026-07-15T10:00:00.000Z";
    mergeWorkspaceSetupState(tempDir, { bootstrapSeededAt: seededAt });
    await writeLegacyWorkspaceState(tempDir, {
      version: 1,
      setupCompletedAt: "2026-07-15T10:01:00.000Z",
    });

    await expect(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    ).rejects.toThrow(/run openclaw doctor --fix/u);
    await expect(
      fs.access(path.join(tempDir, ...LEGACY_WORKSPACE_STATE_PATH_SEGMENTS)),
    ).resolves.toBeUndefined();
    expect(readWorkspaceStateSnapshot(tempDir).setup).toEqual({
      version: 1,
      bootstrapSeededAt: seededAt,
    });
  });

  it("refuses to re-seed a recently attested workspace after the directory disappears", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    expect(readWorkspaceStateSnapshot(tempDir).attestation).toBeDefined();

    await fs.rm(tempDir, { recursive: true, force: true });

    await expectWorkspaceVanished(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    );
    await expectPathMissing(tempDir);
  });

  it("refuses to re-seed a recently attested workspace after its contents are wiped", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });

    await expectWorkspaceVanished(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    );
    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    expect(readWorkspaceStateSnapshot(tempDir).setupExists).toBe(true);
  });

  it("refuses to re-seed a recently attested workspace after only generated remnants survive", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    const generatedAgents = await fs.readFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), "utf-8");

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), generatedAgents);

    await expectWorkspaceVanished(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    );
    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    expect(readWorkspaceStateSnapshot(tempDir).setupExists).toBe(true);
  });

  it("refuses to re-seed a future-attested workspace after only generated remnants survive", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    const snapshot = readWorkspaceStateSnapshot(tempDir);
    const generatedAgents = await fs.readFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), "utf-8");
    replaceWorkspaceAttestation({
      workspaceDir: tempDir,
      attestedAtMs: Date.now() + 60_000,
      generatedHashes: snapshot.attestation!.generatedHashes,
    });

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), generatedAgents);

    await expectWorkspaceVanished(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    );
    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
  });

  it("refuses to re-seed a recently attested workspace after only generated git metadata survives", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });
    await fs.mkdir(path.join(tempDir, ".openclaw"), { recursive: true });

    await expectWorkspaceVanished(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    );
    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
  });

  it("refuses to accept old generated bootstrap files recorded by SQLite attestation", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const oldGeneratedAgents = "old generated agents\n";
    await fs.writeFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), oldGeneratedAgents);
    mergeWorkspaceSetupState(tempDir, {
      bootstrapSeededAt: "2026-07-15T10:00:00.000Z",
      setupCompletedAt: "2026-07-15T10:01:00.000Z",
    });
    replaceWorkspaceAttestation({
      workspaceDir: tempDir,
      attestedAtMs: Date.now(),
      generatedHashes: new Map([
        [DEFAULT_AGENTS_FILENAME, createHash("sha256").update(oldGeneratedAgents).digest("hex")],
      ]),
    });

    await expectWorkspaceVanished(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    );
    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
  });

  it("refuses a recently attested workspace when only one generated file survives", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    const generatedAgents = await fs.readFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), "utf-8");

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), generatedAgents);

    await expectWorkspaceVanished(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    );
    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
  });

  it("uses template comparison when an attestation has no generated hashes", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    const generatedAgents = await fs.readFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), "utf-8");

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), generatedAgents);
    replaceWorkspaceAttestation({
      workspaceDir: tempDir,
      attestedAtMs: Date.now(),
      generatedHashes: new Map(),
    });

    await expectWorkspaceVanished(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    );
    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
  });

  it("accepts a recently attested workspace when customized AGENTS.md survives", async () => {
    // Custom instructions prove the directory is user-managed, so reseeding is
    // skipped and the workspace is accepted.
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await fs.writeFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), "custom instructions\n");
    await fs.rm(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME), { force: true });

    await expect(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    ).resolves.toMatchObject({ dir: tempDir });
    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
  });

  it("accepts a recently attested workspace when only custom skills survive", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(path.join(tempDir, "skills", "local-skill"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "skills", "local-skill", "SKILL.md"), "---\n");

    await expect(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    ).resolves.toMatchObject({ dir: tempDir });
    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    expect((await readWorkspaceState(tempDir)).setupCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("refuses a recently attested workspace when only non-skill skills leftovers survive", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(path.join(tempDir, "skills"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "skills", ".DS_Store"), "");

    await expectWorkspaceVanished(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    );
    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
  });

  it("refuses to recreate a skip-bootstrap workspace after the directory disappears", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await fs.writeFile(path.join(tempDir, "seed.txt"), "preseeded\n");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: false });

    await fs.rm(tempDir, { recursive: true, force: true });

    await expectWorkspaceVanished(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: false }),
    );
    await expectPathMissing(tempDir);
  });

  it("refuses to accept an empty skip-bootstrap workspace after contents are wiped", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await fs.writeFile(path.join(tempDir, "seed.txt"), "preseeded\n");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: false });

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });

    await expectWorkspaceVanished(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: false }),
    );
    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
  });

  it("refuses to accept a wiped skip-bootstrap workspace with only metadata leftovers", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await fs.writeFile(path.join(tempDir, "seed.txt"), "preseeded\n");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: false });

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(path.join(tempDir, ".openclaw"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "skills"), { recursive: true });
    await fs.writeFile(path.join(tempDir, ".DS_Store"), "");

    await expectWorkspaceVanished(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: false }),
    );
    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
  });

  it("allows repeated skip-bootstrap setup for an intentionally empty workspace", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: false });
    await expect(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: false }),
    ).resolves.toMatchObject({ dir: tempDir });
  });

  it("allows a brand new workspace when its SQLite attestation is stale", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const expiredAtMs = Date.now() - 25 * 60 * 60 * 1000;
    mergeWorkspaceSetupState(
      tempDir,
      {
        bootstrapSeededAt: "2026-07-15T10:00:00.000Z",
        setupCompletedAt: "2026-07-15T10:01:00.000Z",
      },
      expiredAtMs,
    );
    replaceWorkspaceAttestation({
      workspaceDir: tempDir,
      attestedAtMs: expiredAtMs,
      generatedHashes: new Map(),
    });
    await fs.rm(tempDir, { recursive: true, force: true });

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expectBootstrapSeeded(tempDir);
    expect((await readWorkspaceState(tempDir)).setupCompletedAt).toBeUndefined();
  });

  it("clears expired setup state when a wiped workspace retains only .git", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const expiredAtMs = Date.now() - 25 * 60 * 60 * 1000;
    mergeWorkspaceSetupState(
      tempDir,
      {
        bootstrapSeededAt: "2026-07-15T10:00:00.000Z",
        setupCompletedAt: "2026-07-15T10:01:00.000Z",
      },
      expiredAtMs,
    );
    replaceWorkspaceAttestation({
      workspaceDir: tempDir,
      attestedAtMs: expiredAtMs,
      generatedHashes: new Map(),
    });
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expectBootstrapSeeded(tempDir);
    expect((await readWorkspaceState(tempDir)).setupCompletedAt).toBeUndefined();
  });

  it("clears expired setup-only state before reseeding an empty workspace", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    mergeWorkspaceSetupState(
      tempDir,
      {
        bootstrapSeededAt: "2026-07-15T10:00:00.000Z",
        setupCompletedAt: "2026-07-15T10:01:00.000Z",
      },
      Date.now() - 25 * 60 * 60 * 1000,
    );

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expectBootstrapSeeded(tempDir);
    expect((await readWorkspaceState(tempDir)).setupCompletedAt).toBeUndefined();
  });

  it("requires Doctor before using a legacy owned attestation marker", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const attestationPath = `${tempDir}.attested`;
    const marker = `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n${new Date().toISOString()}\n`;
    await fs.writeFile(attestationPath, marker);

    await expect(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    ).rejects.toThrow(/run openclaw doctor --fix/u);

    expect(await fs.readFile(attestationPath, "utf-8")).toBe(marker);
    expect(readWorkspaceStateSnapshot(tempDir).setupExists).toBe(false);
  });

  it("requires Doctor when SQLite setup state coexists with a legacy attestation", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    mergeWorkspaceSetupState(tempDir, {
      bootstrapSeededAt: "2026-07-15T10:00:00.000Z",
    });
    const attestationPath = `${tempDir}.attested`;
    const marker = `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n${new Date().toISOString()}\n`;
    await fs.writeFile(attestationPath, marker);

    await expect(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    ).rejects.toThrow(/run openclaw doctor --fix/u);

    expect(await fs.readFile(attestationPath, "utf-8")).toBe(marker);
    expect(readWorkspaceStateSnapshot(tempDir).setupExists).toBe(true);
  });

  it("ignores and preserves a foreign sibling attestation file", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const attestationPath = `${tempDir}.attested`;
    const siblingContent = "external attestation data\n";
    await fs.writeFile(attestationPath, siblingContent);

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expectBootstrapSeeded(tempDir);
    expect(await fs.readFile(attestationPath, "utf-8")).toBe(siblingContent);
  });

  it("recovers partial initialization by creating BOOTSTRAP.md when marker is missing", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_AGENTS_FILENAME, content: "existing" });

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expectBootstrapSeeded(tempDir);
  });

  it("does not recreate BOOTSTRAP.md after completion, even when a core file is recreated", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_IDENTITY_FILENAME, content: "custom" });
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_USER_FILENAME, content: "custom" });
    await fs.unlink(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    await fs.unlink(path.join(tempDir, DEFAULT_TOOLS_FILENAME));

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    await expect(fs.access(path.join(tempDir, DEFAULT_TOOLS_FILENAME))).resolves.toBeUndefined();
    const state = await readWorkspaceState(tempDir);
    expect(state.setupCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("does not re-seed BOOTSTRAP.md for legacy completed workspaces without state marker", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_IDENTITY_FILENAME, content: "custom" });
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_USER_FILENAME, content: "custom" });

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    const state = await readWorkspaceState(tempDir);
    expect(state.bootstrapSeededAt).toBeUndefined();
    expect(state.setupCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("treats memory-backed workspaces as existing even when template files are missing", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "memory", "2026-02-25.md"), "# Daily log\nSome notes");
    await fs.writeFile(path.join(tempDir, "MEMORY.md"), "# Long-term memory\nImportant stuff");

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expect(fs.access(path.join(tempDir, DEFAULT_IDENTITY_FILENAME))).resolves.toBeUndefined();
    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    const state = await readWorkspaceState(tempDir);
    expect(state.setupCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    const memoryContent = await fs.readFile(path.join(tempDir, "MEMORY.md"), "utf-8");
    expect(memoryContent).toBe("# Long-term memory\nImportant stuff");
  });

  it("treats git-backed workspaces as existing even when template files are missing", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });
    await fs.writeFile(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expectCompletedWithoutBootstrap(tempDir);
  });

  it("skips configured optional bootstrap files without skipping required files", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    await ensureAgentWorkspace({
      dir: tempDir,
      ensureBootstrapFiles: true,
      skipOptionalBootstrapFiles: [
        DEFAULT_SOUL_FILENAME,
        DEFAULT_IDENTITY_FILENAME,
        DEFAULT_USER_FILENAME,
        DEFAULT_HEARTBEAT_FILENAME,
      ],
    });

    await expect(fs.access(path.join(tempDir, DEFAULT_AGENTS_FILENAME))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tempDir, DEFAULT_TOOLS_FILENAME))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME)),
    ).resolves.toBeUndefined();
    for (const fileName of [
      DEFAULT_SOUL_FILENAME,
      DEFAULT_IDENTITY_FILENAME,
      DEFAULT_USER_FILENAME,
      DEFAULT_HEARTBEAT_FILENAME,
    ]) {
      await expectPathMissing(path.join(tempDir, fileName));
    }
  });

  it("preserves legacy setup detection when skipped profile files already exist", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_IDENTITY_FILENAME, content: "custom" });
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_USER_FILENAME, content: "custom" });

    await ensureAgentWorkspace({
      dir: tempDir,
      ensureBootstrapFiles: true,
      skipOptionalBootstrapFiles: [DEFAULT_IDENTITY_FILENAME, DEFAULT_USER_FILENAME],
    });

    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    const state = await readWorkspaceState(tempDir);
    expect(state.setupCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("reports bootstrap pending while BOOTSTRAP.md exists and setup is incomplete", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expect(resolveWorkspaceBootstrapStatus(tempDir)).resolves.toBe("pending");
    await expect(isWorkspaceBootstrapPending(tempDir)).resolves.toBe(true);
  });

  it("keeps bootstrap status read-only when stale completion evidence exists", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_IDENTITY_FILENAME,
      content: "# IDENTITY.md\n\n- **Name:** Example\n",
    });

    await expect(resolveWorkspaceBootstrapStatus(tempDir)).resolves.toBe("pending");
    await expect(
      fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME)),
    ).resolves.toBeUndefined();
    expect((await readWorkspaceState(tempDir)).setupCompletedAt).toBeUndefined();
  });

  it("repairs stale BOOTSTRAP.md when profile files show onboarding completed", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_IDENTITY_FILENAME,
      content: "# IDENTITY.md\n\n- **Name:** Example\n",
    });

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    const state = await readWorkspaceState(tempDir);
    expect(state.bootstrapSeededAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(state.setupCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    await expect(resolveWorkspaceBootstrapStatus(tempDir)).resolves.toBe("complete");
    await expect(isWorkspaceBootstrapPending(tempDir)).resolves.toBe(false);
  });

  it("retries transient profile reads before stale bootstrap repair", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_IDENTITY_FILENAME,
      content: "# IDENTITY.md\n\n- **Name:** Example\n",
    });

    const identityPath = path.join(tempDir, DEFAULT_IDENTITY_FILENAME);
    const originalReadFile = fs.readFile.bind(fs);
    let identityReads = 0;
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation((async (filePath, options) => {
      if (filePath === identityPath) {
        identityReads += 1;
        if (identityReads === 1) {
          throw Object.assign(
            new Error("Unknown system error -11: Unknown system error -11, read"),
            { code: "EAGAIN", errno: -11 },
          );
        }
      }
      return await originalReadFile(filePath, options as never);
    }) as typeof fs.readFile);

    try {
      await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
      expect(identityReads).toBeGreaterThanOrEqual(2);
      await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    } finally {
      readSpy.mockRestore();
    }
  });

  it("propagates a transient profile read after the retry budget is exhausted", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    const identityPath = path.join(tempDir, DEFAULT_IDENTITY_FILENAME);
    const originalReadFile = fs.readFile.bind(fs);
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation((async (filePath, options) => {
      if (filePath === identityPath) {
        throw Object.assign(new Error("Unknown system error -11, read"), {
          code: "EAGAIN",
          errno: -11,
        });
      }
      return await originalReadFile(filePath, options as never);
    }) as typeof fs.readFile);

    try {
      await expect(
        ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
      ).rejects.toMatchObject({ code: "EAGAIN" });
    } finally {
      readSpy.mockRestore();
    }
  });

  it("records stale bootstrap completion when BOOTSTRAP.md cleanup fails", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_IDENTITY_FILENAME,
      content: "# IDENTITY.md\n\n- **Name:** Example\n",
    });
    const bootstrapPath = path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME);
    const rmSpy = vi
      .spyOn(fs, "rm")
      .mockRejectedValueOnce(Object.assign(new Error("not a directory"), { code: "ENOTDIR" }));

    try {
      const result = await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
      expect(rmSpy).toHaveBeenCalledWith(bootstrapPath, { force: true });
      await expect(fs.access(bootstrapPath)).resolves.toBeUndefined();
      const state = await readWorkspaceState(tempDir);
      expect(state.setupCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(result.bootstrapPending).toBe(false);
      await expect(resolveWorkspaceBootstrapStatus(tempDir)).resolves.toBe("complete");
      await expect(isWorkspaceBootstrapPending(tempDir)).resolves.toBe(false);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("uses SOUL.md customization as stale bootstrap completion evidence", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_SOUL_FILENAME,
      content: "# SOUL.md\n\nUse a concise, practical voice.\n",
    });

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
  });

  it("does not treat git alone as stale bootstrap completion evidence", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });
    await fs.writeFile(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await expect(resolveWorkspaceBootstrapStatus(tempDir)).resolves.toBe("pending");
    await expect(
      fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME)),
    ).resolves.toBeUndefined();
    expect((await readWorkspaceState(tempDir)).setupCompletedAt).toBeUndefined();
  });

  it("reports bootstrap complete once BOOTSTRAP.md is deleted and completion is recorded", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await fs.unlink(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expect(resolveWorkspaceBootstrapStatus(tempDir)).resolves.toBe("complete");
    await expect(isWorkspaceBootstrapPending(tempDir)).resolves.toBe(false);
  });

  it("no longer seeds HEARTBEAT.md into new workspaces", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    // Heartbeat monitor context lives in cron scratch now; new workspaces get no file.
    await expectPathMissing(path.join(tempDir, DEFAULT_HEARTBEAT_FILENAME));
  });

  it("does not recreate optional bootstrap files when workspace setup is already completed", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    // First call: set up the workspace and complete setup by customizing profile files.
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_IDENTITY_FILENAME,
      content: "custom identity",
    });
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_USER_FILENAME,
      content: "custom user",
    });
    // Delete BOOTSTRAP.md to trigger completion on next ensure call.
    await fs.unlink(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    // Verify setup is completed.
    const state = await readWorkspaceState(tempDir);
    expect(state.setupCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);

    // Delete optional bootstrap files and customize AGENTS.md to simulate
    // a repository workspace where optional files only exist under agent
    // subdirectories but the root still has customized required files.
    await fs.unlink(path.join(tempDir, DEFAULT_SOUL_FILENAME));
    await fs.unlink(path.join(tempDir, DEFAULT_IDENTITY_FILENAME));
    await fs.unlink(path.join(tempDir, DEFAULT_USER_FILENAME));
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: "custom agents instructions\n",
    });

    // Third call: should NOT recreate optional files for an already-configured workspace.
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    // Verify optional files are NOT recreated at the root level.
    await expectPathMissing(path.join(tempDir, DEFAULT_SOUL_FILENAME));
    await expectPathMissing(path.join(tempDir, DEFAULT_IDENTITY_FILENAME));
    await expectPathMissing(path.join(tempDir, DEFAULT_USER_FILENAME));
    await expectPathMissing(path.join(tempDir, DEFAULT_HEARTBEAT_FILENAME));

    // Verify required files (AGENTS.md, TOOLS.md) still exist.
    await expect(fs.access(path.join(tempDir, DEFAULT_AGENTS_FILENAME))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tempDir, DEFAULT_TOOLS_FILENAME))).resolves.toBeUndefined();
  });

  it("observes setup completed concurrently before writing optional bootstrap files", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    await fs.writeFile(agentsPath, "custom agents instructions\n", "utf8");
    mergeWorkspaceSetupState(tempDir, {
      bootstrapSeededAt: "2026-07-15T10:00:00.000Z",
    });
    const realAccess = fs.access.bind(fs);
    let completed = false;
    const accessSpy = vi.spyOn(fs, "access").mockImplementation(async (filePath, mode) => {
      if (!completed && filePath === agentsPath) {
        completed = true;
        mergeWorkspaceSetupState(tempDir, {
          setupCompletedAt: "2026-07-15T10:01:00.000Z",
        });
      }
      return await realAccess(filePath, mode);
    });

    try {
      await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    } finally {
      accessSpy.mockRestore();
    }

    expect(completed).toBe(true);
    for (const filename of [
      DEFAULT_SOUL_FILENAME,
      DEFAULT_IDENTITY_FILENAME,
      DEFAULT_USER_FILENAME,
      DEFAULT_HEARTBEAT_FILENAME,
    ]) {
      await expectPathMissing(path.join(tempDir, filename));
    }
  });
});

describe("loadWorkspaceBootstrapFiles", () => {
  const getMemoryEntries = (files: Awaited<ReturnType<typeof loadWorkspaceBootstrapFiles>>) =>
    files.filter((file) => file.name === DEFAULT_MEMORY_FILENAME);

  const expectSingleMemoryEntry = (
    files: Awaited<ReturnType<typeof loadWorkspaceBootstrapFiles>>,
    content: string,
  ) => {
    const memoryEntries = getMemoryEntries(files);
    expect(memoryEntries).toHaveLength(1);
    expect(memoryEntries[0]?.missing).toBe(false);
    expect(memoryEntries[0]?.content).toBe(content);
  };

  it("includes MEMORY.md when present", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "MEMORY.md", content: "memory" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    expectSingleMemoryEntry(files, "memory");
  });

  it("ignores lowercase memory.md when MEMORY.md is absent", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "memory.md", content: "alt" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    expect(getMemoryEntries(files)).toHaveLength(0);
  });

  it("omits memory entries when no memory files exist", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    expect(getMemoryEntries(files)).toHaveLength(0);
  });

  it("treats hardlinked bootstrap aliases as missing", async () => {
    if (process.platform === "win32") {
      return;
    }
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-hardlink-"));
    try {
      const workspaceDir = path.join(rootDir, "workspace");
      const outsideDir = path.join(rootDir, "outside");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      const outsideFile = path.join(outsideDir, DEFAULT_AGENTS_FILENAME);
      const linkPath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
      await fs.writeFile(outsideFile, "outside", "utf-8");
      try {
        await fs.link(outsideFile, linkPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          return;
        }
        throw err;
      }

      const files = await loadWorkspaceBootstrapFiles(workspaceDir);
      const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
      expect(agents?.missing).toBe(true);
      expect(agents?.content).toBeUndefined();
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("retries a transient bootstrap read instead of dropping the file for the turn", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: "# AGENTS.md\n\nkeep me\n",
    });

    // The bounded fd reader consumes the descriptor via fs.read; inject the
    // transient failure at that seam.
    const originalRead = syncFs.read.bind(syncFs);
    let readCalls = 0;
    let threwTransient = false;
    const readSpy = vi.spyOn(syncFs, "read").mockImplementation(((...args: unknown[]) => {
      readCalls += 1;
      if (!threwTransient) {
        threwTransient = true;
        const callback = args.at(-1) as (error: Error) => void;
        callback(
          Object.assign(new Error("Unknown system error -11: read"), {
            code: "EAGAIN",
            errno: -11,
          }),
        );
        return;
      }
      (originalRead as (...forwarded: unknown[]) => void)(...args);
    }) as typeof syncFs.read);

    try {
      const files = await loadWorkspaceBootstrapFiles(tempDir);
      expect(threwTransient).toBe(true);
      // The retry re-opens and reads again, so the failed first read is followed
      // by at least one more successful read.
      expect(readCalls).toBeGreaterThanOrEqual(2);
      const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
      expect(agents?.missing).toBe(false);
      expect(agents?.content).toContain("keep me");
    } finally {
      readSpy.mockRestore();
    }
  });

  it("marks a bootstrap file missing after transient read retries are exhausted", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: "# AGENTS.md\n",
    });

    const readSpy = vi.spyOn(syncFs, "read").mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void;
      callback(
        Object.assign(new Error("Unknown system error -11: read"), {
          code: "EAGAIN",
          errno: -11,
        }),
      );
    }) as typeof syncFs.read);

    try {
      // Unlike the template check, this reader returns an io failure (not a
      // throw) when the budget is exhausted, so the file surfaces as missing.
      const files = await loadWorkspaceBootstrapFiles(tempDir);
      const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
      expect(agents?.missing).toBe(true);
      expect(agents?.content).toBeUndefined();
    } finally {
      readSpy.mockRestore();
    }
  });

  it("retries a transient boundary-resolution failure before dropping a bootstrap file", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: "# AGENTS.md\n\nboundary retry\n",
    });

    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const originalLstat = syncFs.promises.lstat.bind(syncFs.promises);
    let agentsLstatAttempts = 0;
    const lstatSpy = vi.spyOn(syncFs.promises, "lstat").mockImplementation((async (
      target: unknown,
      options?: unknown,
    ) => {
      if (String(target) === agentsPath && ++agentsLstatAttempts === 1) {
        throw Object.assign(new Error("Unknown system error -11: lstat"), {
          code: "EAGAIN",
          errno: -11,
        });
      }
      return await originalLstat(target as never, options as never);
    }) as typeof syncFs.promises.lstat);

    try {
      const files = await loadWorkspaceBootstrapFiles(tempDir);
      expect(agentsLstatAttempts).toBe(2);
      const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
      expect(agents?.missing).toBe(false);
      expect(agents?.content).toContain("boundary retry");
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it("retries a transient open failure before dropping a bootstrap file", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: "# AGENTS.md\n\nopen retry\n",
    });

    // openRootFile reports a transient open failure as reason "io"; the reader
    // must retry it (re-open) rather than drop the file for the turn.
    const originalOpenSync = syncFs.openSync.bind(syncFs);
    let threwTransientOpen = false;
    const openSpy = vi.spyOn(syncFs, "openSync").mockImplementation(((
      ...args: Parameters<typeof syncFs.openSync>
    ) => {
      if (!threwTransientOpen) {
        threwTransientOpen = true;
        throw Object.assign(new Error("Unknown system error -11: open"), {
          code: "EAGAIN",
          errno: -11,
        });
      }
      return originalOpenSync(...args);
    }) as typeof syncFs.openSync);

    try {
      const files = await loadWorkspaceBootstrapFiles(tempDir);
      expect(threwTransientOpen).toBe(true);
      const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
      expect(agents?.missing).toBe(false);
      expect(agents?.content).toContain("open retry");
    } finally {
      openSpy.mockRestore();
    }
  });
});

describe("filterBootstrapFilesForSession", () => {
  const mockFiles: WorkspaceBootstrapFile[] = [
    { name: "AGENTS.md", path: "/w/AGENTS.md", content: "", missing: false },
    { name: "SOUL.md", path: "/w/SOUL.md", content: "", missing: false },
    { name: "TOOLS.md", path: "/w/TOOLS.md", content: "", missing: false },
    { name: "IDENTITY.md", path: "/w/IDENTITY.md", content: "", missing: false },
    { name: "USER.md", path: "/w/USER.md", content: "", missing: false },
    { name: "BOOTSTRAP.md", path: "/w/BOOTSTRAP.md", content: "", missing: false },
    { name: "MEMORY.md", path: "/w/MEMORY.md", content: "", missing: false },
  ];

  it("returns all files for main session (no sessionKey)", () => {
    const result = filterBootstrapFilesForSession(mockFiles);
    expect(result).toStrictEqual(mockFiles);
  });

  it("returns all files for normal (non-subagent, non-cron) session key", () => {
    const result = filterBootstrapFilesForSession(mockFiles, "agent:default:chat:main");
    expect(result).toStrictEqual(mockFiles);
  });

  it("filters to allowlist for subagent sessions", () => {
    const result = filterBootstrapFilesForSession(mockFiles, "agent:default:subagent:task-1");
    expectSubagentAllowedBootstrapNames(result);
  });

  it("filters to allowlist for cron sessions", () => {
    const result = filterBootstrapFilesForSession(mockFiles, "agent:default:cron:daily-check");
    expectCronAllowedBootstrapNames(result);
  });
});
