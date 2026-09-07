import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PLUGIN_ARTIFACT_ADAPTER_IDENTITY } from "../plugins/install-artifact-inspection.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { exportClawAgent } from "./export.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { installClawMcpServers } from "./mcp.js";
import {
  persistClawPackageRef,
  updateClawInstallRecord,
  updateClawInstallRecordStatus,
} from "./provenance.js";
import { readClawManifestFile } from "./reader.js";
import { parseClawManifest } from "./schema.js";
import type { ClawOpenClawProfile, ClawSourceIdentity } from "./types.js";

const lifecycleStateTestControl = vi.hoisted(() => ({
  afterRead: undefined as (() => Promise<void>) | undefined,
}));
const sourceLimitsTestControl = vi.hoisted(() => ({
  clawManifestBytes: 8 * 1024,
  managedWorkspaceBytes: 32 * 1024,
}));

vi.mock("./lifecycle-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lifecycle-state.js")>();
  return {
    ...actual,
    readClawStatus: async (...args: Parameters<typeof actual.readClawStatus>) => {
      const status = await actual.readClawStatus(...args);
      await lifecycleStateTestControl.afterRead?.();
      return status;
    },
  };
});
vi.mock("./source-limits.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./source-limits.js")>();
  return {
    ...actual,
    MAX_CLAW_MANIFEST_BYTES: sourceLimitsTestControl.clawManifestBytes,
    MAX_MANAGED_WORKSPACE_BYTES: sourceLimitsTestControl.managedWorkspaceBytes,
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  lifecycleStateTestControl.afterRead = undefined;
  vi.unstubAllEnvs();
});

async function installedFixture(
  options: {
    avatar?: string;
    extraWorkspaceFileContent?: Buffer;
    extraWorkspaceFiles?: string[];
    packageBootstrap?: boolean;
    packageBootstrapContent?: Buffer;
    soulContent?: string | Buffer;
    withPackage?: boolean;
  } = {},
) {
  const root = tempDirs.make("openclaw-claw-export-");
  await mkdir(join(root, "source", "reference"), { recursive: true });
  const content = (label: string) => `managed ${label}\n`;
  await writeFile(join(root, "source", "SOUL.md"), options.soulContent ?? content("soul"));
  await writeFile(join(root, "source", "reference", "policy.md"), content("policy"));
  for (const path of options.extraWorkspaceFiles ?? []) {
    await mkdir(join(root, "source", dirname(path)), { recursive: true });
    await writeFile(join(root, "source", path), options.extraWorkspaceFileContent ?? content(path));
  }
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: {
      id: "worker",
      name: "Worker",
      ...(options.avatar ? { identity: { avatar: options.avatar } } : {}),
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
  const openClawProfile: ClawOpenClawProfile = {
    schemaVersion: 1,
    agent: {
      tools: {
        profile: "minimal",
        alsoAllow: ["cron"],
        deny: ["exec"],
        fs: { workspaceOnly: true },
      },
      memory: {
        search: {
          enabled: true,
          rememberAcrossConversations: true,
          sources: ["memory", "sessions"],
        },
      },
    },
  };
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
  const packageBootstrapContent =
    options.packageBootstrapContent ??
    Buffer.from("# First run\n\nReview the repository map first.\n");
  const packageBootstrapPath = join(root, "BOOTSTRAP.md");
  if (options.packageBootstrap) {
    await writeFile(packageBootstrapPath, packageBootstrapContent);
  }
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    ...(options.packageBootstrap
      ? {
          packageBootstrap: {
            sourcePath: "BOOTSTRAP.md",
            realPath: await realpath(packageBootstrapPath),
            byteLength: packageBootstrapContent.byteLength,
            digest: `sha256:${createHash("sha256").update(packageBootstrapContent).digest("hex")}`,
          },
        }
      : {}),
    openClawProfile,
    context: { workspace: join(root, "workspace-worker") },
  });
  let config: OpenClawConfig = {};
  const added = await applyClawAddPlan(plan, {
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
  if (added.status !== "complete") {
    throw new Error(
      `installedFixture applyClawAddPlan incomplete (${added.error?.code ?? "unknown_error"}): ${added.error?.message ?? "missing error details"}`,
    );
  }
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
          requestedRef: "@acme/triage",
          slug: "triage",
          version: "2.0.0",
          installedAt: 0,
          targetDir: join(plan.agent.workspace, "skills", "triage"),
          skillFilePath: join(plan.agent.workspace, "skills", "triage", "SKILL.md"),
          skillFileSha256: "a".repeat(64),
          fileTreeSha256: `sha256:${"a".repeat(64)}`,
        },
      }),
    },
    sourceMcpServers: structuredClone(config.mcp?.servers ?? {}),
  };
}

