// Bundled health check tests cover built-in doctor checks and repair advice.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { ProviderPolicySurface } from "../plugins/provider-policy-surface.js";
import {
  registerBundledHealthChecks,
  resolveBundledHealthCheckPluginStateMode,
} from "./bundled-health-checks.js";

const STATE_DEFERRED_CHECK_ID = "memory-core/managed-local-embedding-setup";

const mocks = vi.hoisted(() => ({
  registerCodexManagedAppServerDoctorChecks: vi.fn(),
  inspectEmbeddingProviderSetup: vi.fn(),
  loadBundledPluginManifestRegistry: vi.fn(
    (): PluginManifestRegistry => ({
      plugins: [],
      diagnostics: [],
    }),
  ),
  loadPluginManifestRegistryForPluginRegistry: vi.fn(() => ({
    plugins: [],
    diagnostics: [],
  })),
  registerCuaDriverDoctorChecks: vi.fn(),
  registerMemoryCoreDoctorChecks: vi.fn(),
  registerPolicyDoctorChecks: vi.fn(),
  registerWorkerProviderDoctorChecks: vi.fn(),
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: vi.fn(
    ({ dirName }: { dirName: string }) =>
      dirName === "crabbox"
        ? { registerWorkerProviderDoctorChecks: mocks.registerWorkerProviderDoctorChecks }
        : null,
  ),
  loadBundledPluginPublicArtifactModuleSync: vi.fn(({ dirName }: { dirName: string }) =>
    dirName === "memory-core"
      ? {
          pluginStateIsolatedDoctorCheckIds: [STATE_DEFERRED_CHECK_ID],
          registerMemoryCoreDoctorChecks: mocks.registerMemoryCoreDoctorChecks,
        }
      : dirName === "cua-computer"
        ? { registerCuaDriverDoctorChecks: mocks.registerCuaDriverDoctorChecks }
        : dirName === "codex"
          ? {
              registerCodexManagedAppServerDoctorChecks:
                mocks.registerCodexManagedAppServerDoctorChecks,
            }
          : { registerPolicyDoctorChecks: mocks.registerPolicyDoctorChecks },
  ),
  resolveProviderPolicySurface: vi.fn((): ProviderPolicySurface | null => ({
    inspectEmbeddingProviderSetup: mocks.inspectEmbeddingProviderSetup,
  })),
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: mocks.loadPluginManifestRegistryForPluginRegistry,
}));
vi.mock("../plugins/manifest-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/manifest-registry.js")>()),
  loadBundledPluginManifestRegistry: mocks.loadBundledPluginManifestRegistry,
}));
vi.mock("../plugins/provider-public-artifacts.js", () => ({
  resolveProviderPolicySurface: mocks.resolveProviderPolicySurface,
}));
vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync:
    mocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync,
  loadBundledPluginPublicArtifactModuleSync: mocks.loadBundledPluginPublicArtifactModuleSync,
}));

let workspaceDir: string;

