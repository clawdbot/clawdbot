// Tests for planning Claw adds that adopt an existing workspace directory.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import type { ClawManifest, ClawSourceIdentity } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
