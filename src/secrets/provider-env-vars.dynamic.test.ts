/** Tests dynamic provider env-var discovery from plugin metadata. */
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeEnvVars } from "../agents/sandbox/sanitize-env-vars.js";
import * as pluginConfigState from "../plugins/config-state.js";
import { resolveLocalProviderAuthEvidence } from "./provider-auth-evidence.js";
import {
  getProviderEnvVars,
  listKnownProviderAuthEnvVarNames,
  listKnownSecretEnvVarNames,
  resolveProviderAuthEnvVarCandidates,
  resolveProviderAuthLookupMaps,
} from "./provider-env-vars.js";

type MockManifestPlugin = {
  id: string;
  origin: string;
  enabled?: boolean;
  enabledByDefault?: boolean;
  kind?: "memory" | "context-engine" | Array<"memory" | "context-engine">;
  providers?: string[];
  providerUsageAuthEnvVars?: Record<string, string[]>;
  providerAuthAliases?: Record<string, string>;
  setup?: {
    requiresRuntime?: boolean;
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
};

type MockManifestRegistry = {
  plugins: MockManifestPlugin[];
  diagnostics: unknown[];
};

type MockSetupProvider = NonNullable<NonNullable<MockManifestPlugin["setup"]>["providers"]>[number];

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
      return metadataSnapshot(...registry.plugins);
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

function manifestRegistry(...plugins: MockManifestPlugin[]): MockManifestRegistry {
  return { plugins, diagnostics: [] };
}

function setupPlugin(
  id: string,
  origin: string,
  provider: MockSetupProvider,
  extra: Omit<MockManifestPlugin, "id" | "origin" | "setup"> = {},
): MockManifestPlugin {
  return { id, origin, ...extra, setup: { providers: [provider] } };
}

function metadataSnapshot(...plugins: MockManifestPlugin[]) {
  return {
    index: {
      plugins: plugins.map((plugin) => ({
        pluginId: plugin.id,
        origin: plugin.origin,
        enabled: plugin.enabled ?? true,
        enabledByDefault: plugin.enabledByDefault ?? true,
      })),
    },
    plugins,
  };
}

const LOAD_PATH_PROVIDER_PLUGIN = setupPlugin("load-path-provider", "global", {
  id: "load-path-provider",
  envVars: ["LOAD_PATH_PROVIDER_API_KEY"],
});

function useInstalledPlugins(...plugins: MockManifestPlugin[]): void {
  pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
    manifestRegistry(...plugins),
  );
}

function useInstalledSetupPlugin(
  id: string,
  origin: string,
  provider: MockSetupProvider,
  extra?: Omit<MockManifestPlugin, "id" | "origin" | "setup">,
): void {
  useInstalledPlugins(setupPlugin(id, origin, provider, extra));
}

function useRegistryPlugins(...plugins: MockManifestPlugin[]): void {
  pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue(
    manifestRegistry(...plugins),
  );
}

