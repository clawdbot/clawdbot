import { AsyncResource } from "node:async_hooks";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PLUGIN_ARTIFACT_ADAPTER_IDENTITY } from "../plugins/install-artifact-inspection.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { installClawPackages, preflightClawPackage } from "./packages.js";
import type { PersistedClawPackageRef } from "./provenance.js";
import type { ClawAddPlan, ResolvedClawPackage } from "./types.js";

function plan(
  packages: ResolvedClawPackage[],
  ownerAction: "install" | "reuse" = "install",
): ClawAddPlan {
  return {
    schemaVersion: "openclaw.clawAddPlan.v1",
    manifestSchemaVersion: 1,
    stability: "experimental",
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: "sha256:plan",
    claw: {
      kind: "package",
      name: "incident-claw",
      version: "1.0.0",
      packageRoot: "/tmp/claw",
      manifestPath: "/tmp/claw/claw.json",
      integrityKind: "artifact",
      integrity: "sha256:claw",
      byteLength: 123,
    },
    agent: {
      requestedId: "incident",
      finalId: "incident-2",
      workspace: "/tmp/incident-2",
      config: { id: "incident-2", workspace: "/tmp/incident-2" },
    },
    summary: {
      totalActions: packages.length,
      agentActions: 0,
      workspaceActions: 0,
      packageActions: packages.length,
      mcpServerActions: 0,
      cronJobActions: 0,
      blockedActions: 0,
      capabilityEscalations: 0,
    },
    capabilityChanges: [],
    actions: packages.map((pkg) => ({
      kind: "package",
      id: `${pkg.kind}:${pkg.ref}`,
      action: "install",
      target: `${pkg.source}:${pkg.ref}@${pkg.version}`,
      details: {
        ...pkg,
        ownerAction,
        ...(pkg.kind === "plugin" ? { installId: pkg.ref.split("/").at(-1) } : {}),
      },
      blocked: false,
    })),
    readiness: { ready: true, requirements: [] },
    blockers: [],
    diagnostics: [],
  };
}

const integrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const pluginPackage = {
  kind: "plugin",
  source: "clawhub",
  ref: "@owner/audit",
  version: "2.0.1",
  integrity,
} as const;

const completePackageRef = vi.fn(
  (ref: PersistedClawPackageRef, status: PersistedClawPackageRef["status"]) => ({
    ...ref,
    status,
  }),
);
const pluginIntegrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
function pluginPackageRef(
  ref: string,
  overrides: Partial<PersistedClawPackageRef> = {},
): PersistedClawPackageRef {
  return {
    schemaVersion: "openclaw.clawPackageRef.v1",
    agentId: "incident-2",
    clawName: "incident-claw",
    kind: "plugin",
    source: "clawhub",
    ref,
    version: "1.0.0",
    integrity: pluginIntegrity,
    status: "complete",
    relationship: "referenced",
    origin: "claw-introduced",
    independentOwner: false,
    installedAtMs: 1_000,
    updatedAtMs: 2_000,
    ...overrides,
  };
}
const acquirePackageLease = vi.fn(() => ({ heartbeat: vi.fn(), release: vi.fn() }));
const probePlugin = vi.fn(async ({ spec }: { spec: string }) => {
  const pluginId = spec.slice(spec.lastIndexOf("/") + 1).split("@")[0]!;
  const packageName = spec.replace(/^clawhub:/, "").replace(/@[^@]+$/, "");
  return {
    ok: true as const,
    pluginId,
    packageName,
    targetDir: "/tmp/plugin",
    extensions: [],
    clawhub: {
      source: "clawhub" as const,
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: packageName,
      clawhubFamily: "code-plugin" as const,
      integrity,
    },
  };
});

