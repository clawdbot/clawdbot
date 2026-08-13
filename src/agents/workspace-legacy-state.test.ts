import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertNoUnmigratedWorkspaceState,
  LEGACY_WORKSPACE_ATTESTATION_HEADER,
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
  resolveLegacyWorkspaceSourcePaths,
} from "./workspace-legacy-state.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import { resolveWorkspaceStateIdentity } from "./workspace-state-store.js";

describe("legacy workspace reset cleanup", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));
  afterEach(() => resetLegacyWorkspaceStateCheckForTest());

  function setup() {
    const homeDir = tempDirs.make("openclaw-workspace-legacy-cleanup-");
    const stateDir = path.join(homeDir, "state");
    const workspaceDir = path.join(homeDir, "workspace");
    const env = { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir };
    const homedir = () => homeDir;
    return {
      env,
      homeDir,
      homedir,
      stateDir,
      workspaceDir,
      paths: resolveLegacyWorkspaceSourcePaths(workspaceDir, { env, homedir }),
    };
  }

  function prepare(context: ReturnType<typeof setup>) {
    return prepareLegacyWorkspaceStateReset(context.workspaceDir, {
      env: context.env,
      homedir: context.homedir,
    });
  }

  it("removes retired setup files, claims, and owned attestations", async () => {
    const context = setup();
    await fs.mkdir(context.workspaceDir, { recursive: true });
    const marker = `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n2026-07-15T11:00:00.000Z\n`;
    const candidates = [
      context.paths.setupStatePaths[0]!,
      `${context.paths.setupStatePaths[1]!}.doctor-importing`,
      context.paths.stateDirAttestationPaths[0]!,
      `${context.paths.stateDirAttestationPaths.at(-1)!}.doctor-importing`,
      context.paths.siblingAttestationPaths[0]!,
      `${context.paths.siblingAttestationPaths[0]!}.doctor-importing`,
    ];
    for (const candidate of candidates) {
      await fs.mkdir(path.dirname(candidate), { recursive: true });
      await fs.writeFile(
        candidate,
        candidate.includes("workspace-state") ? '{"version":1}\n' : marker,
        "utf8",
      );
    }

    const result = await removeLegacyWorkspaceStateForReset(prepare(context));

    expect(result.warnings).toEqual([]);
    expect(new Set(result.removedPaths)).toEqual(new Set(candidates));
    for (const candidate of candidates) {
      await expect(fs.lstat(candidate)).rejects.toHaveProperty("code", "ENOENT");
    }
  });

  it("previews retired state cleanup without deleting files", async () => {
    const context = setup();
    const marker = `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n2026-07-15T11:00:00.000Z\n`;
    const candidates = [
      context.paths.setupStatePaths[0]!,
      context.paths.siblingAttestationPaths[0]!,
    ];
    for (const candidate of candidates) {
      await fs.mkdir(path.dirname(candidate), { recursive: true });
      await fs.writeFile(
        candidate,
        candidate.includes("workspace-state") ? '{"version":1}\n' : marker,
        "utf8",
      );
    }

    const result = await removeLegacyWorkspaceStateForReset(prepare(context), { dryRun: true });

    expect(result.warnings).toEqual([]);
    expect(new Set(result.removedPaths)).toEqual(new Set(candidates));
    for (const candidate of candidates) {
      await expect(fs.lstat(candidate)).resolves.toBeDefined();
    }
  });

  it("preserves a foreign sibling attestation", async () => {
    const context = setup();
    await fs.mkdir(context.workspaceDir, { recursive: true });
    const siblingPath = context.paths.siblingAttestationPaths[0]!;
    await fs.writeFile(siblingPath, "foreign marker\n", "utf8");

    const result = await removeLegacyWorkspaceStateForReset(prepare(context));

    expect(result.warnings).toEqual([]);
    expect(result.removedPaths).toEqual([]);
    await expect(fs.readFile(siblingPath, "utf8")).resolves.toBe("foreign marker\n");
  });

  it("preserves a malformed sibling claim and foreign marker", async () => {
    const context = setup();
    const siblingPath = context.paths.siblingAttestationPaths[0]!;
    const claimPath = `${siblingPath}.doctor-importing`;
    await fs.mkdir(context.workspaceDir, { recursive: true });
    await fs.writeFile(siblingPath, "foreign marker\n", "utf8");
    await fs.writeFile(claimPath, "truncated claim\n", "utf8");

    const result = await removeLegacyWorkspaceStateForReset(prepare(context));

    expect(result.warnings).toEqual([]);
    expect(result.removedPaths).toEqual([]);
    await expect(fs.readFile(siblingPath, "utf8")).resolves.toBe("foreign marker\n");
    await expect(fs.readFile(claimPath, "utf8")).resolves.toBe("truncated claim\n");
    expect(() =>
      assertNoUnmigratedWorkspaceState({ workspaceDir: context.workspaceDir }),
    ).not.toThrow();
  });

  it("checks lexical legacy markers separately for aliases of one workspace", async () => {
    const context = setup();
    const targetDir = path.join(context.homeDir, "workspace-target");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.symlink(
      targetDir,
      context.workspaceDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    assertNoUnmigratedWorkspaceState({ workspaceDir: targetDir });
    await fs.writeFile(
      `${context.workspaceDir}.attested`,
      `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n2026-07-15T11:00:00.000Z\n`,
      "utf8",
    );

    expect(() => assertNoUnmigratedWorkspaceState({ workspaceDir: context.workspaceDir })).toThrow(
      /run openclaw doctor --fix/u,
    );
  });

  it("checks canonical legacy markers when configuration uses a symlink alias", async () => {
    const context = setup();
    const targetDir = path.join(context.homeDir, "workspace-target");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.symlink(
      targetDir,
      context.workspaceDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    const identity = resolveWorkspaceStateIdentity(targetDir);
    const canonicalSiblingPath = `${identity.workspacePath}.attested`;
    const sources = resolveLegacyWorkspaceSourcePaths(context.workspaceDir, {
      env: context.env,
      homedir: context.homedir,
    });
    await fs.writeFile(
      canonicalSiblingPath,
      `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n2026-07-15T11:00:00.000Z\n`,
      "utf8",
    );

    expect(sources.siblingAttestationPaths).toContain(canonicalSiblingPath);
    expect(sources.stateDirAttestationPaths).toContain(
      path.join(context.stateDir, "workspace-attestations", `${identity.workspaceKey}.attested`),
    );
    expect(() => assertNoUnmigratedWorkspaceState({ workspaceDir: context.workspaceDir })).toThrow(
      /run openclaw doctor --fix/u,
    );
    const cleanup = await removeLegacyWorkspaceStateForReset(prepare(context));
    expect(cleanup.removedPaths).toContain(canonicalSiblingPath);
    await expect(fs.lstat(canonicalSiblingPath)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("removes canonical legacy paths after the configured symlink is removed", async () => {
    const context = setup();
    const targetDir = path.join(context.homeDir, "workspace-target");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.symlink(
      targetDir,
      context.workspaceDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    const identity = resolveWorkspaceStateIdentity(targetDir);
    const setupPath = path.join(targetDir, "openclaw-workspace-state.json");
    const stateAttestationPath = path.join(
      context.stateDir,
      "workspace-attestations",
      `${identity.workspaceKey}.attested`,
    );
    const siblingPath = `${identity.workspacePath}.attested`;
    const marker = `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n2026-07-15T11:00:00.000Z\n`;
    await fs.writeFile(setupPath, '{"version":1}\n', "utf8");
    await fs.mkdir(path.dirname(stateAttestationPath), { recursive: true });
    await fs.writeFile(stateAttestationPath, marker, "utf8");
    await fs.writeFile(siblingPath, marker, "utf8");

    const plan = prepare(context);
    await fs.unlink(context.workspaceDir);
    const result = await removeLegacyWorkspaceStateForReset(plan);

    expect(result.warnings).toEqual([]);
    for (const candidate of [setupPath, stateAttestationPath, siblingPath]) {
      await expect(fs.lstat(candidate)).rejects.toHaveProperty("code", "ENOENT");
    }
  });

  it("removes malformed markers from reserved state-directory paths", async () => {
    const context = setup();
    const candidates = [
      context.paths.stateDirAttestationPaths[0]!,
      `${context.paths.stateDirAttestationPaths.at(-1)!}.doctor-importing`,
    ];
    for (const candidate of candidates) {
      await fs.mkdir(path.dirname(candidate), { recursive: true });
      await fs.writeFile(candidate, "truncated marker\n", "utf8");
    }

    const result = await removeLegacyWorkspaceStateForReset(prepare(context));

    expect(result.warnings).toEqual([]);
    expect(new Set(result.removedPaths)).toEqual(new Set(candidates));
    for (const candidate of candidates) {
      await expect(fs.lstat(candidate)).rejects.toHaveProperty("code", "ENOENT");
    }
  });

  it("does not follow a symlinked attestation directory during reset", async () => {
    const context = setup();
    const markerPath = context.paths.stateDirAttestationPaths[0]!;
    const externalDir = path.join(context.homeDir, "external-attestations");
    const externalMarker = path.join(externalDir, path.basename(markerPath));
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.rm(path.dirname(markerPath), { recursive: true, force: true });
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(
      externalMarker,
      `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n2026-07-15T11:00:00.000Z\n`,
      "utf8",
    );
    await fs.symlink(externalDir, path.dirname(markerPath));

    const result = await removeLegacyWorkspaceStateForReset(prepare(context));

    expect(result.warnings.length).toBeGreaterThan(0);
    await expect(fs.readFile(externalMarker, "utf8")).resolves.toContain(
      LEGACY_WORKSPACE_ATTESTATION_HEADER,
    );
  });
});
