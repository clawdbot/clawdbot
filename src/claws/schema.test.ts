// Tests for the grouped Claw manifest and read-only add plan.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildClawAddPlan } from "./lifecycle.js";
import { readClawManifestFile } from "./reader.js";
import { parseClawManifest } from "./schema.js";
import type { ClawManifest, ClawSourceIdentity, ClawSourceSnapshot } from "./types.js";

const baseManifest = {
  schemaVersion: 1,
  agent: {
    id: "github-triage",
    name: "GitHub Triage",
    description: "Reviews incoming issues.",
    identity: { name: "Triage", emoji: "search" },
    groupChat: { mentionPatterns: ["@triage"] },
    sandbox: { mode: "all", scope: "agent", workspaceAccess: "rw" },
    tools: { allow: ["read", "write"], deny: ["exec"] },
    heartbeat: { every: "30m", lightContext: true, skipWhenBusy: true },
    humanDelay: { mode: "natural" },
  },
  workspace: {
    bootstrapFiles: {
      "AGENTS.md": { source: "workspace/AGENTS.md" },
    },
    files: [{ source: "workspace/reference/policy.md", path: "reference/policy.md" }],
  },
  packages: [
    { kind: "skill", source: "clawhub", ref: "@acme/triage", version: "1.2.0" },
    { kind: "plugin", source: "clawhub", ref: "@acme/github", version: "2.0.1" },
  ],
  mcpServers: {
    github: {
      command: "npx",
      args: ["--yes", "@acme/github-mcp@3.4.1"],
      env: { API_TOKEN: "${GITHUB_TOKEN}" },
      toolFilter: { include: ["issues_list"], exclude: ["repository_delete"] },
      timeout: 30,
    },
  },
  cronJobs: [
    {
      id: "weekday-triage",
      name: "Weekday triage",
      schedule: { cron: "0 9 * * 1-5", timezone: "America/New_York" },
      session: "isolated",
      message: "Review new issues.",
      delivery: { mode: "announce", channel: "last" },
    },
  ],
} as const;

function requireManifest(value: unknown = baseManifest): ClawManifest {
  const result = parseClawManifest(value);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result.manifest;
}

function snapshotDigest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function createPlanSource(): Promise<{
  source: ClawSourceIdentity;
  snapshot: ClawSourceSnapshot;
  workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "openclaw-claw-plan-"));
  await mkdir(join(root, "workspace", "reference"), { recursive: true });
  await writeFile(join(root, "workspace", "AGENTS.md"), "# Agent\n", "utf8");
  await writeFile(join(root, "workspace", "reference", "policy.md"), "Policy\n", "utf8");
  return {
    source: {
      kind: "package",
      name: "@acme/github-triage",
      version: "1.0.0",
      packageRoot: root,
      manifestPath: join(root, "openclaw.claw.json"),
      integrityKind: "development-snapshot",
      integrity: "sha256:test",
      byteLength: 0,
    },
    snapshot: {
      workspaceSources: [
        {
          sourcePath: "workspace/AGENTS.md",
          realPath: join(root, "workspace", "AGENTS.md"),
          byteLength: Buffer.byteLength("# Agent\n"),
          digest: snapshotDigest("# Agent\n"),
        },
        {
          sourcePath: "workspace/reference/policy.md",
          realPath: join(root, "workspace", "reference", "policy.md"),
          byteLength: Buffer.byteLength("Policy\n"),
          digest: snapshotDigest("Policy\n"),
        },
      ],
    },
    workspace: join(root, "new-workspace"),
  };
}