describe("preflightClawPackage plugin setup requirements", () => {
  const setup = {
    providers: [
      {
        id: "evidence",
        authMethods: ["api-key"],
        envVars: ["EVIDENCE_API_KEY", "EVIDENCE_TOKEN"],
      },
    ],
  };
  const artifactInspection = { format: "openclaw" as const, mapped: ["plugin"], unavailable: [] };
  const preflightPlugin = vi.fn().mockResolvedValue({ ok: true, action: "install" });
  const probePluginSetup = vi.fn().mockResolvedValue({
    ok: true,
    pluginId: "evidence",
    setup,
    artifactInspection,
    clawhub: { integrity },
  });

  it("reports plugin setup when no declared environment credential is present", async () => {
    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        env: {},
        deps: { preflightPlugin, probePlugin: probePluginSetup },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        requirements: [
          {
            kind: "plugin-setup",
            plugin: "evidence",
            provider: "evidence",
            envVars: ["EVIDENCE_API_KEY", "EVIDENCE_TOKEN"],
            authMethods: ["api-key"],
          },
        ],
      }),
    );
  });

  it("accepts any declared environment credential", async () => {
    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        env: { EVIDENCE_TOKEN: "configured" },
        deps: { preflightPlugin, probePlugin: probePluginSetup },
      }),
    ).resolves.not.toHaveProperty("requirements");
  });

  it("accepts credentials for any declared provider", async () => {
    probePluginSetup.mockResolvedValueOnce({
      ok: true,
      pluginId: "evidence",
      setup: {
        providers: [
          { id: "first", envVars: ["FIRST_API_KEY"] },
          { id: "second", envVars: ["SECOND_API_KEY"] },
        ],
      },
      artifactInspection,
      clawhub: { integrity },
    });

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        env: { SECOND_API_KEY: "configured" },
        deps: { preflightPlugin, probePlugin: probePluginSetup },
      }),
    ).resolves.not.toHaveProperty("requirements");
  });

  it("does not gate readiness on an auth-method-only provider", async () => {
    probePluginSetup.mockResolvedValueOnce({
      ok: true,
      pluginId: "evidence",
      setup: {
        providers: [{ id: "oauth-only", authMethods: ["oauth"] }],
      },
      artifactInspection,
      clawhub: { integrity },
    });

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        env: {},
        deps: { preflightPlugin, probePlugin: probePluginSetup },
      }),
    ).resolves.not.toHaveProperty("requirements");
  });

  it("accepts declared local auth evidence", async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), "claw-auth-evidence-"));
    const credentialsPath = join(credentialsDir, "credentials.json");
    await writeFile(credentialsPath, "{}", "utf8");
    probePluginSetup.mockResolvedValueOnce({
      ok: true,
      pluginId: "evidence",
      setup: {
        providers: [
          {
            ...setup.providers[0],
            authEvidence: [
              {
                type: "local-file-with-env",
                fileEnvVar: "EVIDENCE_CREDENTIALS",
                requiresAllEnv: ["EVIDENCE_PROJECT"],
                credentialMarker: "evidence-local-credentials",
              },
            ],
          },
        ],
      },
      artifactInspection,
      clawhub: { integrity },
    });

    try {
      await expect(
        preflightClawPackage(pluginPackage, "/tmp/workspace", {
          env: {
            EVIDENCE_CREDENTIALS: credentialsPath,
            EVIDENCE_PROJECT: "project",
          },
          deps: { preflightPlugin, probePlugin: probePluginSetup },
        }),
      ).resolves.not.toHaveProperty("requirements");
    } finally {
      await rm(credentialsDir, { recursive: true, force: true });
    }
  });
});