describe("exportClawAgent", () => {
  it("freezes a legacy named profile before exporting it", async () => {
    const fixture = await installedFixture();
    fixture.config.agents!.entries!.worker!.tools = {
      profile: "minimal",
      deny: ["exec"],
    };
    updateClawInstallRecord(
      {
        ...fixture.plan,
        agent: {
          ...fixture.plan.agent,
          config: {
            id: "worker",
            ...fixture.config.agents!.entries!.worker!,
            workspace: fixture.plan.agent.workspace,
          },
        },
      },
      { env: fixture.env },
    );

    const result = await exportClawAgent("worker", join(fixture.root, "legacy-profile-export"), {
      env: fixture.env,
      config: fixture.config,
      packageDeps: fixture.packageDeps,
      sourceMcpServers: fixture.sourceMcpServers,
    });

    expect(result.openClawProfile?.agent.tools).toMatchObject({
      profile: "full",
      allow: expect.arrayContaining(["session_status"]),
      deny: ["exec"],
    });
    expect(result.openClawProfile?.agent.tools).not.toHaveProperty("alsoAllow");
  });

  it("rejects export of an unbounded legacy full profile", async () => {
    const fixture = await installedFixture();
    fixture.config.agents!.entries!.worker!.tools = { profile: "full" };
    updateClawInstallRecord(
      {
        ...fixture.plan,
        agent: {
          ...fixture.plan.agent,
          config: {
            id: "worker",
            ...fixture.config.agents!.entries!.worker!,
            workspace: fixture.plan.agent.workspace,
          },
        },
      },
      { env: fixture.env },
    );

    await expect(
      exportClawAgent("worker", join(fixture.root, "unbounded-profile-export"), {
        env: fixture.env,
        config: fixture.config,
        packageDeps: fixture.packageDeps,
        sourceMcpServers: fixture.sourceMcpServers,
      }),
    ).rejects.toMatchObject({
      code: "tool_profile_consent_required",
    });
  });

  it("writes a grouped package from one installed agent", async () => {
    const fixture = await installedFixture({ withPackage: true });
    expect(fixture.plan.agent.config.memory?.search).toEqual({
      enabled: true,
      rememberAcrossConversations: true,
      sources: ["memory", "sessions"],
    });
    expect(fixture.config.agents?.entries?.worker?.memory?.search).toEqual({
      enabled: true,
      rememberAcrossConversations: true,
      sources: ["memory", "sessions"],
    });
    expect(fixture.config.agents?.entries?.worker).not.toHaveProperty("memorySearch");
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
        agent: { id: "worker", name: "Worker" },
        workspace: {
          bootstrapFiles: {},
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
      openClawProfile: {
        schemaVersion: 1,
        agent: {
          tools: {
            ...fixture.plan.agent.config.tools,
          },
          memory: {
            search: {
              enabled: true,
              rememberAcrossConversations: true,
              sources: ["memory", "sessions"],
            },
          },
        },
      },
    });
    const packageJson = JSON.parse(await readFile(join(out, "package.json"), "utf8"));
    expect(packageJson).toMatchObject({
      name: "openclaw-claw-worker",
      openclaw: { claw: "CLAW.md" },
    });
    expect(packageJson.version).toMatch(/^0\.0\.0-export\.[0-9a-f]{64}$/);
    const clawMarkdown = await readFile(join(out, "CLAW.md"), "utf8");
    expect(clawMarkdown).not.toContain("resolved-secret-must-not-be-exported");
    expect(clawMarkdown).toMatch(/---\nmanaged soul\n$/);
    const exported = await readClawManifestFile(out);
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      throw new Error(JSON.stringify(exported.diagnostics));
    }
    expect(exported.clawMarkdownBody?.toString("utf8")).toBe("managed soul\n");
    expect(exported.manifest.metadata).toEqual({});
    expect(exported.openClawProfile).toMatchObject({
      schemaVersion: 1,
      agent: { tools: fixture.plan.agent.config.tools },
    });
    expect(exported.openClawProfile?.agent.tools).not.toHaveProperty("alsoAllow");
    expect(exported.manifest.workspace.bootstrapFiles).not.toHaveProperty("SOUL.md");
    await expect(readFile(join(out, "profiles", "openclaw.yml"), "utf8")).resolves.toContain(
      "profile: full",
    );
    await expect(readFile(join(out, "workspace", "SOUL.md"), "utf8")).rejects.toThrow();
  });

  it("exports extension plugins into profile v1 without duplicating manifest packages", async () => {
    const fixture = await installedFixture();
    const integrity = `sha256:${"b".repeat(64)}`;
    const extension = {
      id: "coding-tools",
      format: "claude" as const,
      detectedFormat: "claude" as const,
      mapped: ["agents", "commands", "skills"],
      unavailable: [],
      adapterIdentity: PLUGIN_ARTIFACT_ADAPTER_IDENTITY,
    };
    persistClawPackageRef(
      fixture.plan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "@acme/coding-tools",
        version: "1.2.3",
        integrity,
        extension,
      },
      { env: fixture.env, relationship: "referenced" },
    );

    const result = await exportClawAgent("worker", join(fixture.root, "exported-extension"), {
      env: fixture.env,
      config: fixture.config,
      sourceMcpServers: fixture.sourceMcpServers,
      packageDeps: {
        resolvePlugin: async () => ({
          status: "found" as const,
          pluginId: "coding-tools",
          installedVersion: "1.2.3",
          record: { source: "clawhub", integrity },
        }),
      },
    });

    expect(result.manifest.packages).toEqual([]);
    expect(result.manifest.workspace.files).toContainEqual(
      expect.objectContaining({ path: "reference/policy.md" }),
    );
    expect(result.openClawProfile).toMatchObject({
      schemaVersion: 1,
      extensions: [
        {
          id: "coding-tools",
          kind: "plugin",
          format: "claude",
          source: "clawhub",
          ref: "@acme/coding-tools",
          version: "1.2.3",
        },
      ],
    });
  });

  it("attaches an explicit reviewed package bootstrap and re-reads the export", async () => {
    const fixture = await installedFixture();
    const bootstrapPath = join(fixture.root, "reviewed-bootstrap.md");
    const out = join(fixture.root, "exported-with-bootstrap");
    await writeFile(bootstrapPath, "# First run\n\nAsk for the operator's timezone.\n", "utf8");

    const result = await exportClawAgent("worker", out, {
      env: fixture.env,
      config: fixture.config,
      sourceMcpServers: fixture.sourceMcpServers,
      bootstrapPath,
    });

    expect(result.filesWritten).toContain("BOOTSTRAP.md");
    await expect(readFile(join(out, "BOOTSTRAP.md"), "utf8")).resolves.toBe(
      "# First run\n\nAsk for the operator's timezone.\n",
    );
    const exported = await readClawManifestFile(out);
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      throw new Error(JSON.stringify(exported.diagnostics));
    }
    expect(exported.packageBootstrap).toMatchObject({
      sourcePath: "BOOTSTRAP.md",
      byteLength: 46,
    });

    const originalPackage = JSON.parse(await readFile(join(out, "package.json"), "utf8")) as {
      version: string;
    };
    await writeFile(bootstrapPath, "# First run\n\nAsk for the operator's locale.\n", "utf8");
    const changedOut = join(fixture.root, "exported-with-changed-bootstrap");
    await exportClawAgent("worker", changedOut, {
      env: fixture.env,
      config: fixture.config,
      sourceMcpServers: fixture.sourceMcpServers,
      bootstrapPath,
    });
    const changedPackage = JSON.parse(await readFile(join(changedOut, "package.json"), "utf8")) as {
      version: string;
    };
    expect(changedPackage.version).not.toBe(originalPackage.version);
  });

  it("rejects empty bootstrap authoring without leaving an export target", async () => {
    const fixture = await installedFixture();
    const bootstrapPath = join(fixture.root, "empty-bootstrap.md");
    const out = join(fixture.root, "exported-empty-bootstrap");
    await writeFile(bootstrapPath, " \n", "utf8");

    await expect(
      exportClawAgent("worker", out, {
        env: fixture.env,
        config: fixture.config,
        sourceMcpServers: fixture.sourceMcpServers,
        bootstrapPath,
      }),
    ).rejects.toMatchObject({ code: "bootstrap_empty" });
    await expect(readFile(join(out, "CLAW.md"), "utf8")).rejects.toThrow();
  });

  it("rejects non-UTF-8 bootstrap authoring", async () => {
    const fixture = await installedFixture();
    const bootstrapPath = join(fixture.root, "binary-bootstrap.md");
    await writeFile(bootstrapPath, Buffer.from([0xff]));

    await expect(
      exportClawAgent("worker", join(fixture.root, "exported-binary-bootstrap"), {
        env: fixture.env,
        config: fixture.config,
        sourceMcpServers: fixture.sourceMcpServers,
        bootstrapPath,
      }),
    ).rejects.toMatchObject({ code: "bootstrap_invalid" });
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

  it("exports a pending package bootstrap as package-root BOOTSTRAP.md", async () => {
    const fixture = await installedFixture({ packageBootstrap: true });
    const out = join(fixture.root, "exported-bootstrap");

    const result = await exportClawAgent("worker", out, {
      env: fixture.env,
      config: fixture.config,
      packageDeps: fixture.packageDeps,
      sourceMcpServers: fixture.sourceMcpServers,
    });

    expect(result.filesWritten).toContain("BOOTSTRAP.md");
    await expect(readFile(join(out, "BOOTSTRAP.md"), "utf8")).resolves.toContain("repository map");
    const exported = await readClawManifestFile(out);
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      throw new Error(JSON.stringify(exported.diagnostics));
    }
    expect(exported.packageBootstrap).toMatchObject({
      sourcePath: "BOOTSTRAP.md",
      byteLength: "# First run\n\nReview the repository map first.\n".length,
    });
  });

  it("rejects bootstrap content replaced after ownership inspection", async () => {
    const fixture = await installedFixture({ packageBootstrap: true, withPackage: true });
    const out = join(fixture.root, "exported-replaced-bootstrap");

    await expect(
      exportClawAgent("worker", out, {
        env: fixture.env,
        config: fixture.config,
        packageDeps: {
          ...fixture.packageDeps,
          planSkill: async () => {
            await writeFile(
              join(fixture.plan.agent.workspace, "BOOTSTRAP.md"),
              "# Replaced\n\nUnrecorded instructions.\n",
            );
            return await fixture.packageDeps.planSkill();
          },
        },
        sourceMcpServers: fixture.sourceMcpServers,
      }),
    ).rejects.toMatchObject({ code: "bootstrap_drifted" });
    await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a pending package bootstrap that changes after status inspection", async () => {
    const fixture = await installedFixture({ packageBootstrap: true });
    const bootstrapPath = join(fixture.plan.agent.workspace, "BOOTSTRAP.md");
    const out = join(fixture.root, "exported-raced-bootstrap");
    lifecycleStateTestControl.afterRead = async () => {
      await writeFile(bootstrapPath, "# Changed after inspection\n", "utf8");
    };

    await expect(
      exportClawAgent("worker", out, {
        env: fixture.env,
        config: fixture.config,
        packageDeps: fixture.packageDeps,
        sourceMcpServers: fixture.sourceMcpServers,
      }),
    ).rejects.toMatchObject({ code: "bootstrap_drifted" });
    await expect(stat(out)).rejects.toThrow();
  });

  it("does not export native bootstrap content without package ownership", async () => {
    const fixture = await installedFixture();
    await writeFile(
      join(fixture.plan.agent.workspace, "BOOTSTRAP.md"),
      "# First run\n\nOperator-authored onboarding.\n",
    );
    const out = join(fixture.root, "exported-native-bootstrap");

    const result = await exportClawAgent("worker", out, {
      env: fixture.env,
      config: fixture.config,
      packageDeps: fixture.packageDeps,
      sourceMcpServers: fixture.sourceMcpServers,
    });

    expect(result.filesWritten).not.toContain("BOOTSTRAP.md");
    await expect(readFile(join(out, "BOOTSTRAP.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const exported = await readClawManifestFile(out);
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      throw new Error(JSON.stringify(exported.diagnostics));
    }
    expect(exported.packageBootstrap).toBeUndefined();
  });

  it("refuses to export a locally modified package bootstrap", async () => {
    const fixture = await installedFixture({ packageBootstrap: true });
    await writeFile(
      join(fixture.plan.agent.workspace, "BOOTSTRAP.md"),
      "# Edited onboarding\n",
      "utf8",
    );
    const out = join(fixture.root, "exported-modified-bootstrap");

    await expect(
      exportClawAgent("worker", out, {
        env: fixture.env,
        config: fixture.config,
        packageDeps: fixture.packageDeps,
        sourceMcpServers: fixture.sourceMcpServers,
      }),
    ).rejects.toMatchObject({ code: "bootstrap_drifted" });
    await expect(stat(out)).rejects.toThrow();
  });

  it("still exports a consumed package bootstrap without a package BOOTSTRAP.md", async () => {
    const fixture = await installedFixture({ packageBootstrap: true });
    await rm(join(fixture.plan.agent.workspace, "BOOTSTRAP.md"));
    const out = join(fixture.root, "exported-consumed-bootstrap");

    const result = await exportClawAgent("worker", out, {
      env: fixture.env,
      config: fixture.config,
      packageDeps: fixture.packageDeps,
      sourceMcpServers: fixture.sourceMcpServers,
    });

    expect(result.filesWritten).not.toContain("BOOTSTRAP.md");
  });

  it("exports a drifted package bootstrap when a reviewed replacement is supplied", async () => {
    const fixture = await installedFixture({ packageBootstrap: true });
    await writeFile(
      join(fixture.plan.agent.workspace, "BOOTSTRAP.md"),
      "# Edited onboarding\n",
      "utf8",
    );
    const bootstrapPath = join(fixture.root, "reviewed-replacement.md");
    await writeFile(bootstrapPath, "# First run\n\nAsk for the operator's timezone.\n", "utf8");
    const out = join(fixture.root, "exported-replaced-bootstrap");

    const result = await exportClawAgent("worker", out, {
      env: fixture.env,
      config: fixture.config,
      packageDeps: fixture.packageDeps,
      sourceMcpServers: fixture.sourceMcpServers,
      bootstrapPath,
    });

    expect(result.filesWritten).toContain("BOOTSTRAP.md");
    await expect(readFile(join(out, "BOOTSTRAP.md"), "utf8")).resolves.toContain(
      "operator's timezone",
    );
  });

  it("does not reread a pending package bootstrap when an explicit replacement is supplied", async () => {
    const fixture = await installedFixture({ packageBootstrap: true });
    const bootstrapPath = join(fixture.root, "reviewed-race-replacement.md");
    await writeFile(bootstrapPath, "# First run\n\nUse the reviewed replacement.\n", "utf8");
    lifecycleStateTestControl.afterRead = async () => {
      await rm(join(fixture.plan.agent.workspace, "BOOTSTRAP.md"));
    };
    const out = join(fixture.root, "exported-race-replacement");

    const result = await exportClawAgent("worker", out, {
      env: fixture.env,
      config: fixture.config,
      packageDeps: fixture.packageDeps,
      sourceMcpServers: fixture.sourceMcpServers,
      bootstrapPath,
    });

    expect(result.filesWritten).toContain("BOOTSTRAP.md");
    await expect(readFile(join(out, "BOOTSTRAP.md"), "utf8")).resolves.toContain(
      "reviewed replacement",
    );
  });

  it("keeps pending package bootstrap outside the managed workspace aggregate", async () => {
    const workspaceContent = Buffer.alloc(9 * 1024, "w");
    const bootstrapContent = Buffer.alloc(6 * 1024, "b");
    expect(workspaceContent.byteLength * 3).toBeLessThan(
      sourceLimitsTestControl.managedWorkspaceBytes,
    );
    expect(workspaceContent.byteLength * 3 + bootstrapContent.byteLength).toBeGreaterThan(
      sourceLimitsTestControl.managedWorkspaceBytes,
    );
    const fixture = await installedFixture({
      extraWorkspaceFiles: ["one.md", "two.md", "three.md"],
      extraWorkspaceFileContent: workspaceContent,
      packageBootstrap: true,
      packageBootstrapContent: bootstrapContent,
    });
    const out = join(fixture.root, "exported-independent-bootstrap-quota");

    const result = await exportClawAgent("worker", out, {
      env: fixture.env,
      config: fixture.config,
      packageDeps: fixture.packageDeps,
      sourceMcpServers: fixture.sourceMcpServers,
    });

    expect(result.filesWritten).toContain("BOOTSTRAP.md");
    await expect(readFile(join(out, "BOOTSTRAP.md"))).resolves.toEqual(bootstrapContent);
    for (const path of ["one.md", "two.md", "three.md"]) {
      await expect(readFile(join(out, "workspace", path))).resolves.toEqual(workspaceContent);
    }
  });

  it("exports a whitespace-only SOUL.md as an explicit workspace file", async () => {
    const fixture = await installedFixture({ soulContent: " \n" });
    const out = join(fixture.root, "exported-empty-soul");

    await exportClawAgent("worker", out, {
      env: fixture.env,
      config: fixture.config,
      sourceMcpServers: fixture.sourceMcpServers,
    });

    const exported = await readClawManifestFile(out);
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      throw new Error(JSON.stringify(exported.diagnostics));
    }
    expect(exported.clawMarkdownBody).toBeUndefined();
    expect(exported.manifest.workspace.bootstrapFiles["SOUL.md"]).toEqual({
      source: "workspace/SOUL.md",
    });
    await expect(readFile(join(out, "workspace", "SOUL.md"), "utf8")).resolves.toBe(" \n");
  });

  it("exports non-UTF-8 SOUL.md bytes as an explicit workspace file", async () => {
    const fixture = await installedFixture({ soulContent: Buffer.from([0xff]) });
    const out = join(fixture.root, "exported-binary-soul");

    await exportClawAgent("worker", out, {
      env: fixture.env,
      config: fixture.config,
      sourceMcpServers: fixture.sourceMcpServers,
    });

    const exported = await readClawManifestFile(out);
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      throw new Error(JSON.stringify(exported.diagnostics));
    }
    expect(exported.clawMarkdownBody).toBeUndefined();
    expect(exported.manifest.workspace.bootstrapFiles["SOUL.md"]).toEqual({
      source: "workspace/SOUL.md",
    });
    await expect(readFile(join(out, "workspace", "SOUL.md"))).resolves.toEqual(Buffer.from([0xff]));
  });

  it("keeps SOUL.md as a sidecar when embedding would exceed the CLAW.md limit", async () => {
    const fixture = await installedFixture({
      soulContent: Buffer.alloc(sourceLimitsTestControl.clawManifestBytes, 0x61),
    });
    const out = join(fixture.root, "exported-large-soul");

    await exportClawAgent("worker", out, {
      env: fixture.env,
      config: fixture.config,
      sourceMcpServers: fixture.sourceMcpServers,
    });

    const exported = await readClawManifestFile(out);
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      throw new Error(JSON.stringify(exported.diagnostics));
    }
    expect(exported.clawMarkdownBody).toBeUndefined();
    expect(exported.manifest.workspace.bootstrapFiles["SOUL.md"]).toEqual({
      source: "workspace/SOUL.md",
    });
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