describe("parseClawManifest", () => {
  it("parses the grouped portable contract", () => {
    const manifest = requireManifest();

    expect(manifest.agent.id).toBe("github-triage");
    expect(manifest.workspace.files).toHaveLength(1);
    expect(manifest.packages.map((pkg) => pkg.kind)).toEqual(["skill", "plugin"]);
    expect(Object.keys(manifest.mcpServers)).toEqual(["github"]);
    expect(manifest.cronJobs[0]?.id).toBe("weekday-triage");
  });

  it("defaults optional ownership groups without inventing agent settings", () => {
    const manifest = requireManifest({ schemaVersion: 1, agent: { id: "minimal-agent" } });

    expect(manifest).toEqual({
      schemaVersion: 1,
      agent: { id: "minimal-agent" },
      workspace: { bootstrapFiles: {}, files: [] },
      packages: [],
      mcpServers: {},
      cronJobs: [],
    });
  });

  it("rejects the prototype flat entries contract", () => {
    const result = parseClawManifest({
      schemaVersion: "openclaw.claw.v1",
      id: "old-claw",
      entries: [{ kind: "skill", id: "demo", required: false }],
    });

    expect(result.ok).toBe(false);
  });

  it.each(["model", "provider", "skills", "runtime", "bindings", "auth"])(
    "rejects operator-controlled agent field %s",
    (field) => {
      const result = parseClawManifest({
        schemaVersion: 1,
        agent: { id: "unsafe-agent", [field]: field === "skills" ? ["demo"] : "value" },
      });

      expect(result.ok).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "invalid_manifest", path: "$.agent" }),
      );
    },
  );

  it("rejects required flags and connector packages", () => {
    const connector = parseClawManifest({
      ...baseManifest,
      packages: [{ kind: "connector", source: "clawhub", ref: "@acme/chat", version: "1.0.0" }],
    });
    expect(connector.ok).toBe(false);
    expect(connector.diagnostics[0]?.path).toBe("$.packages[0].kind");

    const required = parseClawManifest({
      ...baseManifest,
      packages: [{ ...baseManifest.packages[0], required: false }],
    });
    expect(required.ok).toBe(false);
    expect(required.diagnostics[0]?.path).toBe("$.packages[0]");
  });

  it("requires exact package versions", () => {
    const result = parseClawManifest({
      ...baseManifest,
      packages: [{ kind: "skill", source: "clawhub", ref: "demo", version: "latest" }],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.path).toBe("$.packages[0].version");
  });

  it("rejects resolved MCP secrets", () => {
    const result = parseClawManifest({
      ...baseManifest,
      mcpServers: {
        github: { command: "npx", env: { GITHUB_TOKEN: "secret-value" } },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.path).toBe("$.mcpServers.github.env.GITHUB_TOKEN");
  });

  it("accepts credential-free remote MCP with local OAuth completion", () => {
    const manifest = requireManifest({
      ...baseManifest,
      mcpServers: {
        linear: {
          url: "https://mcp.linear.app/mcp",
          transport: "streamable-http",
          auth: "oauth",
          toolFilter: { include: ["list_issues"] },
        },
      },
    });

    expect(manifest.mcpServers.linear).toEqual({
      url: "https://mcp.linear.app/mcp",
      transport: "streamable-http",
      auth: "oauth",
      toolFilter: { include: ["list_issues"] },
    });
  });

  it.each([
    {
      url: "https://example.com/mcp",
      transport: "streamable-http",
      headers: { Authorization: "secret" },
    },
    { url: "https://example.com/mcp", transport: "streamable-http", command: "npx" },
    { url: "file:///tmp/mcp", transport: "sse" },
    { url: "https://example.com/mcp", transport: "stdio" },
  ])("rejects non-portable remote MCP config %#", (server) => {
    const result = parseClawManifest({
      ...baseManifest,
      mcpServers: { unsafe: server },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.path).toMatch(/^\$\.mcpServers\.unsafe/);
  });

  it("rejects workspace traversal and duplicate destinations", () => {
    const traversal = parseClawManifest({
      ...baseManifest,
      workspace: { files: [{ source: "../outside", path: "inside.md" }] },
    });
    expect(traversal.ok).toBe(false);

    const duplicate = parseClawManifest({
      ...baseManifest,
      workspace: {
        bootstrapFiles: { "AGENTS.md": { source: "workspace/AGENTS.md" } },
        files: [{ source: "workspace/other.md", path: "AGENTS.md" }],
      },
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.diagnostics).toContainEqual(
      expect.objectContaining({ path: "$.workspace.files[0].path" }),
    );
  });

  it("rejects duplicate packages and cron ids", () => {
    const duplicatePackage = parseClawManifest({
      ...baseManifest,
      packages: [baseManifest.packages[0], baseManifest.packages[0]],
    });
    expect(duplicatePackage.ok).toBe(false);

    const duplicateCron = parseClawManifest({
      ...baseManifest,
      cronJobs: [baseManifest.cronJobs[0], baseManifest.cronJobs[0]],
    });
    expect(duplicateCron.ok).toBe(false);
  });

  it("rejects invalid heartbeat durations and cron expressions", () => {
    const heartbeat = parseClawManifest({
      ...baseManifest,
      agent: { ...baseManifest.agent, heartbeat: { every: "eventually" } },
    });
    expect(heartbeat.ok).toBe(false);
    expect(heartbeat.diagnostics).toContainEqual(
      expect.objectContaining({ path: "$.agent.heartbeat.every" }),
    );

    const cron = parseClawManifest({
      ...baseManifest,
      cronJobs: [
        {
          ...baseManifest.cronJobs[0],
          schedule: { cron: "not a cron expression", timezone: "UTC" },
        },
      ],
    });
    expect(cron.ok).toBe(false);
    expect(cron.diagnostics).toContainEqual(
      expect.objectContaining({ path: "$.cronJobs[0].schedule.cron" }),
    );
  });
});

describe("readClawManifestFile", () => {
  it("takes published identity from package.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-claw-package-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/github-triage",
        version: "3.2.1",
        openclaw: { claw: "openclaw.claw.json" },
      }),
      "utf8",
    );
    await writeFile(
      join(root, "openclaw.claw.json"),
      JSON.stringify({ schemaVersion: 1, agent: { id: "triage" } }),
      "utf8",
    );

    const result = await readClawManifestFile(root);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected package to parse");
    }
    expect(result.source).toMatchObject({
      kind: "package",
      name: "@acme/github-triage",
      version: "3.2.1",
      integrityKind: "development-snapshot",
    });
    expect(result.source.integrity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.source.byteLength).toBeGreaterThan(0);
  });

  it("synthesizes explicit development identity for a standalone manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-claw-development-"));
    const path = join(root, "demo.claw.json");
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 1, agent: { id: "demo-agent" } }),
      "utf8",
    );

    const result = await readClawManifestFile(path);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected development manifest to parse");
    }
    expect(result.source).toMatchObject({
      kind: "development",
      name: "local:demo.claw",
      version: "0.0.0-development",
    });
  });

  it("rejects workspace sources through an intermediate symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-claw-reader-symlink-"));
    await mkdir(join(root, "workspace"));
    await writeFile(join(root, "workspace", "AGENTS.md"), "# Agent\n", "utf8");
    await symlink(
      join(root, "workspace"),
      join(root, "workspace-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const manifestPath = join(root, "demo.claw.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "symlink-agent" },
        workspace: { bootstrapFiles: { "AGENTS.md": { source: "workspace-link/AGENTS.md" } } },
      }),
      "utf8",
    );

    const result = await readClawManifestFile(manifestPath);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "workspace_source_unsafe" }),
    );
  });

  it("rejects a workspace source over the per-file byte limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-claw-reader-file-limit-"));
    await writeFile(join(root, "large.md"), Buffer.alloc(1024 * 1024 + 1));
    const manifestPath = join(root, "demo.claw.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "large-agent" },
        workspace: { files: [{ source: "large.md", path: "large.md" }] },
      }),
      "utf8",
    );

    const result = await readClawManifestFile(manifestPath);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "workspace_source_too_large" }),
    );
  });

  it("rejects aggregate workspace bytes before reading source contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-claw-reader-aggregate-limit-"));
    const files = [];
    for (let index = 0; index < 5; index += 1) {
      const source = `large-${index}.md`;
      await writeFile(join(root, source), Buffer.alloc(1024 * 1024, index));
      files.push({ source, path: source });
    }
    const manifestPath = join(root, "demo.claw.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "large-agent" },
        workspace: { files },
      }),
      "utf8",
    );

    const result = await readClawManifestFile(manifestPath);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "workspace_sources_too_large" }),
    );
  });

  it("rejects package manifests that escape the package root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openclaw-claw-escape-"));
    const root = join(parent, "package");
    await mkdir(root);
    await writeFile(
      join(parent, "outside.json"),
      JSON.stringify({ schemaVersion: 1, agent: { id: "outside" } }),
      "utf8",
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/escape",
        version: "1.0.0",
        openclaw: { claw: "../outside.json" },
      }),
      "utf8",
    );

    const result = await readClawManifestFile(root);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "manifest_escapes_package" }),
    );
  });
});