describe("preflightClawPackage isolated plugin inspection", () => {
  it("rejects generic agent bundles outside the Claw schema-v1 format contract", async () => {
    const probeAgentBundle = vi.fn(async () => ({
      ok: true as const,
      pluginId: "audit",
      packageName: "@owner/audit",
      targetDir: "/tmp/extensions/audit",
      extensions: [],
      artifactInspection: {
        format: "agent" as const,
        mapped: ["skills"],
        unavailable: [],
      },
      clawhub: {
        source: "clawhub" as const,
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "@owner/audit",
        clawhubFamily: "code-plugin" as const,
        integrity,
      },
    }));

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        deps: {
          preflightPlugin: vi.fn(async () => ({
            ok: true as const,
            action: "install" as const,
            request: {} as never,
          })),
          probePlugin: probeAgentBundle,
        },
      }),
    ).resolves.toEqual({
      ok: false,
      code: "plugin_artifact_format_unsupported",
      message: "Plugin @owner/audit@2.0.1 uses unsupported Claw extension format agent.",
    });
  });

  it("preserves live extension-directory conflict checks for a new plugin install", async () => {
    const createProbeExtensionsDir = vi.fn();
    const liveProbe = vi.fn(async () => ({
      ok: false as const,
      code: "plugin_target_exists" as never,
      error: "plugin already exists: /tmp/extensions/audit",
    }));

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        deps: {
          preflightPlugin: vi.fn(async () => ({
            ok: true as const,
            action: "install" as const,
            request: {} as never,
          })),
          probePlugin: liveProbe,
          createProbeExtensionsDir,
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: "plugin already exists: /tmp/extensions/audit",
    });
    expect(liveProbe).toHaveBeenCalledWith(
      expect.not.objectContaining({ extensionsDir: expect.anything() }),
    );
    expect(createProbeExtensionsDir).not.toHaveBeenCalled();
  });

  it("preserves canonical inspection when an installed plugin version conflicts", async () => {
    const probePluginConflict = vi.fn(async () => ({
      ok: true as const,
      pluginId: "audit",
      packageName: "@owner/audit",
      targetDir: "/tmp/claw-plugin-probe/audit",
      extensions: [],
      artifactInspection: {
        format: "claude" as const,
        mapped: ["commands", "skills"],
        unavailable: ["agents"],
      },
      clawhub: {
        source: "clawhub" as const,
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "@owner/audit",
        clawhubFamily: "code-plugin" as const,
        integrity,
      },
    }));

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        deps: {
          preflightPlugin: vi.fn(async () => ({
            ok: false as const,
            code: "plugin_version_conflict" as const,
            error: "Installed plugin has a different version.",
            installedVersion: "1.0.0",
            expectedVersion: pluginPackage.version,
            request: {} as never,
          })),
          probePlugin: probePluginConflict,
          createProbeExtensionsDir: vi.fn(async () => "/tmp/claw-plugin-probe"),
          removeProbeExtensionsDir: vi.fn(async () => undefined),
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "plugin_version_conflict",
      installedVersion: "1.0.0",
      integrity: `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`,
      installId: "audit",
      detectedFormat: "claude",
      mapped: ["commands", "skills"],
      unavailable: ["agents"],
      adapterIdentity: expect.stringMatching(/^openclaw\//),
    });
  });

  it("inspects an exact installed plugin outside its live extension directory", async () => {
    const removeProbeExtensionsDir = vi.fn(async () => {
      throw new Error("temporary directory is still busy");
    });
    const isolatedProbe = vi.fn(async () => ({
      ok: true as const,
      pluginId: "audit",
      packageName: "@owner/audit",
      targetDir: "/tmp/claw-plugin-probe/audit",
      extensions: [],
      artifactInspection: {
        format: "openclaw" as const,
        mapped: ["plugin"],
        unavailable: [],
      },
      clawhub: {
        source: "clawhub" as const,
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "@owner/audit",
        clawhubFamily: "code-plugin" as const,
        integrity,
      },
    }));

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        deps: {
          preflightPlugin: vi.fn(async () => ({
            ok: true as const,
            action: "reuse" as const,
            request: {} as never,
            installedId: "audit",
            installedVersion: "2.0.1",
            installedIntegrity: integrity,
            installedAt: "2026-08-06T00:00:00.000Z",
          })),
          probePlugin: isolatedProbe,
          createProbeExtensionsDir: vi.fn(async () => "/tmp/claw-plugin-probe"),
          removeProbeExtensionsDir,
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      action: "reuse",
      installId: "audit",
      installedIntegrity: integrity,
      installedAt: "2026-08-06T00:00:00.000Z",
      detectedFormat: "openclaw",
      mapped: ["plugin"],
      unavailable: [],
    });
    expect(isolatedProbe).toHaveBeenCalledWith(
      expect.objectContaining({ extensionsDir: "/tmp/claw-plugin-probe", dryRun: true }),
    );
    expect(removeProbeExtensionsDir).toHaveBeenCalledWith("/tmp/claw-plugin-probe");
  });
});

