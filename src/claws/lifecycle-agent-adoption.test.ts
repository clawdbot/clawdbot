// Planning coverage for explicitly adopting a configured pre-Claws agent.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { inspectAgentWorkspaceOwnership } from "./lifecycle-agent-workspace.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import type { ClawManifest, ClawSourceIdentity } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function manifest(): ClawManifest {
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "worker", name: "Worker" },
    workspace: { bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } } },
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  return parsed.manifest;
}

async function fixture() {
  const root = tempDirs.make("openclaw-claw-agent-adopt-plan-");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(root, "SOUL.md"), "managed\n", "utf8");
  await writeFile(join(workspace, "SOUL.md"), "managed\n", "utf8");
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/worker",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 1,
  };
  return { source, workspace };
}

describe("buildClawAddPlan configured-agent adoption", () => {
  it("canonicalizes pre-resolved workspace candidates before overlap checks", () => {
    const ownership = inspectAgentWorkspaceOwnership({
      existingAgents: [{ id: "other", resolvedWorkspace: "/workspace-alias" }],
      finalId: "worker",
      workspace: "/workspace",
      adopting: true,
      canonicalize: (path) => (path === "/workspace-alias" ? "/workspace" : path),
    });

    expect(ownership.configuredWorkspaceConflict).toBe(true);
  });

  it("preserves agent_id_collision without explicit adoption", async () => {
    const { source, workspace } = await fixture();
    const plan = await buildClawAddPlan({
      manifest: manifest(),
      source,
      context: {
        workspace,
        existingAgents: [{ id: "worker", name: "Worker", workspace }],
        existingWorkspacePaths: [workspace],
      },
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "agent_id_collision" }));
  });

  it("adopts an exact configured agent and preserves its default marker", async () => {
    const { source, workspace } = await fixture();
    const plan = await buildClawAddPlan({
      manifest: manifest(),
      source,
      context: {
        workspace,
        adoptExistingAgent: true,
        existingAgents: [{ id: "worker", name: "Worker", workspace, default: true }],
        existingWorkspacePaths: [workspace],
      },
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.agent.config).toMatchObject({
      id: "worker",
      name: "Worker",
      workspace,
      default: true,
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "worker", action: "adopt", blocked: false }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspace", action: "adopt", blocked: false }),
    );
    expect(plan.capabilityChanges).toContainEqual(
      expect.objectContaining({ kind: "agent", path: "agent", action: "configure" }),
    );
  });

  it("blocks explicit adoption when the configured agent is missing", async () => {
    const { source, workspace } = await fixture();
    const plan = await buildClawAddPlan({
      manifest: manifest(),
      source,
      context: { workspace, adoptExistingAgent: true, existingAgents: [] },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "agent_adoption_missing", path: "$.agent.id" }),
    );
  });

  it("blocks explicit adoption of an already-managed agent", async () => {
    const { source, workspace } = await fixture();
    const plan = await buildClawAddPlan({
      manifest: manifest(),
      source,
      context: {
        workspace,
        adoptExistingAgent: true,
        existingAgents: [{ id: "worker", name: "Worker", workspace }],
        existingWorkspacePaths: [workspace],
        managedAgentIds: ["worker"],
      },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "agent_already_managed", path: "$.agent.id" }),
    );
  });

  it("reports durable ownership before a missing configured entry", async () => {
    const { source, workspace } = await fixture();
    const plan = await buildClawAddPlan({
      manifest: manifest(),
      source,
      context: {
        workspace,
        adoptExistingAgent: true,
        existingAgents: [],
        managedAgentIds: ["worker"],
      },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "agent_already_managed", path: "$.agent.id" }),
    );
    expect(plan.blockers).not.toContainEqual(
      expect.objectContaining({ code: "agent_adoption_missing" }),
    );
  });

  it("reports bounded differing field paths without either value", async () => {
    const { source, workspace } = await fixture();
    const plan = await buildClawAddPlan({
      manifest: manifest(),
      source,
      openClawProfile: { schemaVersion: 1, agent: { tools: { deny: ["exec"] } } },
      context: {
        workspace,
        adoptExistingAgent: true,
        existingAgents: [{ id: "worker", name: "Worker", workspace, tools: { deny: ["browser"] } }],
        existingWorkspacePaths: [workspace],
      },
    });

    const conflict = plan.blockers.find((candidate) => candidate.code === "agent_config_conflict");
    expect(conflict?.message).toContain("tools.deny[0]");
    expect(conflict?.message).not.toContain("exec");
    expect(conflict?.message).not.toContain("browser");
  });

  it("compares the full config when workspace spellings resolve identically", async () => {
    const { source, workspace } = await fixture();
    const plan = await buildClawAddPlan({
      manifest: manifest(),
      source,
      context: {
        workspace,
        adoptExistingAgent: true,
        existingAgents: [
          {
            id: "worker",
            name: "Different Name",
            workspace: join(source.packageRoot, "workspace-alias"),
            resolvedWorkspace: workspace,
          },
        ],
        existingWorkspacePaths: [workspace],
      },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "agent_config_conflict", path: "$.agent" }),
    );
    expect(plan.blockers).not.toContainEqual(
      expect.objectContaining({ code: "agent_workspace_conflict" }),
    );
  });

  it("blocks a requested workspace remap", async () => {
    const { source, workspace } = await fixture();
    const plan = await buildClawAddPlan({
      manifest: manifest(),
      source,
      context: {
        workspace,
        adoptExistingAgent: true,
        existingAgents: [
          { id: "worker", name: "Worker", workspace: join(source.packageRoot, "other") },
        ],
      },
    });

    expect(
      plan.blockers.filter((diagnostic) => diagnostic.code === "agent_workspace_conflict"),
    ).toHaveLength(1);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspace", action: "create", blocked: true }),
    );
    expect(plan.capabilityChanges).not.toContainEqual(
      expect.objectContaining({ path: "workspace" }),
    );
  });

  it("blocks overlap with another configured agent workspace", async () => {
    const { source, workspace } = await fixture();
    const plan = await buildClawAddPlan({
      manifest: manifest(),
      source,
      context: {
        workspace,
        adoptExistingAgent: true,
        existingAgents: [
          { id: "worker", name: "Worker", workspace },
          { id: "other", workspace: join(workspace, "nested") },
        ],
        existingWorkspacePaths: [workspace, join(workspace, "nested")],
      },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "agent_workspace_conflict", path: "$.workspace" }),
    );
  });

  it("blocks overlap supplied only through supplemental workspace ownership", async () => {
    const { source, workspace } = await fixture();
    const plan = await buildClawAddPlan({
      manifest: manifest(),
      source,
      context: {
        workspace,
        adoptExistingAgent: true,
        existingAgents: [{ id: "worker", name: "Worker", workspace }],
        existingWorkspacePaths: [workspace, join(workspace, "nested")],
      },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "agent_workspace_conflict", path: "$.workspace" }),
    );
  });
});