describe("buildClawAddPlan", () => {
  it("plans one new agent, workspace, packages, MCP servers, and agent-pinned cron jobs", async () => {
    const { source, snapshot, workspace } = await createPlanSource();
    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      snapshot,
      context: { workspace },
    });

    expect(plan).toMatchObject({
      schemaVersion: "openclaw.clawAddPlan.v1",
      manifestSchemaVersion: 1,
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      planIntegrity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      agent: { requestedId: "github-triage", finalId: "github-triage", workspace },
      readiness: {
        ready: false,
        requirements: [{ kind: "environment", mcpServer: "github", name: "GITHUB_TOKEN" }],
      },
      summary: {
        totalActions: 8,
        agentActions: 1,
        workspaceActions: 3,
        packageActions: 2,
        mcpServerActions: 1,
        cronJobActions: 1,
        blockedActions: 2,
        capabilityEscalations: 5,
      },
    });
    expect(plan.capabilityChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent", id: "github-triage" }),
        expect.objectContaining({ kind: "package", id: "plugin:@acme/github" }),
        expect.objectContaining({ kind: "mcpServer", id: "github" }),
        expect.objectContaining({ kind: "cronJob", id: "weekday-triage" }),
      ]),
    );
    expect(
      plan.capabilityChanges.find((change) => change.kind === "mcpServer")?.effect.env,
    ).toEqual([{ name: "API_TOKEN", reference: "GITHUB_TOKEN" }]);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "workspaceFile",
        id: "AGENTS.md",
        digest: expect.stringMatching(/^sha256:/),
      }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "cronJob",
        id: "weekday-triage",
        target: "cron:weekday-triage:agent=github-triage",
      }),
    );
  });

  it("blocks agent, configured workspace, MCP, and cron collisions", async () => {
    const { source, snapshot, workspace } = await createPlanSource();
    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      snapshot,
      context: {
        workspace,
        existingAgentIds: ["github-triage"],
        existingWorkspacePaths: [workspace],
        existingMcpServerNames: ["github"],
        existingCronJobIds: ["weekday-triage"],
      },
    });

    expect(plan.blockers.map((item) => item.code)).toEqual([
      "agent_id_collision",
      "workspace_collision",
      "package_install_unavailable",
      "package_install_unavailable",
      "mcp_server_collision",
      "cron_job_collision",
    ]);
    expect(plan.summary.blockedActions).toBe(8);
  });

  it("uses an explicit unused agent id for every derived action", async () => {
    const { source, snapshot, workspace } = await createPlanSource();
    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      snapshot,
      context: { agentId: "triage-two", workspace },
    });

    expect(plan.agent.finalId).toBe("triage-two");
    expect(plan.actions.find((action) => action.kind === "agent")?.id).toBe("triage-two");
    expect(plan.actions.find((action) => action.kind === "cronJob")?.target).toContain(
      "agent=triage-two",
    );
  });

  it("blocks workspace sources missing from the validated snapshot", async () => {
    const { source, snapshot, workspace } = await createPlanSource();
    const plan = await buildClawAddPlan({
      manifest: requireManifest({
        schemaVersion: 1,
        agent: { id: "symlink-agent" },
        workspace: {
          bootstrapFiles: { "AGENTS.md": { source: "workspace-link/AGENTS.md" } },
        },
      }),
      source,
      snapshot,
      context: { workspace },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "workspace_source_invalid" }),
    );
    const workspaceAction = plan.actions.find(
      (action) => action.kind === "workspaceFile" && action.id === "AGENTS.md",
    );
    expect(workspaceAction).toMatchObject({ kind: "workspaceFile", blocked: true });
    expect(workspaceAction).not.toHaveProperty("digest");
  });

  it("blocks aggregate workspace bytes before hashing sources", async () => {
    const { source, workspace } = await createPlanSource();
    const files = [];
    const workspaceSources = [];
    for (let index = 0; index < 5; index += 1) {
      const sourcePath = `workspace/large-${index}.md`;
      await writeFile(join(source.packageRoot, sourcePath), Buffer.alloc(1024 * 1024, index));
      files.push({ source: sourcePath, path: `large-${index}.md` });
      workspaceSources.push({
        sourcePath,
        realPath: join(source.packageRoot, sourcePath),
        byteLength: 1024 * 1024,
        digest: snapshotDigest(Buffer.alloc(1024 * 1024, index)),
      });
    }
    const plan = await buildClawAddPlan({
      manifest: requireManifest({
        schemaVersion: 1,
        agent: { id: "large-agent" },
        workspace: { files },
      }),
      source,
      snapshot: { workspaceSources },
      context: { workspace },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "workspace_sources_too_large" }),
    );
    const workspaceFileActions = plan.actions.filter((action) => action.kind === "workspaceFile");
    expect(workspaceFileActions).toHaveLength(5);
    expect(workspaceFileActions.every((action) => action.blocked)).toBe(true);
    expect(workspaceFileActions.every((action) => action.blocked)).toBe(true);
  });

  it("uses the validated snapshot after source files change", async () => {
    const { source, snapshot, workspace } = await createPlanSource();
    const agentsSnapshot = snapshot.workspaceSources.find(
      (entry) => entry.sourcePath === "workspace/AGENTS.md",
    );
    await writeFile(join(source.packageRoot, "workspace", "AGENTS.md"), "# Changed\n", "utf8");

    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      snapshot,
      context: { workspace },
    });

    expect(
      plan.actions.find((action) => action.kind === "workspaceFile" && action.id === "AGENTS.md")
        ?.digest,
    ).toBe(agentsSnapshot?.digest);
    expect(agentsSnapshot?.digest).toBe(snapshotDigest("# Agent\n"));
  });

  it("blocks when workspace absence cannot be proven", async () => {
    const { source, snapshot } = await createPlanSource();
    const workspace = join(source.packageRoot, "x".repeat(300));
    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      snapshot,
      context: { workspace },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "workspace_probe_failed" }),
    );
    expect(plan.actions.find((action) => action.kind === "workspace")).toMatchObject({
      blocked: true,
      details: { expectedState: "unknown" },
    });
  });

  it("binds plan integrity to the source and planned mutations", async () => {
    const { source, snapshot, workspace } = await createPlanSource();
    const first = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      snapshot,
      context: { workspace },
    });
    const repeated = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      snapshot,
      context: { workspace },
    });
    const changed = await buildClawAddPlan({
      manifest: requireManifest(),
      source: { ...source, integrity: "sha256:changed" },
      snapshot,
      context: { workspace },
    });
    const changedCapability = await buildClawAddPlan({
      manifest: requireManifest({
        ...baseManifest,
        agent: { ...baseManifest.agent, tools: { allow: ["read", "exec"] } },
      }),
      source,
      snapshot,
      context: { workspace },
    });

    expect(repeated.planIntegrity).toBe(first.planIntegrity);
    expect(changed.planIntegrity).not.toBe(first.planIntegrity);
    expect(changedCapability.planIntegrity).not.toBe(first.planIntegrity);
  });
});
