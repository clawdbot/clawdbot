// Bundled health check tests cover built-in doctor checks and repair advice.
import { linkSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { MissingPublicSurfaceError } from "../plugin-sdk/facade-loader.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import type { ProviderPolicySurface } from "../plugins/provider-policy-surface.js";
import {
  registerBundledHealthChecks,
  resolveBundledHealthCheckPluginStateMode,
} from "./bundled-health-checks.js";
import { clearHealthChecksForTest, getHealthCheck } from "./health-check-registry.js";

const STATE_DEFERRED_CHECK_ID = "memory-core/managed-local-embedding-setup";

const mocks = vi.hoisted(() => ({
  registerCodexManagedAppServerDoctorChecks: vi.fn(() => {
    throw new Error("Unable to resolve bundled plugin public surface codex/api.js");
  }),
  inspectEmbeddingProviderSetup: vi.fn(),
  loadBundledPluginManifestRegistry: vi.fn(
    (): PluginManifestRegistry => ({
      plugins: [],
      diagnostics: [],
    }),
  ),
  loadPluginManifestRegistryForPluginRegistry: vi.fn(
    (): PluginManifestRegistry => ({
      plugins: [],
      diagnostics: [],
    }),
  ),
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
          ? mocks.registerCodexManagedAppServerDoctorChecks()
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
vi.mock("../plugins/public-surface-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/public-surface-loader.js")>()),
  loadBundledPluginPublicArtifactModuleFromCandidatesSync:
    mocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync,
  loadBundledPluginPublicArtifactModuleSync: mocks.loadBundledPluginPublicArtifactModuleSync,
}));

let workspaceDir: string;

describe("registerBundledHealthChecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    workspaceDir = join(tmpdir(), `bundled-health-${process.pid}-${Date.now()}`);
    mkdirSync(workspaceDir, { recursive: true });
    workspaceDir = realpathSync(workspaceDir);
  });

  afterEach(() => {
    clearHealthChecksForTest();
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
      title: "isolates checks selected by the post-plugin update gate",
      selection: { updateReadiness: "post-plugin" },
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
      getHealthCheck: expect.any(Function),
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

  const codexConfig: OpenClawConfig = {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.6-sol" },
        models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
      },
    },
  };

  function codexRecord(
    origin: "bundled" | "global",
    trustedOfficialInstall?: boolean,
    healthChecks = true,
  ) {
    const manifestPath = join(workspaceDir, "openclaw.plugin.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        id: "codex",
        configSchema: {},
        ...(healthChecks ? { doctorHealthChecks: true } : {}),
      }),
    );
    const loaded = loadPluginManifest(workspaceDir);
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    return {
      id: "codex",
      origin,
      trustedOfficialInstall,
      rootDir: workspaceDir,
      source: join(workspaceDir, "index.js"),
      manifestPath,
      doctorHealthChecks: loaded.manifest.doctorHealthChecks,
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      contracts: {},
    } satisfies PluginManifestRegistry["plugins"][number];
  }

  it("continues other health checks for a retained stable Codex without a health API", () => {
    // Published @openclaw/codex@2026.7.1-1 has neither a health declaration nor api.js.
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [codexRecord("global", true, false)],
      diagnostics: [],
    });

    registerBundledHealthChecks({
      cfg: { ...codexConfig, plugins: { entries: { policy: { enabled: true } } } },
      cwd: workspaceDir,
    });

    expect(mocks.registerMemoryCoreDoctorChecks).toHaveBeenCalledOnce();
    expect(mocks.registerPolicyDoctorChecks).toHaveBeenCalledOnce();
    expect(getHealthCheck("codex/managed-app-server")).toBeUndefined();
    expect(mocks.registerCodexManagedAppServerDoctorChecks).not.toHaveBeenCalled();
  });

  it.each(["bundled", "global"] as const)(
    "registers and runs health from the selected %s Codex public artifact",
    async (origin) => {
      mkdirSync(join(workspaceDir, "dist"));
      writeFileSync(
        join(workspaceDir, "dist", "api.js"),
        `
        module.exports.registerCodexManagedAppServerDoctorChecks = (host) => {
          if (!host.getHealthCheck("codex/managed-app-server")) {
            host.registerHealthCheck({
              id: "codex/managed-app-server", kind: "plugin", source: "codex",
              description: "Selected artifact check", detect: async () => [],
            });
          }
        };
      `,
      );
      if (origin === "bundled") {
        linkSync(join(workspaceDir, "dist", "api.js"), join(workspaceDir, "api-copy.js"));
      }
      mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
        plugins: [codexRecord(origin, origin === "global")],
        diagnostics: [],
      });
      const env = { ...process.env, OPENCLAW_STATE_DIR: join(workspaceDir, "state") };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        registerBundledHealthChecks({ cfg: codexConfig, cwd: workspaceDir, env });
      }
      const check = getHealthCheck("codex/managed-app-server");
      expect(check?.description).toBe("Selected artifact check");
      await expect(
        check?.detect({
          cfg: codexConfig,
          env,
          mode: "lint",
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        }),
      ).resolves.toEqual([]);
      expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledWith({
        config: codexConfig,
        workspaceDir,
        env,
        pluginIds: ["codex"],
      });
      expect(mocks.registerCodexManagedAppServerDoctorChecks).not.toHaveBeenCalled();
    },
  );

  it.each([
    "missing",
    "untrusted",
    "untrusted-legacy",
    "missing-api",
    "missing-export",
    "broken-api",
  ])("fails visibly for a selected Codex install with %s state", (state) => {
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins:
        state === "missing"
          ? []
          : [codexRecord("global", !state.startsWith("untrusted"), state !== "untrusted-legacy")],
      diagnostics: [],
    });
    if (state === "untrusted") {
      writeFileSync(
        join(workspaceDir, "api.js"),
        'throw new Error("untrusted artifact executed");',
      );
    }
    if (state === "missing-export") {
      writeFileSync(join(workspaceDir, "api.js"), "module.exports = {};");
    }
    if (state === "broken-api") {
      writeFileSync(join(workspaceDir, "api.js"), 'throw new Error("selected artifact failed");');
    }
    expect(() => registerBundledHealthChecks({ cfg: codexConfig, cwd: workspaceDir })).toThrow(
      state === "broken-api"
        ? "selected artifact failed"
        : state === "missing-export"
          ? TypeError
          : MissingPublicSurfaceError,
    );
    expect(getHealthCheck("codex/managed-app-server")).toBeUndefined();
    expect(mocks.registerCodexManagedAppServerDoctorChecks).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: false },
    { entries: { codex: { enabled: false } } },
    { deny: ["codex"] },
    { allow: ["telegram"] },
  ])("preserves Codex owner policy without loading plugin code: %j", (plugins) => {
    registerBundledHealthChecks({ cfg: { ...codexConfig, plugins }, cwd: workspaceDir });
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).not.toHaveBeenCalled();
    expect(mocks.registerCodexManagedAppServerDoctorChecks).not.toHaveBeenCalled();
  });

  it("does not load managed Codex health for an OpenClaw route", () => {
    registerBundledHealthChecks({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } } },
          },
        },
      },
      cwd: workspaceDir,
    });
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).not.toHaveBeenCalled();
    expect(mocks.registerCodexManagedAppServerDoctorChecks).not.toHaveBeenCalled();
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