describe("installClawPackages", () => {
  it("installs skill packages into the planned workspace with the resolved digest", async () => {
    const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const pending = {
      kind: "skill",
      ref: "@owner/triage",
      status: "pending",
      integrity: skillIntegrity,
    };
    const installSkill = vi.fn().mockResolvedValue({
      ok: true,
      slug: "triage",
      version: "1.2.3",
      targetDir: "/tmp/incident-2/skills/triage",
    });
    const persistPackageRef = vi.fn().mockReturnValue(pending);
    const onExternalMutation = vi.fn();

    await installClawPackages(
      plan([
        {
          kind: "skill",
          source: "clawhub",
          ref: "@owner/triage",
          version: "1.2.3",
          integrity: skillIntegrity,
        },
      ]),
      {
        deps: {
          installSkill,
          preflightSkill: vi
            .fn()
            .mockResolvedValue({ ok: true, action: "install", integrity: skillIntegrity }),
          persistPackageRef,
          completePackageRef,
          acquirePackageLease,
        },
        onExternalMutation,
      },
    );

    expect(installSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/incident-2",
        slug: "@owner/triage",
        version: "1.2.3",
        expectedIntegrity: skillIntegrity,
        clawManaged: true,
      }),
    );
    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ integrity: skillIntegrity }),
      expect.objectContaining({
        status: "pending",
        relationship: "managed",
        origin: "claw-introduced",
        independentOwner: false,
      }),
    );
    expect(onExternalMutation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "skill", ref: "@owner/triage" }),
    );
  });

  it("lets the shared plugin owner acquire its lease in the Gateway request scope", async () => {
    probePlugin.mockClear();
    const gatewayScope = new AsyncResource("claw-plugin-gateway");
    const installPlugin = vi.fn(() =>
      gatewayScope.runInAsyncScope(() =>
        withPluginLifecycleLease({ waitMs: 0 }, async () => undefined),
      ),
    );
    const persistPackageRef = vi.fn().mockReturnValue({
      kind: "plugin",
      ref: "@owner/audit",
      status: "pending",
      integrity,
    });
    const preflightPlugin = vi.fn().mockResolvedValue({ ok: true, action: "install" });

    await installClawPackages(plan([pluginPackage]), {
      deps: {
        installPlugin,
        probePlugin,
        preflightPlugin,
        persistPackageRef,
        completePackageRef,
        acquirePackageLease,
      },
    });

    expect(installPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: "clawhub:@owner/audit@2.0.1",
        allowInstallPolicyWarningPrompt: false,
        opts: {
          expectedIntegrity:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          expectedPluginId: "audit",
        },
        clawManaged: true,
      }),
    );
    expect(probePlugin).toHaveBeenCalledWith(
      expect.not.objectContaining({ extensionsDir: expect.anything() }),
    );
    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      expect.objectContaining({
        status: "pending",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      }),
    );
  });

  it("resumes an exact Claw-introduced plugin requirement without reinstalling", async () => {
    probePlugin.mockClear();
    const introduced = pluginPackageRef("@owner/audit", {
      version: pluginPackage.version,
      integrity,
    });
    const installPlugin = vi.fn();
    const persistPackageRef = vi.fn().mockReturnValue(introduced);

    const result = await installClawPackages(plan([pluginPackage]), {
      deps: {
        installPlugin,
        probePlugin,
        preflightPlugin: vi.fn().mockResolvedValue({
          ok: true,
          action: "reuse",
          installedId: "audit",
          installedIntegrity: integrity,
        }),
        persistPackageRef,
        completePackageRef,
        readPackageRefs: vi.fn().mockReturnValue([introduced]),
        acquirePackageLease,
      },
    });

    expect(result).toEqual([introduced]);
    expect(installPlugin).not.toHaveBeenCalled();
    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        status: "complete",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      }),
    );
  });

  it("records a dependency ref without reinstalling an exact reused plugin", async () => {
    probePlugin.mockClear();
    const extension = {
      id: "audit-tools",
      format: "claude" as const,
      detectedFormat: "claude" as const,
      mapped: ["skills"],
      unavailable: ["agents"],
      adapterIdentity: PLUGIN_ARTIFACT_ADAPTER_IDENTITY,
    };
    const installPlugin = vi.fn();
    const persistPackageRef = vi.fn().mockReturnValue({ kind: "plugin" });
    const preflightPlugin = vi.fn().mockResolvedValue({
      ok: true,
      action: "reuse",
      installedId: "audit",
      installedIntegrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const probePluginForExtension = vi.fn().mockResolvedValue({
      ok: true,
      pluginId: "audit",
      packageName: "@owner/audit",
      targetDir: "/tmp/plugin",
      extensions: [],
      artifactInspection: {
        format: "claude",
        mapped: ["skills"],
        unavailable: ["agents"],
      },
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "@owner/audit",
        clawhubFamily: "code-plugin",
        integrity,
      },
    });

    await installClawPackages(plan([{ ...pluginPackage, extension }], "reuse"), {
      deps: {
        installPlugin,
        probePlugin: probePluginForExtension,
        preflightPlugin,
        persistPackageRef,
        completePackageRef,
        readPackageRefs: vi.fn().mockReturnValue([]),
        acquirePackageLease,
      },
    });

    expect(installPlugin).not.toHaveBeenCalled();
    expect(probePluginForExtension).toHaveBeenCalledWith(
      expect.objectContaining({ extensionsDir: expect.any(String) }),
    );
    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        extension,
      }),
      expect.objectContaining({
        status: "complete",
        relationship: "referenced",
        origin: "pre-existing",
        independentOwner: true,
      }),
    );
  });

  it("rejects changed extension inspection before recording reused plugin provenance", async () => {
    const extension = {
      id: "audit-tools",
      format: "claude" as const,
      detectedFormat: "claude" as const,
      mapped: ["skills"],
      unavailable: ["agents"],
      adapterIdentity: PLUGIN_ARTIFACT_ADAPTER_IDENTITY,
    };
    const persistPackageRef = vi.fn();

    await expect(
      installClawPackages(plan([{ ...pluginPackage, extension }], "reuse"), {
        deps: {
          installPlugin: vi.fn(),
          probePlugin: vi.fn().mockResolvedValue({
            ok: true,
            pluginId: "audit",
            packageName: "@owner/audit",
            targetDir: "/tmp/plugin",
            extensions: [],
            artifactInspection: {
              format: "claude",
              mapped: ["skills", "commands"],
              unavailable: ["agents"],
            },
            clawhub: {
              source: "clawhub",
              clawhubUrl: "https://clawhub.ai",
              clawhubPackage: "@owner/audit",
              clawhubFamily: "code-plugin",
              integrity,
            },
          }),
          preflightPlugin: vi.fn().mockResolvedValue({
            ok: true,
            action: "reuse",
            installedId: "audit",
            installedIntegrity: integrity,
          }),
          persistPackageRef,
          completePackageRef,
          readPackageRefs: vi.fn().mockReturnValue([]),
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({
      code: "package_owner_state_changed",
      message: expect.stringContaining("identity or trust state changed after planning"),
    });
    expect(persistPackageRef).not.toHaveBeenCalled();
  });

  it("inherits Claw-introduced origin when another Claw already owns the plugin", async () => {
    const persistPackageRef = vi.fn().mockReturnValue({ kind: "plugin" });
    const existing = {
      relationship: "referenced",
      origin: "claw-introduced",
      independentOwner: false,
    } as PersistedClawPackageRef;

    await installClawPackages(plan([pluginPackage], "reuse"), {
      deps: {
        installPlugin: vi.fn(),
        probePlugin,
        preflightPlugin: vi.fn().mockResolvedValue({
          ok: true,
          action: "reuse",
          installedId: "audit",
          installedIntegrity: integrity,
        }),
        persistPackageRef,
        completePackageRef,
        readPackageRefs: vi.fn().mockReturnValue([existing]),
        acquirePackageLease,
      },
    });

    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      }),
    );
  });

  it("preserves a newer independent plugin reinstall when another Claw reuses it", async () => {
    const persistPackageRef = vi.fn().mockReturnValue({ kind: "plugin" });
    const existing = {
      relationship: "referenced",
      origin: "claw-introduced",
      independentOwner: false,
      updatedAtMs: 10,
    } as PersistedClawPackageRef;

    await installClawPackages(plan([pluginPackage], "reuse"), {
      deps: {
        installPlugin: vi.fn(),
        probePlugin,
        preflightPlugin: vi.fn().mockResolvedValue({
          ok: true,
          action: "reuse",
          installedId: "audit",
          installedIntegrity: integrity,
          installedAt: new Date(20).toISOString(),
        }),
        persistPackageRef,
        completePackageRef,
        readPackageRefs: vi.fn().mockReturnValue([existing]),
        acquirePackageLease,
      },
    });

    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        relationship: "referenced",
        origin: "pre-existing",
        independentOwner: true,
      }),
    );
  });

  it("marks the pending ref failed when a plugin install fails", async () => {
    const pending = {
      kind: "plugin",
      ref: "@owner/audit",
      status: "pending",
      integrity,
    } as PersistedClawPackageRef;
    const persistPackageRef = vi.fn().mockReturnValue(pending);

    await expect(
      installClawPackages(plan([pluginPackage]), {
        deps: {
          installPlugin: vi.fn().mockRejectedValue(new Error("registry unavailable")),
          probePlugin,
          preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
          persistPackageRef,
          completePackageRef,
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({
      code: "package_install_failed",
      message: "registry unavailable",
      installedPackages: [expect.objectContaining({ ref: "@owner/audit", status: "failed" })],
    });
  });

  it("removes a newly installed plugin when a later package fails", async () => {
    const rollbackIntegrity =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const installPlugin = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second install failed"));
    const uninstallPlugin = vi.fn().mockResolvedValue(undefined);
    const refs = [
      pluginPackageRef("@owner/first", { status: "pending" }),
      pluginPackageRef("@owner/second", { status: "pending" }),
    ];
    const persistPackageRef = vi.fn().mockReturnValueOnce(refs[0]).mockReturnValueOnce(refs[1]);
    const readPackageRefs = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([pluginPackageRef("@owner/first")]);

    await expect(
      installClawPackages(
        plan([
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/first",
            version: "1.0.0",
            integrity: rollbackIntegrity,
          },
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/second",
            version: "1.0.0",
            integrity: rollbackIntegrity,
          },
        ]),
        {
          deps: {
            installPlugin,
            uninstallPlugin,
            probePlugin,
            preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
            persistPackageRef,
            completePackageRef,
            readPackageRefs,
            acquirePackageLease,
            resolvePlugin: vi.fn().mockResolvedValue({
              status: "found",
              pluginId: "first",
              installedVersion: "1.0.0",
              record: {
                source: "clawhub",
                integrity: rollbackIntegrity,
                installedAt: new Date(1_500).toISOString(),
              },
            }),
          },
        },
      ),
    ).rejects.toMatchObject({ code: "package_install_failed", message: "second install failed" });

    expect(uninstallPlugin).toHaveBeenCalledWith(
      "first",
      { force: true, invalidateRuntimeCache: false, clawManaged: true },
      expect.anything(),
    );
    expect(completePackageRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "@owner/first" }),
      "rolled_back",
      expect.anything(),
    );
  });

  it("keeps a newly installed plugin when a direct owner claims it before rollback", async () => {
    const installPlugin = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second install failed"));
    const uninstallPlugin = vi.fn().mockResolvedValue(undefined);
    const refs = [
      pluginPackageRef("@owner/first", { status: "pending" }),
      pluginPackageRef("@owner/second", { status: "pending" }),
    ];

    await expect(
      installClawPackages(
        plan([
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/first",
            version: "1.0.0",
            integrity: pluginIntegrity,
          },
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/second",
            version: "1.0.0",
            integrity: pluginIntegrity,
          },
        ]),
        {
          deps: {
            installPlugin,
            uninstallPlugin,
            probePlugin,
            preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
            persistPackageRef: vi.fn().mockReturnValueOnce(refs[0]).mockReturnValueOnce(refs[1]),
            completePackageRef,
            readPackageRefs: vi
              .fn()
              .mockReturnValueOnce([])
              .mockReturnValueOnce([pluginPackageRef("@owner/first", { independentOwner: true })]),
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "package_rollback_failed",
      message: expect.stringContaining("now has a direct owner"),
    });

    expect(uninstallPlugin).not.toHaveBeenCalled();
  });

  it("preserves the installer error when failure provenance cannot be updated", async () => {
    const pending = {
      kind: "plugin",
      ref: "@owner/audit",
      status: "pending",
      integrity,
    } as PersistedClawPackageRef;
    const failingCompletePackageRef = vi.fn(() => {
      throw new Error("state database unavailable");
    });

    await expect(
      installClawPackages(plan([pluginPackage]), {
        deps: {
          installPlugin: vi.fn().mockRejectedValue(new Error("registry unavailable")),
          probePlugin,
          preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
          persistPackageRef: vi.fn().mockReturnValue(pending),
          completePackageRef: failingCompletePackageRef,
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({
      code: "package_install_failed",
      message: "registry unavailable",
      installedPackages: [pending],
    });
    expect(failingCompletePackageRef).toHaveBeenCalledWith(pending, "failed", expect.anything());
  });

  it("invalidates consent when plugin owner state changes after planning", async () => {
    const installPlugin = vi.fn();
    const persistPackageRef = vi.fn();
    const preflightPlugin = vi.fn().mockResolvedValue({ ok: true, action: "reuse" });

    await expect(
      installClawPackages(plan([pluginPackage]), {
        deps: {
          installPlugin,
          probePlugin,
          preflightPlugin,
          persistPackageRef,
          completePackageRef,
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
    expect(installPlugin).not.toHaveBeenCalled();
    expect(persistPackageRef).not.toHaveBeenCalled();
  });

  it("invalidates consent when a skill trust warning changes after planning", async () => {
    const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const planned = plan([
      {
        kind: "skill",
        source: "clawhub",
        ref: "@owner/triage",
        version: "1.2.3",
        integrity: skillIntegrity,
      },
    ]);
    Object.assign(planned.actions[0]!.details!, { riskWarning: "review warning one" });

    await expect(
      installClawPackages(planned, {
        deps: {
          preflightSkill: vi.fn().mockResolvedValue({
            ok: true,
            action: "install",
            integrity: skillIntegrity,
            warning: "review warning two",
          }),
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
  });

  it("invalidates consent when a plugin trust warning changes after planning", async () => {
    const planned = plan([pluginPackage]);
    Object.assign(planned.actions[0]!.details!, { riskWarning: "review warning one" });

    await expect(
      installClawPackages(planned, {
        deps: {
          probePlugin: vi.fn().mockResolvedValue({
            ok: true,
            pluginId: "audit",
            warning: "review warning two",
            clawhub: { integrity },
          }),
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
  });
});