function useRegistrySetupPlugin(id: string, origin: string, provider: MockSetupProvider): void {
  useRegistryPlugins(setupPlugin(id, origin, provider));
}

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
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
    useInstalledPlugins();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockReset();
    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(undefined);
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockClear();
  });

  it("includes later-installed plugin env vars without a bundled generated map", () => {
    useInstalledSetupPlugin(
      "external-fireworks",
      "global",
      { id: "fireworks", envVars: ["FIREWORKS_ALT_API_KEY"] },
      { providerAuthAliases: { "fireworks-plan": "fireworks" } },
    );

    expect(getProviderEnvVars("fireworks", { config: {} })).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(getProviderEnvVars("fireworks-plan", { config: {} })).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(listKnownProviderAuthEnvVarNames()).toContain("FIREWORKS_ALT_API_KEY");
    expect(listKnownSecretEnvVarNames()).toContain("FIREWORKS_ALT_API_KEY");
  });

  it("scrubs provider usage credentials without making them inference auth candidates", () => {
    useInstalledPlugins({
      id: "provider-billing",
      origin: "global",
      providers: ["provider-billing"],
      providerUsageAuthEnvVars: {
        "provider-billing": ["PROVIDER_BILLING_CREDENTIAL"],
      },
    });

    expect(listKnownProviderAuthEnvVarNames()).toContain("PROVIDER_BILLING_CREDENTIAL");
    expect(listKnownSecretEnvVarNames()).toContain("PROVIDER_BILLING_CREDENTIAL");
    expect(resolveProviderAuthEnvVarCandidates()["provider-billing"]).toBeUndefined();
    expect(getProviderEnvVars("provider-billing")).toStrictEqual([]);
    expect(
      sanitizeEnvVars({ PROVIDER_BILLING_CREDENTIAL: "billing-secret", SAFE_VALUE: "ok" }),
    ).toMatchObject({
      allowed: { SAFE_VALUE: "ok" },
      blocked: ["PROVIDER_BILLING_CREDENTIAL"],
    });
  });

  it("scrubs usage credentials using host metadata rather than the candidate sandbox env", () => {
    const configuredSnapshot = {
      workspaceDir: "/workspace",
      index: {
        plugins: [
          {
            pluginId: "configured-billing",
            origin: "workspace",
            enabled: true,
            enabledByDefault: true,
          },
          {
            pluginId: "disabled-workspace",
            origin: "workspace",
            enabled: false,
            enabledByDefault: false,
          },
        ],
      },
      plugins: [
        {
          id: "configured-billing",
          origin: "workspace",
          providerUsageAuthEnvVars: {
            "configured-billing": ["CONFIGURED_BILLING_CREDENTIAL"],
          },
        },
        {
          id: "disabled-workspace",
          origin: "workspace",
          providerUsageAuthEnvVars: {
            "disabled-workspace": ["PATH"],
          },
        },
      ],
    };
    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockImplementation(
      (params: { env?: NodeJS.ProcessEnv }) =>
        !params.env || params.env === process.env ? configuredSnapshot : undefined,
    );

    expect(
      sanitizeEnvVars({
        CONFIGURED_BILLING_CREDENTIAL: "billing-secret",
        PATH: "/usr/bin",
        SAFE_VALUE: "ok",
      }),
    ).toMatchObject({
      allowed: { PATH: "/usr/bin", SAFE_VALUE: "ok" },
      blocked: ["CONFIGURED_BILLING_CREDENTIAL"],
    });
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("lets openai bootstrap from Codex app-server API-key env", () => {
    expect(resolveProviderAuthEnvVarCandidates()["openai"]).toEqual([
      "CODEX_API_KEY",
      "OPENAI_API_KEY",
    ]);
  });

  it("includes setup provider env vars without loading setup runtime", () => {
    useInstalledSetupPlugin("external-model-studio", "global", {
      id: "model-studio",
      envVars: ["MODEL_STUDIO_API_KEY", "MODEL_STUDIO_API_KEY"],
    });

    expect(getProviderEnvVars("model-studio", { config: {} })).toEqual(["MODEL_STUDIO_API_KEY"]);
    expect(listKnownProviderAuthEnvVarNames()).toContain("MODEL_STUDIO_API_KEY");
    expect(listKnownSecretEnvVarNames()).toContain("MODEL_STUDIO_API_KEY");
  });

  it("includes setup provider auth evidence without loading setup runtime", () => {
    useRegistrySetupPlugin("external-cloud", "global", {
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
    });

    expect(resolveProviderAuthLookupMaps().authEvidenceMap["external-cloud"]).toEqual([
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

  it("expands provider-owned directory variables in manifest credential evidence", () => {
    useRegistrySetupPlugin("external-cloud", "global", {
      id: "external-cloud",
      authEvidence: [
        {
          type: "local-file-with-env",
          fallbackPaths: ["${EXTERNAL_CLOUD_CONFIG}/application_default_credentials.json"],
          requiresAllEnv: ["EXTERNAL_CLOUD_PROJECT"],
          credentialMarker: "external-cloud-local-credentials",
          source: "external cloud credentials",
        },
      ],
    });
    const evidence = resolveProviderAuthLookupMaps().authEvidenceMap["external-cloud"];
    const expectedPath = "/fixture/cloud-sdk/application_default_credentials.json";
    const existsSync = vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return candidate === expectedPath;
    });

    try {
      expect(
        resolveLocalProviderAuthEvidence(evidence, {
          EXTERNAL_CLOUD_CONFIG: "/fixture/cloud-sdk",
          EXTERNAL_CLOUD_PROJECT: "fixture-project",
        }),
      ).toEqual({
        credentialMarker: "external-cloud-local-credentials",
        source: "external cloud credentials",
      });
      expect(existsSync).toHaveBeenCalledWith(expectedPath);
    } finally {
      existsSync.mockRestore();
    }
  });

  it("rejects stale home evidence when an explicit provider directory has no credentials", () => {
    useRegistrySetupPlugin("external-cloud", "global", {
      id: "external-cloud",
      authEvidence: [
        {
          type: "local-file-with-env",
          fallbackPaths: [
            "${EXTERNAL_CLOUD_CONFIG}/credentials.json",
            "${HOME}/credentials.json",
            "${APPDATA}/credentials.json",
          ],
          credentialMarker: "external-cloud-local-credentials",
        },
      ],
    });
    const evidence = resolveProviderAuthLookupMaps().authEvidenceMap["external-cloud"];
    const existsSync = vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return candidate === "/fixture/home/credentials.json";
    });

    try {
      expect(
        resolveLocalProviderAuthEvidence(evidence, {
          EXTERNAL_CLOUD_CONFIG: "/fixture/missing-cloud-sdk",
          HOME: "/fixture/home",
          APPDATA: "/fixture/appdata",
        }),
      ).toBeNull();
      expect(existsSync).toHaveBeenCalledOnce();
      expect(existsSync).toHaveBeenCalledWith("/fixture/missing-cloud-sdk/credentials.json");
    } finally {
      existsSync.mockRestore();
    }
  });

  it("preserves home and appdata fallback when no provider directory is selected", () => {
    const fallbackPaths = [
      "${EXTERNAL_CLOUD_CONFIG}/credentials.json",
      "${HOME}/credentials.json",
      "${APPDATA}/credentials.json",
    ];
    const evidence = [
      {
        type: "local-file-with-env" as const,
        fallbackPaths,
        credentialMarker: "external-cloud-local-credentials",
      },
    ];
    const existsSync = vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return (
        candidate === "/fixture/home/credentials.json" ||
        candidate === "/fixture/appdata/credentials.json"
      );
    });

    try {
      expect(resolveLocalProviderAuthEvidence(evidence, { HOME: "/fixture/home" })).toEqual({
        credentialMarker: "external-cloud-local-credentials",
        source: "local auth evidence",
      });
      expect(
        resolveLocalProviderAuthEvidence(evidence, {
          EXTERNAL_CLOUD_CONFIG: "   ",
          HOME: "/fixture/missing-home",
          APPDATA: "/fixture/appdata",
        }),
      ).toEqual({
        credentialMarker: "external-cloud-local-credentials",
        source: "local auth evidence",
      });
    } finally {
      existsSync.mockRestore();
    }
  });

  it("accepts placeholder text introduced by an environment value", () => {
    const existsSync = vi.spyOn(fs, "existsSync").mockReturnValue(true);

    try {
      expect(
        resolveLocalProviderAuthEvidence(
          [
            {
              type: "local-file-with-env",
              fallbackPaths: ["${EXTERNAL_CLOUD_CONFIG}/credentials.json"],
              credentialMarker: "external-cloud-local-credentials",
            },
          ],
          { EXTERNAL_CLOUD_CONFIG: "/fixture/${literal}" },
        ),
      ).toEqual({
        credentialMarker: "external-cloud-local-credentials",
        source: "local auth evidence",
      });
      expect(existsSync).toHaveBeenCalledWith("/fixture/${literal}/credentials.json");
    } finally {
      existsSync.mockRestore();
    }
  });

  it.each([
    {
      scenario: "missing variable",
      fallbackPath: "${EXTERNAL_CLOUD_CONFIG}/credentials.json",
      env: {},
    },
    {
      scenario: "blank variable",
      fallbackPath: "${EXTERNAL_CLOUD_CONFIG}/credentials.json",
      env: { EXTERNAL_CLOUD_CONFIG: "   " },
    },
    {
      scenario: "invalid variable name",
      fallbackPath: "${EXTERNAL-CLOUD-CONFIG}/credentials.json",
      env: { "EXTERNAL-CLOUD-CONFIG": "/fixture/cloud-sdk" },
    },
    {
      scenario: "unterminated placeholder",
      fallbackPath: "${EXTERNAL_CLOUD_CONFIG/credentials.json",
      env: { EXTERNAL_CLOUD_CONFIG: "/fixture/cloud-sdk" },
    },
  ])("rejects manifest credential evidence with a $scenario", ({ fallbackPath, env }) => {
    const existsSync = vi.spyOn(fs, "existsSync").mockReturnValue(true);

    try {
      expect(
        resolveLocalProviderAuthEvidence(
          [
            {
              type: "local-file-with-env",
              fallbackPaths: [fallbackPath],
              credentialMarker: "external-cloud-local-credentials",
            },
          ],
          env,
        ),
      ).toBeNull();
      expect(existsSync).not.toHaveBeenCalled();
    } finally {
      existsSync.mockRestore();
    }
  });

  it("reuses the current compatible metadata snapshot for workspace auth evidence", () => {
    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(
      metadataSnapshot(
        setupPlugin("external-cloud", "global", {
          id: "external-cloud",
          authEvidence: [
            {
              type: "local-file-with-env",
              fileEnvVar: "EXTERNAL_CLOUD_CREDENTIALS",
              credentialMarker: "external-cloud-local-credentials",
            },
          ],
        }),
      ),
    );

    expect(
      resolveProviderAuthLookupMaps({
        config: {},
        workspaceDir: "/workspace",
      }).authEvidenceMap["external-cloud"],
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
    const staleSnapshot = metadataSnapshot(LOAD_PATH_PROVIDER_PLUGIN);
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
    useRegistrySetupPlugin("workspace-cloud", "workspace", {
      id: "workspace-cloud",
      authEvidence: [
        {
          type: "local-file-with-env",
          fileEnvVar: "WORKSPACE_CLOUD_CREDENTIALS",
          credentialMarker: "workspace-cloud-local-credentials",
        },
      ],
    });

    expect(
      resolveProviderAuthLookupMaps({ config: { plugins: {} } }).authEvidenceMap["workspace-cloud"],
    ).toBeUndefined();
  });

  it("keeps explicitly trusted workspace plugin auth evidence", () => {
    useRegistrySetupPlugin("workspace-cloud", "workspace", {
      id: "workspace-cloud",
      authEvidence: [
        {
          type: "local-file-with-env",
          fileEnvVar: "WORKSPACE_CLOUD_CREDENTIALS",
          credentialMarker: "workspace-cloud-local-credentials",
        },
      ],
    });

    expect(
      resolveProviderAuthLookupMaps({
        config: {
          plugins: {
            allow: ["workspace-cloud"],
          },
        },
      }).authEvidenceMap["workspace-cloud"],
    ).toEqual([
      {
        type: "local-file-with-env",
        fileEnvVar: "WORKSPACE_CLOUD_CREDENTIALS",
        credentialMarker: "workspace-cloud-local-credentials",
      },
    ]);
  });

  it("deduplicates setup provider env vars in declaration order", () => {
    useInstalledSetupPlugin("external-fireworks", "global", {
      id: "fireworks",
      envVars: ["FIREWORKS_API_KEY", "FIREWORKS_SETUP_KEY", "FIREWORKS_API_KEY"],
    });

    expect(getProviderEnvVars("fireworks", { config: {} })).toEqual([
      "FIREWORKS_API_KEY",
      "FIREWORKS_SETUP_KEY",
    ]);
  });

  it("keeps default provider env lookups lazy and cached", async () => {
    useInstalledSetupPlugin("external-fireworks", "global", {
      id: "fireworks",
      envVars: ["FIREWORKS_ALT_API_KEY"],
    });

    vi.resetModules();
    const mod = await import("./provider-env-vars.js");

    expect(pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
    expect(mod.getProviderEnvVars("fireworks")).toEqual(["FIREWORKS_ALT_API_KEY"]);
    const initialLoads =
      pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mock.calls.length;
    expect(initialLoads).toBeGreaterThan(0);
    expect(mod.getProviderEnvVars("fireworks")).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(
      initialLoads,
    );
  });

  it("keeps workspace plugin env vars in default lookups", async () => {
    useInstalledSetupPlugin("workspace-audio", "workspace", {
      id: "whisperx",
      envVars: ["WHISPERX_API_KEY"],
    });

    vi.resetModules();
    const mod = await import("./provider-env-vars.js");

    expect(mod.getProviderEnvVars("whisperx")).toEqual(["WHISPERX_API_KEY"]);
    expect(mod.listKnownProviderAuthEnvVarNames()).toContain("WHISPERX_API_KEY");
  });

  it("excludes untrusted workspace plugin env vars when requested", async () => {
    useInstalledPlugins({
      id: "workspace-audio",
      origin: "workspace",
      setup: {
        providers: [
          {
            id: "whisperx",
            envVars: ["AWS_SECRET_ACCESS_KEY"],
          },
          {
            id: "workspace-setup",
            envVars: ["WORKSPACE_SETUP_SECRET"],
          },
        ],
      },
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
    useInstalledSetupPlugin("workspace-audio", "workspace", {
      id: "whisperx",
      envVars: ["WHISPERX_API_KEY"],
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
    useInstalledSetupPlugin("workspace-audio", "workspace", {
      id: "whisperx",
      envVars: ["AWS_SECRET_ACCESS_KEY"],
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
    useInstalledSetupPlugin(
      "workspace-engine",
      "workspace",
      { id: "whisperx", envVars: ["WHISPERX_API_KEY"] },
      { kind: "context-engine" },
    );

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

  it.each([
    {
      name: "auth candidates",
      resolve: () => resolveProviderAuthEnvVarCandidates({ config: {} }).fireworks,
      metadataLoads: 1,
    },
    {
      name: "auth scrub keys",
      resolve: () =>
        listKnownProviderAuthEnvVarNames({ config: {} }).filter((key) =>
          key.startsWith("FIREWORKS_"),
        ),
      metadataLoads: 2,
    },
  ])("resolves $name without repeated metadata discovery", ({ resolve, metadataLoads }) => {
    useInstalledSetupPlugin(
      "external-fireworks",
      "global",
      { id: "fireworks", envVars: ["FIREWORKS_ALT_API_KEY"] },
      { providerAuthAliases: { "fireworks-plan": "fireworks" } },
    );

    pluginRegistryMocks.loadPluginMetadataSnapshot.mockClear();

    expect(resolve()).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot.mock.calls.length).toBeLessThanOrEqual(
      metadataLoads,
    );
  });

  it("resolves auth maps with policy work bounded to contributing plugins", () => {
    useInstalledPlugins(
      {
        id: "external-fireworks",
        origin: "global",
        providerAuthAliases: {
          "fireworks-plan": "fireworks",
        },
        setup: {
          providers: [
            {
              id: "fireworks",
              envVars: ["FIREWORKS_ALT_API_KEY"],
              authEvidence: [
                {
                  type: "local-file-with-env",
                  fileEnvVar: "FIREWORKS_CREDENTIALS",
                  credentialMarker: "fireworks-local-credentials",
                },
              ],
            },
          ],
        },
      },
      {
        id: "legacy-setup-owner",
        origin: "global",
        providers: ["legacy-cloud"],
        providerAuthAliases: {
          "legacy-cloud-plan": "legacy-cloud",
        },
      },
      { id: "channel-only", origin: "bundled", providers: [] },
      {
        id: "metadata-only",
        origin: "bundled",
        setup: {
          requiresRuntime: false,
          providers: [{ id: "metadata-only", envVars: ["METADATA_ONLY_API_KEY"] }],
        },
      },
    );

    const policy = vi.spyOn(pluginConfigState, "resolveEffectivePluginActivationState");
    let lookupMaps: ReturnType<typeof resolveProviderAuthLookupMaps>;
    try {
      lookupMaps = resolveProviderAuthLookupMaps({ config: {} });
      expect(policy.mock.calls.length).toBeLessThanOrEqual(2);
      expect(policy.mock.calls.map(([{ id }]) => id)).not.toContain("channel-only");
      expect(policy.mock.calls.map(([{ id }]) => id)).not.toContain("metadata-only");
    } finally {
      policy.mockRestore();
    }

    expect(lookupMaps.aliasMap["fireworks-plan"]).toBe("fireworks");
    expect(lookupMaps.envCandidateMap["metadata-only"]).toEqual(["METADATA_ONLY_API_KEY"]);
    expect(lookupMaps.envCandidateMap["fireworks-plan"]).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(lookupMaps.authEvidenceMap["fireworks-plan"]).toEqual([
      {
        type: "local-file-with-env",
        fileEnvVar: "FIREWORKS_CREDENTIALS",
        credentialMarker: "fireworks-local-credentials",
      },
    ]);
    expect(lookupMaps.setupProviderFallbackRefs).toEqual([
      "fireworks",
      "fireworks-plan",
      "legacy-cloud",
      "legacy-cloud-plan",
    ]);
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).toHaveBeenCalledTimes(1);
  });

  it("updates runtime auth evidence and fallback refs without dropping disabled credential hints", () => {
    const plugin = setupPlugin(
      "disabled-setup-owner",
      "global",
      {
        id: "disabled-cloud",
        envVars: ["DISABLED_CLOUD_API_KEY"],
        authEvidence: [{ type: "local-file-with-env", credentialMarker: "cloud-local" }],
      },
      {
        enabled: false,
        providers: ["disabled-cloud"],
        providerAuthAliases: {
          "disabled-cloud-plan": "disabled-cloud",
        },
      },
    );

    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(metadataSnapshot(plugin));
    const config = { plugins: { entries: { "disabled-setup-owner": { enabled: false } } } };
    for (const enabled of [false, true, false]) {
      config.plugins.entries["disabled-setup-owner"].enabled = enabled;
      const lookupMaps = resolveProviderAuthLookupMaps({ config });
      expect(lookupMaps.setupProviderFallbackRefs).toEqual(
        enabled ? ["disabled-cloud", "disabled-cloud-plan"] : [],
      );
      expect(lookupMaps.authEvidenceMap["disabled-cloud-plan"]).toEqual(
        enabled ? plugin.setup?.providers?.[0]?.authEvidence : undefined,
      );
      expect(lookupMaps.envCandidateMap["disabled-cloud-plan"]).toEqual(["DISABLED_CLOUD_API_KEY"]);
    }
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("preserves alias-chain expansion order and ownership of lookup results", () => {
    const evidence = {
      type: "local-file-with-env" as const,
      fileEnvVar: "BASE_CREDENTIALS",
      credentialMarker: "base-local-credentials",
    };
    useInstalledPlugins(
      setupPlugin("base-owner", "global", {
        id: "base",
        envVars: ["BASE_API_KEY"],
        authEvidence: [evidence],
      }),
      { id: "first-alias", origin: "global", providerAuthAliases: { z: "base" } },
      { id: "second-alias", origin: "global", providerAuthAliases: { a: "z" } },
      { id: "third-alias", origin: "global", providerAuthAliases: { b: "a" } },
    );

    const first = resolveProviderAuthLookupMaps({ config: {} });
    expect(Object.keys(first.aliasMap)).toEqual(["z", "a", "b"]);
    expect(first.aliasMap).toEqual({ z: "base", a: "z", b: "a" });
    expect(Object.getPrototypeOf(first.aliasMap)).toBeNull();
    expect(first.envCandidateMap.base).toEqual(["BASE_API_KEY"]);
    expect(first.envCandidateMap.z).toEqual(["BASE_API_KEY"]);
    expect(first.envCandidateMap.a).toBeUndefined();
    expect(first.envCandidateMap.b).toBeUndefined();
    expect(first.authEvidenceMap).toEqual({ base: [evidence], z: [evidence] });
    expect(first.authEvidenceMap.z?.[0]).toBe(evidence);
    expect(first.setupProviderFallbackRefs).toEqual(["a", "b", "base", "z"]);

    const second = resolveProviderAuthLookupMaps({ config: {} });
    expect(second).toEqual(first);
    expect(second.aliasMap).not.toBe(first.aliasMap);
    expect(second.envCandidateMap).not.toBe(first.envCandidateMap);
    expect(second.envCandidateMap.z).not.toBe(first.envCandidateMap.z);
    expect(second.authEvidenceMap).not.toBe(first.authEvidenceMap);
    expect(second.authEvidenceMap.z).not.toBe(first.authEvidenceMap.z);
    expect(second.authEvidenceMap.z?.[0]).toBe(evidence);
    expect(second.setupProviderFallbackRefs).not.toBe(first.setupProviderFallbackRefs);
    expect(second.envCandidateMap.openai).toBe(first.envCandidateMap.openai);
  });

  it("does not reuse a load-path current snapshot for default provider env lookups without parameters", () => {
    const staleSnapshot = metadataSnapshot(LOAD_PATH_PROVIDER_PLUGIN);
    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockImplementation(
      (params: { config?: unknown; requireDefaultDiscoveryContext?: boolean }) => {
        if (params.config || params.requireDefaultDiscoveryContext) {
          return undefined;
        }
        return staleSnapshot;
      },
    );

    expect(resolveProviderAuthEnvVarCandidates()["load-path-provider"]).toBeUndefined();
    expect(pluginRegistryMocks.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
      env: process.env,
      allowWorkspaceScopedSnapshot: true,
      requireDefaultDiscoveryContext: true,
    });
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).toHaveBeenCalled();
  });
});
