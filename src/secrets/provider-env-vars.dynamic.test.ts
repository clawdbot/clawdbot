import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  getProviderEnvVars,
  listKnownProviderAuthEnvVarNames,
  listKnownSecretEnvVarNames,
  PROVIDER_AUTH_ENV_VAR_CANDIDATES,
  PROVIDER_ENV_VARS,
  resolveProviderAuthEnvVarCandidates,
  resolveProviderAuthEvidence,
} from "./provider-env-vars.js";

type MockManifestRegistry = {
  plugins: Array<{
    id: string;
    origin: string;
    kind?: "memory" | "context-engine" | Array<"memory" | "context-engine">;
    providerAuthEnvVars?: Record<string, string[]>;
    providerAuthAliases?: Record<string, string>;
    setup?: {
      providers?: Array<{
        id: string;
        envVars?: string[];
        authEvidence?: Array<{
          type: "local-file-with-env";
          fileEnvVar?: string;
          fallbackPaths?: string[];
          requiresAnyEnv?: string[];
          requiresAllEnv?: string[];
          credentialMarker: string;
          source?: string;
        }>;
      }>;
    };
  }>;
  diagnostics: unknown[];
};

const pluginRegistryMocks = vi.hoisted(() => {
  const loadManifestRegistry = vi.fn<(...args: unknown[]) => MockManifestRegistry>(() => ({
    plugins: [],
    diagnostics: [],
  }));
  return {
    getCurrentPluginMetadataSnapshot: vi.fn(),
    loadPluginManifestRegistryForInstalledIndex: loadManifestRegistry,
    loadPluginManifestRegistryForPluginRegistry: loadManifestRegistry,
    loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
    loadPluginMetadataSnapshot: vi.fn((params: unknown) => {
      const registry = loadManifestRegistry(params) ?? { plugins: [], diagnostics: [] };
      return {
        index: {
          plugins: registry.plugins.map((plugin) => ({
            pluginId: plugin.id,
            origin: plugin.origin,
            enabled: true,
            enabledByDefault: true,
          })),
        },
        plugins: registry.plugins,
      };
    }),
  };
});

function requireLastMetadataSnapshotCall(): unknown[] {
  const calls = pluginRegistryMocks.loadPluginMetadataSnapshot.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected plugin metadata snapshot call");
  }
  return call;
}

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: pluginRegistryMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../plugins/manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex:
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex,
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry:
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry,
  loadPluginRegistrySnapshot: pluginRegistryMocks.loadPluginRegistrySnapshot,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginRegistryMocks.loadPluginMetadataSnapshot,
}));

