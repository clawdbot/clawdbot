// Tests for planning Claw adds that adopt an existing workspace directory.
import { createHash } from "node:crypto";
import { link, mkdir, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { makeProvenancePlan, readInstallRow, stateEnv } from "./provenance.test-helpers.js";
import { parseClawManifest } from "./schema.js";
import type { ClawManifest, ClawSourceIdentity } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

function requireManifest(): ClawManifest {
  const result = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "adopt-agent" },
    workspace: {
      bootstrapFiles: { "AGENTS.md": { source: "workspace/AGENTS.md" } },
      files: [{ source: "workspace/reference/policy.md", path: "reference/policy.md" }],
    },
  });
  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result.manifest;
}

async function createPlanSource(): Promise<{ source: ClawSourceIdentity; workspace: string }> {
  const root = tempDirs.make("openclaw-claw-adopt-plan-");
  await mkdir(join(root, "workspace", "reference"), { recursive: true });
  await writeFile(join(root, "workspace", "AGENTS.md"), "# Agent\n", "utf8");
  await writeFile(join(root, "workspace", "reference", "policy.md"), "Policy\n", "utf8");
  return {
    source: {
      kind: "package",
      name: "@acme/adopt-agent",
      version: "1.0.0",
      packageRoot: root,
      manifestPath: join(root, "openclaw.claw.json"),
      integrityKind: "development-snapshot",
      integrity: "sha256:test",
      byteLength: 0,
    },
    workspace: join(root, "existing-workspace"),
  };
}

describe("buildClawAddPlan workspace adoption", () => {
  it("adopts an existing workspace when identical declared files are present", async () => {
    const { source, workspace } = await createPlanSource();
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "# Agent\n", "utf8");

    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      context: { workspace, adoptExistingWorkspace: true },
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspace", action: "adopt", blocked: false }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", id: "AGENTS.md", action: "adopt" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "workspaceFile",
        id: "reference/policy.md",
        action: "write",
      }),
    );
    expect(plan.capabilityChanges).toContainEqual(
      expect.objectContaining({ kind: "agent", path: "workspace", action: "configure" }),
    );
  });

  it("blocks adoption when a declared file exists with different content", async () => {
    const { source, workspace } = await createPlanSource();
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "# Divergent\n", "utf8");

    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      context: { workspace, adoptExistingWorkspace: true },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "workspace_file_conflict" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", id: "AGENTS.md", blocked: true }),
    );
  });

  it("blocks adoption of a hardlinked declared file before consent", async () => {
    const { source, workspace } = await createPlanSource();
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "origin.md"), "# Agent\n", "utf8");
    await link(join(workspace, "origin.md"), join(workspace, "AGENTS.md"));

    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      context: { workspace, adoptExistingWorkspace: true },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "workspace_file_conflict" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", id: "AGENTS.md", blocked: true }),
    );
    expect(plan.actions).not.toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", id: "AGENTS.md", action: "adopt" }),
    );
  });

  it("blocks an existing package bootstrap instead of claiming operator-owned content", async () => {
    const { source, workspace } = await createPlanSource();
    const bootstrap = Buffer.from("Package setup\n");
    const bootstrapPath = join(source.packageRoot, "BOOTSTRAP.md");
    await writeFile(bootstrapPath, bootstrap);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "BOOTSTRAP.md"), bootstrap);

    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      packageBootstrap: {
        sourcePath: "BOOTSTRAP.md",
        realPath: bootstrapPath,
        byteLength: bootstrap.byteLength,
        digest: `sha256:${createHash("sha256").update(bootstrap).digest("hex")}`,
      },
      context: { workspace, adoptExistingWorkspace: true },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "workspace_file_conflict", path: "$packageBootstrap" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "bootstrap", id: "BOOTSTRAP.md", blocked: true }),
    );
  });

  it("still blocks adoption of a workspace configured for another agent", async () => {
    const { source, workspace } = await createPlanSource();
    await mkdir(workspace, { recursive: true });

    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      context: {
        workspace,
        adoptExistingWorkspace: true,
        existingWorkspacePaths: [workspace],
      },
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "workspace_collision" }));
  });

  it("keeps blocking a non-adopted existing workspace", async () => {
    const { source, workspace } = await createPlanSource();
    await mkdir(workspace, { recursive: true });

    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      context: { workspace },
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "workspace_collision" }));
  });
});

describe("applyClawAddPlan workspace adoption", () => {
  it("revalidates an adopted workspace before realizing shared plugin requirements", async () => {
    const root = tempDirs.make("openclaw-claw-adopt-add-");
    const workspace = join(root, "existing-workspace");
    await mkdir(workspace);
    const { plan } = await makeProvenancePlan(
      root,
      {
        schemaVersion: 1,
        agent: { id: "worker" },
        packages: [{ kind: "plugin", source: "clawhub", ref: "@acme/audit", version: "1.0.0" }],
      },
      {
        workspace,
        adoptExistingWorkspace: true,
        packagePreflight: async () => ({
          ok: true,
          action: "install",
          integrity: `sha256:${"a".repeat(64)}`,
          installId: "audit",
        }),
      },
    );
    expect(plan.blockers).toEqual([]);
    await rmdir(workspace);
    const installPackages = vi.fn();

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env: stateEnv(root),
        installPackages,
      }),
    ).rejects.toMatchObject({ code: "workspace_collision" });
    expect(installPackages).not.toHaveBeenCalled();
    expect(readInstallRow("worker", root)).toBeUndefined();
  });

  it("reserves an adopted workspace before writing adopted workspace files", async () => {
    const { source, workspace } = await createPlanSource();
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "# Agent\n", "utf8");
    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      context: { workspace, adoptExistingWorkspace: true },
    });
    expect(plan.blockers).toEqual([]);
    const seedPackageBootstrap = vi.fn(async () => undefined);
    const createWorkspaceFiles = vi.fn();
    const commitConfig = vi.fn(async (transform) => {
      transform({
        agents: { entries: { other: { name: "Other", workspace } } },
      });
    });

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env: stateEnv(source.packageRoot),
        commitConfig,
        seedPackageBootstrap,
        createWorkspaceFiles,
      }),
    ).resolves.toMatchObject({
      error: { code: "workspace_collision" },
      status: "partial",
    });

    expect(seedPackageBootstrap).toHaveBeenCalledOnce();
    expect(commitConfig).toHaveBeenCalledOnce();
    expect(seedPackageBootstrap.mock.invocationCallOrder[0]).toBeLessThan(
      commitConfig.mock.invocationCallOrder[0] ?? 0,
    );
    expect(createWorkspaceFiles).not.toHaveBeenCalled();
  });
});
