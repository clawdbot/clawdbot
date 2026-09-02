// Covers provider install catalog entries from plugin metadata.
import { beforeEach, describe, expect, it, vi } from "vitest";

type LoadPluginRegistrySnapshot = typeof import("./plugin-registry.js").loadPluginRegistrySnapshot;
type ResolveManifestProviderAuthChoices =
  typeof import("./provider-auth-choices.js").resolveManifestProviderAuthChoices;
type ListOfficialExternalPluginCatalogEntries =
  typeof import("./official-external-plugin-catalog.js").listOfficialExternalPluginCatalogEntries;
type PluginInstallSourceInfo = import("./install-source-info.js").PluginInstallSourceInfo;
type InstalledPluginInstallRecordInfo =
  import("./installed-plugin-index.js").InstalledPluginInstallRecordInfo;
type InstalledPluginIndexRecord = import("./installed-plugin-index.js").InstalledPluginIndexRecord;

const loadPluginRegistrySnapshot = vi.hoisted(() =>
  vi.fn<LoadPluginRegistrySnapshot>(() => ({
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 0,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  })),
);
vi.mock("./plugin-registry.js", () => ({
  loadPluginRegistrySnapshot,
}));

const resolveManifestProviderAuthChoices = vi.hoisted(() =>
  vi.fn<ResolveManifestProviderAuthChoices>(() => []),
);
vi.mock("./provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices,
}));

const loadHostedCatalog = vi.hoisted(() => vi.fn());
const remoteProvider = vi.hoisted(() => vi.fn(() => undefined));
vi.mock("../model-catalog/remote-overlay.js", () => ({
  getRemoteModelCatalogProviderOverlay: remoteProvider,
}));

const listOfficialExternalPluginCatalogEntries = vi.hoisted(() =>
  vi.fn<ListOfficialExternalPluginCatalogEntries>(() => []),
);
vi.mock("./official-external-plugin-catalog.js", async () => {
  const actual = await vi.importActual<typeof import("./official-external-plugin-catalog.js")>(
    "./official-external-plugin-catalog.js",
  );
  return {
    ...actual,
    listOfficialExternalPluginCatalogEntries,
    loadConfiguredHostedOfficialExternalPluginCatalogEntries: loadHostedCatalog,
  };
});

import { resetPluginCache } from "./plugin-cache.js";
import {
  loadProviderSetupAuthChoices,
  resolveDeprecatedProviderInstallCatalogEntry,
  resolveProviderInstallCatalogEntries,
  resolveProviderInstallCatalogEntry,
} from "./provider-install-catalog.js";

function registrySnapshot(
  overrides: {
    installRecords?: Record<string, InstalledPluginInstallRecordInfo>;
    plugins?: InstalledPluginIndexRecord[];
  } = {},
) {
  return {
    version: 1 as const,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1 as const,
    policyHash: "test",
    generatedAtMs: 0,
    installRecords: overrides.installRecords ?? {},
    plugins: overrides.plugins ?? [],
    diagnostics: [],
  };
}

function vllmPluginWithPackageInstall(): InstalledPluginIndexRecord {
  return {
    pluginId: "vllm",
    origin: "global",
    manifestPath: "/Users/test/.openclaw/plugins/vllm/openclaw.plugin.json",
    manifestHash: "hash",
    rootDir: "/Users/test/.openclaw/plugins/vllm",
    enabled: true,
    startup: {
      sidecar: false,
      memory: false,
      agentHarnesses: [],
    },
    compat: [],
    packageName: "@openclaw/vllm",
    packageInstall: {
      npm: {
        spec: "@openclaw/vllm-fork@1.0.0",
        packageName: "@openclaw/vllm-fork",
        selector: "1.0.0",
        selectorKind: "exact-version",
        exactVersion: true,
        expectedIntegrity: "sha512-old",
        pinState: "exact-with-integrity",
      },
      warnings: [],
    },
  };
}

function mockVllmAuthChoice() {
  resolveManifestProviderAuthChoices.mockReturnValue([
    {
      pluginId: "vllm",
      providerId: "vllm",
      methodId: "server",
      choiceId: "vllm",
      choiceLabel: "vLLM",
      groupLabel: "vLLM",
    },
  ]);
}