describe("provider env vars dynamic manifest metadata", () => {
  beforeEach(() => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReset();
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockReset();
    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(undefined);
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockClear();
    __testing.resetProviderEnvVarCachesForTests();
  });

  it("includes later-installed plugin env vars without a bundled generated map", () => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "external-fireworks",
          origin: "global",
          providerAuthEnvVars: {
            fireworks: ["FIREWORKS_ALT_API_KEY"],
          },
          providerAuthAliases: {
            "fireworks-plan": "fireworks",
          },
        },
      ],
      diagnostics: [],
    });

    expect(getProviderEnvVars("fireworks")).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(getProviderEnvVars("fireworks-plan")).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(listKnownProviderAuthEnvVarNames()).toContain("FIREWORKS_ALT_API_KEY");
    expect(listKnownSecretEnvVarNames()).toContain("FIREWORKS_ALT_API_KEY");
  });

  it("includes setup provider env vars without loading setup runtime", () => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "external-model-studio",
          origin: "global",
          setup: {
            providers: [
              {
                id: "model-studio",
                envVars: ["MODEL_STUDIO_API_KEY", "MODEL_STUDIO_API_KEY"],
              },
            ],
          },
        },
      ],
      diagnostics: [],
    });

    expect(getProviderEnvVars("model-studio")).toEqual(["MODEL_STUDIO_API_KEY"]);
    expect(listKnownProviderAuthEnvVarNames()).toContain("MODEL_STUDIO_API_KEY");
    expect(listKnownSecretEnvVarNames()).toContain("MODEL_STUDIO_API_KEY");
  });

  it("includes setup provider auth evidence without loading setup runtime", () => {
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [
        {
          id: "external-cloud",
          origin: "global",
          setup: {
            providers: [
              {
                id: "external-cloud",
                authEvidence: [
                  {
                    type: "local-file-with-env",
                    fileEnvVar: "EXTERNAL_CLOUD_CREDENTIALS",
                    requiresAllEnv: ["EXTERNAL_CLOUD_PROJECT"],
                    credentialMarker: "external-cloud-local-credentials",
                    source: "external cloud credentials",
                  },
                ],
              },
            ],
          },
        },
      ],
      diagnostics: [],
    });

    expect(resolveProviderAuthEvidence()["external-cloud"]).toEqual([
      {
        type: "local-file-with-env",
        fileEnvVar: "EXTERNAL_CLOUD_CREDENTIALS",
        requiresAllEnv: ["EXTERNAL_CLOUD_PROJECT"],
        credentialMarker: "external-cloud-local-credentials",
        source: "external cloud credentials",
      },
    ]);
    const [snapshotOptions] = requireLastMetadataSnapshotCall() as [{ preferPersisted?: boolean }];
    expect(snapshotOptions.preferPersisted).toBe(false);
  });

  it("reuses the current compatible metadata snapshot for workspace auth evidence", () => {
    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockReturnValue({
      index: {
        plugins: [
          {
            pluginId: "external-cloud",
            origin: "global",
            enabled: true,
            enabledByDefault: true,
          },
        ],
      },
      plugins: [
        {
          id: "external-cloud",
          origin: "global",
          setup: {
            providers: [
              {
                id: "external-cloud",
                authEvidence: [
                  {
                    type: "local-file-with-env",
                    fileEnvVar: "EXTERNAL_CLOUD_CREDENTIALS",
                    credentialMarker: "external-cloud-local-credentials",
                  },
                ],
              },
            ],
          },
        },
      ],
    });

    expect(
      resolveProviderAuthEvidence({
        config: {},
        workspaceDir: "/workspace",
      })["external-cloud"],
    ).toEqual([
      {
        type: "local-file-with-env",
        fileEnvVar: "EXTERNAL_CLOUD_CREDENTIALS",
        credentialMarker: "external-cloud-local-credentials",
      },
    ]);
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("does not reuse a load-path current snapshot for default provider env lookups", () => {
    const staleSnapshot = {
      index: {
        plugins: [
          {
            pluginId: "load-path-provider",
            origin: "global",
            enabled: true,
            enabledByDefault: true,
          },
        ],
      },
      plugins: [
        {
          id: "load-path-provider",
          origin: "global",
          providerAuthEnvVars: {
            "load-path-provider": ["LOAD_PATH_PROVIDER_API_KEY"],
          },
        },
      ],
    };
    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockImplementation(
      (params: { config?: unknown; requireDefaultDiscoveryContext?: boolean }) => {
        if (params.config || params.requireDefaultDiscoveryContext) {
          return undefined;
        }
        return staleSnapshot;
      },
    );

    expect(
      resolveProviderAuthEnvVarCandidates({ config: {} })["load-path-provider"],
    ).toBeUndefined();
    expect(pluginRegistryMocks.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
      env: process.env,
      allowWorkspaceScopedSnapshot: true,
      requireDefaultDiscoveryContext: true,
    });
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).toHaveBeenCalled();
  });

  it("excludes untrusted workspace plugin auth evidence by default", () => {
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [
        {
          id: "workspace-cloud",
          origin: "workspace",
          setup: {
            providers: [
              {
                id: "workspace-cloud",
                authEvidence: [
                  {
                    type: "local-file-with-env",
                    fileEnvVar: "WORKSPACE_CLOUD_CREDENTIALS",
                    credentialMarker: "workspace-cloud-local-credentials",
                  },
                ],
              },
            ],
          },
        },
      ],
      diagnostics: [],
    });

    expect(
      resolveProviderAuthEvidence({ config: { plugins: {} } })["workspace-cloud"],
    ).toBeUndefined();
  });

  it("keeps explicitly trusted workspace plugin auth evidence", () => {
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [
        {
          id: "workspace-cloud",
          origin: "workspace",
          setup: {
            providers: [
              {
                id: "workspace-cloud",
                authEvidence: [
                  {
                    type: "local-file-with-env",
                    fileEnvVar: "WORKSPACE_CLOUD_CREDENTIALS",
                    credentialMarker: "workspace-cloud-local-credentials",
                  },
                ],
              },
            ],
          },
        },
      ],
      diagnostics: [],
    });

    expect(
      resolveProviderAuthEvidence({
        config: {
          plugins: {
            allow: ["workspace-cloud"],
          },
        },
      })["workspace-cloud"],
    ).toEqual([
      {
        type: "local-file-with-env",
        fileEnvVar: "WORKSPACE_CLOUD_CREDENTIALS",
        credentialMarker: "workspace-cloud-local-credentials",
      },
    ]);
  });

  it("appends setup provider env vars after explicit provider auth env vars", () => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "external-fireworks",
          origin: "global",
          providerAuthEnvVars: {
            fireworks: ["FIREWORKS_API_KEY"],
          },
          setup: {
            providers: [
              {
                id: "fireworks",
                envVars: ["FIREWORKS_SETUP_KEY", "FIREWORKS_API_KEY"],
              },
            ],
          },
        },
      ],
      diagnostics: [],
    });

    expect(getProviderEnvVars("fireworks")).toEqual(["FIREWORKS_API_KEY", "FIREWORKS_SETUP_KEY"]);
  });

  it("keeps lazy manifest-backed exports cold until accessed and resolves them once", () => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "external-fireworks",
          origin: "global",
          providerAuthEnvVars: {
            fireworks: ["FIREWORKS_ALT_API_KEY"],
          },
        },
      ],
      diagnostics: [],
    });

    expect(pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
    expect(PROVIDER_ENV_VARS.fireworks).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(PROVIDER_AUTH_ENV_VAR_CANDIDATES.fireworks).toEqual(["FIREWORKS_ALT_API_KEY"]);
    const initialLoads =
      pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mock.calls.length;
    expect(initialLoads).toBeGreaterThan(0);

    void PROVIDER_ENV_VARS.fireworks;
    void PROVIDER_AUTH_ENV_VAR_CANDIDATES.fireworks;
    expect(pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(
      initialLoads,
    );
  });

  it("reuses the lazy default lookup cache for repeated provider env var reads", () => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "external-fireworks",
          origin: "global",
          providerAuthEnvVars: {
            fireworks: ["FIREWORKS_ALT_API_KEY"],
          },
        },
      ],
      diagnostics: [],
    });

    expect(getProviderEnvVars("fireworks")).toEqual(["FIREWORKS_ALT_API_KEY"]);
    const initialLoads =
      pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mock.calls.length;
    expect(initialLoads).toBeGreaterThan(0);
    expect(getProviderEnvVars("fireworks")).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(
      initialLoads,
    );
  });

  it("keeps workspace plugin env vars in default lookups", async () => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "workspace-audio",
          origin: "workspace",
          providerAuthEnvVars: {
            whisperx: ["WHISPERX_API_KEY"],
          },
        },
      ],
      diagnostics: [],
    });

    const mod = await import("./provider-env-vars.js");

    expect(mod.getProviderEnvVars("whisperx")).toEqual(["WHISPERX_API_KEY"]);
    expect(mod.listKnownProviderAuthEnvVarNames()).toContain("WHISPERX_API_KEY");
  });

  it("excludes untrusted workspace plugin env vars when requested", async () => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "workspace-audio",
          origin: "workspace",
          providerAuthEnvVars: {
            whisperx: ["AWS_SECRET_ACCESS_KEY"],
          },
          setup: {
            providers: [
              {
                id: "workspace-setup",
                envVars: ["WORKSPACE_SETUP_SECRET"],
              },
            ],
          },
        },
      ],
      diagnostics: [],
    });

    const mod = await import("./provider-env-vars.js");

    expect(
      mod.getProviderEnvVars("whisperx", {
        config: { plugins: {} },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toStrictEqual([]);
    expect(
      mod.getProviderEnvVars("workspace-setup", {
        config: { plugins: {} },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toStrictEqual([]);
    expect(
      mod.listKnownProviderAuthEnvVarNames({
        config: { plugins: {} },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(
      mod.listKnownProviderAuthEnvVarNames({
        config: { plugins: {} },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).not.toContain("WORKSPACE_SETUP_SECRET");
  });

  it("keeps explicitly trusted workspace plugin env vars when requested", async () => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "workspace-audio",
          origin: "workspace",
          providerAuthEnvVars: {
            whisperx: ["WHISPERX_API_KEY"],
          },
        },
      ],
      diagnostics: [],
    });

    const mod = await import("./provider-env-vars.js");

    expect(
      mod.getProviderEnvVars("whisperx", {
        config: {
          plugins: {
            allow: ["workspace-audio"],
          },
        },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toEqual(["WHISPERX_API_KEY"]);
  });

  it("does not trust arbitrary workspace plugin ids from the context engine slot", async () => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "workspace-audio",
          origin: "workspace",
          providerAuthEnvVars: {
            whisperx: ["AWS_SECRET_ACCESS_KEY"],
          },
        },
      ],
      diagnostics: [],
    });

    const mod = await import("./provider-env-vars.js");

    expect(
      mod.getProviderEnvVars("whisperx", {
        config: {
          plugins: {
            slots: {
              contextEngine: "workspace-audio",
            },
          },
        },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toStrictEqual([]);
  });

  it("keeps selected workspace context engine env vars when requested", async () => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "workspace-engine",
          origin: "workspace",
          kind: "context-engine",
          providerAuthEnvVars: {
            whisperx: ["WHISPERX_API_KEY"],
          },
        },
      ],
      diagnostics: [],
    });

    const mod = await import("./provider-env-vars.js");

    expect(
      mod.getProviderEnvVars("whisperx", {
        config: {
          plugins: {
            slots: {
              contextEngine: "workspace-engine",
            },
          },
        },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toEqual(["WHISPERX_API_KEY"]);
  });
});