describe("registerBundledHealthChecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceDir = join(tmpdir(), `bundled-health-${process.pid}-${Date.now()}`);
    mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it.each([
    {
      title: "defers state for an explicitly selected owner-declared check",
      selection: { onlyIds: [STATE_DEFERRED_CHECK_ID] },
      expected: "deferred",
    },
    {
      title: "isolates owner-declared checks included by --all",
      selection: { includeAllChecks: true },
      expected: "isolated",
    },
    {
      title: "isolates mixed explicit selections",
      selection: {
        onlyIds: [STATE_DEFERRED_CHECK_ID, "core/doctor/final-config-validation"],
      },
      expected: "isolated",
    },
    {
      title: "uses direct state for ordinary default selection",
      selection: {},
      expected: "direct",
    },
    {
      title: "uses direct state for an unrelated explicit check",
      selection: { onlyIds: ["core/doctor/final-config-validation"] },
      expected: "direct",
    },
    {
      title: "uses direct state when the selected deferred check is skipped",
      selection: {
        onlyIds: [STATE_DEFERRED_CHECK_ID],
        skipIds: [STATE_DEFERRED_CHECK_ID],
      },
      expected: "direct",
    },
    {
      title: "uses direct state when the deferred check is excluded from --all",
      selection: {
        includeAllChecks: true,
        skipIds: [STATE_DEFERRED_CHECK_ID],
      },
      expected: "direct",
    },
  ] as const)("$title", ({ selection, expected }) => {
    expect(resolveBundledHealthCheckPluginStateMode(selection)).toBe(expected);
    if (selection.onlyIds === undefined && selection.includeAllChecks !== true) {
      expect(mocks.loadBundledPluginPublicArtifactModuleSync).not.toHaveBeenCalled();
    }
  });

  it("always registers passive memory provider readiness without policy opt-in", async () => {
    registerBundledHealthChecks({ cfg: {}, cwd: workspaceDir });

    expect(mocks.loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith({
      dirName: "memory-core",
      artifactBasename: "doctor-health-api.js",
    });
    expect(mocks.loadBundledPluginPublicArtifactModuleSync).not.toHaveBeenCalledWith(
      expect.objectContaining({ dirName: "llama-cpp" }),
    );
    const host = mocks.registerMemoryCoreDoctorChecks.mock.calls[0]?.[0];
    expect(host).toMatchObject({
      getHealthCheck: expect.any(Function),
      registerHealthCheck: expect.any(Function),
      inspectEmbeddingProviderSetup: expect.any(Function),
      memoryCoreActive: true,
    });
    await expect(
      host?.inspectEmbeddingProviderSetup({
        config: {},
        env: process.env,
        agentId: "main",
        provider: "local",
      }),
    ).resolves.toBeUndefined();
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledWith({
      config: {},
      workspaceDir,
      env: process.env,
    });
    expect(mocks.resolveProviderPolicySurface).toHaveBeenCalledWith("local", {
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    expect(mocks.inspectEmbeddingProviderSetup).toHaveBeenCalledWith({
      config: {},
      env: process.env,
      agentId: "main",
      provider: "local",
    });
    expect(mocks.registerPolicyDoctorChecks).not.toHaveBeenCalled();
    expect(mocks.registerCuaDriverDoctorChecks).not.toHaveBeenCalled();
    expect(mocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync).not.toHaveBeenCalled();
  });

  it.each([
    { slots: { memory: "memory-lancedb" } },
    { slots: { memory: "none" } },
    { enabled: false },
    { allow: ["browser"] },
    { deny: ["memory-core"] },
    { entries: { "memory-core": { enabled: false } } },
  ])("keeps the check addressable but inactive when memory-core does not own memory", (plugins) => {
    registerBundledHealthChecks({ cfg: { plugins }, cwd: workspaceDir });

    expect(mocks.registerMemoryCoreDoctorChecks).toHaveBeenCalledWith(
      expect.objectContaining({
        registerHealthCheck: expect.any(Function),
        inspectEmbeddingProviderSetup: expect.any(Function),
        memoryCoreActive: false,
      }),
    );
  });

  it("honors an explicitly selected memory-core slot behind a restrictive allowlist", () => {
    registerBundledHealthChecks({
      cfg: {
        plugins: {
          allow: ["browser"],
          slots: { memory: "memory-core" },
        },
      },
      cwd: workspaceDir,
    });

    expect(mocks.registerMemoryCoreDoctorChecks).toHaveBeenCalledWith(
      expect.objectContaining({
        registerHealthCheck: expect.any(Function),
        inspectEmbeddingProviderSetup: expect.any(Function),
        memoryCoreActive: true,
      }),
    );
  });

  it("returns no inspector when the selected provider exposes no policy surface", async () => {
    mocks.resolveProviderPolicySurface.mockReturnValueOnce(null);
    registerBundledHealthChecks({ cfg: {}, cwd: workspaceDir });

    const host = mocks.registerMemoryCoreDoctorChecks.mock.calls[0]?.[0];
    await expect(
      host?.inspectEmbeddingProviderSetup({
        config: {},
        env: process.env,
        agentId: "main",
        provider: "local",
      }),
    ).resolves.toBeUndefined();
  });

  it("scopes plugin state only while the selected provider setup is inspected", async () => {
    const sourceEnv = { ...process.env, OPENCLAW_STATE_DIR: "/operator/state" };
    const pluginMetadataEnv = {
      ...sourceEnv,
      OPENCLAW_STATE_DIR: "/private/read-only-state",
    };
    let snapshotRuns = 0;
    const runWithPluginStateSnapshot = async <T>(
      run: (env: NodeJS.ProcessEnv) => Promise<T>,
    ): Promise<T> => {
      snapshotRuns += 1;
      return await run(pluginMetadataEnv);
    };
    mocks.inspectEmbeddingProviderSetup.mockResolvedValueOnce(null);

    registerBundledHealthChecks({
      cfg: {},
      cwd: workspaceDir,
      env: sourceEnv,
      runWithPluginStateSnapshot,
    });

    expect(snapshotRuns).toBe(0);
    const host = mocks.registerMemoryCoreDoctorChecks.mock.calls[0]?.[0];
    await expect(
      host?.inspectEmbeddingProviderSetup({
        config: {},
        env: sourceEnv,
        agentId: "main",
        provider: "local",
      }),
    ).resolves.toBeNull();
    expect(snapshotRuns).toBe(1);
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledWith({
      config: {},
      workspaceDir,
      env: pluginMetadataEnv,
    });
    expect(mocks.inspectEmbeddingProviderSetup).toHaveBeenCalledWith({
      config: {},
      env: pluginMetadataEnv,
      agentId: "main",
      provider: "local",
    });
  });

  it("loads bundled policy health checks when policy extension is enabled", () => {
    registerBundledHealthChecks({
      cfg: { plugins: { entries: { policy: { enabled: true } } } },
      cwd: workspaceDir,
    });

    expect(mocks.loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith({
      dirName: "policy",
      artifactBasename: "api.js",
    });
    expect(mocks.registerPolicyDoctorChecks).toHaveBeenCalledWith({
      registerHealthCheck: expect.any(Function),
    });
  });

  it("loads CUA Driver artifact health when the plugin is enabled", () => {
    registerBundledHealthChecks({
      cfg: { plugins: { entries: { "cua-computer": { enabled: true } } } },
      cwd: workspaceDir,
    });

    expect(mocks.loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith({
      dirName: "cua-computer",
      artifactBasename: "api.js",
    });
    expect(mocks.registerCuaDriverDoctorChecks).toHaveBeenCalledWith({
      registerHealthCheck: expect.any(Function),
    });
  });

  it("loads configured worker-provider health through its bundled manifest owner", () => {
    mocks.loadBundledPluginManifestRegistry.mockReturnValueOnce({
      plugins: [
        {
          id: "crabbox",
          origin: "bundled",
          contracts: { workerProviders: ["crabbox"] },
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          rootDir: "/bundled/crabbox",
          source: "/bundled/crabbox/index.js",
          manifestPath: "/bundled/crabbox/openclaw.plugin.json",
        },
      ],
      diagnostics: [],
    });

    registerBundledHealthChecks({
      cfg: { cloudWorkers: { profiles: { aws: { provider: "crabbox" } } } },
      cwd: workspaceDir,
    });

    expect(mocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync).toHaveBeenCalledWith({
      dirName: "crabbox",
      artifactCandidates: ["doctor-health-api.js"],
    });
    expect(mocks.registerWorkerProviderDoctorChecks).toHaveBeenCalledWith({
      registerHealthCheck: expect.any(Function),
    });
  });

  it("does not load health artifacts for a configured provider without a bundled owner", () => {
    registerBundledHealthChecks({
      cfg: { cloudWorkers: { profiles: { development: { provider: "static-ssh" } } } },
      cwd: workspaceDir,
    });

    expect(mocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync).not.toHaveBeenCalled();
    expect(mocks.registerWorkerProviderDoctorChecks).not.toHaveBeenCalled();
  });

  it("loads managed Codex health when an effective model route selects Codex", () => {
    registerBundledHealthChecks({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            models: {
              "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
            },
          },
        },
      },
      cwd: workspaceDir,
    });

    expect(mocks.loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith({
      dirName: "codex",
      artifactBasename: "api.js",
    });
    expect(mocks.registerCodexManagedAppServerDoctorChecks).toHaveBeenCalledWith({
      registerHealthCheck: expect.any(Function),
    });
  });

  it("does not load managed Codex health for OpenClaw routes or disabled Codex", () => {
    for (const cfg of [
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            models: {
              "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      },
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            models: {
              "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
            },
          },
        },
        plugins: { entries: { codex: { enabled: false } } },
      },
    ]) {
      vi.clearAllMocks();
      registerBundledHealthChecks({ cfg, cwd: workspaceDir });
      expect(mocks.loadBundledPluginPublicArtifactModuleSync).not.toHaveBeenCalledWith({
        dirName: "codex",
        artifactBasename: "api.js",
      });
    }
  });

  it("does not use policy.jsonc existence as extension activation", () => {
    writeFileSync(join(workspaceDir, "policy.jsonc"), "{}\n", "utf-8");

    registerBundledHealthChecks({ cfg: {}, cwd: workspaceDir });

    expect(mocks.registerPolicyDoctorChecks).not.toHaveBeenCalled();
  });

  it("honors explicit policy disablement", () => {
    registerBundledHealthChecks({
      cfg: { plugins: { entries: { policy: { enabled: true, config: { enabled: false } } } } },
      cwd: workspaceDir,
    });

    expect(mocks.registerPolicyDoctorChecks).not.toHaveBeenCalled();
  });

  it("honors plugin control-plane disablement for policy checks", () => {
    for (const plugins of [
      { enabled: false, entries: { policy: { enabled: true } } },
      { deny: ["policy"], entries: { policy: { enabled: true } } },
      { allow: ["telegram"], entries: { policy: { enabled: true } } },
    ]) {
      vi.clearAllMocks();

      registerBundledHealthChecks({ cfg: { plugins }, cwd: workspaceDir });

      expect(mocks.registerPolicyDoctorChecks).not.toHaveBeenCalled();
    }
  });
});
