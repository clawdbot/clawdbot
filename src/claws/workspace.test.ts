// Tests create-only Claw workspace files and immediate per-file provenance.
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import type { ClawAddPlan, ClawSourceIdentity } from "./types.js";
import { clawWorkspaceWasAdopted } from "./workspace-origin.js";
import { ClawWorkspaceWriteError, createClawWorkspaceFiles } from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

async function writeSource(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function makeAdoptionPlan(params?: { existingAgentsContent?: string }) {
  const root = tempDirs.make("openclaw-claw-workspace-adopt-");
  const workspace = join(root, "workspace-agent");
  await writeSource(root, "content/AGENTS.md", "# Agent\n");
  await writeSource(root, "content/policy.md", "Policy\n");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, "AGENTS.md"),
    params?.existingAgentsContent ?? "# Agent\n",
    "utf8",
  );
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "workspace-agent" },
    workspace: {
      bootstrapFiles: { "AGENTS.md": { source: "content/AGENTS.md" } },
      files: [{ source: "content/policy.md", path: "reference/policy.md" }],
    },
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/workspace-agent",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "development-snapshot",
    integrity: "sha256:manifest",
    byteLength: 0,
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace, adoptExistingWorkspace: true },
  });
  return { root, workspace, plan };
}

async function makePlan(params?: {
  workspace?: unknown;
  createWorkspace?: boolean;
  mutateAfterPlan?: (plan: ClawAddPlan, root: string) => Promise<void>;
}) {
  const root = tempDirs.make("openclaw-claw-workspace-");
  const workspace = join(root, "workspace-agent");
  await writeSource(root, "content/AGENTS.md", "# Agent\n");
  await writeSource(root, "content/policy.md", "Policy\n");
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "workspace-agent" },
    workspace: params?.workspace ?? {
      bootstrapFiles: { "AGENTS.md": { source: "content/AGENTS.md" } },
      files: [{ source: "content/policy.md", path: "reference/policy.md" }],
    },
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/workspace-agent",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "development-snapshot",
    integrity: "sha256:manifest",
    byteLength: 0,
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace },
  });
  expect(plan.blockers).toEqual([]);
  if (params?.createWorkspace !== false) {
    await mkdir(workspace);
  }
  await params?.mutateAfterPlan?.(plan, root);
  return { root, workspace, plan };
}

function stateEnv(root: string) {
  return { OPENCLAW_STATE_DIR: join(root, "state") };
}

