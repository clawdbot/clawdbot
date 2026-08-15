// Setup-only SQLite safety tests cover attestation-write failure and
// independently migrated setup state.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import {
  mergeWorkspaceSetupState,
  readWorkspaceStateSnapshot,
  resolveWorkspaceStateIdentity,
} from "./workspace-state-store.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  ensureAgentWorkspace,
  WORKSPACE_VANISHED_ERROR_CODE,
} from "./workspace.js";

let testState: OpenClawTestState | undefined;

beforeEach(async () => {
  resetLegacyWorkspaceStateCheckForTest();
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workspace-sqlite-safety-",
  });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  resetLegacyWorkspaceStateCheckForTest();
  await testState?.cleanup();
  testState = undefined;
});

function deleteWorkspaceAttestation(workspaceDir: string): void {
  const identity = resolveWorkspaceStateIdentity(workspaceDir);
  openOpenClawStateDatabase()
    .db.prepare("DELETE FROM workspace_attestations WHERE workspace_key = ?")
    .run(identity.workspaceKey);
}

describe("workspace setup-only SQLite safety", () => {
  it("clears expired setup-only state when one generated remnant survives", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    const generatedAgents = await fs.readFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), "utf8");
    const identity = resolveWorkspaceStateIdentity(tempDir);
    const expiredAtMs = Date.now() - 25 * 60 * 60 * 1000;
    const db = openOpenClawStateDatabase().db;
    deleteWorkspaceAttestation(tempDir);
    db.prepare("UPDATE workspace_setup_state SET updated_at = ? WHERE workspace_key = ?").run(
      expiredAtMs,
      identity.workspaceKey,
    );
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), generatedAgents);

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expect(
      fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME)),
    ).resolves.toBeUndefined();
    expect(readWorkspaceStateSnapshot(tempDir).setup.setupCompletedAt).toBeUndefined();
  });

  it("clears expired state when only one generated bootstrap file survives", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    const generatedAgents = await fs.readFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), "utf-8");
    const identity = resolveWorkspaceStateIdentity(tempDir);
    const expiredAtMs = Date.now() - 25 * 60 * 60 * 1000;
    const db = openOpenClawStateDatabase().db;
    db.prepare(
      "UPDATE workspace_attestations SET attested_at_ms = ?, updated_at_ms = ? WHERE workspace_key = ?",
    ).run(expiredAtMs, expiredAtMs, identity.workspaceKey);
    db.prepare("UPDATE workspace_setup_state SET updated_at = ? WHERE workspace_key = ?").run(
      expiredAtMs,
      identity.workspaceKey,
    );
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), generatedAgents);

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expect(
      fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME)),
    ).resolves.toBeUndefined();
    expect(readWorkspaceStateSnapshot(tempDir).setup.setupCompletedAt).toBeUndefined();
  });

  it("refuses an empty recent setup-only workspace when bootstrap creation is disabled", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    mergeWorkspaceSetupState(tempDir, {
      bootstrapSeededAt: new Date().toISOString(),
    });

    await expect(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: false }),
    ).rejects.toMatchObject({
      code: WORKSPACE_VANISHED_ERROR_CODE,
      name: "WorkspaceVanishedError",
    });
  });

  it("does not mistake an old generated template for setup-only customization", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await fs.writeFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), "old generated agents\n");
    mergeWorkspaceSetupState(tempDir, {
      bootstrapSeededAt: "2026-07-15T10:00:00.000Z",
      setupCompletedAt: "2026-07-15T10:01:00.000Z",
    });

    await expect(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    ).rejects.toMatchObject({
      code: WORKSPACE_VANISHED_ERROR_CODE,
      name: "WorkspaceVanishedError",
    });
    await expect(fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });

  it("refuses to reseed a missing workspace with recent setup-only state", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    mergeWorkspaceSetupState(tempDir, {
      bootstrapSeededAt: new Date().toISOString(),
    });
    await fs.rm(tempDir, { recursive: true, force: true });

    await expect(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    ).rejects.toMatchObject({
      code: WORKSPACE_VANISHED_ERROR_CODE,
      name: "WorkspaceVanishedError",
    });
    await expect(fs.access(tempDir)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("refuses to trust setup-only state after only generated remnants survive", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    const generatedAgents = await fs.readFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), "utf-8");
    deleteWorkspaceAttestation(tempDir);

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), generatedAgents);

    await expect(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    ).rejects.toMatchObject({
      code: WORKSPACE_VANISHED_ERROR_CODE,
      name: "WorkspaceVanishedError",
    });
    await expect(fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });

  it("accepts an intact generated workspace with setup-only state", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await fs.rm(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    deleteWorkspaceAttestation(tempDir);

    await expect(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    ).resolves.toMatchObject({ dir: tempDir });
    await expect(fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });
});
