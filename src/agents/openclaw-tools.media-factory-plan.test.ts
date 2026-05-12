import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setBundledPluginsDirOverrideForTest } from "../plugins/bundled-dir.js";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { InstalledPluginIndexRecord } from "../plugins/installed-plugin-index.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveOptionalMediaToolFactoryPlan } from "./openclaw-tools.media-factory-plan.js";
import { DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY } from "./tool-policy.js";
import * as pdfModelConfigModule from "./tools/pdf-tool.model-config.js";

type CreateOpenClawToolsOptions = Parameters<
  typeof import("./openclaw-tools.js").createOpenClawTools
>[0];

async function createOpenClawToolsForTest(options?: CreateOpenClawToolsOptions) {
  const { createOpenClawTools } = await import("./openclaw-tools.js");
  return createOpenClawTools(options);
}

function createAuthStore(providers: string[] = []): AuthProfileStore {
  return {
    version: 1,
    profiles: Object.fromEntries(
      providers.map((provider) => [
        `${provider}:default`,
        {
          provider,
          type: "api_key",
          key: "test",
        },
      ]),
    ),
  };
}

function createPlugin(params: {
  id: string;
  origin?: PluginManifestRecord["origin"];
  contracts: NonNullable<PluginManifestRecord["contracts"]>;
  imageGenerationProviderMetadata?: PluginManifestRecord["imageGenerationProviderMetadata"];
  videoGenerationProviderMetadata?: PluginManifestRecord["videoGenerationProviderMetadata"];
  musicGenerationProviderMetadata?: PluginManifestRecord["musicGenerationProviderMetadata"];
  providerAuthEnvVars?: PluginManifestRecord["providerAuthEnvVars"];
  setupProviders?: Array<{ id: string; envVars?: string[] }>;
}): PluginManifestRecord {
  return {
    id: params.id,
    origin: params.origin ?? "bundled",
    rootDir: `/plugins/${params.id}`,
    source: `/plugins/${params.id}/index.js`,
    manifestPath: `/plugins/${params.id}/openclaw.plugin.json`,
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    contracts: params.contracts,
    imageGenerationProviderMetadata: params.imageGenerationProviderMetadata,
    videoGenerationProviderMetadata: params.videoGenerationProviderMetadata,
    musicGenerationProviderMetadata: params.musicGenerationProviderMetadata,
    providerAuthEnvVars: params.providerAuthEnvVars,
    setup: params.setupProviders ? { providers: params.setupProviders } : undefined,
  };
}

function createInstalledPluginRecord(
  plugin: PluginManifestRecord,
  enabledPluginIds: string[],
): InstalledPluginIndexRecord {
  const enabled = plugin.origin === "bundled" || enabledPluginIds.includes(plugin.id);
  return {
    pluginId: plugin.id,
    manifestPath: plugin.manifestPath,
    manifestHash: `test-${plugin.id}`,
    source: plugin.source,
    rootDir: plugin.rootDir,
    origin: plugin.origin,
    enabled,
    startup: {
      sidecar: false,
      memory: false,
      deferConfiguredChannelFullLoadUntilAfterListen: false,
      agentHarnesses: [],
    },
    compat: [],
  };
}

function legacyModelProviderConfig(provider: Record<string, unknown>): OpenClawConfig {
  return {
    models: {
      providers: {
        comfy: provider as never,
      },
    },
  };
}

function installSnapshot(
  config: OpenClawConfig,
  plugins: PluginManifestRecord[],
  enabledPluginIds = plugins
    .filter((plugin) => plugin.origin !== "bundled")
    .map((plugin) => plugin.id),
  workspaceDir?: string,
) {
  const snapshot = {
    policyHash: resolveInstalledPluginIndexPolicyHash(config),
    ...(workspaceDir ? { workspaceDir } : {}),
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 0,
      installRecords: {},
      plugins: plugins.map((plugin) => createInstalledPluginRecord(plugin, enabledPluginIds)),
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: { plugins, diagnostics: [] },
    plugins,
    diagnostics: [],
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    normalizePluginId: (id: string) => id,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: plugins.length,
    },
  } satisfies PluginMetadataSnapshot;
  setCurrentPluginMetadataSnapshot(snapshot, { config });
}