type WorkspaceFileRow = {
  schema_version: string;
  agent_id: string;
  workspace: string;
  target_path: string;
  source_path: string;
  content_digest: string;
  status: "pending" | "complete" | "failed";
  created_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

function readWorkspaceFileRows(agentId: string, root: string) {
  const rows = openOpenClawStateDatabase({ env: stateEnv(root) })
    .db.prepare(
      `SELECT schema_version, agent_id, workspace, target_path, source_path,
              content_digest, status, created_at_ms, updated_at_ms
         FROM claw_workspace_files
        WHERE agent_id = ?
        ORDER BY target_path`,
    )
    .all(agentId) as WorkspaceFileRow[];
  return rows.map((row) => ({
    schemaVersion: "openclaw.clawWorkspaceFileRecord.v1" as const,
    agentId: row.agent_id,
    workspace: row.workspace,
    path: row.target_path,
    sourcePath: row.source_path,
    contentDigest: row.content_digest,
    status: row.status,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  }));
}

function readInstallStatus(agentId: string, root: string): string | undefined {
  const row = openOpenClawStateDatabase({ env: stateEnv(root) })
    .db.prepare(`SELECT status FROM claw_installs WHERE agent_id = ?`)
    .get(agentId) as { status: string } | undefined;
  return row?.status;
}

describe("createClawWorkspaceFiles", () => {
  it("materializes the CLAW.md body as managed SOUL.md content", async () => {
    const root = tempDirs.make("openclaw-claw-body-workspace-");
    const workspace = join(root, "workspace-agent");
    const body = Buffer.from("# Portable soul\n\nBe concise.\n");
    const manifest = parseClawManifest({ schemaVersion: 1, agent: { id: "workspace-agent" } });
    if (!manifest.ok) {
      throw new Error(JSON.stringify(manifest.diagnostics));
    }
    const manifestPath = join(root, "CLAW.md");
    await writeFile(
      manifestPath,
      Buffer.concat([
        Buffer.from("---\nschemaVersion: 1\nagent: { id: workspace-agent }\n---\n"),
        body,
      ]),
    );
    const plan = await buildClawAddPlan({
      manifest: manifest.manifest,
      clawMarkdownBody: body,
      source: {
        kind: "package",
        name: "@acme/workspace-agent",
        version: "1.0.0",
        packageRoot: root,
        manifestPath,
        integrityKind: "development-snapshot",
        integrity: "sha256:manifest",
        byteLength: 0,
      },
      context: { workspace },
    });
    await mkdir(workspace);

    const records = await createClawWorkspaceFiles(plan, { env: stateEnv(root), nowMs: 10 });

    await expect(readFile(join(workspace, "SOUL.md"), "utf8")).resolves.toBe(body.toString());
    expect(records).toContainEqual(
      expect.objectContaining({ path: "SOUL.md", sourcePath: "CLAW.md", status: "complete" }),
    );
  });

  it.runIf(process.platform !== "win32")(
    "materializes the CLAW.md body through a symlinked package root",
    async () => {
      const root = tempDirs.make("openclaw-claw-linked-package-");
      const realPackageRoot = join(root, "real-package");
      const linkedPackageRoot = join(root, "linked-package");
      const workspace = join(root, "workspace-agent");
      const body = Buffer.from("# Portable soul\n\nBe concise.\n");
      await mkdir(realPackageRoot);
      await symlink(realPackageRoot, linkedPackageRoot, "dir");
      const manifestPath = join(linkedPackageRoot, "CLAW.md");
      await writeFile(
        manifestPath,
        Buffer.concat([
          Buffer.from("---\nschemaVersion: 1\nagent: { id: workspace-agent }\n---\n"),
          body,
        ]),
      );
      const manifest = parseClawManifest({ schemaVersion: 1, agent: { id: "workspace-agent" } });
      if (!manifest.ok) {
        throw new Error(JSON.stringify(manifest.diagnostics));
      }
      const plan = await buildClawAddPlan({
        manifest: manifest.manifest,
        clawMarkdownBody: body,
        source: {
          kind: "package",
          name: "@acme/workspace-agent",
          version: "1.0.0",
          packageRoot: linkedPackageRoot,
          manifestPath,
          integrityKind: "development-snapshot",
          integrity: "sha256:manifest",
          byteLength: 0,
        },
        context: { workspace },
      });
      await mkdir(workspace);

      await createClawWorkspaceFiles(plan, { env: stateEnv(root), nowMs: 10 });

      await expect(readFile(join(workspace, "SOUL.md"), "utf8")).resolves.toBe(body.toString());
    },
  );

  it("adopts an existing identical file without rewriting and records complete provenance", async () => {
    const { root, workspace, plan } = await makeAdoptionPlan();
    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", id: "AGENTS.md", action: "adopt" }),
    );

    const records = await createClawWorkspaceFiles(plan, { env: stateEnv(root), nowMs: 10 });

    expect(records).toContainEqual(
      expect.objectContaining({ path: "AGENTS.md", status: "complete" }),
    );
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).resolves.toBe("# Agent\n");
    await expect(readFile(join(workspace, "reference", "policy.md"), "utf8")).resolves.toBe(
      "Policy\n",
    );
  });

  it("fails closed when an adoptable file changes between planning and apply", async () => {
    const { root, workspace, plan } = await makeAdoptionPlan();
    expect(plan.blockers).toEqual([]);
    await writeFile(join(workspace, "AGENTS.md"), "# Changed after planning\n", "utf8");

    await expect(
      createClawWorkspaceFiles(plan, { env: stateEnv(root), nowMs: 10 }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "workspace_file_conflict" })],
    });
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).resolves.toBe(
      "# Changed after planning\n",
    );
  });

  it("fails closed when an adoptable file disappears between planning and apply", async () => {
    const { root, workspace, plan } = await makeAdoptionPlan();
    expect(plan.blockers).toEqual([]);
    await rm(join(workspace, "AGENTS.md"));

    await expect(
      createClawWorkspaceFiles(plan, { env: stateEnv(root), nowMs: 10 }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "workspace_file_conflict" })],
    });
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("creates canonical bootstrap and supporting files and records their hashes", async () => {
    const { root, workspace, plan } = await makePlan();

    const records = await createClawWorkspaceFiles(plan, { env: stateEnv(root), nowMs: 10 });

    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).resolves.toBe("# Agent\n");
    await expect(readFile(join(workspace, "reference", "policy.md"), "utf8")).resolves.toBe(
      "Policy\n",
    );
    expect(records).toEqual([
      expect.objectContaining({
        schemaVersion: "openclaw.clawWorkspaceFileRecord.v1",
        agentId: "workspace-agent",
        path: "AGENTS.md",
        sourcePath: "content/AGENTS.md",
        contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        status: "complete",
        createdAtMs: 10,
        updatedAtMs: 10,
      }),
      expect.objectContaining({
        agentId: "workspace-agent",
        path: "reference/policy.md",
      }),
    ]);
    expect(readWorkspaceFileRows("workspace-agent", root)).toEqual(records);
  });

  it("never overwrites an unexpected destination", async () => {
    const { root, workspace, plan } = await makePlan();
    await writeFile(join(workspace, "AGENTS.md"), "operator content\n", "utf8");

    await expect(createClawWorkspaceFiles(plan, { env: stateEnv(root) })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "workspace_file_collision" })],
      createdFiles: [],
    });
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).resolves.toBe(
      "operator content\n",
    );
  });

  it("revalidates source content immediately before writing", async () => {
    const { root, workspace, plan } = await makePlan({
      mutateAfterPlan: async (_plan, packageRoot) => {
        await writeFile(join(packageRoot, "content", "AGENTS.md"), "changed\n", "utf8");
      },
    });

    await expect(createClawWorkspaceFiles(plan, { env: stateEnv(root) })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "workspace_source_changed" })],
    });
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "rejects a source replaced by a symlink after planning",
    async () => {
      const outside = tempDirs.make("openclaw-claw-outside-");
      await writeFile(join(outside, "outside.md"), "outside\n", "utf8");
      const { root, workspace, plan } = await makePlan({
        mutateAfterPlan: async (_plan, packageRoot) => {
          const source = join(packageRoot, "content", "AGENTS.md");
          await rm(source);
          await symlink(join(outside, "outside.md"), source);
        },
      });

      await expect(createClawWorkspaceFiles(plan, { env: stateEnv(root) })).rejects.toBeInstanceOf(
        ClawWorkspaceWriteError,
      );
      await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).rejects.toThrow();
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a tampered plan source through a symlinked parent",
    async () => {
      const { root, workspace, plan } = await makePlan();
      await symlink(join(root, "content"), join(root, "content-link"), "dir");
      const action = plan.actions.find(
        (candidate) => candidate.kind === "workspaceFile" && candidate.id === "AGENTS.md",
      );
      if (!action) {
        throw new Error("expected workspace action");
      }
      action.source = join(plan.claw.packageRoot, "content-link", "AGENTS.md");

      await expect(createClawWorkspaceFiles(plan, { env: stateEnv(root) })).rejects.toMatchObject({
        // fs-safe 0.5.2 rejects the symlinked parent before the alias check runs.
        diagnostics: [expect.objectContaining({ code: "workspace_file_symlink" })],
      });
      await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).rejects.toThrow();
    },
  );

  it("persists earlier files when a later destination collides", async () => {
    const { root, workspace, plan } = await makePlan({
      workspace: {
        files: [
          { source: "content/AGENTS.md", path: "first.md" },
          { source: "content/policy.md", path: "second.md" },
        ],
      },
    });
    await writeFile(join(workspace, "second.md"), "collision\n", "utf8");

    await expect(
      createClawWorkspaceFiles(plan, { env: stateEnv(root), nowMs: 20 }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "workspace_file_collision" })],
      createdFiles: [expect.objectContaining({ path: "first.md" })],
    });
    await expect(readFile(join(workspace, "first.md"), "utf8")).resolves.toBe("# Agent\n");
    expect(readWorkspaceFileRows("workspace-agent", root)).toEqual([
      expect.objectContaining({ path: "first.md", createdAtMs: 20 }),
    ]);
  });

  it("resumes matching owned files without weakening create-only collision checks", async () => {
    const { root, workspace, plan } = await makePlan();

    const first = await createClawWorkspaceFiles(plan, { env: stateEnv(root), nowMs: 10 });
    const resumed = await createClawWorkspaceFiles(plan, { env: stateEnv(root), nowMs: 20 });

    expect(resumed).toHaveLength(first.length);
    for (const [index, record] of resumed.entries()) {
      const initial = first[index];
      if (!initial) {
        throw new Error(`missing initial workspace record at index ${index}`);
      }
      expect(record).toEqual({ ...initial, status: "complete", updatedAtMs: 20 });
    }
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).resolves.toBe("# Agent\n");
  });

  it("does not adopt an independently created file after a failed write record", async () => {
    const { root, workspace, plan } = await makePlan();
    const action = plan.actions.find(
      (candidate) => candidate.kind === "workspaceFile" && candidate.id === "AGENTS.md",
    );
    if (!action?.digest) {
      throw new Error("expected AGENTS.md workspace action");
    }
    openOpenClawStateDatabase({ env: stateEnv(root) })
      .db.prepare(
        `INSERT INTO claw_workspace_files (
           schema_version, agent_id, workspace, target_path, source_path,
           content_digest, status, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "openclaw.clawWorkspaceFileRecord.v1",
        plan.agent.finalId,
        plan.agent.workspace,
        "AGENTS.md",
        "content/AGENTS.md",
        action.digest,
        "failed",
        10,
        10,
      );
    await writeFile(join(workspace, "AGENTS.md"), "# Agent\n", "utf8");

    await expect(
      createClawWorkspaceFiles(plan, { env: stateEnv(root), nowMs: 20 }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "workspace_file_collision" })],
      createdFiles: [],
    });
    expect(readWorkspaceFileRows("workspace-agent", root)).toEqual([
      expect.objectContaining({ path: "AGENTS.md", status: "failed", updatedAtMs: 10 }),
    ]);
  });

  it("fails closed when a previously owned destination drifts before resume", async () => {
    const { root, workspace, plan } = await makePlan();
    await createClawWorkspaceFiles(plan, { env: stateEnv(root), nowMs: 10 });
    await writeFile(join(workspace, "AGENTS.md"), "operator edit\n", "utf8");

    await expect(
      createClawWorkspaceFiles(plan, { env: stateEnv(root), nowMs: 20 }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "workspace_file_drift" })],
      createdFiles: [],
    });
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).resolves.toBe("operator edit\n");
  });

  it("rejects a tampered plan destination outside the new workspace", async () => {
    const { root, plan } = await makePlan();
    const action = plan.actions.find((candidate) => candidate.kind === "workspaceFile");
    if (!action) {
      throw new Error("expected workspace action");
    }
    action.target = join(root, "outside.md");

    await expect(createClawWorkspaceFiles(plan, { env: stateEnv(root) })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "workspace_file_path_escape" })],
    });
  });
});

describe("workspace files in the consented add lifecycle", () => {
  it("completes an adoption add without rewriting existing files and commits the agent", async () => {
    const { root, workspace, plan } = await makeAdoptionPlan();
    expect(plan.blockers).toEqual([]);
    let config: OpenClawConfig = {};

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: stateEnv(root),
      nowMs: 30,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(result).toMatchObject({
      status: "complete",
      workspaceCreated: true,
      workspaceFiles: [
        expect.objectContaining({ path: "AGENTS.md", status: "complete" }),
        expect.objectContaining({ path: "reference/policy.md", status: "complete" }),
      ],
      installRecord: { status: "complete" },
    });
    expect(config.agents?.entries?.["workspace-agent"]).toBeDefined();
    expect(readInstallStatus("workspace-agent", root)).toBe("complete");
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).resolves.toBe("# Agent\n");
    await expect(readFile(join(workspace, "reference", "policy.md"), "utf8")).resolves.toBe(
      "Policy\n",
    );
  });

  it("preserves an adopted workspace when config commit rolls back", async () => {
    const { root, workspace, plan } = await makeAdoptionPlan();
    let config: OpenClawConfig = {};

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: stateEnv(root),
      nowMs: 35,
      commitConfig: async () => {
        throw new Error("config unavailable");
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: true,
      configCommitted: false,
      workspaceFiles: [],
      installRecord: { status: "workspace_ready" },
      error: { code: "config_commit_failed", message: "config unavailable" },
    });
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).resolves.toBe("# Agent\n");

    const resumed = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: stateEnv(root),
      nowMs: 36,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(resumed).toMatchObject({
      status: "complete",
      configCommitted: true,
      installRecord: { status: "complete" },
    });
    expect(config.agents?.entries?.["workspace-agent"]).toBeDefined();
  });

  it("records adopted origin but leaves the agent unroutable when file revalidation fails", async () => {
    const { root, workspace, plan } = await makeAdoptionPlan();
    let config: OpenClawConfig = {};
    await writeFile(join(workspace, "AGENTS.md"), "# Changed after planning\n", "utf8");

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: stateEnv(root),
      nowMs: 37,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      installRecord: { status: "workspace_ready" },
      error: {
        code: "workspace_files_failed",
        diagnostics: [expect.objectContaining({ code: "workspace_file_conflict" })],
      },
    });
    expect(config.agents?.entries?.["workspace-agent"]).toBeUndefined();
    const originRows = openOpenClawStateDatabase({ env: stateEnv(root) })
      .db.prepare(
        "SELECT target_path, workspace, content_digest FROM claw_workspace_files WHERE agent_id = ? ORDER BY target_path",
      )
      .all("workspace-agent");
    expect(originRows).toEqual([
      {
        target_path: ".",
        workspace: plan.agent.workspace,
        content_digest: "openclaw:adopted-workspace",
      },
    ]);
    expect(
      clawWorkspaceWasAdopted("workspace-agent", plan.agent.workspace, { env: stateEnv(root) }),
    ).toBe(true);
  });

  it("marks the root install complete after every declared file is created", async () => {
    const { root, plan } = await makePlan({ createWorkspace: false });
    let config: OpenClawConfig = {};

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: stateEnv(root),
      nowMs: 30,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(result).toMatchObject({
      status: "complete",
      workspaceFiles: [
        expect.objectContaining({ path: "AGENTS.md" }),
        expect.objectContaining({ path: "reference/policy.md" }),
      ],
      installRecord: { status: "complete" },
    });
    expect(config.agents?.entries?.["workspace-agent"]).toBeDefined();
    expect(readInstallStatus("workspace-agent", root)).toBe("complete");
  });

  it("keeps root add resumable and retains earlier file refs after a later source changes", async () => {
    const { root, plan } = await makePlan({
      createWorkspace: false,
      mutateAfterPlan: async (_plan, packageRoot) => {
        await writeFile(join(packageRoot, "content", "policy.md"), "changed\n", "utf8");
      },
    });
    let config: OpenClawConfig = {};

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: stateEnv(root),
      nowMs: 40,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      workspaceFiles: [expect.objectContaining({ path: "AGENTS.md" })],
      installRecord: { status: "workspace_ready" },
      error: {
        code: "workspace_files_failed",
        diagnostics: [expect.objectContaining({ code: "workspace_source_changed" })],
      },
    });
    expect(config.agents?.entries?.["workspace-agent"]).toBeUndefined();
    expect(readInstallStatus("workspace-agent", root)).toBe("workspace_ready");

    await writeFile(join(root, "content", "policy.md"), "Policy\n", "utf8");
    const resumed = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: stateEnv(root),
      nowMs: 50,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(resumed).toMatchObject({
      status: "complete",
      workspaceFiles: [
        expect.objectContaining({ path: "AGENTS.md", status: "complete" }),
        expect.objectContaining({ path: "reference/policy.md", status: "complete" }),
      ],
      installRecord: { status: "complete" },
    });
    expect(readInstallStatus("workspace-agent", root)).toBe("complete");
  });
});
