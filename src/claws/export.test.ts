import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { exportClawAgent } from "./export.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { installClawMcpServers } from "./mcp.js";
import { persistClawPackageRef, updateClawInstallRecordStatus } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

async function installedFixture(
  options: {
    avatar?: string;
    extraWorkspaceFiles?: string[];
    withPackage?: boolean;
  } = {},
) {
  const root = tempDirs.make("openclaw-claw-export-");
  await mkdir(join(root, "source", "reference"), { recursive: true });
  const content = (label: string) => `managed ${label}\n`;
  await writeFile(join(root, "source", "SOUL.md"), content("soul"));
  await writeFile(join(root, "source", "reference", "policy.md"), content("policy"));
  for (const path of options.extraWorkspaceFiles ?? []) {
    await mkdir(join(root, "source", dirname(path)), { recursive: true });
    await writeFile(join(root, "source", path), content(path));
  }
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: {
      id: "worker",
      name: "Worker",
      ...(options.avatar ? { identity: { avatar: options.avatar } } : {}),
      tools: {
        profile: "coding",
        alsoAllow: ["cron"],
        deny: ["exec"],
        fs: { workspaceOnly: true },
      },
      memorySearch: {
        enabled: true,
        rememberAcrossConversations: true,
        sources: ["memory", "sessions"],
      },
    },
    workspace: {
      bootstrapFiles: { "SOUL.md": { source: "source/SOUL.md" } },
      files: [
        { source: "source/reference/policy.md", path: "reference/policy.md" },
        ...(options.extraWorkspaceFiles ?? []).map((path) => ({ source: `source/${path}`, path })),
      ],
    },
    mcpServers: {
      docs: {
        command: "uvx",
        args: ["docs-mcp"],
        env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
      },
      linear: {
        url: "https://mcp.linear.app/mcp",
        transport: "streamable-http",
        auth: "oauth",
      },
    },
    cronJobs: [
      {
        id: "daily-report",
        schedule: { cron: "0 9 * * *", timezone: "UTC" },
        session: "isolated",
        message: "Prepare report",
      },
    ],
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/worker",
    version: "1.2.3",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 100,
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: join(root, "workspace-worker") },
  });
  let config: OpenClawConfig = {};
  await applyClawAddPlan(plan, {
    consentPlanIntegrity: plan.planIntegrity,
    env: { OPENCLAW_STATE_DIR: join(root, "state") },
    commitConfig: async (transform) => {
      config = transform(config);
    },
    installMcpServers: async (currentPlan, stateOptions) =>
      await installClawMcpServers(currentPlan, {
        ...stateOptions,
        setMcpServer: async ({ name, server }) => {
          const servers = { ...config.mcp?.servers, [name]: server as McpServerConfig };
          config.mcp = { ...config.mcp, servers };
          return { ok: true, path: "config", config, mcpServers: servers };
        },
      }),
    cronGateway: { add: async () => ({ id: "scheduler-daily" }) },
  });
  if (options.withPackage) {
    persistClawPackageRef(
      plan,
      {
        kind: "skill",
        source: "clawhub",
        ref: "@acme/triage",
        version: "2.0.0",
        integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      { env: { OPENCLAW_STATE_DIR: join(root, "state") } },
    );
  }
  return {
    root,
    plan,
    config,
    env: { OPENCLAW_STATE_DIR: join(root, "state") },
    packageDeps: {
      planSkill: async () => ({
        ok: true as const,
        plan: {
          workspaceDir: plan.agent.workspace,
          slug: "@acme/triage",
          version: "2.0.0",
          installedAt: 0,
          targetDir: join(plan.agent.workspace, "skills", "@acme", "triage"),
          skillFilePath: join(plan.agent.workspace, "skills", "@acme", "triage", "SKILL.md"),
          skillFileSha256: "a".repeat(64),
          fileTreeSha256: `sha256:${"a".repeat(64)}`,
        },
      }),
    },
    sourceMcpServers: structuredClone(config.mcp?.servers ?? {}),
  };
}