describe("optional media tool factory planning", () => {
  beforeEach(() => {
    clearSecretsRuntimeSnapshot();
  });

  afterEach(() => {
    clearCurrentPluginMetadataSnapshot();
    clearSecretsRuntimeSnapshot();
    setBundledPluginsDirOverrideForTest(undefined);
    vi.unstubAllEnvs();
  });

  it("skips unavailable generation and PDF factories from snapshot and run auth facts", () => {
    const config: OpenClawConfig = {};
    installSnapshot(config, [
      createPlugin({
        id: "image-owner",
        contracts: { imageGenerationProviders: ["image-owner"] },
        setupProviders: [{ id: "image-owner", envVars: ["IMAGE_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "video-owner",
        contracts: { videoGenerationProviders: ["video-owner"] },
        setupProviders: [{ id: "video-owner", envVars: ["VIDEO_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "music-owner",
        contracts: { musicGenerationProviders: ["music-owner"] },
        setupProviders: [{ id: "music-owner", envVars: ["MUSIC_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "media-owner",
        contracts: { mediaUnderstandingProviders: ["media-owner"] },
        setupProviders: [{ id: "media-owner", envVars: ["MEDIA_OWNER_API_KEY"] }],
      }),
    ]);

    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(["github-copilot"]),
      }),
    ).toEqual({
      imageGenerate: false,
      videoGenerate: false,
      musicGenerate: false,
      pdf: false,
    });
  });

  it("keeps explicit model configs on the factory path", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          imageGenerationModel: { primary: "image-owner/model" },
          videoGenerationModel: { primary: "video-owner/model" },
          musicGenerationModel: { primary: "music-owner/model" },
          pdfModel: { primary: "media-owner/model" },
        },
      },
    };
    installSnapshot(config, []);

    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(),
      }),
    ).toEqual({
      imageGenerate: true,
      videoGenerate: true,
      musicGenerate: true,
      pdf: true,
    });
  });

  it("preserves implicit allow-all from alsoAllow-only policies for built-in media factories", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          imageGenerationModel: { primary: "image-owner/model" },
          videoGenerationModel: { primary: "video-owner/model" },
          musicGenerationModel: { primary: "music-owner/model" },
          pdfModel: { primary: "media-owner/model" },
        },
      },
    };
    const allowlistFromAlsoAllowOnlyPolicy = ["group:memory", DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY];
    installSnapshot(config, []);

    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(),
        toolAllowlist: allowlistFromAlsoAllowOnlyPolicy,
      }),
    ).toEqual({
      imageGenerate: true,
      videoGenerate: true,
      musicGenerate: true,
      pdf: true,
    });

    const toolNames = (
      await createOpenClawToolsForTest({
        config,
        agentDir: "/tmp/openclaw-agent-main",
        authProfileStore: createAuthStore(),
        pluginToolAllowlist: allowlistFromAlsoAllowOnlyPolicy,
      })
    ).map((tool) => tool.name);
    expect(toolNames).toContain("image_generate");
    expect(toolNames).toContain("video_generate");
    expect(toolNames).toContain("music_generate");
    expect(toolNames).toContain("pdf");
  });

  it("keeps denylists authoritative when alsoAllow-only policies preserve factory construction", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          imageGenerationModel: { primary: "image-owner/model" },
          videoGenerationModel: { primary: "video-owner/model" },
          musicGenerationModel: { primary: "music-owner/model" },
          pdfModel: { primary: "media-owner/model" },
        },
      },
    };
    installSnapshot(config, []);

    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(),
        toolAllowlist: [DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY],
        toolDenylist: ["video_generate", "pdf"],
      }),
    ).toEqual({
      imageGenerate: true,
      videoGenerate: false,
      musicGenerate: true,
      pdf: false,
    });
  });

  it("skips tools that the resolved allowlist cannot expose", () => {
    const config: OpenClawConfig = {};
    installSnapshot(config, [
      createPlugin({
        id: "image-owner",
        contracts: { imageGenerationProviders: ["image-owner"] },
        setupProviders: [{ id: "image-owner", envVars: ["IMAGE_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "media-owner",
        contracts: { mediaUnderstandingProviders: ["anthropic"] },
        setupProviders: [{ id: "anthropic", envVars: ["ANTHROPIC_API_KEY"] }],
      }),
    ]);

    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(["image-owner", "anthropic"]),
        toolAllowlist: ["image_generate"],
      }),
    ).toEqual({
      imageGenerate: true,
      videoGenerate: false,
      musicGenerate: false,
      pdf: false,
    });
  });

  it("skips tools that the resolved denylist blocks", () => {
    const config: OpenClawConfig = {};
    installSnapshot(config, [
      createPlugin({
        id: "image-owner",
        contracts: { imageGenerationProviders: ["image-owner"] },
        setupProviders: [{ id: "image-owner", envVars: ["IMAGE_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "media-owner",
        contracts: { mediaUnderstandingProviders: ["anthropic"] },
        setupProviders: [{ id: "anthropic", envVars: ["ANTHROPIC_API_KEY"] }],
      }),
    ]);

    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(["image-owner", "anthropic"]),
        toolDenylist: ["image_generate", "pdf"],
      }),
    ).toEqual({
      imageGenerate: false,
      videoGenerate: false,
      musicGenerate: false,
      pdf: false,
    });
  });

  it("applies global tool policy before optional media factories run", () => {
    const config: OpenClawConfig = { tools: { deny: ["pdf"] } };
    installSnapshot(config, [
      createPlugin({
        id: "media-owner",
        contracts: { mediaUnderstandingProviders: ["anthropic"] },
        setupProviders: [{ id: "anthropic", envVars: ["ANTHROPIC_API_KEY"] }],
      }),
    ]);

    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(["anthropic"]),
      }).pdf,
    ).toBe(false);
  });

  it("applies wildcard deny patterns to optional factory planning", () => {
    const config: OpenClawConfig = {};
    installSnapshot(config, [
      createPlugin({
        id: "image-owner",
        contracts: { imageGenerationProviders: ["image-owner"] },
        setupProviders: [{ id: "image-owner", envVars: ["IMAGE_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "video-owner",
        contracts: { videoGenerationProviders: ["video-owner"] },
        setupProviders: [{ id: "video-owner", envVars: ["VIDEO_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "music-owner",
        contracts: { musicGenerationProviders: ["music-owner"] },
        setupProviders: [{ id: "music-owner", envVars: ["MUSIC_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "media-owner",
        contracts: { mediaUnderstandingProviders: ["anthropic"] },
        setupProviders: [{ id: "anthropic", envVars: ["ANTHROPIC_API_KEY"] }],
      }),
    ]);

    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(["image-owner", "video-owner", "music-owner", "anthropic"]),
        toolDenylist: ["*_generate", "p*"],
      }),
    ).toEqual({
      imageGenerate: false,
      videoGenerate: false,
      musicGenerate: false,
      pdf: false,
    });
  });

  it("keeps auth-backed providers on the factory path", () => {
    const config: OpenClawConfig = {};
    installSnapshot(config, [
      createPlugin({
        id: "image-owner",
        contracts: { imageGenerationProviders: ["image-owner"] },
        setupProviders: [{ id: "image-owner", envVars: ["IMAGE_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "video-owner",
        contracts: { videoGenerationProviders: ["video-owner"] },
        setupProviders: [{ id: "video-owner", envVars: ["VIDEO_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "music-owner",
        contracts: { musicGenerationProviders: ["music-owner"] },
        setupProviders: [{ id: "music-owner", envVars: ["MUSIC_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "media-owner",
        contracts: { mediaUnderstandingProviders: ["media-owner"] },
        setupProviders: [{ id: "media-owner", envVars: ["MEDIA_OWNER_API_KEY"] }],
      }),
    ]);
    vi.stubEnv("VIDEO_OWNER_API_KEY", "video-key");

    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(["image-owner", "music-owner", "media-owner"]),
      }),
    ).toEqual({
      imageGenerate: true,
      videoGenerate: true,
      musicGenerate: true,
      pdf: true,
    });
  });

  it("keeps manifest provider auth env aliases on the music factory path", () => {
    const config: OpenClawConfig = {};
    installSnapshot(config, [
      createPlugin({
        id: "minimax",
        contracts: { musicGenerationProviders: ["minimax", "minimax-portal"] },
        providerAuthEnvVars: {
          minimax: ["MINIMAX_CODE_PLAN_KEY", "MINIMAX_CODING_API_KEY", "MINIMAX_API_KEY"],
          "minimax-portal": ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"],
        },
      }),
    ]);
    vi.stubEnv("MINIMAX_API_KEY", "minimax-key");

    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(),
      }).musicGenerate,
    ).toBe(true);
  });

  it("defers PDF model resolution from the tool-prep hot path", async () => {
    const config: OpenClawConfig = {};
    installSnapshot(config, []);
    const resolveSpy = vi.spyOn(pdfModelConfigModule, "resolvePdfModelConfigForTool");

    const tools = await createOpenClawToolsForTest({
      config,
      agentDir: "/tmp/openclaw-agent-main",
      authProfileStore: createAuthStore(["anthropic"]),
    });

    expect(tools.map((tool) => tool.name)).toContain("pdf");
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("keeps enabled external manifest capability providers on the factory path", () => {
    const config: OpenClawConfig = {};
    installSnapshot(config, [
      createPlugin({
        id: "external-image",
        origin: "global",
        contracts: { imageGenerationProviders: ["external-image"] },
        setupProviders: [{ id: "external-image", envVars: ["EXTERNAL_IMAGE_API_KEY"] }],
      }),
      createPlugin({
        id: "external-video",
        origin: "global",
        contracts: { videoGenerationProviders: ["external-video"] },
        setupProviders: [{ id: "external-video", envVars: ["EXTERNAL_VIDEO_API_KEY"] }],
      }),
      createPlugin({
        id: "external-music",
        origin: "global",
        contracts: { musicGenerationProviders: ["external-music"] },
        setupProviders: [{ id: "external-music", envVars: ["EXTERNAL_MUSIC_API_KEY"] }],
      }),
      createPlugin({
        id: "external-media",
        origin: "global",
        contracts: { mediaUnderstandingProviders: ["external-media"] },
        setupProviders: [{ id: "external-media", envVars: ["EXTERNAL_MEDIA_API_KEY"] }],
      }),
    ]);

    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore([
          "external-image",
          "external-video",
          "external-music",
          "external-media",
        ]),
      }),
    ).toEqual({
      imageGenerate: true,
      videoGenerate: true,
      musicGenerate: true,
      pdf: true,
    });
  });

  it("keeps manifest-declared image provider auth aliases on the factory path", async () => {
    const config: OpenClawConfig = {};
    const plugins = [
      createPlugin({
        id: "openai",
        contracts: { imageGenerationProviders: ["openai"] },
        imageGenerationProviderMetadata: {
          openai: {
            aliases: ["openai-codex"],
            authSignals: [
              {
                provider: "openai",
              },
              {
                provider: "openai-codex",
                providerBaseUrl: {
                  provider: "openai",
                  defaultBaseUrl: "https://api.openai.com/v1",
                  allowedBaseUrls: ["https://api.openai.com/v1"],
                },
              },
            ],
          },
        },
      }),
    ];
    installSnapshot(config, plugins);

    const plan = resolveOptionalMediaToolFactoryPlan({
      config,
      authStore: createAuthStore(["openai-codex"]),
    });
    expect(plan.imageGenerate).toBe(true);
    installSnapshot(config, plugins, undefined, process.cwd());
    expect(
      (
        await createOpenClawToolsForTest({
          config,
          workspaceDir: process.cwd(),
          authProfileStore: createAuthStore(["openai-codex"]),
          pluginToolAllowlist: ["image_generate"],
        })
      ).map((tool) => tool.name),
    ).toContain("image_generate");
  });

  it("keeps manifest-declared config-only generation providers on the factory path", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          comfy: {
            config: {
              mode: "local",
              workflow: { "1": { inputs: {} } },
              promptNodeId: "1",
            },
          },
        },
      },
    };
    const configSignals = [
      {
        rootPath: "plugins.entries.comfy.config",
        mode: {
          path: "mode",
          default: "local",
          allowed: ["local"],
        },
        requiredAny: ["workflow", "workflowPath"],
        required: ["promptNodeId"],
      },
    ];
    installSnapshot(config, [
      createPlugin({
        id: "comfy",
        contracts: {
          imageGenerationProviders: ["comfy"],
          videoGenerationProviders: ["comfy"],
          musicGenerationProviders: ["comfy"],
        },
        imageGenerationProviderMetadata: {
          comfy: { configSignals },
        },
        videoGenerationProviderMetadata: {
          comfy: { configSignals },
        },
        musicGenerationProviderMetadata: {
          comfy: { configSignals },
        },
      }),
    ]);

    const plan = resolveOptionalMediaToolFactoryPlan({
      config,
      authStore: createAuthStore(),
    });
    expect(plan.imageGenerate).toBe(true);
    expect(plan.videoGenerate).toBe(true);
    expect(plan.musicGenerate).toBe(true);
  });

  it("does not expose manifest-backed generation providers when plugins are globally disabled", async () => {
    const config: OpenClawConfig = {
      plugins: {
        enabled: false,
        entries: {
          comfy: {
            config: {
              mode: "local",
              workflow: { "1": { inputs: {} } },
              promptNodeId: "1",
            },
          },
        },
      },
    };
    const configSignals = [
      {
        rootPath: "plugins.entries.comfy.config",
        mode: {
          path: "mode",
          default: "local",
          allowed: ["local"],
        },
        requiredAny: ["workflow", "workflowPath"],
        required: ["promptNodeId"],
      },
    ];
    installSnapshot(config, [
      createPlugin({
        id: "comfy",
        contracts: {
          imageGenerationProviders: ["comfy"],
          videoGenerationProviders: ["comfy"],
          musicGenerationProviders: ["comfy"],
        },
        imageGenerationProviderMetadata: {
          comfy: { configSignals },
        },
        videoGenerationProviderMetadata: {
          comfy: { configSignals },
        },
        musicGenerationProviderMetadata: {
          comfy: { configSignals },
        },
      }),
    ]);

    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(),
      }),
    ).toEqual({
      imageGenerate: false,
      videoGenerate: false,
      musicGenerate: false,
      pdf: false,
    });
    const toolNames = (
      await createOpenClawToolsForTest({
        config,
        authProfileStore: createAuthStore(),
        pluginToolAllowlist: ["image_generate", "video_generate", "music_generate"],
      })
    ).map((tool) => tool.name);
    expect(toolNames).not.toContain("image_generate");
    expect(toolNames).not.toContain("video_generate");
    expect(toolNames).not.toContain("music_generate");
  });

  it("does not count unresolved SecretRef config signals as configured", async () => {
    vi.stubEnv("COMFY_TEST_API_KEY", "");
    const workspaceDir = process.cwd();
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          comfy: {
            config: {
              mode: "cloud",
              apiKey: { source: "env", provider: "default", id: "COMFY_TEST_API_KEY" },
              workflow: { "1": { inputs: {} } },
              promptNodeId: "1",
            },
          },
        },
      },
    };
    const configSignals = [
      {
        rootPath: "plugins.entries.comfy.config",
        mode: {
          path: "mode",
          allowed: ["cloud"],
        },
        requiredAny: ["workflow", "workflowPath"],
        required: ["promptNodeId", "apiKey"],
      },
    ];
    installSnapshot(
      config,
      [
        createPlugin({
          id: "comfy",
          contracts: {
            imageGenerationProviders: ["comfy"],
            videoGenerationProviders: ["comfy"],
            musicGenerationProviders: ["comfy"],
          },
          imageGenerationProviderMetadata: {
            comfy: { configSignals },
          },
          videoGenerationProviderMetadata: {
            comfy: { configSignals },
          },
          musicGenerationProviderMetadata: {
            comfy: { configSignals },
          },
        }),
      ],
      undefined,
      workspaceDir,
    );

    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        workspaceDir,
        authStore: createAuthStore(),
      }),
    ).toEqual({
      imageGenerate: false,
      videoGenerate: false,
      musicGenerate: false,
      pdf: false,
    });
    const toolNames = (
      await createOpenClawToolsForTest({
        config,
        workspaceDir,
        authProfileStore: createAuthStore(),
        pluginToolAllowlist: ["image_generate", "video_generate", "music_generate"],
      })
    ).map((tool) => tool.name);
    expect(toolNames).not.toContain("image_generate");
    expect(toolNames).not.toContain("video_generate");
    expect(toolNames).not.toContain("music_generate");
  });

  it("counts configured non-env SecretRef config signals without resolving secrets", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          comfy: {
            config: {
              mode: "cloud",
              apiKey: { source: "file", provider: "vault", id: "/comfy/api-key" },
              workflow: { "1": { inputs: {} } },
              promptNodeId: "1",
            },
          },
        },
      },
      secrets: {
        providers: {
          vault: {
            source: "file",
            path: "/tmp/openclaw-secrets.json",
            mode: "json",
          },
        },
      },
    };
    const configSignals = [
      {
        rootPath: "plugins.entries.comfy.config",
        mode: {
          path: "mode",
          allowed: ["cloud"],
        },
        requiredAny: ["workflow", "workflowPath"],
        required: ["promptNodeId", "apiKey"],
      },
    ];
    installSnapshot(config, [
      createPlugin({
        id: "comfy",
        contracts: {
          imageGenerationProviders: ["comfy"],
          videoGenerationProviders: ["comfy"],
          musicGenerationProviders: ["comfy"],
        },
        imageGenerationProviderMetadata: {
          comfy: { configSignals },
        },
        videoGenerationProviderMetadata: {
          comfy: { configSignals },
        },
        musicGenerationProviderMetadata: {
          comfy: { configSignals },
        },
      }),
    ]);

    const plan = resolveOptionalMediaToolFactoryPlan({
      config,
      authStore: createAuthStore(),
    });
    expect(plan.imageGenerate).toBe(true);
    expect(plan.videoGenerate).toBe(true);
    expect(plan.musicGenerate).toBe(true);
  });

  it("does not register the image tool without cheap vision availability evidence", async () => {
    const config: OpenClawConfig = {};
    installSnapshot(config, [
      createPlugin({
        id: "media-owner",
        contracts: { mediaUnderstandingProviders: ["media-owner"] },
        setupProviders: [{ id: "media-owner", envVars: ["MEDIA_OWNER_API_KEY"] }],
      }),
    ]);

    expect(
      (
        await createOpenClawToolsForTest({
          config,
          agentDir: "/tmp/openclaw-agent",
          authProfileStore: createAuthStore(),
          disablePluginTools: true,
        })
      ).map((tool) => tool.name),
    ).not.toContain("image");
  });

  it.each([
    {
      name: "legacy local provider config",
      config: legacyModelProviderConfig({
        workflow: { "1": { inputs: {} } },
        promptNodeId: "1",
      }),
    },
    {
      name: "plugin cloud API key config",
      config: {
        plugins: {
          entries: {
            comfy: {
              config: {
                mode: "cloud",
                apiKey: "cloud-key",
                workflow: { "1": { inputs: {} } },
                promptNodeId: "1",
              },
            },
          },
        },
      } satisfies OpenClawConfig,
    },
    {
      name: "legacy cloud API key config",
      config: legacyModelProviderConfig({
        mode: "cloud",
        apiKey: "cloud-key",
        workflow: { "1": { inputs: {} } },
        promptNodeId: "1",
      }),
    },
  ])(
    "registers generation tools from Comfy $name without a current metadata snapshot",
    async ({ config }) => {
      setBundledPluginsDirOverrideForTest(path.join(process.cwd(), "extensions"));

      const toolNames = (
        await createOpenClawToolsForTest({
          config,
          authProfileStore: createAuthStore(),
          pluginToolAllowlist: ["image_generate", "video_generate", "music_generate"],
        })
      ).map((tool) => tool.name);

      expect(toolNames).toContain("image_generate");
      expect(toolNames).toContain("video_generate");
      expect(toolNames).toContain("music_generate");
    },
  );

  it("honors manifest-declared image provider auth alias base-url guards", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "http://localhost:11434/v1",
            models: [],
          },
        },
      },
    };
    installSnapshot(config, [
      createPlugin({
        id: "openai",
        contracts: { imageGenerationProviders: ["openai"] },
        imageGenerationProviderMetadata: {
          openai: {
            aliases: ["openai-codex"],
            authSignals: [
              {
                provider: "openai-codex",
                providerBaseUrl: {
                  provider: "openai",
                  defaultBaseUrl: "https://api.openai.com/v1",
                  allowedBaseUrls: ["https://api.openai.com/v1"],
                },
              },
            ],
          },
        },
      }),
    ]);

    const plan = resolveOptionalMediaToolFactoryPlan({
      config,
      authStore: createAuthStore(["openai-codex"]),
    });
    expect(plan.imageGenerate).toBe(false);
  });

  it("ignores external manifest capability providers excluded by plugin policy", () => {
    const config: OpenClawConfig = {
      plugins: {
        allow: ["other-plugin"],
      },
    };
    installSnapshot(config, [
      createPlugin({
        id: "external-image",
        origin: "global",
        contracts: { imageGenerationProviders: ["external-image"] },
        setupProviders: [{ id: "external-image", envVars: ["EXTERNAL_IMAGE_API_KEY"] }],
      }),
    ]);

    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(["external-image"]),
      }),
    ).toEqual({
      imageGenerate: false,
      videoGenerate: false,
      musicGenerate: false,
      pdf: false,
    });
  });

  it("does not use a generic factory plan when metadata has no availability proof", () => {
    const config: OpenClawConfig = {};
    installSnapshot(config, []);

    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(),
      }),
    ).toEqual({
      imageGenerate: false,
      videoGenerate: false,
      musicGenerate: false,
      pdf: false,
    });
  });
});