describe("provider install catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    remoteProvider.mockReturnValue(undefined);
    resetPluginCache();
    loadPluginRegistrySnapshot.mockReturnValue({
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 0,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    });
    resolveManifestProviderAuthChoices.mockReturnValue([]);
    listOfficialExternalPluginCatalogEntries.mockReturnValue([]);
  });

  it("merges manifest auth-choice metadata with registry install metadata", () => {
    loadPluginRegistrySnapshot.mockReturnValue({
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 0,
      installRecords: {},
      plugins: [
        {
          pluginId: "openai",
          origin: "bundled",
          manifestPath: "/repo/extensions/openai/openclaw.plugin.json",
          manifestHash: "hash",
          rootDir: "/repo/extensions/openai",
          enabled: true,
          startup: {
            sidecar: false,
            memory: false,
            agentHarnesses: [],
          },
          compat: [],
          packageName: "@openclaw/openai",
          packageInstall: {
            defaultChoice: "npm",
            npm: {
              spec: "@openclaw/openai@1.2.3",
              packageName: "@openclaw/openai",
              selector: "1.2.3",
              selectorKind: "exact-version",
              exactVersion: true,
              expectedIntegrity: "sha512-openai",
              pinState: "exact-with-integrity",
            },
            local: {
              path: "extensions/openai",
            },
            warnings: [],
          },
        },
      ],
      diagnostics: [],
    });
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        groupId: "openai",
        groupLabel: "OpenAI",
      },
    ]);

    expect(resolveProviderInstallCatalogEntries()).toEqual([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        groupId: "openai",
        groupLabel: "OpenAI",
        label: "OpenAI",
        origin: "bundled",
        install: {
          npmSpec: "@openclaw/openai@1.2.3",
          localPath: "extensions/openai",
          defaultChoice: "npm",
          expectedIntegrity: "sha512-openai",
        },
        installSource: {
          defaultChoice: "npm",
          npm: {
            spec: "@openclaw/openai@1.2.3",
            packageName: "@openclaw/openai",
            selector: "1.2.3",
            selectorKind: "exact-version",
            exactVersion: true,
            expectedIntegrity: "sha512-openai",
            pinState: "exact-with-integrity",
          },
          local: {
            path: "extensions/openai",
          },
          warnings: [],
        },
      },
    ]);
  });

  it("prefers durable install records over package-authored install intent", () => {
    loadPluginRegistrySnapshot.mockReturnValue(
      registrySnapshot({
        installRecords: {
          vllm: {
            source: "npm",
            spec: "@openclaw/vllm",
            resolvedSpec: "@openclaw/vllm@2.0.0",
            integrity: "sha512-vllm",
          },
        },
        plugins: [vllmPluginWithPackageInstall()],
      }),
    );
    mockVllmAuthChoice();

    expect(resolveProviderInstallCatalogEntry("vllm")).toEqual({
      pluginId: "vllm",
      providerId: "vllm",
      methodId: "server",
      choiceId: "vllm",
      choiceLabel: "vLLM",
      groupLabel: "vLLM",
      label: "vLLM",
      origin: "global",
      install: {
        npmSpec: "@openclaw/vllm@2.0.0",
        expectedIntegrity: "sha512-vllm",
        defaultChoice: "npm",
      },
      installSource: {
        defaultChoice: "npm",
        npm: {
          spec: "@openclaw/vllm@2.0.0",
          packageName: "@openclaw/vllm",
          selector: "2.0.0",
          selectorKind: "exact-version",
          exactVersion: true,
          expectedIntegrity: "sha512-vllm",
          pinState: "exact-with-integrity",
        },
        warnings: [],
      },
    });
  });

  it("preserves durable ClawHub install records for provider setup reinstall hints", () => {
    loadPluginRegistrySnapshot.mockReturnValue(
      registrySnapshot({
        installRecords: {
          vllm: {
            source: "clawhub",
            spec: "clawhub:openclaw/vllm@2026.5.2",
            integrity: "sha256-clawpack",
            clawhubPackage: "openclaw/vllm",
          },
        },
        plugins: [vllmPluginWithPackageInstall()],
      }),
    );
    mockVllmAuthChoice();

    expect(resolveProviderInstallCatalogEntry("vllm")).toEqual({
      pluginId: "vllm",
      providerId: "vllm",
      methodId: "server",
      choiceId: "vllm",
      choiceLabel: "vLLM",
      groupLabel: "vLLM",
      label: "vLLM",
      origin: "global",
      install: {
        clawhubSpec: "clawhub:openclaw/vllm@2026.5.2",
        defaultChoice: "clawhub",
      },
      installSource: {
        defaultChoice: "clawhub",
        clawhub: {
          spec: "clawhub:openclaw/vllm@2026.5.2",
          packageName: "openclaw/vllm",
          version: "2026.5.2",
          exactVersion: true,
        },
        warnings: [],
      },
    });
  });

  it("does not expose untrusted global package install intent without an install record", () => {
    loadPluginRegistrySnapshot.mockReturnValue({
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 0,
      installRecords: {},
      plugins: [
        {
          pluginId: "demo-provider",
          origin: "global",
          manifestPath: "/Users/test/.openclaw/plugins/demo-provider/openclaw.plugin.json",
          manifestHash: "hash",
          rootDir: "/Users/test/.openclaw/plugins/demo-provider",
          enabled: true,
          startup: {
            sidecar: false,
            memory: false,
            agentHarnesses: [],
          },
          compat: [],
          packageName: "@vendor/demo-provider",
          packageInstall: {
            npm: {
              spec: "@vendor/demo-provider@1.2.3",
              packageName: "@vendor/demo-provider",
              selector: "1.2.3",
              selectorKind: "exact-version",
              exactVersion: true,
              expectedIntegrity: "sha512-demo",
              pinState: "exact-with-integrity",
            },
            warnings: [],
          },
        },
      ],
      diagnostics: [],
    });
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "demo-provider",
        providerId: "demo-provider",
        methodId: "api-key",
        choiceId: "demo-provider-api-key",
        choiceLabel: "Demo Provider API key",
      },
    ]);

    expect(resolveProviderInstallCatalogEntries()).toStrictEqual([]);
  });

  it("ignores malformed persisted package install metadata", () => {
    loadPluginRegistrySnapshot.mockReturnValue({
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 0,
      installRecords: {},
      plugins: [
        {
          pluginId: "openai",
          origin: "bundled",
          manifestPath: "/repo/extensions/openai/openclaw.plugin.json",
          manifestHash: "hash",
          rootDir: "/repo/extensions/openai",
          enabled: true,
          startup: {
            sidecar: false,
            memory: false,
            agentHarnesses: [],
          },
          compat: [],
          packageName: "@openclaw/openai",
          packageInstall: {
            defaultChoice: "npm",
            npm: {
              spec: 12,
              packageName: "@openclaw/openai",
              selectorKind: "exact-version",
              exactVersion: true,
              pinState: "exact-with-integrity",
            },
            warnings: [],
          } as unknown as PluginInstallSourceInfo,
        },
      ],
      diagnostics: [],
    });
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
      },
    ]);

    expect(resolveProviderInstallCatalogEntries()).toStrictEqual([]);
  });

  it("skips untrusted workspace package install metadata when the plugin is disabled", () => {
    loadPluginRegistrySnapshot.mockReturnValue({
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 0,
      installRecords: {},
      plugins: [
        {
          pluginId: "demo-provider",
          origin: "workspace",
          manifestPath: "/repo/extensions/demo-provider/openclaw.plugin.json",
          manifestHash: "hash",
          rootDir: "/repo/extensions/demo-provider",
          enabled: false,
          startup: {
            sidecar: false,
            memory: false,
            agentHarnesses: [],
          },
          compat: [],
          packageInstall: {
            local: {
              path: "extensions/demo-provider",
            },
            warnings: [],
          },
        },
      ],
      diagnostics: [],
    });
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "demo-provider",
        providerId: "demo-provider",
        methodId: "api-key",
        choiceId: "demo-provider-api-key",
        choiceLabel: "Demo Provider API key",
      },
    ]);

    expect(
      resolveProviderInstallCatalogEntries({
        config: {
          plugins: {
            enabled: false,
          },
        },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toStrictEqual([]);
  });

  it("surfaces official external provider install metadata when the provider plugin is not installed", () => {
    listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        name: "@openclaw/codex",
        source: "official",
        kind: "provider",
        openclaw: {
          plugin: { id: "codex", label: "Codex" },
          providers: [
            {
              id: "codex",
              name: "Codex",
              authChoices: [
                {
                  method: "app-server",
                  choiceId: "codex",
                  choiceLabel: "Codex app-server",
                  choiceHint: "Use the Codex app-server runtime.",
                  groupId: "codex",
                  groupLabel: "Codex",
                  onboardingScopes: ["text-inference"],
                },
              ],
            },
          ],
          install: {
            npmSpec: "@openclaw/codex",
            defaultChoice: "npm",
          },
        },
      },
    ]);

    expect(resolveProviderInstallCatalogEntry("codex")).toEqual({
      pluginId: "codex",
      providerId: "codex",
      methodId: "app-server",
      choiceId: "codex",
      choiceLabel: "Codex app-server",
      choiceHint: "Use the Codex app-server runtime.",
      groupId: "codex",
      groupLabel: "Codex",
      onboardingScopes: ["text-inference"],
      label: "Codex",
      origin: "bundled",
      install: {
        npmSpec: "@openclaw/codex",
        defaultChoice: "npm",
      },
      installSource: {
        defaultChoice: "npm",
        npm: {
          spec: "@openclaw/codex",
          packageName: "@openclaw/codex",
          selectorKind: "none",
          exactVersion: false,
          pinState: "floating-without-integrity",
        },
        warnings: ["npm-spec-floating", "npm-spec-missing-integrity"],
      },
    });
  });

  it("preserves official external provider aliases for configured-plugin repair", () => {
    listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        name: "@openclaw/gmi-provider",
        source: "official",
        kind: "provider",
        openclaw: {
          plugin: { id: "gmi", label: "GMI Cloud" },
          providers: [
            {
              id: "gmi",
              aliases: ["gmi-cloud", "gmicloud"],
              name: "GMI Cloud",
              authChoices: [
                {
                  method: "api-key",
                  choiceId: "gmi-api-key",
                  choiceLabel: "GMI Cloud API key",
                },
              ],
            },
          ],
          install: {
            npmSpec: "@openclaw/gmi-provider",
            defaultChoice: "npm",
          },
        },
      },
    ]);

    expect(resolveProviderInstallCatalogEntry("gmi-api-key")).toMatchObject({
      pluginId: "gmi",
      providerId: "gmi",
      providerAliases: ["gmi-cloud", "gmicloud"],
    });
  });

  it("projects manual setup hints without enabling catalog-authored discovery", () => {
    listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        name: "@vendor/dynamic-provider",
        source: "official",
        kind: "provider",
        openclaw: {
          plugin: { id: "dynamic-provider", label: "Dynamic Provider" },
          providers: [
            {
              id: "dynamic",
              authChoices: [
                {
                  method: "api-key",
                  choiceId: "dynamic-connect",
                  choiceLabel: "Dynamic Provider API key",
                  appGuidedSecret: true,
                  appGuidedDiscovery: true,
                  icon: "https://provider.example/icon.svg",
                  website: "https://provider.example/",
                },
              ],
            },
          ],
          install: { npmSpec: "@vendor/dynamic-provider@1.0.0", defaultChoice: "npm" },
        },
      } as unknown as ReturnType<ListOfficialExternalPluginCatalogEntries>[number],
    ]);

    const choice = resolveProviderInstallCatalogEntry("dynamic-connect");

    expect(choice).toMatchObject({
      appGuidedSecret: true,
      icon: "https://provider.example/icon.svg",
      website: "https://provider.example/",
    });
    expect(choice?.appGuidedDiscovery).toBeUndefined();
  });

  it.each([null, 3, { id: 3 }, { id: "broken", authChoices: [null, { method: 3 }] }])(
    "ignores malformed provider metadata without losing a valid sibling: %j",
    (malformed) => {
      listOfficialExternalPluginCatalogEntries.mockReturnValue([
        {
          name: "@vendor/dynamic-provider",
          source: "official",
          kind: "provider",
          openclaw: {
            plugin: { id: "dynamic-provider", label: "Dynamic Provider" },
            providers: [
              malformed,
              {
                id: "dynamic",
                authChoices: [
                  { method: "api-key", choiceId: "dynamic-connect", choiceLabel: "Connect" },
                ],
              },
            ],
            install: { npmSpec: "@vendor/dynamic-provider@1.0.0", defaultChoice: "npm" },
          },
        } as unknown as ReturnType<ListOfficialExternalPluginCatalogEntries>[number],
      ]);

      expect(resolveProviderInstallCatalogEntries().map((entry) => entry.choiceId)).toEqual([
        "dynamic-connect",
      ]);
    },
  );

  it("resolves deprecated official external auth choices before their plugin is installed", () => {
    listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        name: "@openclaw/qwen-provider",
        source: "official",
        kind: "provider",
        openclaw: {
          plugin: { id: "qwen", label: "Qwen Cloud" },
          providers: [
            {
              id: "qwen",
              name: "Qwen Cloud",
              authChoices: [
                {
                  method: "api-key",
                  choiceId: "qwen-api-key",
                  deprecatedChoiceIds: ["modelstudio-api-key"],
                  choiceLabel: "Qwen Cloud API key",
                },
              ],
            },
          ],
          install: {
            npmSpec: "@openclaw/qwen-provider",
            defaultChoice: "npm",
          },
        },
      },
    ]);

    expect(resolveDeprecatedProviderInstallCatalogEntry("modelstudio-api-key")).toMatchObject({
      pluginId: "qwen",
      choiceId: "qwen-api-key",
    });
  });

  it("shares a prepared hosted snapshot and offers exact installs without runtime model authority", async () => {
    const methodId = "project key@v1";
    const choiceId = "_connect/dynamic:key@v1";
    const entry = {
      type: "plugin",
      id: "@vendor/dynamic-provider",
      title: "Dynamic Provider",
      state: "available",
      publisher: { id: "vendor", trust: "official" },
      install: {
        candidates: [
          {
            sourceRef: "public-clawhub",
            package: "@vendor/dynamic-provider",
            version: "1.2.3",
            integrity: `sha256:${"a".repeat(64)}`,
          },
        ],
      },
      openclaw: {
        plugin: { id: "dynamic-provider", label: "Dynamic Provider" },
        providers: [
          {
            id: "dynamic",
            authChoices: [
              {
                method: methodId,
                choiceId,
                choiceLabel: "Dynamic Provider",
                appGuidedSecret: true,
              },
            ],
          },
        ],
        modelCatalog: {
          providers: {
            dynamic: {
              defaultModel: "@vendor/latest",
              models: [{ id: "@vendor/latest", name: "Latest model" }],
              baseUrl: "https://ignored.example",
              apiKey: "fixture-only",
            },
          },
        },
      },
    };
    loadHostedCatalog.mockResolvedValue({ source: "hosted", entries: [entry] });

    expect(resolveProviderInstallCatalogEntry(choiceId)).toBeUndefined();
    await loadProviderSetupAuthChoices();
    await loadProviderSetupAuthChoices();
    const choice = resolveProviderInstallCatalogEntry(choiceId);
    expect(choice).toMatchObject({
      pluginId: "dynamic-provider",
      providerId: "dynamic",
      methodId,
      appGuidedSecret: true,
      choiceHint: "Models: Latest model",
      install: {
        clawhubSpec: "clawhub:@vendor/dynamic-provider@1.2.3",
        expectedIntegrity: `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`,
      },
    });
    expect(choice).not.toHaveProperty("modelCatalog");
    expect(choice).not.toHaveProperty("apiKey");
    expect(loadHostedCatalog).toHaveBeenCalledOnce();

    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "dynamic-provider",
        providerId: "dynamic",
        methodId: "local",
        choiceId: "local-connect",
        choiceLabel: "Installed override",
      },
    ]);
    loadPluginRegistrySnapshot.mockReturnValue(
      registrySnapshot({
        plugins: [{ ...vllmPluginWithPackageInstall(), pluginId: "dynamic-provider" }],
      }),
    );
    expect(
      (await loadProviderSetupAuthChoices()).map((setupChoice) => setupChoice.choiceId),
    ).toEqual(["local-connect"]);
    expect(resolveProviderInstallCatalogEntry(choiceId)).toBeUndefined();
  });

  it("does not offer an unavailable hosted provider even when its preview has auth metadata", async () => {
    loadHostedCatalog.mockResolvedValue({
      source: "hosted",
      entries: [
        {
          type: "plugin",
          id: "@vendor/withdrawn",
          title: "Withdrawn",
          state: "unavailable",
          publisher: { id: "vendor", trust: "official" },
          openclaw: {
            plugin: { id: "withdrawn" },
            providers: [
              {
                id: "withdrawn",
                authChoices: [
                  { method: "key", choiceId: "withdrawn-key", choiceLabel: "Withdrawn" },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(await loadProviderSetupAuthChoices()).toEqual([]);
  });
});