describe("exportClawAgent", () => {
  it("writes a grouped package from one installed agent", async () => {
    const fixture = await installedFixture({ withPackage: true });
    fixture.config.mcp!.servers!.docs!.env = {
      DOCS_TOKEN: "resolved-secret-must-not-be-exported",
    };
    const out = join(fixture.root, "exported");

    const result = await exportClawAgent("worker", out, {
      env: fixture.env,
      config: fixture.config,
      packageDeps: fixture.packageDeps,
      sourceMcpServers: fixture.sourceMcpServers,
    });

    expect(result).toMatchObject({
      schemaVersion: "openclaw.clawExportResult.v1",
      stability: "experimental",
      agentId: "worker",
      manifest: {
        schemaVersion: 1,
        agent: {
          id: "worker",
          name: "Worker",
          tools: {
            profile: "coding",
            alsoAllow: ["cron"],
            deny: ["exec"],
            fs: { workspaceOnly: true },
          },
          memorySearch: {
            enabled: true,
            rememberAcrossConversations: true,
            sources: ["memory", "sessions"],
          },
        },
        workspace: {
          bootstrapFiles: { "SOUL.md": { source: "workspace/SOUL.md" } },
          files: [{ source: "workspace/reference/policy.md", path: "reference/policy.md" }],
        },
        packages: [
          {
            kind: "skill",
            source: "clawhub",
            ref: "@acme/triage",
            version: "2.0.0",
          },
        ],
        mcpServers: {
          docs: {
            command: "uvx",
            args: ["docs-mcp"],
            env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
          },
          linear: {
            url: "https://mcp.linear.app/mcp",
            transport: "streamable-http",
            auth: "oauth",
          },
        },
        cronJobs: [
          {
            id: "daily-report",
            schedule: { cron: "0 9 * * *", timezone: "UTC" },
            session: "isolated",
            message: "Prepare report",
          },
        ],
      },
    });
    const packageJson = JSON.parse(await readFile(join(out, "package.json"), "utf8"));
    expect(packageJson).toMatchObject({
      name: "openclaw-claw-worker",
      openclaw: { claw: "CLAW.md" },
    });
    expect(packageJson.version).toMatch(/^0\.0\.0-export\.[0-9a-f]{64}$/);
    await expect(readFile(join(out, "CLAW.md"), "utf8")).resolves.not.toContain(
      "resolved-secret-must-not-be-exported",
    );
    await expect(readFile(join(out, "workspace", "SOUL.md"), "utf8")).resolves.toBe(
      "managed soul\n",
    );
  });

  it("rejects modified managed content instead of silently creating a snapshot", async () => {
    const fixture = await installedFixture();
    await writeFile(join(fixture.plan.agent.workspace, "SOUL.md"), "operator revision\n", "utf8");
    const out = join(fixture.root, "exported-edited");

    await expect(
      exportClawAgent("worker", out, {
        env: fixture.env,
        config: fixture.config,
        packageDeps: fixture.packageDeps,
        sourceMcpServers: fixture.sourceMcpServers,
      }),
    ).rejects.toMatchObject({ code: "workspace_files_drifted" });
  });

  it("rejects a partial install rather than exporting an incomplete snapshot", async () => {
    const fixture = await installedFixture();
    updateClawInstallRecordStatus("worker", "partial", { env: fixture.env });

    await expect(
      exportClawAgent("worker", join(fixture.root, "exported-partial"), {
        env: fixture.env,
        config: fixture.config,
        packageDeps: fixture.packageDeps,
      }),
    ).rejects.toMatchObject({ code: "install_incomplete" });
  });

  it("rejects agent configuration drift", async () => {
    const fixture = await installedFixture();
    const agent = fixture.config.agents!.entries!.worker!;
    agent.name = "Locally changed worker";

    await expect(
      exportClawAgent("worker", join(fixture.root, "exported-agent-drift"), {
        env: fixture.env,
        config: fixture.config,
      }),
    ).rejects.toMatchObject({ code: "agent_drifted" });
  });

  it("rejects missing or drifted package dependencies", async () => {
    const fixture = await installedFixture({ withPackage: true });

    await expect(
      exportClawAgent("worker", join(fixture.root, "exported-package-drift"), {
        env: fixture.env,
        config: fixture.config,
        packageDeps: {
          planSkill: async () => ({ ok: false as const, code: "missing", error: "missing" }),
        },
      }),
    ).rejects.toMatchObject({ code: "packages_drifted" });
  });

  it("packages a safe workspace-relative avatar as a sidecar", async () => {
    const fixture = await installedFixture({
      avatar: "avatars/worker.png",
      extraWorkspaceFiles: ["avatars/worker.png"],
    });
    const avatarPath = join(fixture.plan.agent.workspace, "avatars", "worker.png");
    const out = join(fixture.root, "exported-avatar");

    const result = await exportClawAgent("worker", out, {
      env: fixture.env,
      config: fixture.config,
      sourceMcpServers: fixture.sourceMcpServers,
    });

    expect(result.manifest.agent.identity?.avatar).toBe("avatars/worker.png");
    expect(result.manifest.workspace.files).toContainEqual({
      source: "workspace/avatars/worker.png",
      path: "avatars/worker.png",
    });
    await expect(readFile(join(out, "workspace", "avatars", "worker.png"), "utf8")).resolves.toBe(
      "managed avatars/worker.png\n",
    );
    await expect(readFile(avatarPath, "utf8")).resolves.toBe("managed avatars/worker.png\n");
  });

  it("rejects an agent whose effective workspace changed after installation", async () => {
    const fixture = await installedFixture();
    const movedWorkspace = join(fixture.root, "moved-workspace");
    await mkdir(movedWorkspace);
    const agent = fixture.config.agents!.entries!.worker!;
    agent.workspace = movedWorkspace;

    await expect(
      exportClawAgent("worker", join(fixture.root, "exported-moved-workspace"), {
        env: fixture.env,
        config: fixture.config,
      }),
    ).rejects.toMatchObject({ code: "workspace_changed" });
  });

  it("expands a home-relative output directory", async () => {
    const fixture = await installedFixture();
    vi.stubEnv("HOME", fixture.root);

    const result = await exportClawAgent("worker", "~/exported-home", {
      env: fixture.env,
      config: fixture.config,
      sourceMcpServers: fixture.sourceMcpServers,
    });

    expect(result.outputDirectory).toBe(join(fixture.root, "exported-home"));
    await expect(readFile(join(result.outputDirectory, "CLAW.md"), "utf8")).resolves.toContain(
      "schemaVersion: 1",
    );
  });

  it("fails closed when a managed file is unavailable", async () => {
    const fixture = await installedFixture();
    await writeFile(join(fixture.plan.agent.workspace, "SOUL.md"), "still available\n", "utf8");
    await rm(join(fixture.plan.agent.workspace, "reference", "policy.md"));

    await expect(
      exportClawAgent("worker", join(fixture.root, "exported-missing"), {
        env: fixture.env,
        config: fixture.config,
        sourceMcpServers: fixture.sourceMcpServers,
      }),
    ).rejects.toMatchObject({ code: "workspace_files_drifted" });
  });

  it("never writes into an existing output directory", async () => {
    const fixture = await installedFixture();
    const out = join(fixture.root, "existing");
    await mkdir(out);
    await writeFile(join(out, "operator.txt"), "keep\n", "utf8");

    await expect(
      exportClawAgent("worker", out, {
        env: fixture.env,
        config: fixture.config,
        sourceMcpServers: fixture.sourceMcpServers,
      }),
    ).rejects.toMatchObject({ code: "output_collision" });
    await expect(readFile(join(out, "operator.txt"), "utf8")).resolves.toBe("keep\n");
  });
});
