// Capability CLI tests cover capability command registration and output formatting.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { inspectLocalAudioSelection } from "../media-understanding/local-audio.js";
import { registerCapabilityCli } from "./capability-cli.js";
import { CAPABILITY_METADATA } from "./capability-cli/metadata.js";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yf7kAAAAASUVORK5CYII=";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createIsomBrandBuffer(brand: "hevc" | "msf1"): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(buffer.length, 0);
  buffer.write("ftyp", 4, "ascii");
  buffer.write(brand, 8, "ascii");
  return buffer;
}

async function runCap(...argv: string[]): Promise<void> {
  const program = new Command();
  await registerCapabilityCli(program, ["node", "openclaw", ...argv]);
  await program.parseAsync(argv, { from: "user" });
}

function runCapability(domain: string, action: string, ...argv: string[]): Promise<void> {
  return runCap("capability", domain, action, ...argv);
}

function runCapabilityWithParentAgent(
  domain: string,
  action: string,
  agent: string,
  ...argv: string[]
): Promise<void> {
  return runCap("capability", domain, "--agent", agent, action, ...argv);
}

function runModelAuthWithAgent(
  position: "parent" | "leaf",
  action: "login" | "logout" | "status",
  agent: string,
  ...argv: string[]
): Promise<void> {
  return position === "parent"
    ? runCap("capability", "model", "--agent", agent, "auth", action, ...argv)
    : runCap("capability", "model", "auth", action, "--agent", agent, ...argv);
}

function primeOpenAiAuthProfile(mode: "api-key" | "token" = "api-key"): void {
  mocks.resolveApiKeyForProviderCore.mockResolvedValueOnce({
    apiKey: mode === "token" ? "profile-openai-token" : "profile-openai-key",
    source: mode === "token" ? "profile:openai:token" : "profile:openai:qa",
    mode,
  });
}

type LocalAudioSelection = Awaited<ReturnType<typeof inspectLocalAudioSelection>>;

const closeEmbeddingProviderMock = vi.hoisted(() => vi.fn(async () => {}));
const mocks = vi.hoisted(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
  },
  loadConfig: vi.fn(() => ({})),
  getRuntimeConfigSourceSnapshot: vi.fn(() => null),
  setRuntimeConfigSnapshot: vi.fn(),
  loadAuthProfileStoreForRuntime: vi.fn<
    typeof import("../agents/auth-profiles.js").loadAuthProfileStoreForRuntime
  >(() => ({ version: 1, profiles: {}, order: {} })),
  listProfilesForProvider: vi.fn<
    typeof import("../agents/auth-profiles.js").listProfilesForProvider
  >(() => []),
  resolveApiKeyForProviderCore: vi.fn(),
  loadManifestMetadataSnapshot: vi.fn(() => ({ manifestRegistry: { plugins: [] } })),
  planEffectiveModelCatalogRows: vi.fn<
    typeof import("../model-catalog/index.js").planEffectiveModelCatalogRows
  >(() => ({ rows: [], entries: [], conflicts: [] })),
  resolveAgentDir: vi.fn((_cfg: unknown, agentId: string) => `/tmp/agent-${agentId}`),
  updateAuthProfileStoreWithLock: vi.fn(
    async ({ updater }: { updater: (store: any) => boolean }) => {
      const store = {
        version: 1,
        profiles: {},
        order: {},
        lastGood: {},
        usageStats: {},
      };
      updater(store);
      return store;
    },
  ),
  resolveMemorySearchConfig: vi.fn<
    typeof import("../agents/memory-search.js").resolveMemorySearchConfig
  >(() => null),
  loadModelCatalog: vi.fn(async () => []),
  prepareSimpleCompletionModelForAgent: vi.fn(async () => ({
    selection: {
      provider: "openai",
      modelId: "gpt-5.4",
      agentDir: "/tmp/agent",
    },
    model: {
      provider: "openai",
      id: "gpt-5.4",
      maxTokens: 128,
    },
    auth: {
      apiKey: "sk-test",
      source: "env:TEST_API_KEY",
      mode: "api-key",
    },
  })),
  completeWithPreparedSimpleCompletionModel: vi.fn(async () => ({
    content: [{ type: "text", text: "local reply" }],
  })),
  callGateway: vi.fn(async ({ method }: { method: string }) => {
    if (method === "tts.status") {
      return { enabled: true, provider: "openai" };
    }
    if (method === "agent") {
      return {
        result: {
          payloads: [{ text: "gateway reply" }],
          meta: { agentMeta: { provider: "anthropic", model: "claude-sonnet-4-6" } },
        },
      };
    }
    return {};
  }),
  describeImageFile: vi.fn(async () => ({
    text: "friendly lobster",
    provider: "openai",
    model: "gpt-4.1-mini",
  })),
  prepareImageDescriptionInput: vi.fn(async () => ({
    buffer: Buffer.from("image"),
    fileName: "photo.jpg",
    mime: "image/jpeg",
  })),
  describePreparedImageWithModel: vi.fn(async () => ({
    text: "friendly lobster",
    model: "gpt-4.1-mini",
  })),
  describeImageFileWithModel: vi.fn(async () => ({
    text: "friendly lobster",
    model: "gpt-4.1-mini",
  })),
  generateImage: vi.fn(),
  listRuntimeImageGenerationProviders: vi.fn(() => []),
  generateVideo: vi.fn(),
  describeVideoFile: vi.fn(),
  listRuntimeVideoGenerationProviders: vi.fn(() => []),
  transcribeAudioFile: vi.fn(async () => ({ text: "meeting notes" })),
  textToSpeech: vi.fn(async () => ({
    success: true,
    audioPath: "/tmp/tts-source.mp3",
    provider: "openai",
    outputFormat: "mp3",
    voiceCompatible: false,
    attempts: [],
  })),
  setTtsProvider: vi.fn(),
  getTtsProvider: vi.fn(() => "openai"),
  listSpeechProviders: vi.fn(() => []),
  setTtsPersona: vi.fn(),
  resolveTtsConfig: vi.fn(() => ({})),
  resolveExplicitTtsOverrides: vi.fn(
    ({
      provider,
      modelId,
      voiceId,
    }: {
      provider?: string;
      modelId?: string;
      voiceId?: string;
    }) => ({
      ...(provider ? { provider } : {}),
      ...(modelId || voiceId
        ? {
            providerOverrides: {
              [provider ?? "openai"]: {
                ...(modelId ? { modelId } : {}),
                ...(voiceId ? { voiceId } : {}),
              },
            },
          }
        : {}),
    }),
  ),
  getProviderEnvVars: vi.fn((providerId: string) => [
    `${providerId.toUpperCase().replaceAll("-", "_")}_API_KEY`,
  ]),
  embedBatch: vi.fn(async (inputs: unknown[], options?: { inputType?: string }) =>
    inputs.map(() => (options?.inputType === "document" ? [0.1, 0.2] : [9, 9])),
  ),
  createEmbeddingProvider: vi.fn(async () => ({
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embed: async () => [0.1, 0.2],
      embedBatch: (...args: Parameters<typeof mocks.embedBatch>) => mocks.embedBatch(...args),
      close: closeEmbeddingProviderMock,
    },
  })),
  listMemoryEmbeddingProviders: vi.fn(() => [
    { id: "openai", defaultModel: "text-embedding-3-small", transport: "remote" },
  ]),
  listEmbeddingProviders: vi.fn(() => []),
  buildMediaUnderstandingRegistry: vi.fn(() => new Map()),
  inspectLocalAudioSelection: vi.fn<() => Promise<LocalAudioSelection>>(async () => ({
    candidates: [],
    entries: [],
  })),
  convertHeicToJpeg: vi.fn(async () => Buffer.from("jpeg-normalized")),
  listWebSearchProviders: vi.fn<typeof import("../web-search/runtime.js").listWebSearchProviders>(
    () => [],
  ),
  isWebSearchProviderConfigured: vi.fn<
    typeof import("../web-search/runtime.js").isWebSearchProviderConfigured
  >(() => false),
  isWebFetchProviderConfigured: vi.fn(() => false),
  getModelsCommandSecretTargetIds: vi.fn(() => new Set(["models.providers.*.apiKey"])),
  getMemoryEmbeddingCommandSecretTargetIds: vi.fn(() => new Set(["models.providers.*.apiKey"])),
  getTtsCommandSecretTargetIds: vi.fn(() => new Set(["models.providers.*.apiKey"])),
  getCapabilityWebSearchCommandSecretTargets: vi.fn(
    (
      config: { tools?: { web?: { search?: { provider?: string } } } },
      options?: { providerId?: string },
    ) => {
      const providerId = options?.providerId ?? config.tools?.web?.search?.provider ?? "tavily";
      const pathValue = `plugins.entries.${providerId}.config.webSearch.apiKey`;
      return {
        targetIds: new Set([pathValue]),
        ...(options?.providerId ? { forcedActivePaths: new Set([pathValue]) } : {}),
      };
    },
  ),
  getCapabilityWebFetchCommandSecretTargets: vi.fn(
    (
      _config: { tools?: { web?: { fetch?: { provider?: string } } } },
      options?: { providerId?: string },
    ) => {
      const pathLocal =
        options?.providerId === "firecrawl"
          ? "plugins.entries.firecrawl.config.webSearch.apiKey"
          : "plugins.entries.firecrawl.config.webFetch.apiKey";
      return {
        targetIds: new Set([pathLocal]),
        ...(options?.providerId ? { forcedActivePaths: new Set([pathLocal]) } : {}),
      };
    },
  ),
  resolveCommandConfigWithSecrets: vi.fn(
    async ({ config }: { config: Record<string, unknown> }) => ({
      resolvedConfig: config,
      effectiveConfig: config,
      diagnostics: [],
    }),
  ),
  modelsStatusCommand: vi.fn(
    async (_opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
      runtime.log(JSON.stringify({ ok: true, providers: [{ id: "openai" }] }));
    },
  ),
  modelsAuthLoginCommand: vi.fn(),
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: { writeJson: (value: unknown) => void }, value: unknown) =>
    runtime.writeJson(value),
}));

vi.mock("../secrets/provider-env-vars.js", () => ({
  getProviderEnvVars: mocks.getProviderEnvVars,
  resolveProviderAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: {},
    authEvidenceMap: {},
  }),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfigSourceSnapshot:
    mocks.getRuntimeConfigSourceSnapshot as typeof import("../config/config.js").getRuntimeConfigSourceSnapshot,
  getRuntimeConfig: mocks.loadConfig as typeof import("../config/config.js").getRuntimeConfig,
  loadConfig: mocks.loadConfig as typeof import("../config/config.js").loadConfig,
  setRuntimeConfigSnapshot:
    mocks.setRuntimeConfigSnapshot as typeof import("../config/config.js").setRuntimeConfigSnapshot,
}));

vi.mock("../model-catalog/index.js", () => ({
  planEffectiveModelCatalogRows: mocks.planEffectiveModelCatalogRows,
}));

vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: mocks.loadManifestMetadataSnapshot,
}));

vi.mock("./command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: mocks.resolveCommandConfigWithSecrets,
}));

vi.mock("./command-secret-targets.js", () => ({
  getCapabilityWebFetchCommandSecretTargets: mocks.getCapabilityWebFetchCommandSecretTargets,
  getCapabilityWebSearchCommandSecretTargets: mocks.getCapabilityWebSearchCommandSecretTargets,
  getMemoryEmbeddingCommandSecretTargetIds: mocks.getMemoryEmbeddingCommandSecretTargetIds,
  getModelsCommandSecretTargetIds: mocks.getModelsCommandSecretTargetIds,
  getTtsCommandSecretTargetIds: mocks.getTtsCommandSecretTargetIds,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentConfig: () => ({}),
  resolveAgentEffectiveModelPrimary: (
    cfg: {
      agents?: {
        defaults?: { model?: string };
        entries?: Record<string, { model?: string }>;
      };
    },
    agentId: string,
  ) => cfg.agents?.entries?.[agentId]?.model ?? cfg.agents?.defaults?.model,
  resolveAgentModelFallbacksOverride: () => [],
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalog:
    mocks.loadModelCatalog as typeof import("../agents/prepared-model-catalog.js").loadPreparedModelCatalog,
}));

vi.mock("../agents/simple-completion-runtime.js", () => ({
  prepareSimpleCompletionModelForAgent:
    mocks.prepareSimpleCompletionModelForAgent as unknown as typeof import("../agents/simple-completion-runtime.js").prepareSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel:
    mocks.completeWithPreparedSimpleCompletionModel as unknown as typeof import("../agents/simple-completion-runtime.js").completeWithPreparedSimpleCompletionModel,
}));

vi.mock("../agents/auth-profiles.js", () => ({
  loadAuthProfileStoreForRuntime:
    mocks.loadAuthProfileStoreForRuntime as unknown as typeof import("../agents/auth-profiles.js").loadAuthProfileStoreForRuntime,
  listProfilesForProvider:
    mocks.listProfilesForProvider as typeof import("../agents/auth-profiles.js").listProfilesForProvider,
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProviderCore:
    mocks.resolveApiKeyForProviderCore as typeof import("../agents/model-auth.js").resolveApiKeyForProviderCore,
}));

vi.mock("../agents/auth-profiles/store-runtime.js", () => ({
  updateAuthProfileStoreWithLock:
    mocks.updateAuthProfileStoreWithLock as typeof import("../agents/auth-profiles/store-runtime.js").updateAuthProfileStoreWithLock,
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig:
    mocks.resolveMemorySearchConfig as typeof import("../agents/memory-search.js").resolveMemorySearchConfig,
}));

vi.mock("../commands/models/auth.js", () => ({
  modelsAuthLoginCommand: mocks.modelsAuthLoginCommand,
}));

vi.mock("../commands/models/list.status-command.js", () => ({
  modelsStatusCommand:
    mocks.modelsStatusCommand as typeof import("../commands/models/list.status-command.js").modelsStatusCommand,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway as typeof import("../gateway/call.js").callGateway,
  randomIdempotencyKey: () => "run-1",
}));

vi.mock("../gateway/connection-details.js", () => ({
  buildGatewayConnectionDetailsWithResolvers: vi.fn(() => ({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
    message: "Gateway target: ws://127.0.0.1:18789",
  })),
}));

vi.mock("../media-understanding/runtime.js", () => ({
  describeImageFile:
    mocks.describeImageFile as typeof import("../media-understanding/runtime.js").describeImageFile,
  prepareImageDescriptionInput:
    mocks.prepareImageDescriptionInput as typeof import("../media-understanding/runtime.js").prepareImageDescriptionInput,
  describePreparedImageWithModel:
    mocks.describePreparedImageWithModel as typeof import("../media-understanding/runtime.js").describePreparedImageWithModel,
  describeImageFileWithModel:
    mocks.describeImageFileWithModel as typeof import("../media-understanding/runtime.js").describeImageFileWithModel,
  describeVideoFile:
    mocks.describeVideoFile as typeof import("../media-understanding/runtime.js").describeVideoFile,
  transcribeAudioFile:
    mocks.transcribeAudioFile as typeof import("../media-understanding/runtime.js").transcribeAudioFile,
}));

vi.mock("../media-understanding/provider-registry.js", () => ({
  buildMediaUnderstandingRegistry:
    mocks.buildMediaUnderstandingRegistry as typeof import("../media-understanding/provider-registry.js").buildMediaUnderstandingRegistry,
}));

vi.mock("../media-understanding/local-audio.js", () => ({
  inspectLocalAudioSelection: mocks.inspectLocalAudioSelection,
}));

vi.mock("../media/media-services.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/media-services.js")>();
  return {
    ...actual,
    convertHeicToJpeg:
      mocks.convertHeicToJpeg as typeof import("../media/media-services.js").convertHeicToJpeg,
  };
});

vi.mock("../plugins/memory-embedding-provider-runtime.js", () => ({
  listRegisteredMemoryEmbeddingProviderAdapters:
    mocks.listMemoryEmbeddingProviders as unknown as typeof import("../plugins/memory-embedding-provider-runtime.js").listRegisteredMemoryEmbeddingProviderAdapters,
}));

vi.mock("../plugins/embedding-provider-runtime.js", () => ({
  listEmbeddingProviders:
    mocks.listEmbeddingProviders as unknown as typeof import("../plugins/embedding-provider-runtime.js").listEmbeddingProviders,
}));

vi.mock("../plugin-sdk/memory-core-bundled-runtime.js", () => ({
  createEmbeddingProvider:
    mocks.createEmbeddingProvider as unknown as typeof import("../plugin-sdk/memory-core-bundled-runtime.js").createEmbeddingProvider,
}));

vi.mock("../image-generation/runtime.js", () => ({
  generateImage: (...args: unknown[]) => mocks.generateImage(...args),
  listRuntimeImageGenerationProviders: mocks.listRuntimeImageGenerationProviders,
}));

vi.mock("../video-generation/runtime.js", () => ({
  generateVideo: mocks.generateVideo,
  listRuntimeVideoGenerationProviders: mocks.listRuntimeVideoGenerationProviders,
}));

vi.mock("../tts/tts.js", () => ({
  getTtsPersona: vi.fn(() => undefined),
  getTtsProvider: mocks.getTtsProvider,
  listTtsPersonas: vi.fn(() => []),
  listSpeechVoices: vi.fn(async () => []),
  resolveTtsConfig:
    mocks.resolveTtsConfig as unknown as typeof import("../tts/tts.js").resolveTtsConfig,
  resolveTtsPrefsPath: vi.fn(() => "/tmp/tts.json"),
  setTtsEnabled: vi.fn(),
  setTtsPersona: mocks.setTtsPersona as typeof import("../tts/tts.js").setTtsPersona,
  setTtsProvider: mocks.setTtsProvider as typeof import("../tts/tts.js").setTtsProvider,
  resolveExplicitTtsOverrides:
    mocks.resolveExplicitTtsOverrides as typeof import("../tts/tts.js").resolveExplicitTtsOverrides,
  textToSpeech: mocks.textToSpeech as typeof import("../tts/tts.js").textToSpeech,
}));

vi.mock("../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: vi.fn((provider: string) => provider),
  listSpeechProviders: mocks.listSpeechProviders,
  normalizeSpeechProviderId: vi.fn(
    (provider: string | undefined) => provider?.trim().toLowerCase() || undefined,
  ),
}));

vi.mock("../web-search/runtime.js", () => ({
  listWebSearchProviders: mocks.listWebSearchProviders,
  isWebSearchProviderConfigured:
    mocks.isWebSearchProviderConfigured as typeof import("../web-search/runtime.js").isWebSearchProviderConfigured,
  runWebSearch: vi.fn(),
}));

vi.mock("../web-fetch/runtime.js", () => ({
  listWebFetchProviders: vi.fn(() => []),
  isWebFetchProviderConfigured:
    mocks.isWebFetchProviderConfigured as typeof import("../web-fetch/runtime.js").isWebFetchProviderConfigured,
  resolveWebFetchDefinition: vi.fn(),
}));

vi.mock("../plugins/web-fetch-providers.runtime.js", () => ({
  resolvePluginWebFetchProviders: vi.fn((params: { config?: Record<string, unknown> }) => [
    {
      pluginId: "firecrawl",
      id: "firecrawl",
      credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
      getConfiguredCredentialValue: (config?: {
        plugins?: {
          entries?: {
            firecrawl?: { config?: { webFetch?: { apiKey?: unknown } } };
          };
        };
      }) => config?.plugins?.entries?.firecrawl?.config?.webFetch?.apiKey,
      getConfiguredCredentialFallback: () => ({
        path: "plugins.entries.firecrawl.config.webSearch.apiKey",
        value: (
          params.config as {
            plugins?: {
              entries?: {
                firecrawl?: { config?: { webSearch?: { apiKey?: unknown } } };
              };
            };
          }
        )?.plugins?.entries?.firecrawl?.config?.webSearch?.apiKey,
      }),
      getCredentialValue: (): undefined => undefined,
    },
  ]),
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: vi.fn(() => [
    {
      pluginId: "tavily",
      id: "tavily",
      credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
      getConfiguredCredentialValue: (config?: {
        plugins?: {
          entries?: {
            tavily?: { config?: { webSearch?: { apiKey?: unknown } } };
          };
        };
      }) => config?.plugins?.entries?.tavily?.config?.webSearch?.apiKey,
      getConfiguredCredentialFallback: (): undefined => undefined,
      getCredentialValue: (): undefined => undefined,
    },
    {
      pluginId: "firecrawl",
      id: "firecrawl",
      credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
      getConfiguredCredentialValue: (config?: {
        plugins?: {
          entries?: {
            firecrawl?: { config?: { webSearch?: { apiKey?: unknown } } };
          };
        };
      }) => config?.plugins?.entries?.firecrawl?.config?.webSearch?.apiKey,
      getConfiguredCredentialFallback: (): undefined => undefined,
      getCredentialValue: (): undefined => undefined,
    },
    {
      pluginId: "exa",
      id: "exa",
      credentialPath: "plugins.entries.exa.config.webSearch.apiKey",
      getConfiguredCredentialValue: (config?: {
        plugins?: {
          entries?: {
            exa?: { config?: { webSearch?: { apiKey?: unknown } } };
          };
        };
      }) => config?.plugins?.entries?.exa?.config?.webSearch?.apiKey,
      getConfiguredCredentialFallback: (): undefined => undefined,
      getCredentialValue: (): undefined => undefined,
    },
  ]),
}));

describe("capability cli", () => {
  it.each(
    [
      { args: ["image", "edit", "--prompt", "crop the image"], option: "--file <path>" },
      { args: ["image", "describe-many"], option: "--file <path>" },
      { args: ["embedding", "create"], option: "--text <text>" },
    ].flatMap(({ args, option }) =>
      ["infer", "capability"].map((root) => ({ args, option, root })),
    ),
  )("rejects missing required repeatable input for $root $args", async ({ root, args, option }) => {
    const argv = [root, ...args, "--json"];
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    await registerCapabilityCli(program, ["node", "openclaw", ...argv]);

    await expect(
      program.parseAsync(argv, { from: "user" }).then(() => undefined),
    ).rejects.toMatchObject({
      code: "commander.missingMandatoryOptionValue",
      message: `error: required option '${option}' not specified`,
    });
    expect(mocks.resolveCommandConfigWithSecrets).not.toHaveBeenCalled();
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.describeImageFile).not.toHaveBeenCalled();
    expect(mocks.createEmbeddingProvider).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    mocks.loadConfig.mockReset().mockReturnValue({});
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.loadModelCatalog
      .mockReset()
      .mockResolvedValue([{ id: "gpt-5.4", provider: "openai", name: "GPT-5.4" }] as never);
    mocks.loadAuthProfileStoreForRuntime
      .mockReset()
      .mockReturnValue({ version: 1, profiles: {}, order: {} });
    mocks.listProfilesForProvider.mockReset().mockReturnValue([]);
    mocks.resolveApiKeyForProviderCore.mockReset().mockRejectedValue(new Error("no auth profile"));
    mocks.loadManifestMetadataSnapshot
      .mockReset()
      .mockReturnValue({ manifestRegistry: { plugins: [] } });
    mocks.planEffectiveModelCatalogRows
      .mockReset()
      .mockReturnValue({ rows: [], entries: [], conflicts: [] });
    mocks.resolveAgentDir.mockClear();
    mocks.resolveTtsConfig.mockReset().mockReturnValue({});
    mocks.getRuntimeConfigSourceSnapshot.mockReset().mockReturnValue(null);
    mocks.setRuntimeConfigSnapshot.mockClear();
    mocks.updateAuthProfileStoreWithLock
      .mockReset()
      .mockImplementation(async ({ updater }: { updater: (store: any) => boolean }) => {
        const store = {
          version: 1,
          profiles: {},
          order: {},
          lastGood: {},
          usageStats: {},
        };
        updater(store);
        return store;
      });
    mocks.resolveMemorySearchConfig.mockReset().mockReturnValue(null);
    mocks.prepareSimpleCompletionModelForAgent.mockClear();
    mocks.completeWithPreparedSimpleCompletionModel.mockClear();
    mocks.callGateway.mockReset().mockImplementation((async ({ method }: { method: string }) => {
      if (method === "tts.status") {
        return { enabled: true, provider: "openai" };
      }
      if (method === "tts.convert") {
        return {
          audioPath: "/tmp/gateway-tts.mp3",
          provider: "openai",
          outputFormat: "mp3",
          voiceCompatible: false,
        };
      }
      if (method === "agent") {
        return {
          result: {
            payloads: [{ text: "gateway reply" }],
            meta: { agentMeta: { provider: "anthropic", model: "claude-sonnet-4-6" } },
          },
        };
      }
      return {};
    }) as never);
    mocks.describeImageFile.mockClear();
    mocks.prepareImageDescriptionInput.mockClear();
    mocks.describePreparedImageWithModel.mockClear();
    mocks.describeImageFileWithModel.mockClear();
    mocks.generateImage.mockReset();
    mocks.listRuntimeImageGenerationProviders.mockReset().mockReturnValue([]);
    mocks.generateVideo.mockReset();
    mocks.describeVideoFile.mockReset().mockResolvedValue({
      text: "friendly lobster",
      provider: "openai",
      model: "gpt-4.1-mini",
    } as never);
    mocks.listRuntimeVideoGenerationProviders.mockReset().mockReturnValue([]);
    mocks.transcribeAudioFile.mockClear();
    mocks.textToSpeech.mockClear();
    mocks.setTtsProvider.mockClear();
    mocks.setTtsPersona.mockClear();
    mocks.getTtsProvider.mockReset().mockReturnValue("openai");
    mocks.listSpeechProviders.mockReset().mockReturnValue([]);
    mocks.resolveExplicitTtsOverrides.mockClear();
    mocks.getProviderEnvVars
      .mockReset()
      .mockImplementation((providerId: string) => [
        `${providerId.toUpperCase().replaceAll("-", "_")}_API_KEY`,
      ]);
    mocks.buildMediaUnderstandingRegistry.mockReset().mockReturnValue(new Map());
    mocks.inspectLocalAudioSelection.mockReset().mockResolvedValue({ candidates: [], entries: [] });
    mocks.convertHeicToJpeg.mockClear();
    mocks.createEmbeddingProvider.mockClear();
    closeEmbeddingProviderMock.mockClear();
    mocks.listMemoryEmbeddingProviders
      .mockReset()
      .mockReturnValue([
        { id: "openai", defaultModel: "text-embedding-3-small", transport: "remote" },
      ]);
    mocks.listEmbeddingProviders.mockReset().mockReturnValue([]);
    mocks.listWebSearchProviders.mockReset().mockReturnValue([]);
    mocks.isWebSearchProviderConfigured.mockReset().mockReturnValue(false);
    mocks.isWebFetchProviderConfigured.mockReset().mockReturnValue(false);
    mocks.getModelsCommandSecretTargetIds.mockClear();
    mocks.getMemoryEmbeddingCommandSecretTargetIds.mockClear();
    mocks.getTtsCommandSecretTargetIds.mockClear();
    mocks.getCapabilityWebSearchCommandSecretTargets.mockClear();
    mocks.getCapabilityWebFetchCommandSecretTargets.mockClear();
    mocks.resolveCommandConfigWithSecrets
      .mockReset()
      .mockImplementation(async ({ config }: { config: Record<string, unknown> }) => ({
        resolvedConfig: config,
        effectiveConfig: config,
        diagnostics: [],
      }));
    mocks.modelsStatusCommand.mockClear();
    mocks.modelsAuthLoginCommand.mockClear();
  });

  async function runModelRunWithModel(model: string, transport: "local" | "gateway") {
    await runCapability(
      "model",
      "run",
      "--model",
      model,
      "--prompt",
      "hello",
      ...(transport === "gateway" ? ["--gateway"] : []),
      "--json",
    );
  }

  type GatewayCall = {
    clientName?: unknown;
    method?: unknown;
    mode?: unknown;
    params?: Record<string, unknown>;
    scopes?: unknown;
  };
  type CompletionCall = {
    context?: {
      messages?: Array<{ content?: unknown; role?: unknown }>;
      systemPrompt?: unknown;
    };
    options?: { reasoning?: unknown };
  };
  type ImageDescribeParams = {
    filePath?: string;
    mediaUrl?: string;
    model?: unknown;
    prompt?: unknown;
    provider?: unknown;
    timeoutMs?: unknown;
  };

  function firstGatewayCall() {
    const calls = mocks.callGateway.mock.calls as unknown as Array<[GatewayCall]>;
    return calls[0]?.[0];
  }

  function firstCompletionCall() {
    const calls = mocks.completeWithPreparedSimpleCompletionModel.mock.calls as unknown as Array<
      [CompletionCall]
    >;
    return calls[0]?.[0];
  }

  function firstPreparedModelParams() {
    const calls = mocks.prepareSimpleCompletionModelForAgent.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    return calls[0]?.[0];
  }

  function firstJsonOutput() {
    const calls = mocks.runtime.writeJson.mock.calls as unknown as Array<[Record<string, unknown>]>;
    return calls[0]?.[0];
  }

  function firstCommandConfigResolutionCall() {
    const calls = mocks.resolveCommandConfigWithSecrets.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    return calls[0]?.[0];
  }

  function imageDescribeCall(index = 0) {
    const calls = mocks.describeImageFile.mock.calls as unknown as Array<[ImageDescribeParams]>;
    return calls[index]?.[0];
  }

  function firstImagePrepareCall() {
    const calls = mocks.prepareImageDescriptionInput.mock.calls as unknown as Array<
      [ImageDescribeParams]
    >;
    return calls[0]?.[0];
  }

  function firstImageDescribeWithModelCall() {
    const calls = mocks.describePreparedImageWithModel.mock.calls as unknown as Array<
      [ImageDescribeParams]
    >;
    return calls[0]?.[0];
  }

  function firstImageGenerationCall() {
    const calls = mocks.generateImage.mock.calls as unknown as Array<[Record<string, unknown>]>;
    return calls[0]?.[0];
  }

  function firstVideoGenerationCall() {
    const calls = mocks.generateVideo.mock.calls as unknown as Array<[Record<string, unknown>]>;
    return calls[0]?.[0];
  }

  function firstVideoDescriptionCall() {
    const calls = mocks.describeVideoFile.mock.calls as unknown as Array<[Record<string, unknown>]>;
    return calls[0]?.[0];
  }

  function primeGeneratedVideoUrl(url: string): void {
    mocks.generateVideo.mockResolvedValue({
      provider: "vydra",
      model: "veo3",
      attempts: [],
      videos: [{ url, mimeType: "video/mp4", fileName: "provider-name.mp4" }],
    });
  }

  function primeGeneratedImage(model: string, fileName: string): void {
    mocks.generateImage.mockResolvedValue({
      provider: "openai",
      model,
      attempts: [],
      images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png", fileName }],
    });
  }

  function firstAudioTranscriptionCall() {
    const calls = mocks.transcribeAudioFile.mock.calls as unknown as Array<
      [
        {
          agentDir?: string;
          cfg?: unknown;
          filePath?: string;
          language?: unknown;
          prompt?: unknown;
        },
      ]
    >;
    return calls[0]?.[0];
  }

  function firstTextToSpeechCall() {
    const calls = mocks.textToSpeech.mock.calls as unknown as Array<[Record<string, unknown>]>;
    return calls[0]?.[0];
  }

  function firstEmbeddingProviderCall() {
    const calls = mocks.createEmbeddingProvider.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    return calls[0]?.[0];
  }

  function expectModelRunDispatch(transport: "local" | "gateway", modelRef: string) {
    if (transport === "gateway") {
      const slash = modelRef.indexOf("/");
      const gatewayCall = firstGatewayCall();
      expect(gatewayCall?.method).toBe("agent");
      expect(gatewayCall?.params?.provider).toBe(modelRef.slice(0, slash));
      expect(gatewayCall?.params?.model).toBe(modelRef.slice(slash + 1));
      return;
    }
    expect(firstPreparedModelParams()?.modelRef).toBe(modelRef);
  }

  function runtimeErrorMessages(): string[] {
    return mocks.runtime.error.mock.calls.map((call) => String(call[0] ?? ""));
  }

  function expectRuntimeErrorContains(expected: string): void {
    expect(runtimeErrorMessages().join("\n")).toContain(expected);
  }

  it("lists canonical capabilities", async () => {
    await runCap("capability", "list", "--json");

    const payload = (firstJsonOutput() as unknown as Array<{ id: string }> | undefined) ?? [];
    const ids = payload.map((entry) => entry.id);
    expect(ids).toContain("model.run");
    expect(ids).toContain("image.describe");
  });

  it.each([
    ["list", []],
    ["inspect", ["--model", "openai/gpt-5.4"]],
    ["providers", []],
  ] as const)("keeps model %s catalog inspection read-only", async (command, args) => {
    await runCap("capability", "model", command, ...args, "--json");

    expect(mocks.loadModelCatalog).toHaveBeenCalledWith({
      config: mocks.loadConfig(),
      ...(command === "providers" ? { agentId: "main" } : {}),
      readOnly: true,
    });
  });

  it("renders an explicit empty model list without changing JSON output", async () => {
    mocks.loadModelCatalog.mockResolvedValue([]);

    await runCapability("model", "list", "--json");
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith([]);

    await runCapability("model", "list");
    expect(mocks.runtime.log).toHaveBeenCalledWith("No results found.");
  });

  it("reports model providers configured through their environment key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");

    await runCap("capability", "model", "providers", "--json");

    const providers = firstJsonOutput() as unknown as Array<{
      configured?: boolean;
      provider?: string;
    }>;
    expect(providers).toContainEqual(
      expect.objectContaining({ provider: "openai", configured: true }),
    );
    expect(mocks.getProviderEnvVars).toHaveBeenCalledWith("openai");
  });

  it("scopes provider state and model selection to an explicit agent", async () => {
    const cfg = {
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "beta" } },
        entries: {
          alpha: { model: "anthropic/claude-sonnet-4-6" },
          beta: { model: "openai/gpt-5.4" },
        },
      },
    };
    mocks.loadConfig.mockReturnValue(cfg);
    mocks.loadModelCatalog.mockResolvedValueOnce([
      { id: "claude-sonnet-4-6", provider: "anthropic", name: "Claude" },
      { id: "gpt-5.4", provider: "openai", name: "GPT" },
    ] as never);
    mocks.loadAuthProfileStoreForRuntime.mockImplementation(
      (agentDir) =>
        ({
          profiles:
            agentDir === "/tmp/agent-alpha"
              ? { "anthropic:alpha": { provider: "anthropic" } }
              : { "openai:beta": { provider: "openai" } },
          order: {},
        }) as never,
    );
    mocks.listProfilesForProvider.mockImplementation((store, provider) =>
      Object.entries(store.profiles as Record<string, { provider: string }>)
        .filter(([, profile]) => profile.provider === provider)
        .map(([id]) => id),
    );

    await runCapability("model", "providers", "--agent", "alpha", "--json");

    expect(mocks.loadModelCatalog).toHaveBeenCalledWith({
      config: cfg,
      agentId: "alpha",
      readOnly: true,
    });
    expect(mocks.resolveAgentDir.mock.calls.map((call) => call[1])).toEqual(["alpha", "alpha"]);
    expect(firstJsonOutput()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "anthropic", configured: true, selected: true }),
        expect.objectContaining({ provider: "openai", configured: false, selected: false }),
      ]),
    );
  });

  it("uses the configured system agent for embedding provider state", async () => {
    const cfg = {
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "beta" } },
        entries: { alpha: {}, beta: {} },
      },
    };
    mocks.loadConfig.mockReturnValue(cfg);
    mocks.resolveMemorySearchConfig.mockImplementation(
      (_cfg, agentId) =>
        (agentId === "beta"
          ? { provider: "openai", model: "text-embedding-3-small" }
          : null) as never,
    );

    await runCapability("embedding", "providers", "--json");

    expect(mocks.resolveMemorySearchConfig).toHaveBeenCalledWith(cfg, "beta");
    expect(mocks.resolveAgentDir.mock.calls.every((call) => call[1] === "beta")).toBe(true);
    expect(firstJsonOutput()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "openai", configured: true, selected: true }),
      ]),
    );
  });

  it("requires an explicit owner for agent-backed provider state in explicit fleets", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: {
        ownership: "explicit",
        entries: { alpha: {}, beta: {} },
      },
    });

    await expect(runCapability("audio", "providers", "--json")).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("inference provider inspection has no explicit owner");
    expectRuntimeErrorContains("Pass --agent <id> or set agents.defaults.systemAgent.agentId");
    expect(mocks.loadAuthProfileStoreForRuntime).not.toHaveBeenCalled();
  });

  it.each([
    { position: "parent", systemAgent: undefined },
    { position: "leaf", systemAgent: undefined },
    { position: "parent", systemAgent: "alpha" },
    { position: "leaf", systemAgent: "alpha" },
  ])(
    "scopes audio providers to the $position-level agent with system owner $systemAgent",
    async ({ position, systemAgent }) => {
      const cfg = {
        agents: {
          ownership: "explicit" as const,
          ...(systemAgent ? { defaults: { systemAgent: { agentId: systemAgent } } } : {}),
          entries: { alpha: {}, beta: {} },
        },
      };
      mocks.loadConfig.mockReturnValue(cfg);
      mocks.buildMediaUnderstandingRegistry.mockReturnValueOnce(
        new Map([["openai", { id: "openai", capabilities: ["audio"] }]]),
      );
      mocks.loadAuthProfileStoreForRuntime.mockImplementation(
        (agentDir) =>
          ({
            version: 1,
            profiles:
              agentDir === "/tmp/agent-beta" ? { "openai:beta": { provider: "openai" } } : {},
            order: {},
          }) as never,
      );
      mocks.listProfilesForProvider.mockImplementation((store, provider) =>
        Object.entries(store.profiles as Record<string, { provider: string }>)
          .filter(([, profile]) => profile.provider === provider)
          .map(([id]) => id),
      );

      if (position === "parent") {
        await runCapabilityWithParentAgent("audio", "providers", "beta", "--json");
      } else {
        await runCapability("audio", "providers", "--agent", "beta", "--json");
      }

      expect(mocks.loadAuthProfileStoreForRuntime).toHaveBeenCalledWith("/tmp/agent-beta");
      expect(firstJsonOutput()).toEqual([
        expect.objectContaining({ id: "openai", configured: true }),
      ]);
    },
  );

  it("scopes web search auth inspection to the selected agent", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: {
        ownership: "explicit",
        entries: { alpha: {}, beta: {} },
      },
    });
    const provider = {
      id: "openai",
      envVars: ["OPENAI_API_KEY"],
      requiresCredential: true,
    };
    mocks.listWebSearchProviders.mockReturnValue([provider] as never);

    await runCapability("web", "providers", "--agent", "beta", "--json");

    expect(firstJsonOutput()).toMatchObject({ search: [{ id: "openai" }], fetch: [] });
    expect(mocks.isWebSearchProviderConfigured).toHaveBeenCalledWith({
      provider,
      config: mocks.loadConfig(),
      agentDir: "/tmp/agent-beta",
    });
  });

  it("inspects runtime-declared manifest models without live discovery", async () => {
    mocks.loadModelCatalog.mockResolvedValueOnce([] as never);
    mocks.planEffectiveModelCatalogRows.mockReturnValueOnce({
      rows: [
        {
          provider: "openai",
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          ref: "openai/gpt-5.6-sol",
          mergeKey: "openai/gpt-5.6-sol",
          source: "manifest",
          input: ["text"],
          reasoning: true,
          status: "available",
        },
      ],
      entries: [],
      conflicts: [],
    });

    await runCap("capability", "model", "inspect", "--model", "openai/gpt-5.6-sol", "--json");

    expect(firstJsonOutput()).toEqual(
      expect.objectContaining({ provider: "openai", id: "gpt-5.6-sol" }),
    );
  });

  it("defaults model run to local transport", async () => {
    await runCapability("model", "run", "--prompt", "hello", "--json");

    expect(mocks.prepareSimpleCompletionModelForAgent).toHaveBeenCalledTimes(1);
    expect(mocks.completeWithPreparedSimpleCompletionModel).toHaveBeenCalledTimes(1);
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(firstJsonOutput()?.capability).toBe("model.run");
    expect(firstJsonOutput()?.transport).toBe("local");
  });

  it("runs local model probes through the lean completion path", async () => {
    await runCapability("model", "run", "--prompt", "hello", "--json");

    const preparedParams = firstPreparedModelParams();
    expect(preparedParams?.agentId).toBe("main");
    expect(preparedParams?.allowMissingApiKeyModes).toEqual(["aws-sdk"]);
    expect(preparedParams?.skipAgentDiscovery).toBe(true);
    const call = firstCompletionCall();
    expect(call?.context?.messages?.[0]?.role).toBe("user");
    expect(call?.context?.messages?.[0]?.content).toBe("hello");
    expect(call?.context).not.toHaveProperty("systemPrompt");
  });

  it("uses the configured system agent for local model runs", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { ops: {}, main: {} },
      },
    });

    await runCapability("model", "run", "--local", "--prompt", "hi", "--json");

    expect(firstPreparedModelParams()?.agentId).toBe("ops");
  });

  it("requires an agent owner for model runs in explicit fleets", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: {
        ownership: "explicit",
        entries: { ops: {}, main: {} },
      },
    });

    await expect(
      runCapability("model", "run", "--local", "--prompt", "hi", "--json"),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("infer model run");
    expectRuntimeErrorContains("--agent");
    expectRuntimeErrorContains("agents.defaults.systemAgent.agentId");
  });

  it("lets explicit model run agents override the system agent", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { ops: {}, main: {} },
      },
    });

    await runCapability("model", "run", "--local", "--prompt", "hi", "--agent", "main", "--json");

    expect(firstPreparedModelParams()?.agentId).toBe("main");
  });

  it("rejects unknown model run agents", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { ops: {}, main: {} },
      },
    });

    await expect(
      runCapability("model", "run", "--local", "--prompt", "hi", "--agent", "nope", "--json"),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains('Unknown agent id "nope"');
  });

  it("opts explicit local provider/model probes into bundled static catalog fallback", async () => {
    await runModelRunWithModel("mistral/mistral-medium-3-5", "local");

    const params = firstPreparedModelParams();
    expect(params?.modelRef).toBe("mistral/mistral-medium-3-5");
    expect(params?.allowBundledStaticCatalogFallback).toBe(true);
    expect(params?.skipAgentDiscovery).toBe(true);
  });

  it("does not enable bundled static catalog fallback without an explicit provider/model override", async () => {
    await runCapability("model", "run", "--prompt", "hello", "--json");

    const calls = mocks.prepareSimpleCompletionModelForAgent.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    const params = calls[0]?.[0];
    if (!params) {
      throw new Error("Expected simple completion model params");
    }
    expect(params).not.toHaveProperty("allowBundledStaticCatalogFallback");
  });

  it("passes image files to local model probes", async () => {
    const tempInput = path.join(os.tmpdir(), `openclaw-model-run-image-${Date.now()}.png`);
    await fs.writeFile(tempInput, Buffer.from(PNG_1X1_BASE64, "base64"));

    await runCapability("model", "run", "--prompt", "describe this", "--file", tempInput, "--json");

    const call = firstCompletionCall();
    expect(call?.context?.messages?.[0]?.role).toBe("user");
    expect(call?.context?.messages?.[0]?.content).toEqual([
      { type: "text", text: "describe this" },
      { type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" },
    ]);
    expect(call?.context).not.toHaveProperty("systemPrompt");
    const inputs = firstJsonOutput()?.inputs as Array<{ mimeType?: unknown; path?: unknown }>;
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.path).toBe(tempInput);
    expect(inputs[0]?.mimeType).toBe("image/png");
  });

  it("adds minimal instructions only for openai local model probes", async () => {
    mocks.prepareSimpleCompletionModelForAgent.mockResolvedValueOnce({
      selection: {
        provider: "openai",
        modelId: "gpt-5.5",
        agentDir: "/tmp/agent",
      },
      model: {
        provider: "openai",
        id: "gpt-5.5",
        api: "openai-chatgpt-responses",
        maxTokens: 128,
      },
      auth: {
        apiKey: "codex-app-server",
        source: "codex-app-server",
        mode: "token",
      },
    } as never);

    await runCapability("model", "run", "--model", "openai/gpt-5.5", "--prompt", "hello", "--json");

    const call = firstCompletionCall();
    expect(call?.context?.systemPrompt).toBe(
      "You are a personal assistant running inside OpenClaw.",
    );
    expect(call?.context?.messages?.[0]?.role).toBe("user");
    expect(call?.context?.messages?.[0]?.content).toBe("hello");
  });

  it("passes thinking overrides to local model probes", async () => {
    await runCapability("model", "run", "--prompt", "hello", "--thinking", "high", "--json");

    expect(firstCompletionCall()?.options?.reasoning).toBe("high");
  });

  it("passes image files to gateway model probes as attachments", async () => {
    const tempInput = path.join(os.tmpdir(), `openclaw-model-run-gateway-image-${Date.now()}.png`);
    await fs.writeFile(tempInput, Buffer.from(PNG_1X1_BASE64, "base64"));

    await runCapability(
      "model",
      "run",
      "--prompt",
      "describe this",
      "--file",
      tempInput,
      "--gateway",
      "--json",
    );

    const gatewayCall = firstGatewayCall();
    expect(gatewayCall?.method).toBe("agent");
    expect(gatewayCall?.params?.message).toBe("describe this");
    expect(gatewayCall?.params?.attachments).toEqual([
      {
        type: "image",
        fileName: path.basename(tempInput),
        mimeType: "image/png",
        content: PNG_1X1_BASE64,
      },
    ]);
    expect(gatewayCall?.params?.modelRun).toBe(true);
    expect(gatewayCall?.params?.promptMode).toBe("none");
  });

  it("normalizes HEIC files to JPEG before local model probes", async () => {
    const tempInput = path.join(os.tmpdir(), `openclaw-model-run-image-${Date.now()}.heic`);
    await fs.writeFile(tempInput, Buffer.from("heic-like"));

    await runCapability("model", "run", "--prompt", "describe this", "--file", tempInput, "--json");

    expect(mocks.convertHeicToJpeg).toHaveBeenCalledWith(Buffer.from("heic-like"));
    const call = firstCompletionCall();
    expect(call?.context?.messages?.[0]?.role).toBe("user");
    expect(call?.context?.messages?.[0]?.content).toEqual([
      { type: "text", text: "describe this" },
      {
        type: "image",
        data: Buffer.from("jpeg-normalized").toString("base64"),
        mimeType: "image/jpeg",
      },
    ]);
    const inputs = firstJsonOutput()?.inputs as Array<{ mimeType?: unknown; path?: unknown }>;
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.path).toBe(tempInput);
    expect(inputs[0]?.mimeType).toBe("image/jpeg");
  });

  it("normalizes sniffed HEIC sequences to JPEG before local model probes", async () => {
    const source = createIsomBrandBuffer("hevc");
    const tempInput = path.join(tempDirs.make("openclaw-model-run-heic-sequence-"), "opaque.bin");
    await fs.writeFile(tempInput, source);

    await runCapability("model", "run", "--prompt", "describe this", "--file", tempInput, "--json");

    expect(mocks.convertHeicToJpeg).toHaveBeenCalledWith(source);
    const call = firstCompletionCall();
    expect(call?.context?.messages?.[0]?.content).toEqual([
      { type: "text", text: "describe this" },
      {
        type: "image",
        data: Buffer.from("jpeg-normalized").toString("base64"),
        mimeType: "image/jpeg",
      },
    ]);
    expect(firstJsonOutput()?.inputs).toEqual([{ path: tempInput, mimeType: "image/jpeg" }]);
  });

  it("normalizes sniffed HEIF sequences to JPEG before gateway model probes", async () => {
    const source = createIsomBrandBuffer("msf1");
    const tempInput = path.join(tempDirs.make("openclaw-model-run-heif-sequence-"), "opaque.bin");
    await fs.writeFile(tempInput, source);

    await runCapability(
      "model",
      "run",
      "--prompt",
      "describe this",
      "--file",
      tempInput,
      "--gateway",
      "--json",
    );

    expect(mocks.convertHeicToJpeg).toHaveBeenCalledWith(source);
    expect(firstGatewayCall()?.params?.attachments).toEqual([
      {
        type: "image",
        fileName: "opaque.bin",
        mimeType: "image/jpeg",
        content: Buffer.from("jpeg-normalized").toString("base64"),
      },
    ]);
    expect(firstJsonOutput()?.inputs).toEqual([{ path: tempInput, mimeType: "image/jpeg" }]);
  });

  it("rejects non-image files for model probes", async () => {
    const tempInput = path.join(os.tmpdir(), `openclaw-model-run-audio-${Date.now()}.mp3`);
    await fs.writeFile(tempInput, Buffer.from("not really audio"));

    await expect(
      runCapability("model", "run", "--prompt", "transcribe this", "--file", tempInput, "--json"),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Only image files are supported");
    expect(mocks.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("fails local model probes when the provider returns no text output", async () => {
    mocks.completeWithPreparedSimpleCompletionModel.mockResolvedValueOnce({
      content: [],
    } as never);

    await expect(runCapability("model", "run", "--prompt", "hello", "--json")).rejects.toThrow(
      "exit 1",
    );

    expectRuntimeErrorContains('No text output returned for provider "openai" model "gpt-5.4"');
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("surfaces provider errors when local model probes return no text output", async () => {
    mocks.completeWithPreparedSimpleCompletionModel.mockResolvedValueOnce({
      content: [],
      stopReason: "error",
      errorMessage: '{"detail":"Instructions are required"}',
    } as never);

    await expect(runCapability("model", "run", "--prompt", "hello", "--json")).rejects.toThrow(
      "exit 1",
    );

    expectRuntimeErrorContains('{"detail":"Instructions are required"}');
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("rejects local Codex provider probes before simple-completion dispatch", async () => {
    mocks.prepareSimpleCompletionModelForAgent.mockResolvedValueOnce({
      selection: {
        provider: "codex",
        modelId: "gpt-5.4",
        agentDir: "/tmp/agent",
      },
      model: {
        provider: "codex",
        id: "gpt-5.4",
        api: "openai-chatgpt-responses",
      },
      auth: {
        apiKey: "codex-app-server",
        source: "codex-app-server",
        mode: "token",
      },
    } as never);

    await expect(
      runCapability("model", "run", "--model", "codex/gpt-5.4", "--prompt", "hello", "--json"),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Codex app-server agent runtime");
    expect(mocks.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "\n\t"])(
    "rejects empty model run prompts before local dispatch (%j)",
    async (prompt) => {
      await expect(runCapability("model", "run", "--prompt", prompt, "--json")).rejects.toThrow(
        "exit 1",
      );

      expectRuntimeErrorContains("--prompt cannot be empty or whitespace-only.");
      expect(mocks.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
      expect(mocks.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
      expect(mocks.callGateway).not.toHaveBeenCalled();
      expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    },
  );

  it.each(["local", "gateway"] as const)(
    "rejects malformed explicit model refs before %s dispatch",
    async (transport) => {
      await expect(
        runCap(
          "capability",
          "model",
          "run",
          "--model",
          "not-a-provider/",
          "--prompt",
          "hello",
          ...(transport === "gateway" ? ["--gateway"] : []),
          "--json",
        ),
      ).rejects.toThrow("exit 1");

      expectRuntimeErrorContains("Model overrides must use the form <provider/model>.");
      expect(mocks.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
      expect(mocks.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
      expect(mocks.callGateway).not.toHaveBeenCalled();
    },
  );

  it("runs gateway model probes in fresh raw sessions without chat-agent prompt policy or tools", async () => {
    await runCapability("model", "run", "--prompt", "hello", "--gateway", "--json");

    const gatewayCall = firstGatewayCall();
    const sessionId = gatewayCall?.params?.sessionId;
    expect(gatewayCall?.method).toBe("agent");
    expect(typeof sessionId).toBe("string");
    if (typeof sessionId !== "string") {
      throw new Error("expected gateway model run session id");
    }
    expect(sessionId).toEqual(expect.stringMatching(/^model-run-[0-9a-f-]{36}$/));
    expect(gatewayCall?.params?.sessionKey).toBe(`agent:main:explicit:${sessionId}`);
    expect(gatewayCall?.params?.cleanupBundleMcpOnRunEnd).toBe(true);
    expect(gatewayCall?.params?.modelRun).toBe(true);
    expect(gatewayCall?.params?.promptMode).toBe("none");

    await runCapability("model", "run", "--prompt", "again", "--gateway", "--json");

    const gatewayCalls = mocks.callGateway.mock.calls as unknown as Array<[GatewayCall]>;
    const nextGatewayCall = gatewayCalls[1]?.[0];
    const nextSessionId = nextGatewayCall?.params?.sessionId;
    expect(nextGatewayCall?.method).toBe("agent");
    expect(typeof nextSessionId).toBe("string");
    if (typeof nextSessionId !== "string") {
      throw new Error("expected second gateway model run session id");
    }
    expect(nextSessionId).toEqual(expect.stringMatching(/^model-run-[0-9a-f-]{36}$/));
    expect(nextGatewayCall?.params?.sessionKey).toBe(`agent:main:explicit:${nextSessionId}`);
    expect(nextSessionId).not.toBe(sessionId);
  });

  it("surfaces gateway model fallback attempts in model probe JSON", async () => {
    mocks.callGateway.mockResolvedValueOnce({
      result: {
        payloads: [{ text: "gateway fallback reply" }],
        meta: {
          agentMeta: {
            provider: "openai",
            model: "gpt-4.1-mini",
            fallbackAttempts: [
              {
                provider: "openrouter",
                model: "openrouter/auto",
                error: "model unavailable",
                reason: "model_not_found",
              },
            ],
          },
        },
      },
    } as never);

    await runCapability("model", "run", "--prompt", "hello", "--gateway", "--json");

    const payload = firstJsonOutput();
    const attempts = payload?.attempts as Array<Record<string, unknown>>;
    expect(payload?.provider).toBe("openai");
    expect(payload?.model).toBe("gpt-4.1-mini");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.provider).toBe("openrouter");
    expect(attempts[0]?.model).toBe("openrouter/auto");
    expect(attempts[0]?.reason).toBe("model_not_found");
  });

  it("requests admin scope for gateway model probes with provider/model overrides", async () => {
    await runCapability(
      "model",
      "run",
      "--prompt",
      "hello",
      "--gateway",
      "--model",
      "anthropic/claude-haiku-4-5",
      "--json",
    );

    const gatewayCall = firstGatewayCall();
    expect(gatewayCall?.clientName).toBe("gateway-client");
    expect(gatewayCall?.method).toBe("agent");
    expect(gatewayCall?.mode).toBe("backend");
    expect(gatewayCall?.scopes).toEqual(["operator.admin"]);
    expect(gatewayCall?.params?.provider).toBe("anthropic");
    expect(gatewayCall?.params?.model).toBe("claude-haiku-4-5");
    expect(gatewayCall?.params?.modelRun).toBe(true);
    expect(gatewayCall?.params?.promptMode).toBe("none");
  });

  it.each(["local", "gateway"] as const)(
    "canonicalizes case-only catalog model refs before %s dispatch",
    async (transport) => {
      mocks.loadModelCatalog.mockResolvedValueOnce([
        { id: "claude-opus-4-7", provider: "anthropic", name: "Claude Opus 4.7" },
      ] as never);

      await runModelRunWithModel("Anthropic/CLAUDE-OPUS-4-7", transport);

      const catalogCalls = mocks.loadModelCatalog.mock.calls as unknown as Array<
        [{ readOnly?: unknown }]
      >;
      const catalogParams = catalogCalls[0]?.[0];
      expect(catalogParams?.readOnly).toBe(true);
      expectModelRunDispatch(transport, "anthropic/claude-opus-4-7");
    },
  );

  it("canonicalizes case-only catalog refs and preserves auth profiles before local dispatch", async () => {
    mocks.loadModelCatalog.mockResolvedValueOnce([
      { id: "claude-opus-4-7", provider: "anthropic", name: "Claude Opus 4.7" },
    ] as never);

    await runModelRunWithModel("Anthropic/CLAUDE-OPUS-4-7@work", "local");

    expectModelRunDispatch("local", "anthropic/claude-opus-4-7@work");
  });

  it("leaves auth profile refs unchanged before gateway dispatch", async () => {
    mocks.loadModelCatalog.mockResolvedValueOnce([
      { id: "claude-opus-4-7", provider: "anthropic", name: "Claude Opus 4.7" },
    ] as never);

    await runModelRunWithModel("Anthropic/CLAUDE-OPUS-4-7@work", "gateway");

    expectModelRunDispatch("gateway", "Anthropic/CLAUDE-OPUS-4-7@work");
  });

  it("preserves custom mixed-case profile refs before local dispatch when the catalog has no match", async () => {
    mocks.loadModelCatalog.mockResolvedValueOnce([] as never);

    await runModelRunWithModel("custom/MyModel@work", "local");

    expectModelRunDispatch("local", "custom/MyModel@work");
  });

  it("passes thinking overrides to gateway model probes", async () => {
    await runCapability(
      "model",
      "run",
      "--prompt",
      "hello",
      "--gateway",
      "--thinking",
      "high",
      "--json",
    );

    const gatewayCall = firstGatewayCall();
    expect(gatewayCall?.method).toBe("agent");
    expect(gatewayCall?.params?.thinking).toBe("high");
    expect(gatewayCall?.params?.modelRun).toBe(true);
    expect(gatewayCall?.params?.promptMode).toBe("none");
  });

  it("rejects invalid model run thinking overrides before dispatch", async () => {
    await expect(
      runCapability("model", "run", "--prompt", "hello", "--thinking", "turbo-mode", "--json"),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Invalid thinking level.");
    expect(mocks.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
    expect(mocks.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("rejects empty model run prompts before gateway dispatch", async () => {
    await expect(
      runCapability("model", "run", "--prompt", " ", "--gateway", "--json"),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("--prompt cannot be empty or whitespace-only.");
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("defaults tts status to gateway transport", async () => {
    await runCapability("tts", "status", "--json");

    expect(firstGatewayCall()?.method).toBe("tts.status");
    expect(firstJsonOutput()?.transport).toBe("gateway");
  });

  it.each(
    (["local", "gateway"] as const).flatMap((transport) => [
      { order: "persona then off", selectorArgs: ["--persona", "work", "--off"], transport },
      { order: "off then persona", selectorArgs: ["--off", "--persona", "work"], transport },
    ]),
  )(
    "rejects conflicting TTS persona selectors via $transport ($order)",
    async ({ selectorArgs, transport }) => {
      const argv = ["infer", "tts", "set-persona", ...selectorArgs, `--${transport}`, "--json"];
      const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
      await registerCapabilityCli(program, ["node", "openclaw", ...argv]);

      let error: unknown;
      try {
        await program.parseAsync(argv, { from: "user" });
      } catch (cause) {
        error = cause;
      }

      expect(mocks.callGateway).not.toHaveBeenCalled();
      expect(mocks.setTtsPersona).not.toHaveBeenCalled();
      expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
      expect(error).toMatchObject({
        code: "commander.conflictingOption",
        message: "error: option '--persona <id>' cannot be used with option '--off'",
      });
    },
  );

  it("routes image describe through media understanding, not generation", async () => {
    await runCapability("image", "describe", "--file", "photo.jpg", "--json");

    const describeCall = imageDescribeCall();
    expect(path.basename(describeCall?.filePath ?? "")).toBe("photo.jpg");
    const output = firstJsonOutput();
    const outputs = output?.outputs as Array<Record<string, unknown>>;
    expect(output?.capability).toBe("image.describe");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.kind).toBe("image.description");
  });

  it.each([
    { domain: "audio", action: "transcribe", file: "memo.m4a", result: "meeting notes" },
    { domain: "image", action: "describe", file: "photo.jpg", result: "friendly lobster" },
    { domain: "image", action: "describe-many", file: "photo.jpg", result: "friendly lobster" },
    { domain: "video", action: "describe", file: "clip.mp4", result: "friendly lobster" },
  ])(
    "prints both the input path and result for $domain $action by default",
    async ({ domain, action, file, result }) => {
      await runCapability(domain, action, "--file", file);

      const output = mocks.runtime.log.mock.calls.at(-1)?.[0];
      expect(output).toContain(path.resolve(file));
      expect(output).toContain(result);
    },
  );

  it("keeps encoded image describe HTTP URLs intact", async () => {
    const mediaUrl = "https://cdn.example.com/clip%2Emp4?download=1#preview";
    await runCapability("image", "describe", "--file", mediaUrl, "--json");

    const describeCall = imageDescribeCall();
    expect(describeCall).toMatchObject({ filePath: mediaUrl, mediaUrl });
    const output = firstJsonOutput();
    const outputs = output?.outputs as Array<Record<string, unknown>>;
    expect(outputs[0]?.path).toBe(mediaUrl);
  });

  it("passes image describe prompts through media understanding", async () => {
    await runCapability(
      "image",
      "describe",
      "--file",
      "photo.jpg",
      "--prompt",
      "Read the menu text",
      "--timeout-ms",
      "90000",
      "--json",
    );

    const describeCall = imageDescribeCall();
    expect(path.basename(describeCall?.filePath ?? "")).toBe("photo.jpg");
    expect(describeCall?.prompt).toBe("Read the menu text");
    expect(describeCall?.timeoutMs).toBe(90000);
  });

  it("keeps image describe URL files as remote media references", async () => {
    await runCapability("image", "describe", "--file", "https://example.com/photo.png", "--json");

    const describeCall = imageDescribeCall();
    expect(describeCall?.filePath).toBe("https://example.com/photo.png");
    expect(describeCall?.mediaUrl).toBe("https://example.com/photo.png");
    const outputs = firstJsonOutput()?.outputs as Array<Record<string, unknown>>;
    expect(outputs[0]?.path).toBe("https://example.com/photo.png");
  });

  it("uses the explicit media-understanding provider for image describe model overrides", async () => {
    await runCapability(
      "image",
      "describe",
      "--file",
      "photo.jpg",
      "--model",
      "ollama/qwen2.5vl:7b",
      "--prompt",
      "Count visible buttons",
      "--timeout-ms",
      "120000",
      "--json",
    );

    const prepareCall = firstImagePrepareCall();
    const describeCall = firstImageDescribeWithModelCall();
    expect(path.basename(prepareCall?.filePath ?? "")).toBe("photo.jpg");
    expect(describeCall?.provider).toBe("ollama");
    expect(describeCall?.model).toBe("qwen2.5vl:7b");
    expect(describeCall?.prompt).toBe("Count visible buttons");
    expect(describeCall?.timeoutMs).toBe(120000);
    expect(mocks.describeImageFile).not.toHaveBeenCalled();
    expect(firstJsonOutput()?.provider).toBe("ollama");
    expect(firstJsonOutput()?.model).toBe("gpt-4.1-mini");
  });

  it("keeps explicit-model image describe URL files as remote media references", async () => {
    await runCapability(
      "image",
      "describe",
      "--file",
      "https://example.com/photo.png",
      "--model",
      "ollama/qwen2.5vl:7b",
      "--json",
    );

    const prepareCall = firstImagePrepareCall();
    expect(prepareCall?.filePath).toBe("https://example.com/photo.png");
    expect(prepareCall?.mediaUrl).toBe("https://example.com/photo.png");
    expect(mocks.describeImageFile).not.toHaveBeenCalled();
    const outputs = firstJsonOutput()?.outputs as Array<Record<string, unknown>>;
    expect(outputs[0]?.path).toBe("https://example.com/photo.png");
  });

  it("keeps explicit-model image describe HTTP URLs as URLs", async () => {
    await runCapability(
      "image",
      "describe",
      "--file",
      "https://httpbin.org/image/png",
      "--model",
      "minimax-cn/MiniMax-VL-01",
      "--json",
    );

    const prepareCall = firstImagePrepareCall();
    const describeCall = firstImageDescribeWithModelCall();
    expect(prepareCall?.filePath).toBe("https://httpbin.org/image/png");
    expect(describeCall?.provider).toBe("minimax-cn");
    expect(describeCall?.model).toBe("MiniMax-VL-01");
    expect(mocks.describeImageFile).not.toHaveBeenCalled();
  });

  it("falls back to configured image models for explicit-model image describe", async () => {
    mocks.resolveCommandConfigWithSecrets.mockResolvedValueOnce({
      resolvedConfig: {},
      effectiveConfig: {
        agents: {
          defaults: {
            imageModel: {
              primary: "openrouter/google/gemma-4-31b-it:free",
              fallbacks: ["openrouter/google/gemma-4-31b-it"],
            },
          },
        },
      },
      diagnostics: [],
    });
    mocks.describePreparedImageWithModel
      .mockRejectedValueOnce(new Error("upstream 429 rate limit"))
      .mockResolvedValueOnce({
        text: "fallback description",
        model: "google/gemma-4-31b-it",
      });

    await runCapability(
      "image",
      "describe",
      "--file",
      "photo.jpg",
      "--model",
      "openrouter/google/gemma-4-31b-it:free",
      "--json",
    );

    expect(mocks.prepareImageDescriptionInput).toHaveBeenCalledTimes(1);
    const calls = mocks.describePreparedImageWithModel.mock.calls as unknown as Array<
      [ImageDescribeParams]
    >;
    expect(calls.map(([call]) => `${String(call.provider)}/${String(call.model)}`)).toEqual([
      "openrouter/google/gemma-4-31b-it:free",
      "openrouter/google/gemma-4-31b-it",
    ]);
    expect(firstJsonOutput()).toMatchObject({
      ok: true,
      capability: "image.describe",
      provider: "openrouter",
      model: "google/gemma-4-31b-it",
      attempts: [
        {
          provider: "openrouter",
          model: "google/gemma-4-31b-it:free",
          error: "upstream 429 rate limit",
        },
      ],
      outputs: [
        {
          text: "fallback description",
          model: "google/gemma-4-31b-it",
        },
      ],
    });
  });

  it("does not retry image input preparation failures as model fallbacks", async () => {
    mocks.resolveCommandConfigWithSecrets.mockResolvedValueOnce({
      resolvedConfig: {},
      effectiveConfig: {
        agents: {
          defaults: {
            imageModel: {
              primary: "openrouter/google/gemma-4-31b-it:free",
              fallbacks: ["openrouter/google/gemma-4-31b-it"],
            },
          },
        },
      },
      diagnostics: [],
    });
    mocks.prepareImageDescriptionInput.mockRejectedValueOnce(new Error("image file not found"));

    await expect(
      runCapability(
        "image",
        "describe",
        "--file",
        "missing.jpg",
        "--model",
        "openrouter/google/gemma-4-31b-it:free",
        "--json",
      ),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("image file not found");
    expect(runtimeErrorMessages().join("\n")).not.toContain("All image models failed");
    expect(mocks.describePreparedImageWithModel).not.toHaveBeenCalled();
  });

  it("passes describe-many prompts to each image", async () => {
    await runCapability(
      "image",
      "describe-many",
      "--file",
      "a.jpg",
      "--file",
      "b.jpg",
      "--prompt",
      "Extract all visible labels",
      "--timeout-ms",
      "45000",
      "--json",
    );

    expect(mocks.describeImageFile).toHaveBeenCalledTimes(2);
    const firstDescribe = imageDescribeCall(0);
    const secondDescribe = imageDescribeCall(1);
    expect(path.basename(firstDescribe?.filePath ?? "")).toBe("a.jpg");
    expect(firstDescribe?.prompt).toBe("Extract all visible labels");
    expect(firstDescribe?.timeoutMs).toBe(45000);
    expect(path.basename(secondDescribe?.filePath ?? "")).toBe("b.jpg");
    expect(secondDescribe?.prompt).toBe("Extract all visible labels");
    expect(secondDescribe?.timeoutMs).toBe(45000);
  });

  it("fails image describe when no description text is returned", async () => {
    mocks.describeImageFile.mockResolvedValueOnce({
      text: undefined,
      provider: undefined,
      model: undefined,
    } as never);

    await expect(
      runCapability("image", "describe", "--file", "photo.jpg", "--json"),
    ).rejects.toThrow("exit 1");
    expect(runtimeErrorMessages()).toEqual([
      `No description returned for image: ${path.resolve("photo.jpg")}`,
    ]);
  });

  it.each([
    { command: "describe", checksImageModel: true },
    { command: "describe-many", checksImageModel: false },
  ])(
    "reports missing image understanding configuration for image $command",
    async ({ command, checksImageModel }) => {
      mocks.describeImageFile.mockResolvedValueOnce({
        text: undefined,
        decision: {
          capability: "image",
          outcome: "skipped",
          attachments: [{ attachmentIndex: 0, attempts: [] }],
        },
      } as never);

      await expect(
        runCap("capability", "image", command, "--file", "photo.jpg", "--json"),
      ).rejects.toThrow("exit 1");
      expectRuntimeErrorContains("No image understanding provider is configured or ready");
      if (checksImageModel) {
        expectRuntimeErrorContains("agents.defaults.imageModel.primary");
      }
    },
  );

  it("rewrites mismatched explicit image output extensions to the detected file type", async () => {
    const jpegBase64 =
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBUQEBAVFRUVFRUVFRUVFRUVFRUVFRUXFhUVFRUYHSggGBolHRUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGhAQGi0fHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAXAAEBAQEAAAAAAAAAAAAAAAAAAQID/8QAFhEBAQEAAAAAAAAAAAAAAAAAAAER/9oADAMBAAIQAxAAAAH2AP/EABgQAQEAAwAAAAAAAAAAAAAAAAEAEQIS/9oACAEBAAEFAk1o7//EABYRAQEBAAAAAAAAAAAAAAAAAAABEf/aAAgBAwEBPwGn/8QAFhEBAQEAAAAAAAAAAAAAAAAAABEB/9oACAECAQE/AYf/xAAaEAACAgMAAAAAAAAAAAAAAAABEQAhMUFh/9oACAEBAAY/AjK9cY2f/8QAGhABAQACAwAAAAAAAAAAAAAAAAERITFBUf/aAAgBAQABPyGQk7W5jVYkA//Z";
    mocks.generateImage.mockResolvedValue({
      provider: "openai",
      model: "gpt-image-1",
      attempts: [],
      images: [
        {
          buffer: Buffer.from(jpegBase64, "base64"),
          mimeType: "image/png",
          fileName: "provider-output.png",
        },
      ],
    });

    const tempOutput = path.join(os.tmpdir(), `openclaw-image-mismatch-${Date.now()}.png`);
    await fs.rm(tempOutput, { force: true });
    await fs.rm(tempOutput.replace(/\.png$/, ".jpg"), { force: true });

    await runCapability(
      "image",
      "generate",
      "--prompt",
      "friendly lobster",
      "--output",
      tempOutput,
      "--json",
    );

    const outputs = firstJsonOutput()?.outputs as Array<Record<string, unknown>>;
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.path).toBe(tempOutput.replace(/\.png$/, ".jpg"));
    expect(outputs[0]?.mimeType).toBe("image/jpeg");
  });

  it("passes image generation timeout through to runtime", async () => {
    primeGeneratedImage("gpt-image-1", "provider-output.png");

    await runCapability(
      "image",
      "generate",
      "--prompt",
      "friendly lobster",
      "--timeout-ms",
      "180000",
      "--json",
    );

    expect(firstImageGenerationCall()?.prompt).toBe("friendly lobster");
    expect(firstImageGenerationCall()?.timeoutMs).toBe(180000);
  });

  it("keeps image generation owner selection explicit in multi-agent fleets", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: { entries: { alpha: {}, beta: {} }, ownership: "explicit" },
    });

    await expect(
      runCapability("image", "generate", "--prompt", "friendly lobster", "--json"),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Multiple agents are configured");
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it.each([
    { agent: "", message: "--agent must not be blank" },
    { agent: "retired", message: 'Unknown agent id "retired"' },
  ])(
    "rejects invalid image generation agent '$agent' before dispatch",
    async ({ agent, message }) => {
      mocks.loadConfig.mockReturnValue({
        agents: { entries: { alpha: {}, beta: {} }, ownership: "explicit" },
      });

      await expect(
        runCapability(
          "image",
          "generate",
          "--agent",
          agent,
          "--prompt",
          "friendly lobster",
          "--json",
        ),
      ).rejects.toThrow("exit 1");

      expectRuntimeErrorContains(message);
      expect(mocks.generateImage).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "model run",
      run: () => runCapability("model", "run", "--agent", "beta", "--prompt", "hello", "--json"),
      selectedAgent: () => firstPreparedModelParams()?.agentId,
      expectedAgent: "beta",
    },
    {
      name: "image generate",
      run: () => {
        primeGeneratedImage("gpt-image-1", "provider-output.png");
        return runCapability(
          "image",
          "generate",
          "--agent",
          "beta",
          "--prompt",
          "portrait",
          "--json",
        );
      },
      selectedAgent: () => firstImageGenerationCall()?.agentDir,
      expectedAgent: "/tmp/agent-beta",
    },
    {
      name: "image edit",
      run: async () => {
        const inputDir = tempDirs.make("openclaw-image-agent-");
        const inputPath = path.join(inputDir, "input.png");
        await fs.writeFile(inputPath, Buffer.from(PNG_1X1_BASE64, "base64"));
        primeGeneratedImage("gpt-image-1", "provider-output.png");
        await runCapability(
          "image",
          "edit",
          "--agent",
          "beta",
          "--file",
          inputPath,
          "--prompt",
          "crop it",
          "--json",
        );
      },
      selectedAgent: () => firstImageGenerationCall()?.agentDir,
      expectedAgent: "/tmp/agent-beta",
    },
    {
      name: "image describe",
      run: () =>
        runCapability("image", "describe", "--agent", "beta", "--file", "photo.png", "--json"),
      selectedAgent: () => mocks.resolveAgentDir.mock.calls[0]?.[1],
      expectedAgent: "beta",
    },
    {
      name: "image describe-many",
      run: () =>
        runCapability("image", "describe-many", "--agent", "beta", "--file", "photo.png", "--json"),
      selectedAgent: () => mocks.resolveAgentDir.mock.calls[0]?.[1],
      expectedAgent: "beta",
    },
    {
      name: "audio transcribe",
      run: () =>
        runCapability("audio", "transcribe", "--agent", "beta", "--file", "memo.m4a", "--json"),
      selectedAgent: () => firstAudioTranscriptionCall()?.agentDir,
      expectedAgent: "/tmp/agent-beta",
    },
    {
      name: "video generate",
      run: () => {
        mocks.generateVideo.mockResolvedValue({
          provider: "minimax",
          model: "MiniMax-Hailuo-2.3",
          attempts: [],
          videos: [
            {
              buffer: Buffer.from("video-bytes"),
              mimeType: "video/mp4",
              fileName: "provider-name.mp4",
            },
          ],
        });
        return runCapability("video", "generate", "--agent", "beta", "--prompt", "clip", "--json");
      },
      selectedAgent: () => firstVideoGenerationCall()?.agentDir,
      expectedAgent: "/tmp/agent-beta",
    },
    {
      name: "video describe",
      run: () =>
        runCapability("video", "describe", "--agent", "beta", "--file", "clip.mp4", "--json"),
      selectedAgent: () => firstVideoDescriptionCall()?.agentDir,
      expectedAgent: "/tmp/agent-beta",
    },
    {
      name: "embedding create",
      run: () =>
        runCapability("embedding", "create", "--agent", "beta", "--text", "hello", "--json"),
      selectedAgent: () => firstEmbeddingProviderCall()?.agentDir,
      expectedAgent: "/tmp/agent-beta",
    },
  ])(
    "routes --agent through $name owner selection",
    async ({ run, selectedAgent, expectedAgent }) => {
      mocks.loadConfig.mockReturnValue({
        agents: { entries: { alpha: {}, beta: {} }, ownership: "explicit" },
      });

      await run();

      expect(selectedAgent()).toBe(expectedAgent);
    },
  );

  it.each([
    {
      name: "model run",
      run: () =>
        runCapabilityWithParentAgent("model", "run", "beta", "--prompt", "hello", "--json"),
      selectedAgent: () => firstPreparedModelParams()?.agentId,
      expectedAgent: "beta",
    },
    {
      name: "image generate",
      run: () => {
        primeGeneratedImage("gpt-image-1", "provider-output.png");
        return runCapabilityWithParentAgent(
          "image",
          "generate",
          "beta",
          "--prompt",
          "portrait",
          "--json",
        );
      },
      selectedAgent: () => firstImageGenerationCall()?.agentDir,
      expectedAgent: "/tmp/agent-beta",
    },
    {
      name: "image edit",
      run: async () => {
        const inputDir = tempDirs.make("openclaw-image-parent-agent-");
        const inputPath = path.join(inputDir, "input.png");
        await fs.writeFile(inputPath, Buffer.from(PNG_1X1_BASE64, "base64"));
        primeGeneratedImage("gpt-image-1", "provider-output.png");
        await runCapabilityWithParentAgent(
          "image",
          "edit",
          "beta",
          "--file",
          inputPath,
          "--prompt",
          "crop it",
          "--json",
        );
      },
      selectedAgent: () => firstImageGenerationCall()?.agentDir,
      expectedAgent: "/tmp/agent-beta",
    },
    {
      name: "image describe",
      run: () =>
        runCapabilityWithParentAgent("image", "describe", "beta", "--file", "photo.png", "--json"),
      selectedAgent: () => mocks.resolveAgentDir.mock.calls[0]?.[1],
      expectedAgent: "beta",
    },
    {
      name: "image describe-many",
      run: () =>
        runCapabilityWithParentAgent(
          "image",
          "describe-many",
          "beta",
          "--file",
          "photo.png",
          "--json",
        ),
      selectedAgent: () => mocks.resolveAgentDir.mock.calls[0]?.[1],
      expectedAgent: "beta",
    },
    {
      name: "audio transcribe",
      run: () =>
        runCapabilityWithParentAgent("audio", "transcribe", "beta", "--file", "memo.m4a", "--json"),
      selectedAgent: () => firstAudioTranscriptionCall()?.agentDir,
      expectedAgent: "/tmp/agent-beta",
    },
    {
      name: "video generate",
      run: () => {
        mocks.generateVideo.mockResolvedValue({
          provider: "minimax",
          model: "MiniMax-Hailuo-2.3",
          attempts: [],
          videos: [
            {
              buffer: Buffer.from("video-bytes"),
              mimeType: "video/mp4",
              fileName: "provider-name.mp4",
            },
          ],
        });
        return runCapabilityWithParentAgent(
          "video",
          "generate",
          "beta",
          "--prompt",
          "clip",
          "--json",
        );
      },
      selectedAgent: () => firstVideoGenerationCall()?.agentDir,
      expectedAgent: "/tmp/agent-beta",
    },
    {
      name: "video describe",
      run: () =>
        runCapabilityWithParentAgent("video", "describe", "beta", "--file", "clip.mp4", "--json"),
      selectedAgent: () => firstVideoDescriptionCall()?.agentDir,
      expectedAgent: "/tmp/agent-beta",
    },
    {
      name: "embedding create",
      run: () =>
        runCapabilityWithParentAgent("embedding", "create", "beta", "--text", "hello", "--json"),
      selectedAgent: () => firstEmbeddingProviderCall()?.agentDir,
      expectedAgent: "/tmp/agent-beta",
    },
  ])(
    "inherits parent --agent through $name owner selection",
    async ({ run, selectedAgent, expectedAgent }) => {
      mocks.loadConfig.mockReturnValue({
        agents: { entries: { alpha: {}, beta: {} }, ownership: "explicit" },
      });

      await run();

      expect(selectedAgent()).toBe(expectedAgent);
    },
  );

  it("prefers a leaf --agent over the parent selector", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: { entries: { alpha: {}, beta: {} }, ownership: "explicit" },
    });
    primeGeneratedImage("gpt-image-1", "provider-output.png");

    await runCap(
      "capability",
      "image",
      "--agent",
      "alpha",
      "generate",
      "--agent",
      "beta",
      "--prompt",
      "portrait",
      "--json",
    );

    expect(firstImageGenerationCall()?.agentDir).toBe("/tmp/agent-beta");
  });

  it.each([
    { agent: "", message: "--agent must not be blank" },
    { agent: "retired", message: 'Unknown agent id "retired"' },
  ])("rejects invalid inherited agent '$agent' before dispatch", async ({ agent, message }) => {
    mocks.loadConfig.mockReturnValue({
      agents: { entries: { alpha: {}, beta: {} }, ownership: "explicit" },
    });

    await expect(
      runCapabilityWithParentAgent(
        "image",
        "generate",
        agent,
        "--prompt",
        "friendly lobster",
        "--json",
      ),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains(message);
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it("passes image output format and generic background hints through to generation runtime", async () => {
    primeGeneratedImage("gpt-image-1.5", "transparent.png");

    await runCapability(
      "image",
      "generate",
      "--prompt",
      "transparent sticker",
      "--model",
      "openai/gpt-image-1.5",
      "--output-format",
      "png",
      "--background",
      "transparent",
      "--json",
    );

    const generationCall = firstImageGenerationCall();
    expect(generationCall?.prompt).toBe("transparent sticker");
    expect(generationCall?.modelOverride).toBe("openai/gpt-image-1.5");
    expect(generationCall?.outputFormat).toBe("png");
    expect(generationCall?.background).toBe("transparent");
    expect(generationCall?.providerOptions).toBeUndefined();
  });

  it("passes image quality and OpenAI moderation hints through to generation runtime", async () => {
    primeGeneratedImage("gpt-image-2", "draft.png");

    await runCapability(
      "image",
      "generate",
      "--prompt",
      "low-cost draft",
      "--quality",
      "low",
      "--openai-moderation",
      "low",
      "--json",
    );

    const generationCall = firstImageGenerationCall();
    expect(generationCall?.prompt).toBe("low-cost draft");
    expect(generationCall?.quality).toBe("low");
    expect(generationCall?.providerOptions).toEqual({
      openai: {
        moderation: "low",
      },
    });
  });

  it("passes image output format, quality, and OpenAI hints through to edit runtime", async () => {
    primeGeneratedImage("gpt-image-1.5", "transparent-edit.png");
    const inputPath = path.join(os.tmpdir(), `openclaw-image-edit-${Date.now()}.png`);
    await fs.writeFile(inputPath, Buffer.from("png-input"));

    await runCapability(
      "image",
      "edit",
      "--file",
      inputPath,
      "--prompt",
      "make background transparent",
      "--model",
      "openai/gpt-image-1.5",
      "--output-format",
      "png",
      "--openai-background",
      "transparent",
      "--openai-moderation",
      "auto",
      "--quality",
      "high",
      "--json",
    );

    const generationCall = firstImageGenerationCall();
    const inputImages = generationCall?.inputImages as Array<Record<string, unknown>>;
    expect(generationCall?.prompt).toBe("make background transparent");
    expect(generationCall?.modelOverride).toBe("openai/gpt-image-1.5");
    expect(generationCall?.outputFormat).toBe("png");
    expect(generationCall?.quality).toBe("high");
    expect(generationCall?.background).toBeUndefined();
    expect(generationCall?.providerOptions).toEqual({
      openai: {
        background: "transparent",
        moderation: "auto",
      },
    });
    expect(inputImages).toHaveLength(1);
    expect(inputImages[0]?.fileName).toBe(path.basename(inputPath));
  });

  it("forwards --count through to the image edit runtime", async () => {
    primeGeneratedImage("gpt-image-1.5", "edit.png");
    const inputPath = path.join(os.tmpdir(), `openclaw-image-edit-count-${Date.now()}.png`);
    await fs.writeFile(inputPath, Buffer.from("png-input"));

    await runCapability(
      "image",
      "edit",
      "--file",
      inputPath,
      "--file",
      inputPath,
      "--prompt",
      "make three variants",
      "--count",
      "3",
      "--json",
    );

    expect(firstImageGenerationCall()?.count).toBe(3);
    expect(firstImageGenerationCall()?.inputImages).toHaveLength(2);
  });

  it("rejects unsupported image output format and background hints", async () => {
    await expect(
      runCapability(
        "image",
        "generate",
        "--prompt",
        "transparent sticker",
        "--output-format",
        "gif",
        "--json",
      ),
    ).rejects.toThrow("exit 1");
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "--output-format must be one of png, jpeg, or webp",
    );

    mocks.runtime.error.mockClear();
    await expect(
      runCapability(
        "image",
        "generate",
        "--prompt",
        "transparent sticker",
        "--openai-background",
        "clear",
        "--json",
      ),
    ).rejects.toThrow("exit 1");
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "--openai-background must be one of transparent, opaque, or auto",
    );

    mocks.runtime.error.mockClear();
    await expect(
      runCapability(
        "image",
        "generate",
        "--prompt",
        "transparent sticker",
        "--background",
        "clear",
        "--json",
      ),
    ).rejects.toThrow("exit 1");
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "--background must be one of transparent, opaque, or auto",
    );

    mocks.runtime.error.mockClear();
    await expect(
      runCapability(
        "image",
        "generate",
        "--prompt",
        "transparent sticker",
        "--quality",
        "expensive",
        "--json",
      ),
    ).rejects.toThrow("exit 1");
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "--quality must be one of low, medium, high, or auto",
    );

    mocks.runtime.error.mockClear();
    await expect(
      runCapability(
        "image",
        "generate",
        "--prompt",
        "transparent sticker",
        "--openai-moderation",
        "none",
        "--json",
      ),
    ).rejects.toThrow("exit 1");
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "--openai-moderation must be one of low or auto",
    );
  });

  it("forwards size, aspect ratio, and resolution overrides for image edit", async () => {
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yf7kAAAAASUVORK5CYII=";
    mocks.generateImage.mockResolvedValue({
      provider: "openai",
      model: "gpt-image-2",
      attempts: [],
      images: [
        {
          buffer: Buffer.from(pngBase64, "base64"),
          mimeType: "image/png",
          fileName: "provider-output.png",
        },
      ],
    });

    const tempInput = path.join(os.tmpdir(), `openclaw-image-edit-input-${Date.now()}.png`);
    const tempOutput = path.join(os.tmpdir(), `openclaw-image-edit-output-${Date.now()}.png`);
    await fs.writeFile(tempInput, Buffer.from(pngBase64, "base64"));
    await fs.rm(tempOutput, { force: true });

    await runCapability(
      "image",
      "edit",
      "--file",
      tempInput,
      "--prompt",
      "remove the background object",
      "--model",
      "openai/gpt-image-2",
      "--size",
      "2160x3840",
      "--aspect-ratio",
      "9:16",
      "--resolution",
      "4K",
      "--output",
      tempOutput,
      "--json",
    );

    const generationCall = firstImageGenerationCall();
    const inputImages = generationCall?.inputImages as Array<Record<string, unknown>>;
    expect(generationCall?.prompt).toBe("remove the background object");
    expect(generationCall?.modelOverride).toBe("openai/gpt-image-2");
    expect(generationCall?.size).toBe("2160x3840");
    expect(generationCall?.aspectRatio).toBe("9:16");
    expect(generationCall?.resolution).toBe("4K");
    expect(inputImages).toHaveLength(1);
    expect(inputImages[0]?.fileName).toBe(path.basename(tempInput));
    expect(inputImages[0]?.mimeType).toBe("image/png");
  });

  it("reports the expanded image.edit flags in capability inspect", async () => {
    await runCapability("inspect", "--name", "image.edit", "--json");

    expect(firstJsonOutput()?.id).toBe("image.edit");
    expect(firstJsonOutput()?.flags).toEqual([
      "--file",
      "--prompt",
      "--model",
      "--count",
      "--size",
      "--aspect-ratio",
      "--resolution",
      "--output-format",
      "--background",
      "--openai-background",
      "--openai-moderation",
      "--quality",
      "--timeout-ms",
      "--output",
      "--agent",
      "--json",
    ]);
  });

  it("reports the expanded image.generate flags in capability inspect", async () => {
    await runCapability("inspect", "--name", "image.generate", "--json");

    expect(firstJsonOutput()?.id).toBe("image.generate");
    expect(firstJsonOutput()?.flags).toEqual([
      "--prompt",
      "--model",
      "--count",
      "--size",
      "--aspect-ratio",
      "--resolution",
      "--output-format",
      "--background",
      "--openai-background",
      "--openai-moderation",
      "--quality",
      "--timeout-ms",
      "--output",
      "--agent",
      "--json",
    ]);
  });

  it("keeps capability inspect metadata flags in sync with each command's registered options", async () => {
    const program = new Command();
    await registerCapabilityCli(program, ["node", "openclaw", "infer", "--help"]);
    const capability =
      program.commands.find((command) => command.name() === "infer") ??
      program.commands.find((command) => command.aliases().includes("capability"));
    expect(capability).toBeDefined();

    const registeredFlags = (id: string): string[] => {
      let command: Command | undefined = capability;
      for (const segment of id.split(".")) {
        command = command?.commands.find((child) => child.name() === segment);
      }
      if (!command) {
        throw new Error(`no registered command for capability id ${id}`);
      }
      return command.options
        .map((option) => option.long)
        .filter((long): long is string => Boolean(long));
    };

    // CAPABILITY_METADATA.flags is the inspect/list contract; it must list exactly what each
    // command actually registers, or `infer inspect` reports working flags as unsupported.
    for (const entry of CAPABILITY_METADATA) {
      expect({ id: entry.id, flags: entry.flags }).toEqual({
        id: entry.id,
        flags: registeredFlags(entry.id),
      });
    }
  });

  it("streams url-only generated videos to --output paths", async () => {
    primeGeneratedVideoUrl("https://example.com/generated-video.mp4");
    const fetchMock = vi.fn(
      async () =>
        new Response(Buffer.from("video-bytes"), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tempDir = tempDirs.make("openclaw-video-generate-");
    const outputBase = path.join(tempDir, "result");
    const outputPath = `${outputBase}.mp4`;
    await fs.writeFile(outputPath, "previous-video");
    await fs.chmod(outputPath, 0o640);

    try {
      await runCapability(
        "video",
        "generate",
        "--prompt",
        "friendly lobster",
        "--output",
        outputBase,
        "--json",
      );

      const fetchCalls = fetchMock.mock.calls as unknown as Array<[string, { signal?: unknown }]>;
      const fetchCall = fetchCalls[0];
      expect(fetchCall?.[0]).toBe("https://example.com/generated-video.mp4");
      expect(fetchCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(await fs.readFile(outputPath, "utf8")).toBe("video-bytes");
      if (process.platform !== "win32") {
        expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o640);
      }
      expect(await fs.readdir(tempDir)).toEqual(["result.mp4"]);
      const output = firstJsonOutput();
      const outputs = output?.outputs as Array<Record<string, unknown>>;
      expect(output?.capability).toBe("video.generate");
      expect(output?.provider).toBe("vydra");
      expect(outputs).toHaveLength(1);
      expect(outputs[0]?.path).toBe(outputPath);
      expect(outputs[0]?.mimeType).toBe("video/mp4");
      expect(outputs[0]?.size).toBe(11);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves an existing --output and removes its temp when a video stream fails", async () => {
    primeGeneratedVideoUrl("https://example.com/broken-video.mp4");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial-video"));
        controller.error(new Error("video stream exploded"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "video/mp4" },
          }),
      ),
    );
    const tempDir = tempDirs.make("openclaw-video-stream-fail-");
    const outputBase = path.join(tempDir, "result");
    const outputPath = `${outputBase}.mp4`;
    await fs.writeFile(outputPath, "keep-existing-video");

    try {
      await expect(
        runCapability(
          "video",
          "generate",
          "--prompt",
          "friendly lobster",
          "--output",
          outputBase,
          "--json",
        ),
      ).rejects.toThrow("exit 1");

      expectRuntimeErrorContains("video stream exploded");
      expect(await fs.readFile(outputPath, "utf8")).toBe("keep-existing-video");
      expect(await fs.readdir(tempDir)).toEqual(["result.mp4"]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    { kind: "image", extension: ".png", original: "existing-image", byte: 0x49 },
    { kind: "video", extension: ".mp4", original: "existing-video", byte: 0x56 },
  ])(
    "preserves an existing buffered $kind --output when publication fails",
    async ({ kind, extension, original, byte }) => {
      const buffer = Buffer.alloc(2_048, byte);
      if (kind === "image") {
        mocks.generateImage.mockResolvedValue({
          provider: "openai",
          model: "gpt-image-2",
          attempts: [],
          images: [{ buffer, mimeType: "image/png", fileName: "generated.png" }],
        });
      } else {
        mocks.generateVideo.mockResolvedValue({
          provider: "openai",
          model: "sora-2",
          attempts: [],
          videos: [{ buffer, mimeType: "video/mp4", fileName: "generated.mp4" }],
        });
      }

      const tempDir = tempDirs.make(`openclaw-buffered-${kind}-fail-`);
      const outputBase = path.join(tempDir, "result");
      const outputPath = `${outputBase}${extension}`;
      await fs.writeFile(outputPath, original);
      await fs.chmod(outputPath, 0o640);

      const writeFile = fs.writeFile.bind(fs);
      const writeFileSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        const [filePath, data, options] = args;
        if (typeof filePath === "string" && Buffer.isBuffer(data) && data.equals(buffer)) {
          await writeFile(filePath, data.subarray(0, 17), options);
          throw new Error("injected buffered media write failure");
        }
        await writeFile(...args);
      });

      try {
        await expect(
          runCapability(
            kind,
            "generate",
            "--prompt",
            "friendly lobster",
            "--output",
            outputBase,
            "--json",
          ),
        ).rejects.toThrow("exit 1");

        expectRuntimeErrorContains("injected buffered media write failure");
        expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
        expect(await fs.readFile(outputPath, "utf8")).toBe(original);
        if (process.platform !== "win32") {
          expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o640);
        }
        expect(await fs.readdir(tempDir)).toEqual([`result${extension}`]);
      } finally {
        writeFileSpy.mockRestore();
      }
    },
  );

  it("blocks private-network url-only generated video downloads by default", async () => {
    mocks.loadConfig.mockReturnValue({});
    primeGeneratedVideoUrl("http://127.0.0.2:40123/private-video.mp4?sig=secret-presigned-token");
    const fetchMock = vi.fn(
      async () =>
        new Response(Buffer.from("video-bytes"), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runCapability("video", "generate", "--prompt", "friendly lobster", "--json"),
    ).rejects.toThrow("exit 1");

    expect(fetchMock).not.toHaveBeenCalled();
    expectRuntimeErrorContains("Blocked hostname or private/internal/special-use IP address");
    expect(runtimeErrorMessages().join("\n")).not.toContain("secret-presigned-token");
    expect(runtimeErrorMessages().join("\n")).not.toContain("/private-video.mp4");
  });

  it("allows private-network generated video downloads when the provider request opts in", async () => {
    mocks.loadConfig.mockReturnValue({
      models: {
        providers: {
          vydra: {
            request: { allowPrivateNetwork: true },
          },
        },
      },
    });
    primeGeneratedVideoUrl("http://127.0.0.2:40123/private-video.mp4");
    const fetchMock = vi.fn(
      async () =>
        new Response(Buffer.from("video-bytes"), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runCapability("video", "generate", "--prompt", "friendly lobster", "--json");

    const fetchCalls = fetchMock.mock.calls as unknown as Array<[string]>;
    expect(fetchCalls[0]?.[0]).toBe("http://127.0.0.2:40123/private-video.mp4");
    const output = firstJsonOutput();
    expect(output?.capability).toBe("video.generate");
    expect(output?.provider).toBe("vydra");
    expect(output?.outputs as Array<Record<string, unknown>>).toHaveLength(1);
  });

  it("passes video generation parameters through to runtime", async () => {
    mocks.generateVideo.mockResolvedValue({
      provider: "minimax",
      model: "MiniMax-Hailuo-2.3",
      attempts: [],
      videos: [
        {
          buffer: Buffer.from("video-bytes"),
          mimeType: "video/mp4",
          fileName: "provider-name.mp4",
        },
      ],
    });

    await runCapability(
      "video",
      "generate",
      "--prompt",
      "friendly lobster",
      "--model",
      "minimax/MiniMax-Hailuo-2.3",
      "--size",
      "1280x768",
      "--aspect-ratio",
      "16:9",
      "--resolution",
      "768p",
      "--duration",
      "6",
      "--audio",
      "--watermark",
      "--timeout-ms",
      "300000",
      "--json",
    );

    const videoCall = firstVideoGenerationCall();
    expect(videoCall?.prompt).toBe("friendly lobster");
    expect(videoCall?.modelOverride).toBe("minimax/MiniMax-Hailuo-2.3");
    expect(videoCall?.size).toBe("1280x768");
    expect(videoCall?.aspectRatio).toBe("16:9");
    expect(videoCall?.resolution).toBe("768P");
    expect(videoCall?.durationSeconds).toBe(6);
    expect(videoCall?.audio).toBe(true);
    expect(videoCall?.watermark).toBe(true);
    expect(videoCall?.timeoutMs).toBe(300000);
  });

  it("fails video generate when a provider returns an undeliverable asset", async () => {
    mocks.generateVideo.mockResolvedValue({
      provider: "vydra",
      model: "veo3",
      attempts: [],
      videos: [{ mimeType: "video/mp4" }],
    });

    await expect(
      runCapability("video", "generate", "--prompt", "friendly lobster", "--json"),
    ).rejects.toThrow("exit 1");
    expectRuntimeErrorContains("Video asset at index 0 has neither buffer nor url");
  });

  it("fails closed when an url-only generated video exceeds the in-memory byte cap", async () => {
    mocks.loadConfig.mockReturnValue({});
    primeGeneratedVideoUrl("https://example.com/oversized-video.mp4?sig=secret-presigned-token");
    // Offer far more than the 16 MiB default video cap in 1 MiB chunks so the
    // bounded reader has to cancel mid-stream instead of buffering it all. The
    // source would yield 64 MiB if fully drained; a correct guard stops early.
    const oneMiBChunk = new Uint8Array(1024 * 1024);
    const overCapChunks = 64;
    let enqueued = 0;
    let canceled = false;
    const oversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (enqueued >= overCapChunks) {
          controller.close();
          return;
        }
        enqueued += 1;
        controller.enqueue(oneMiBChunk);
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(oversizedBody, {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // No --output: forces the in-memory buffered fallback path.
    await expect(
      runCapability("video", "generate", "--prompt", "friendly lobster", "--json"),
    ).rejects.toThrow("exit 1");

    // Real path was driven: the provider URL was actually fetched...
    const fetchCalls = fetchMock.mock.calls as unknown as Array<[string]>;
    expect(fetchCalls[0]?.[0]).toBe(
      "https://example.com/oversized-video.mp4?sig=secret-presigned-token",
    );
    // ...and the read was rejected (fail-closed) referencing the provider label
    // and the 16 MiB default cap rather than buffering the body.
    expectRuntimeErrorContains("vydra generated video download exceeds 16777216 bytes");
    // Security regression guard: the overflow error must NOT echo the raw
    // provider URL (it may carry signed/tokenized access material). See the
    // sibling generated-media downloaders, which report provider + cap only.
    expect(runtimeErrorMessages().join("\n")).not.toContain("secret-presigned-token");
    expect(runtimeErrorMessages().join("\n")).not.toContain("https://example.com");
    // The reader cancelled shortly after crossing the 16 MiB cap rather than
    // draining the full 64 MiB the source was willing to produce.
    expect(canceled).toBe(true);
    expect(enqueued).toBeLessThan(overCapChunks);
    expect(enqueued).toBeLessThanOrEqual(18);
  });

  it("redacts provider video URLs when the no-output download fails", async () => {
    mocks.loadConfig.mockReturnValue({});
    primeGeneratedVideoUrl("https://example.com/private-video.mp4?sig=secret-presigned-token");
    const fetchMock = vi.fn(
      async () =>
        new Response("download forbidden", {
          status: 403,
          statusText: "Forbidden",
          headers: { "content-type": "text/plain" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runCapability("video", "generate", "--prompt", "friendly lobster", "--json"),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("vydra generated video download failed");
    expectRuntimeErrorContains("HTTP 403");
    expect(runtimeErrorMessages().join("\n")).not.toContain("secret-presigned-token");
    expect(runtimeErrorMessages().join("\n")).not.toContain("https://example.com");
  });

  it("buffers an url-only generated video that stays under the byte cap", async () => {
    mocks.loadConfig.mockReturnValue({});
    primeGeneratedVideoUrl("https://example.com/small-video.mp4");
    const fetchMock = vi.fn(
      async () =>
        new Response(Buffer.from("small-video-bytes"), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // No --output: in-memory buffered fallback path, under cap.
    await runCapability("video", "generate", "--prompt", "friendly lobster", "--json");

    const fetchCalls = fetchMock.mock.calls as unknown as Array<[string]>;
    expect(fetchCalls[0]?.[0]).toBe("https://example.com/small-video.mp4");
    const output = firstJsonOutput();
    expect(output?.capability).toBe("video.generate");
    expect(output?.provider).toBe("vydra");
    expect(output?.outputs as Array<Record<string, unknown>>).toHaveLength(1);
    // No overflow error on the under-cap path.
    expect(runtimeErrorMessages().join("\n")).not.toContain("exceeds");
  });

  it("honors a smaller configured mediaMaxMb cap on the in-memory video path", async () => {
    // Operators can lower the cap via agents.defaults.mediaMaxMb; the bounded
    // read must respect it (here 2 MiB) and cancel even earlier.
    mocks.loadConfig.mockReturnValue({ agents: { defaults: { mediaMaxMb: 2 } } });
    primeGeneratedVideoUrl("https://example.com/over-2mb-video.mp4");
    const oneMiBChunk = new Uint8Array(1024 * 1024);
    const totalChunks = 16;
    let enqueued = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (enqueued >= totalChunks) {
          controller.close();
          return;
        }
        enqueued += 1;
        controller.enqueue(oneMiBChunk);
      },
    });
    const fetchMock = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": "video/mp4" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runCapability("video", "generate", "--prompt", "friendly lobster", "--json"),
    ).rejects.toThrow("exit 1");

    // Cap resolved from config (2 MiB = 2097152), not the 16 MiB default.
    expectRuntimeErrorContains("vydra generated video download exceeds 2097152 bytes");
    // Cancelled after crossing 2 MiB, far below the 16 MiB the source offered.
    expect(enqueued).toBeLessThanOrEqual(4);
  });

  it.each([
    { mode: "buffered", withOutput: false },
    { mode: "streamed", withOutput: true },
  ])("rejects an empty-body url-only generated video in $mode mode", async ({ withOutput }) => {
    mocks.loadConfig.mockReturnValue({});
    primeGeneratedVideoUrl("https://example.com/empty-video.mp4");
    const fetchMock = vi.fn(
      async () =>
        new Response(Buffer.alloc(0), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tempDir = withOutput ? tempDirs.make("openclaw-empty-video-") : undefined;
    const outputBase = tempDir ? path.join(tempDir, "result") : undefined;
    const outputPath = outputBase ? `${outputBase}.mp4` : undefined;
    if (outputPath) {
      await fs.writeFile(outputPath, "keep-existing-video");
    }

    try {
      await expect(
        runCapability(
          "video",
          "generate",
          "--prompt",
          "friendly lobster",
          ...(outputBase ? ["--output", outputBase] : []),
          "--json",
        ),
      ).rejects.toThrow("exit 1");

      expectRuntimeErrorContains("Generated media output is empty");
      expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
      if (tempDir && outputPath) {
        expect(await fs.readFile(outputPath, "utf8")).toBe("keep-existing-video");
        expect(await fs.readdir(tempDir)).toEqual(["result.mp4"]);
      }
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("rejects successful textual responses from generated video URLs", async () => {
    mocks.loadConfig.mockReturnValue({});
    primeGeneratedVideoUrl("https://example.com/not-a-video.mp4");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("render still processing", {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      ),
    );

    await expect(
      runCapability("video", "generate", "--prompt", "friendly lobster", "--json"),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("vydra generated video download: malformed video response");
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("rejects partial image generate count before provider dispatch", async () => {
    await expect(
      runCapability("image", "generate", "--prompt", "portrait", "--count", "2x"),
    ).rejects.toThrow("exit 1");
    expectRuntimeErrorContains("--count must be a positive integer");
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it("rejects partial image generate timeout before provider dispatch", async () => {
    await expect(
      runCapability("image", "generate", "--prompt", "portrait", "--timeout-ms", "1000ms"),
    ).rejects.toThrow("exit 1");
    expectRuntimeErrorContains("Invalid --timeout. Use a positive millisecond value");
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it.each([
    [
      "image generate",
      ["capability", "image", "generate", "--prompt", "portrait", "--timeout-ms", "1000ms"],
    ],
    [
      "image edit",
      [
        "capability",
        "image",
        "edit",
        "--file",
        "photo.png",
        "--prompt",
        "crop it",
        "--timeout-ms",
        "1000ms",
      ],
    ],
    [
      "image describe",
      ["capability", "image", "describe", "--file", "photo.png", "--timeout-ms", "1000ms"],
    ],
    [
      "image describe-many",
      ["capability", "image", "describe-many", "--file", "photo.png", "--timeout-ms", "1000ms"],
    ],
    [
      "video generate",
      ["capability", "video", "generate", "--prompt", "clip", "--timeout-ms", "1000ms"],
    ],
  ])("rejects malformed %s timeout before provider dispatch", async (_name, argv) => {
    await expect(runCap(...argv)).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Invalid --timeout. Use a positive millisecond value");
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.generateVideo).not.toHaveBeenCalled();
    expect(mocks.describeImageFile).not.toHaveBeenCalled();
    expect(mocks.describeImageFileWithModel).not.toHaveBeenCalled();
  });

  it("routes audio transcribe through transcription, not realtime", async () => {
    await runCapability("audio", "transcribe", "--file", "memo.m4a", "--json");

    expect(path.basename(firstAudioTranscriptionCall()?.filePath ?? "")).toBe("memo.m4a");
    const output = firstJsonOutput();
    const outputs = output?.outputs as Array<Record<string, unknown>>;
    expect(output?.capability).toBe("audio.transcribe");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.kind).toBe("audio.transcription");
  });

  it("resolves command SecretRefs before local audio transcription", async () => {
    const rawConfig = { models: { providers: { openai: { apiKey: "raw-ref" } } } };
    const resolvedConfig = { models: { providers: { openai: { apiKey: "resolved-key" } } } };
    mocks.loadConfig.mockReturnValue(rawConfig);
    mocks.resolveCommandConfigWithSecrets.mockResolvedValueOnce({
      resolvedConfig,
      effectiveConfig: resolvedConfig,
      diagnostics: [],
    } as never);

    await runCapability("audio", "transcribe", "--file", "memo.m4a", "--json");

    expect(firstCommandConfigResolutionCall()).toEqual(
      expect.objectContaining({
        config: rawConfig,
        commandName: "infer audio transcribe",
      }),
    );
    expect(
      (
        expectDefined(
          firstCommandConfigResolutionCall(),
          "firstCommandConfigResolutionCall() test invariant",
        ).targetIds as Set<string>
      ).has("models.providers.*.apiKey"),
    ).toBe(true);
    expect(firstAudioTranscriptionCall()?.cfg).toBe(resolvedConfig);
  });

  it("fails audio transcribe when no transcript text is returned", async () => {
    mocks.transcribeAudioFile.mockResolvedValueOnce({ text: undefined } as never);

    await expect(
      runCapability("audio", "transcribe", "--file", "memo.m4a", "--json"),
    ).rejects.toThrow("exit 1");
    expect(runtimeErrorMessages()).toEqual([
      `No transcript returned for audio: ${path.resolve("memo.m4a")}`,
    ]);
  });

  it("reports missing audio transcription configuration for audio transcribe", async () => {
    mocks.transcribeAudioFile.mockResolvedValueOnce({
      text: undefined,
      decision: {
        capability: "audio",
        outcome: "skipped",
        attachments: [{ attachmentIndex: 0, attempts: [] }],
      },
    } as never);

    await expect(
      runCapability("audio", "transcribe", "--file", "memo.m4a", "--json"),
    ).rejects.toThrow("exit 1");
    expectRuntimeErrorContains("No audio transcription provider is configured or ready");
    expectRuntimeErrorContains("tools.media.models");
  });

  it("surfaces the underlying transcription failure for audio transcribe", async () => {
    mocks.transcribeAudioFile.mockRejectedValueOnce(
      new Error("Audio transcription response missing text"),
    );

    await expect(
      runCapability("audio", "transcribe", "--file", "memo.m4a", "--json"),
    ).rejects.toThrow("exit 1");
    expect(runtimeErrorMessages()).toEqual(["Audio transcription response missing text"]);
  });

  it("forwards transcription prompt and language hints", async () => {
    await runCapability(
      "audio",
      "transcribe",
      "--file",
      "memo.m4a",
      "--language",
      "en",
      "--prompt",
      "Focus on names",
      "--json",
    );

    const transcribeCall = firstAudioTranscriptionCall();
    expect(path.basename(transcribeCall?.filePath ?? "")).toBe("memo.m4a");
    expect(transcribeCall?.language).toBe("en");
    expect(transcribeCall?.prompt).toBe("Focus on names");
  });

  it("uses request-scoped TTS overrides without mutating prefs", async () => {
    await runCapability(
      "tts",
      "convert",
      "--text",
      "hello",
      "--model",
      "openai/gpt-4o-mini-tts",
      "--voice",
      "alloy",
      "--json",
    );

    const ttsCall = firstTextToSpeechCall();
    const overrides = ttsCall?.overrides as
      | {
          provider?: unknown;
          providerOverrides?: { openai?: { modelId?: unknown; voiceId?: unknown } };
        }
      | undefined;
    expect(overrides?.provider).toBe("openai");
    expect(overrides?.providerOverrides?.openai?.modelId).toBe("gpt-4o-mini-tts");
    expect(overrides?.providerOverrides?.openai?.voiceId).toBe("alloy");
    expect(mocks.setTtsProvider).not.toHaveBeenCalled();
  });

  it("hydrates local TTS provider config from API-key auth profiles", async () => {
    const rawConfig = { tts: { providers: { openai: { voice: "coral" } } } };
    mocks.loadConfig.mockReturnValue(rawConfig);
    primeOpenAiAuthProfile();

    await runCapability(
      "tts",
      "convert",
      "--text",
      "hello",
      "--model",
      "openai/gpt-4o-mini-tts",
      "--json",
    );

    expect(mocks.resolveApiKeyForProviderCore).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        cfg: rawConfig,
        credentialPrecedence: "profile-first",
      }),
    );
    const cfg = firstTextToSpeechCall()?.cfg as {
      tts?: { providers?: { openai?: { apiKey?: string; voice?: string } } };
    };
    expect(cfg.tts?.providers?.openai).toMatchObject({
      apiKey: "profile-openai-key",
      voice: "coral",
    });
    expect(mocks.setRuntimeConfigSnapshot).toHaveBeenLastCalledWith(cfg);
  });

  it("hydrates local TTS default provider config from API-key auth profiles", async () => {
    const rawConfig = { tts: { provider: "openai" } };
    mocks.loadConfig.mockReturnValue(rawConfig);
    primeOpenAiAuthProfile();

    await runCapability("tts", "convert", "--text", "hello", "--json");

    expect(mocks.resolveApiKeyForProviderCore).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        cfg: rawConfig,
        credentialPrecedence: "profile-first",
      }),
    );
    const cfg = firstTextToSpeechCall()?.cfg as {
      tts?: { providers?: { openai?: { apiKey?: string } } };
    };
    expect(cfg.tts?.providers?.openai).toMatchObject({
      apiKey: "profile-openai-key",
    });
  });

  it("hydrates local TTS channel provider config from API-key auth profiles", async () => {
    const rawConfig = { channels: { discord: { tts: { provider: "openai" } } } };
    mocks.loadConfig.mockReturnValue(rawConfig);
    primeOpenAiAuthProfile();

    await runCapability("tts", "convert", "--text", "hello", "--channel", "discord", "--json");

    expect(mocks.resolveTtsConfig).toHaveBeenCalledWith(rawConfig, { channelId: "discord" });
    expect(mocks.resolveExplicitTtsOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "discord" }),
    );
    const cfg = firstTextToSpeechCall()?.cfg as {
      tts?: { providers?: { openai?: { apiKey?: string } } };
    };
    expect(cfg.tts?.providers?.openai).toMatchObject({
      apiKey: "profile-openai-key",
    });
  });

  it("hydrates local TTS channel direct provider config from API-key auth profiles", async () => {
    const rawConfig = {
      channels: {
        discord: {
          tts: {
            openai: { speakerVoice: "nova" },
          },
        },
      },
    };
    mocks.loadConfig.mockReturnValue(rawConfig);
    primeOpenAiAuthProfile();

    await runCapability("tts", "convert", "--text", "hello", "--channel", "discord", "--json");

    const cfg = firstTextToSpeechCall()?.cfg as {
      channels?: {
        discord?: { tts?: { openai?: { apiKey?: string; speakerVoice?: string } } };
      };
      tts?: { providers?: { openai?: { apiKey?: string } } };
    };
    expect(cfg.channels?.discord?.tts?.openai).toMatchObject({
      apiKey: "profile-openai-key",
      speakerVoice: "nova",
    });
    expect(cfg.tts?.providers?.openai).toBeUndefined();
    expect(mocks.setRuntimeConfigSnapshot).toHaveBeenLastCalledWith(cfg);
  });

  it("does not override inherited local TTS channel provider API keys", async () => {
    const rawConfig = {
      tts: { providers: { openai: { apiKey: "config-key" } } },
      channels: {
        discord: {
          tts: {
            providers: { openai: { speakerVoice: "nova" } },
          },
        },
      },
    };
    mocks.loadConfig.mockReturnValue(rawConfig);
    mocks.resolveTtsConfig.mockReturnValue({
      providerConfigs: { openai: { apiKey: "config-key", speakerVoice: "nova" } },
    });
    primeOpenAiAuthProfile();

    await runCapability("tts", "convert", "--text", "hello", "--channel", "discord", "--json");

    const cfg = firstTextToSpeechCall()?.cfg as {
      tts?: { providers?: { openai?: { apiKey?: string } } };
      channels?: {
        discord?: { tts?: { providers?: { openai?: { apiKey?: string; speakerVoice?: string } } } };
      };
    };
    expect(cfg.tts?.providers?.openai?.apiKey).toBe("config-key");
    expect(cfg.channels?.discord?.tts?.providers?.openai).toEqual({ speakerVoice: "nova" });
    expect(mocks.resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  });

  it("does not hydrate local TTS provider config from token auth profiles", async () => {
    const rawConfig = { tts: { provider: "openai" } };
    mocks.loadConfig.mockReturnValue(rawConfig);
    primeOpenAiAuthProfile("token");

    await runCapability("tts", "convert", "--text", "hello", "--json");

    const cfg = firstTextToSpeechCall()?.cfg as {
      tts?: { providers?: { openai?: { apiKey?: string } } };
    };
    expect(cfg.tts?.providers?.openai?.apiKey).toBeUndefined();
  });

  it("does not override existing TTS provider API keys with different casing", async () => {
    const rawConfig = { tts: { providers: { OpenAI: { apiKey: "config-key" } } } };
    mocks.loadConfig.mockReturnValue(rawConfig);
    primeOpenAiAuthProfile();

    await runCapability(
      "tts",
      "convert",
      "--text",
      "hello",
      "--model",
      "openai/gpt-4o-mini-tts",
      "--json",
    );

    const cfg = firstTextToSpeechCall()?.cfg as {
      tts?: { providers?: { openai?: { apiKey?: string }; OpenAI?: { apiKey?: string } } };
    };
    expect(cfg.tts?.providers?.OpenAI?.apiKey).toBe("config-key");
    expect(cfg.tts?.providers?.openai).toBeUndefined();
  });

  it("does not override existing direct TTS provider API keys", async () => {
    const rawConfig = { tts: { openai: { apiKey: "config-key" } } };
    mocks.loadConfig.mockReturnValue(rawConfig);
    primeOpenAiAuthProfile();

    await runCapability(
      "tts",
      "convert",
      "--text",
      "hello",
      "--model",
      "openai/gpt-4o-mini-tts",
      "--json",
    );

    const cfg = firstTextToSpeechCall()?.cfg as {
      tts?: {
        openai?: { apiKey?: string };
        providers?: { openai?: { apiKey?: string } };
      };
    };
    expect(cfg.tts?.openai?.apiKey).toBe("config-key");
    expect(cfg.tts?.providers?.openai).toBeUndefined();
  });

  it("disables TTS fallback when explicit provider or voice/model selection is requested", async () => {
    await runCapability(
      "tts",
      "convert",
      "--text",
      "hello",
      "--model",
      "openai/gpt-4o-mini-tts",
      "--voice",
      "alloy",
      "--json",
    );

    expect(firstTextToSpeechCall()?.disableFallback).toBe(true);
  });

  it("selects a TTS provider without inventing a model override", async () => {
    await runCap(
      "capability",
      "tts",
      "convert",
      "--text",
      "hello",
      "--provider",
      "xiaomi",
      "--json",
    );

    expect(mocks.resolveExplicitTtsOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "xiaomi", modelId: undefined }),
    );
    expect(firstTextToSpeechCall()?.disableFallback).toBe(true);
  });

  it("rejects conflicting TTS provider and model selections", async () => {
    await expect(
      runCap(
        "capability",
        "tts",
        "convert",
        "--text",
        "hello",
        "--provider",
        "xiaomi",
        "--model",
        "openai/gpt-4o-mini-tts",
        "--json",
      ),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("TTS --provider must match the provider in --model.");
  });

  it("accepts equivalent TTS provider casing with a model selection", async () => {
    await runCap(
      "capability",
      "tts",
      "convert",
      "--text",
      "hello",
      "--provider",
      "OpenAI",
      "--model",
      "openai/gpt-4o-mini-tts",
      "--json",
    );

    expect(mocks.resolveExplicitTtsOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", modelId: "gpt-4o-mini-tts" }),
    );
  });

  it("does not infer and forward a local provider guess for gateway TTS overrides", async () => {
    await runCapability(
      "tts",
      "convert",
      "--gateway",
      "--text",
      "hello",
      "--voice",
      "alloy",
      "--json",
    );

    expect(firstGatewayCall()?.method).toBe("tts.convert");
    expect(firstGatewayCall()?.params?.provider).toBeUndefined();
    expect(firstGatewayCall()?.params?.voiceId).toBe("alloy");
  });

  it("fails clearly when gateway TTS output is requested against a remote gateway", async () => {
    const gatewayConnection = await import("../gateway/connection-details.js");
    vi.mocked(gatewayConnection.buildGatewayConnectionDetailsWithResolvers).mockReturnValueOnce({
      url: "wss://gateway.example.com",
      urlSource: "config gateway.remote.url",
      message: "Gateway target: wss://gateway.example.com",
    });

    await expect(
      runCapability(
        "tts",
        "convert",
        "--gateway",
        "--text",
        "hello",
        "--output",
        "hello.mp3",
        "--json",
      ),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("--output is not supported for remote gateway TTS yet");
  });

  it.each(["local", "gateway"] as const)(
    "preserves an existing %s TTS --output when the final copy fails",
    async (transport) => {
      const tempDir = tempDirs.make(`openclaw-tts-${transport}-copy-fail-`);
      const sourcePath = path.join(tempDir, "source.mp3");
      const outputDir = path.join(tempDir, "output");
      const outputPath = path.join(outputDir, "speech.mp3");
      await fs.mkdir(outputDir);
      await fs.writeFile(sourcePath, Buffer.alloc(2_048, 0x41));
      await fs.writeFile(outputPath, "existing-speech");
      await fs.chmod(outputPath, 0o640);

      if (transport === "gateway") {
        mocks.callGateway.mockResolvedValueOnce({
          audioPath: sourcePath,
          provider: "openai",
          outputFormat: "mp3",
          voiceCompatible: false,
        } as never);
      } else {
        mocks.textToSpeech.mockResolvedValueOnce({
          success: true,
          audioPath: sourcePath,
          provider: "openai",
          outputFormat: "mp3",
          voiceCompatible: false,
          attempts: [],
        });
      }

      const copyFile = fs.copyFile.bind(fs);
      const copyFileSpy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
        const [source, destination] = args;
        if (source === sourcePath) {
          const bytes = await fs.readFile(source);
          await fs.writeFile(destination, bytes.subarray(0, 17));
          throw new Error("injected TTS copy failure");
        }
        await copyFile(...args);
      });

      try {
        await expect(
          runCapability(
            "tts",
            "convert",
            `--${transport}`,
            "--text",
            "hello",
            "--output",
            outputPath,
            "--json",
          ),
        ).rejects.toThrow("exit 1");

        expectRuntimeErrorContains("injected TTS copy failure");
        expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
        expect(await fs.readFile(outputPath, "utf8")).toBe("existing-speech");
        if (process.platform !== "win32") {
          expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o640);
        }
        expect(await fs.readdir(outputDir)).toEqual(["speech.mp3"]);
      } finally {
        copyFileSpy.mockRestore();
      }
    },
  );

  it("uses only embedding providers for embedding creation", async () => {
    await runCapability("embedding", "create", "--text", "hello", "--text", "world", "--json");

    expect(firstEmbeddingProviderCall()?.provider).toBe("auto");
    expect(firstEmbeddingProviderCall()?.fallback).toBe("none");
    expect(firstJsonOutput()?.capability).toBe("embedding.create");
    expect(firstJsonOutput()?.provider).toBe("openai");
    expect(firstJsonOutput()?.model).toBe("text-embedding-3-small");
    expect(firstJsonOutput()).toMatchObject({
      outputs: [
        { text: "hello", embedding: [0.1, 0.2] },
        { text: "world", embedding: [0.1, 0.2] },
      ],
    });
    expect(mocks.embedBatch).toHaveBeenCalledWith(["hello", "world"], { inputType: "document" });
    expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(1);
  });

  it("closes the embedding provider without masking embedding failure", async () => {
    closeEmbeddingProviderMock.mockRejectedValueOnce(new Error("close failed"));
    mocks.createEmbeddingProvider.mockResolvedValueOnce({
      provider: {
        id: "openai",
        model: "text-embedding-3-small",
        embed: async () => [0.1, 0.2],
        embedBatch: async () => {
          throw new Error("embedding failed");
        },
        close: closeEmbeddingProviderMock,
      },
    });

    await expect(runCapability("embedding", "create", "--text", "hello", "--json")).rejects.toThrow(
      "exit 1",
    );

    expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(2);
    expectRuntimeErrorContains("embedding failed");
  });

  it("retries embedding provider cleanup before reporting close failure", async () => {
    closeEmbeddingProviderMock
      .mockRejectedValueOnce(new Error("close failed"))
      .mockRejectedValueOnce(new Error("close failed"));

    await expect(runCapability("embedding", "create", "--text", "hello", "--json")).rejects.toThrow(
      "exit 1",
    );

    expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(2);
    expectRuntimeErrorContains("close failed");
  });

  it("resolves command SecretRefs before local model capability execution", async () => {
    const rawConfig = { agents: { defaults: { model: "openai/gpt-5.4" } } };
    const resolvedConfig = { agents: { defaults: { model: "openai/gpt-5.4" } }, resolved: true };
    mocks.loadConfig.mockReturnValue(rawConfig);
    mocks.resolveCommandConfigWithSecrets.mockResolvedValueOnce({
      resolvedConfig,
      effectiveConfig: resolvedConfig,
      diagnostics: [],
    } as never);

    await runCapability("model", "run", "--prompt", "hello", "--json");

    expect(firstCommandConfigResolutionCall()).toEqual(
      expect.objectContaining({
        config: rawConfig,
        commandName: "infer model run",
        runtime: mocks.runtime,
      }),
    );
    expect(
      (
        expectDefined(
          firstCommandConfigResolutionCall(),
          "firstCommandConfigResolutionCall() test invariant",
        ).targetIds as Set<string>
      ).has("models.providers.*.apiKey"),
    ).toBe(true);
    expect(firstPreparedModelParams()?.cfg).toBe(resolvedConfig);
    expect(mocks.setRuntimeConfigSnapshot).toHaveBeenCalledWith(resolvedConfig);
  });

  it("derives the embedding provider from a provider/model override", async () => {
    await runCapability(
      "embedding",
      "create",
      "--text",
      "hello",
      "--model",
      "openai/text-embedding-3-large",
      "--json",
    );

    expect(firstEmbeddingProviderCall()?.provider).toBe("openai");
    expect(firstEmbeddingProviderCall()?.fallback).toBe("none");
    expect(firstEmbeddingProviderCall()?.model).toBe("text-embedding-3-large");
  });

  it.each([
    {
      name: "embedding create",
      argv: ["capability", "embedding", "create", "--text", "hello"],
    },
    {
      name: "image generate",
      argv: ["capability", "image", "generate", "--prompt", "portrait"],
    },
    {
      name: "image edit",
      argv: ["capability", "image", "edit", "--file", "photo.png", "--prompt", "crop it"],
    },
    {
      name: "video generate",
      argv: ["capability", "video", "generate", "--prompt", "clip"],
    },
  ])("rejects malformed model refs before $name provider dispatch", async ({ argv }) => {
    for (const model of ["openai/", "/gpt-4.1-mini"]) {
      await expect(runCap(...argv, "--model", model, "--json")).rejects.toThrow("exit 1");
      expectRuntimeErrorContains("Model overrides must use the form <provider/model>.");
      expect(mocks.resolveCommandConfigWithSecrets).not.toHaveBeenCalled();
      expect(mocks.createEmbeddingProvider).not.toHaveBeenCalled();
      expect(mocks.generateImage).not.toHaveBeenCalled();
      expect(mocks.generateVideo).not.toHaveBeenCalled();
    }
  });

  it("cleans provider auth profiles and usage stats on logout", async () => {
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue({
      profiles: {
        "openai:default": { id: "openai:default" },
        "openai:secondary": { id: "openai:secondary" },
        "anthropic:default": { id: "anthropic:default" },
      },
      order: { openai: ["openai:default", "openai:secondary"] },
      lastGood: { openai: "openai:secondary" },
      usageStats: {
        "openai:default": { errorCount: 2 },
        "openai:secondary": { errorCount: 1 },
        "anthropic:default": { errorCount: 3 },
      },
    } as never);
    mocks.listProfilesForProvider.mockReturnValue(["openai:default", "openai:secondary"] as never);

    let updatedStore: Record<string, any> | null = null;
    mocks.updateAuthProfileStoreWithLock.mockImplementationOnce(
      async ({ updater }: { updater: (store: any) => boolean }) => {
        const store = {
          version: 1,
          profiles: {
            "openai:default": { id: "openai:default" },
            "openai:secondary": { id: "openai:secondary" },
            "anthropic:default": { id: "anthropic:default" },
          },
          order: { openai: ["openai:default", "openai:secondary"] },
          lastGood: { openai: "openai:secondary" },
          usageStats: {
            "openai:default": { errorCount: 2 },
            "openai:secondary": { errorCount: 1 },
            "anthropic:default": { errorCount: 3 },
          },
        };
        updater(store);
        updatedStore = store;
        return store;
      },
    );

    await runCapability("model", "auth", "logout", "--provider", "openai", "--json");

    if (updatedStore === null) {
      throw new Error("expected updated auth store");
    }
    const storeSnapshot = updatedStore as unknown as Record<string, any>;
    expect(storeSnapshot.profiles).toEqual({
      "anthropic:default": { id: "anthropic:default" },
    });
    expect(storeSnapshot.order).toEqual({});
    expect(storeSnapshot.lastGood).toEqual({});
    expect(storeSnapshot.usageStats).toEqual({
      "anthropic:default": { errorCount: 3 },
    });
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
      provider: "openai",
      removedProfiles: ["openai:default", "openai:secondary"],
    });
    expect(mocks.updateAuthProfileStoreWithLock).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: "/tmp/agent-main" }),
    );
  });

  it("removes model auth profiles from the selected agent store", async () => {
    mocks.loadConfig.mockReturnValue({ agents: { entries: { poe: {} }, ownership: "explicit" } });
    mocks.listProfilesForProvider.mockReturnValue(["openai:default"] as never);

    await runCapability(
      "model",
      "auth",
      "logout",
      "--provider",
      "openai",
      "--agent",
      "poe",
      "--json",
    );

    expect(mocks.loadAuthProfileStoreForRuntime).toHaveBeenCalledWith("/tmp/agent-poe");
    expect(mocks.updateAuthProfileStoreWithLock).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: "/tmp/agent-poe" }),
    );
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
      provider: "openai",
      removedProfiles: ["openai:default"],
    });
  });

  it.each(["parent", "leaf"] as const)(
    "routes %s --agent through model auth login",
    async (position) => {
      mocks.loadConfig.mockReturnValue({
        agents: { entries: { alpha: {}, beta: {} }, ownership: "explicit" },
      });

      await runModelAuthWithAgent(position, "login", "beta", "--provider", "openai");

      expect(mocks.modelsAuthLoginCommand).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "openai", agent: "beta" }),
        mocks.runtime,
      );
    },
  );

  it.each(["parent", "leaf"] as const)(
    "routes %s --agent through model auth status",
    async (position) => {
      mocks.loadConfig.mockReturnValue({
        agents: { entries: { alpha: {}, beta: {} }, ownership: "explicit" },
      });

      await runModelAuthWithAgent(position, "status", "beta", "--json");

      expect(mocks.modelsStatusCommand).toHaveBeenCalledWith(
        expect.objectContaining({ json: true, agent: "beta" }),
        expect.any(Object),
      );
    },
  );

  it.each(["parent", "leaf"] as const)(
    "routes %s --agent through model auth logout",
    async (position) => {
      mocks.loadConfig.mockReturnValue({
        agents: { entries: { alpha: {}, beta: {} }, ownership: "explicit" },
      });
      mocks.listProfilesForProvider.mockReturnValue(["openai:default"] as never);

      await runModelAuthWithAgent(position, "logout", "beta", "--provider", "openai", "--json");

      expect(mocks.loadAuthProfileStoreForRuntime).toHaveBeenCalledWith("/tmp/agent-beta");
    },
  );

  it.each([
    { position: "parent" as const, agent: "", message: "--agent must not be blank" },
    { position: "leaf" as const, agent: "retired", message: 'Unknown agent id "retired"' },
  ])(
    "rejects invalid $position model auth agent '$agent' before dispatch",
    async ({ position, agent, message }) => {
      mocks.loadConfig.mockReturnValue({
        agents: { entries: { alpha: {}, beta: {} }, ownership: "explicit" },
      });

      await expect(runModelAuthWithAgent(position, "status", agent, "--json")).rejects.toThrow(
        "exit 1",
      );

      expectRuntimeErrorContains(message);
      expect(mocks.modelsStatusCommand).not.toHaveBeenCalled();
    },
  );

  it("fails logout if the auth store update does not complete", async () => {
    mocks.listProfilesForProvider.mockReturnValue(["openai:default"] as never);
    mocks.updateAuthProfileStoreWithLock.mockResolvedValueOnce(null as never);

    await expect(
      runCapability("model", "auth", "logout", "--provider", "openai", "--json"),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Failed to remove saved auth profiles for provider openai.");
  });

  it.each([
    {
      name: "rejects providerless audio model overrides",
      capability: "audio",
      action: "transcribe",
      file: "memo.m4a",
      model: "whisper-1",
    },
    {
      name: "rejects providerless image describe model overrides",
      capability: "image",
      action: "describe",
      file: "photo.jpg",
      model: "gpt-4.1-mini",
    },
    {
      name: "rejects providerless video describe model overrides",
      capability: "video",
      action: "describe",
      file: "clip.mp4",
      model: "gpt-4.1-mini",
    },
  ])("$name", async ({ capability, action, file, model }) => {
    let dispatchMock: ReturnType<typeof vi.fn>;
    if (capability === "video") {
      const mediaRuntime = await import("../media-understanding/runtime.js");
      dispatchMock = vi.mocked(mediaRuntime.describeVideoFile);
      dispatchMock.mockResolvedValue({
        text: "friendly lobster",
        provider: "openai",
        model: "gpt-4.1-mini",
      } as never);
    } else {
      dispatchMock = capability === "audio" ? mocks.transcribeAudioFile : mocks.describeImageFile;
    }
    await expect(
      runCap("capability", capability, action, "--file", file, "--model", model, "--json"),
    ).rejects.toThrow("exit 1");
    expectRuntimeErrorContains("Model overrides must use the form <provider/model>.");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("lists generic embedding providers when the memory registry is empty", async () => {
    mocks.listMemoryEmbeddingProviders.mockReturnValueOnce([]);
    mocks.listEmbeddingProviders.mockReturnValueOnce([
      { id: "generic", defaultModel: "generic-embed", transport: "remote" },
    ] as never);

    await runCapability("embedding", "providers", "--json");

    expect(firstJsonOutput()).toMatchObject([
      { id: "generic", defaultModel: "generic-embed", transport: "remote" },
    ]);
  });

  it("marks env-backed audio providers as configured", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "deepgram-test-key");
    vi.stubEnv("GROQ_API_KEY", "groq-test-key");
    mocks.buildMediaUnderstandingRegistry.mockReturnValueOnce(
      new Map([
        [
          "deepgram",
          {
            id: "deepgram",
            capabilities: ["audio"],
            defaultModels: { audio: "nova-3" },
          },
        ],
        [
          "groq",
          {
            id: "groq",
            capabilities: ["audio"],
            defaultModels: { audio: "whisper-large-v3-turbo" },
          },
        ],
      ]),
    );

    await runCapability("audio", "providers", "--json");

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith([
      {
        available: true,
        configured: true,
        selected: false,
        id: "deepgram",
        capabilities: ["audio"],
        defaultModels: { audio: "nova-3" },
      },
      {
        available: true,
        configured: true,
        selected: false,
        id: "groq",
        capabilities: ["audio"],
        defaultModels: { audio: "whisper-large-v3-turbo" },
      },
    ]);
  });

  it("marks env-backed image providers as configured", async () => {
    vi.stubEnv("FAL_KEY", "fal-test-key");
    mocks.getProviderEnvVars.mockReturnValueOnce(["FAL_KEY"]);
    mocks.listRuntimeImageGenerationProviders.mockReturnValueOnce([
      { id: "fal", label: "fal", defaultModel: "fal-ai/flux", models: [] },
    ] as never);

    await runCap("capability", "image", "providers", "--json");

    expect(firstJsonOutput()).toMatchObject([
      { id: "fal", available: true, configured: true, selected: false },
    ]);
  });

  it("marks env-backed video generation and description providers as configured", async () => {
    vi.stubEnv("RUNWAYML_API_SECRET", "runway-test-key");
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
    mocks.getProviderEnvVars.mockImplementation((providerId: string) =>
      providerId === "runway" ? ["RUNWAYML_API_SECRET"] : ["GEMINI_API_KEY"],
    );
    mocks.listRuntimeVideoGenerationProviders.mockReturnValueOnce([
      { id: "runway", label: "Runway", defaultModel: "gen4", models: [] },
    ] as never);
    mocks.buildMediaUnderstandingRegistry.mockReturnValueOnce(
      new Map([
        [
          "google",
          {
            id: "google",
            capabilities: ["video"],
            defaultModels: { video: "gemini-3-flash-preview" },
          },
        ],
      ]),
    );

    await runCap("capability", "video", "providers", "--json");

    expect(firstJsonOutput()).toMatchObject({
      generation: [{ id: "runway", configured: true }],
      description: [{ id: "google", configured: true }],
    });
  });

  it("marks env-backed TTS providers as configured", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-test-key");
    mocks.getProviderEnvVars.mockReturnValueOnce(["XAI_API_KEY"]);
    mocks.listSpeechProviders.mockReturnValueOnce([
      { id: "xai", label: "xAI", models: [], voices: [] },
    ] as never);

    await runCap("capability", "tts", "providers", "--local", "--json");

    expect(firstJsonOutput()).toMatchObject({
      providers: [{ id: "xai", configured: true, selected: false }],
    });
  });

  it("marks env-backed embedding providers as configured", async () => {
    vi.stubEnv("DEEPINFRA_API_KEY", "deepinfra-test-key");
    mocks.listMemoryEmbeddingProviders.mockReturnValueOnce([
      { id: "deepinfra", defaultModel: "BAAI/bge-m3", transport: "remote" },
    ]);

    await runCap("capability", "embedding", "providers", "--json");

    expect(firstJsonOutput()).toMatchObject([
      { id: "deepinfra", configured: true, selected: false },
    ]);
  });

  it("distinguishes the local STT fallback winner from global provider selection", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "deepgram-test-key");
    mocks.buildMediaUnderstandingRegistry.mockReturnValueOnce(
      new Map([
        [
          "deepgram",
          {
            id: "deepgram",
            capabilities: ["audio"],
            defaultModels: { audio: "nova-3" },
          },
        ],
      ]),
    );
    const candidate = {
      id: "whisper-cli" as const,
      command: "whisper-cli",
      resolvedCommand: "/opt/homebrew/bin/whisper-cli",
      available: true,
      ready: true,
      capableBackend: "metal" as const,
      evidence: "Apple Silicon Homebrew whisper-cpp runtime with Metal support",
      selected: true,
      entry: {
        type: "cli" as const,
        command: "whisper-cli",
        args: ["{{MediaPath}}"],
      },
    };
    mocks.inspectLocalAudioSelection.mockResolvedValueOnce({
      candidates: [candidate],
      entries: [candidate.entry],
      selected: candidate,
    });

    await runCapability("audio", "providers", "--json");

    expect(firstJsonOutput()).toEqual([
      {
        available: true,
        configured: true,
        selected: false,
        id: "deepgram",
        capabilities: ["audio"],
        defaultModels: { audio: "nova-3" },
      },
      {
        available: true,
        configured: true,
        selected: false,
        localFallbackSelected: true,
        id: "local/whisper-cli",
        transport: "local-cli",
        command: "whisper-cli",
        capableBackend: "metal",
        observedBackend: "unknown",
        evidence: "Apple Silicon Homebrew whisper-cpp runtime with Metal support",
      },
    ]);
  });

  it("resolves plugin web search SecretRefs before running infer web search", async () => {
    const unresolvedConfig = {
      tools: { web: { search: { provider: "tavily", enabled: true } } },
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "TAVILY_API_KEY" },
              },
            },
          },
        },
      },
    };
    const resolvedConfig = {
      ...unresolvedConfig,
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: {
                apiKey: "resolved-tavily-key",
              },
            },
          },
        },
      },
    };
    mocks.loadConfig.mockReturnValue(unresolvedConfig);
    mocks.resolveCommandConfigWithSecrets.mockResolvedValueOnce({
      resolvedConfig,
      effectiveConfig: resolvedConfig,
      diagnostics: [],
    });
    const webSearchRuntime = await import("../web-search/runtime.js");
    vi.mocked(webSearchRuntime.runWebSearch).mockResolvedValueOnce({
      provider: "tavily",
      result: { results: [] },
    } as never);

    await runCap("infer", "web", "search", "--query", "ping", "--json");

    const { getCapabilityWebSearchCommandSecretTargets } =
      await import("./command-secret-targets.js");
    const scopedTargets = getCapabilityWebSearchCommandSecretTargets(unresolvedConfig as never);
    expect(mocks.resolveCommandConfigWithSecrets).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: "infer web search",
        targetIds: scopedTargets.targetIds,
      }),
    );
    expect(webSearchRuntime.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        config: resolvedConfig,
      }),
    );
  });

  it("rejects partial web search limit before provider dispatch", async () => {
    const webSearchRuntime = await import("../web-search/runtime.js");
    vi.mocked(webSearchRuntime.runWebSearch).mockClear();
    await expect(
      runCapability("web", "search", "--query", "ping", "--limit", "3x"),
    ).rejects.toThrow("exit 1");
    expectRuntimeErrorContains("--limit must be a positive integer");
    expect(webSearchRuntime.runWebSearch).not.toHaveBeenCalled();
  });

  it("reports structured web search failures in the envelope and exits nonzero", async () => {
    const webSearchRuntime = await import("../web-search/runtime.js");
    vi.mocked(webSearchRuntime.runWebSearch).mockResolvedValueOnce({
      provider: "kitchen-sink-search",
      result: {
        ok: false,
        statusCode: 429,
        error: { code: "rate_limited", message: "Kitchen Sink rate limit." },
        results: [],
      },
    });

    await expect(
      runCap("capability", "web", "search", "--query", "rate limit", "--json"),
    ).rejects.toThrow("exit 1");

    expect(firstJsonOutput()).toEqual(
      expect.objectContaining({
        ok: false,
        capability: "web.search",
        provider: "kitchen-sink-search",
        error: "Kitchen Sink rate limit.",
      }),
    );
  });

  it("uses the infer web search provider override when resolving SecretRefs", async () => {
    const unresolvedConfig = {
      tools: { web: { search: { provider: "exa", enabled: true } } },
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" },
              },
            },
          },
          exa: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "EXA_API_KEY" },
              },
            },
          },
        },
      },
    };
    const resolvedConfig = {
      ...unresolvedConfig,
      plugins: {
        entries: {
          ...unresolvedConfig.plugins.entries,
          firecrawl: {
            config: {
              webSearch: {
                apiKey: "resolved-firecrawl-key",
              },
            },
          },
        },
      },
    };
    mocks.loadConfig.mockReturnValue(unresolvedConfig);
    mocks.resolveCommandConfigWithSecrets.mockResolvedValueOnce({
      resolvedConfig,
      effectiveConfig: resolvedConfig,
      diagnostics: [],
    });
    const webSearchRuntime = await import("../web-search/runtime.js");
    vi.mocked(webSearchRuntime.runWebSearch).mockResolvedValueOnce({
      provider: "firecrawl",
      result: { results: [] },
    } as never);

    await runCap("infer", "web", "search", "--query", "ping", "--provider", "firecrawl", "--json");

    const { getCapabilityWebSearchCommandSecretTargets } =
      await import("./command-secret-targets.js");
    const scopedTargets = getCapabilityWebSearchCommandSecretTargets(unresolvedConfig as never, {
      providerId: "firecrawl",
    });
    const configResolutionCall = mocks.resolveCommandConfigWithSecrets.mock.calls.at(-1)?.[0];
    expect(configResolutionCall).toEqual(
      expect.objectContaining({
        commandName: "infer web search",
        targetIds: scopedTargets.targetIds,
        forcedActivePaths: scopedTargets.forcedActivePaths,
      }),
    );
    expect(configResolutionCall).not.toHaveProperty("allowedPaths");
    expect(webSearchRuntime.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        config: resolvedConfig,
        providerId: "firecrawl",
      }),
    );
  });

  it("resolves only plugin web fetch SecretRefs before running infer web fetch", async () => {
    const unresolvedConfig = {
      tools: { web: { fetch: { provider: "firecrawl", enabled: true } } },
      plugins: {
        entries: {
          exa: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "EXA_API_KEY" },
              },
            },
          },
          firecrawl: {
            config: {
              webFetch: {
                apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" },
              },
            },
          },
        },
      },
    };
    const resolvedConfig = {
      ...unresolvedConfig,
      plugins: {
        entries: {
          ...unresolvedConfig.plugins.entries,
          firecrawl: {
            config: {
              webFetch: {
                apiKey: "resolved-firecrawl-key",
              },
            },
          },
        },
      },
    };
    mocks.loadConfig.mockReturnValue(unresolvedConfig);
    mocks.resolveCommandConfigWithSecrets.mockResolvedValueOnce({
      resolvedConfig,
      effectiveConfig: resolvedConfig,
      diagnostics: [],
    });
    const webFetchRuntime = await import("../web-fetch/runtime.js");
    vi.mocked(webFetchRuntime.resolveWebFetchDefinition).mockReturnValueOnce({
      provider: { id: "firecrawl" },
      definition: { execute: vi.fn(async () => ({ content: "ok" })) },
    } as never);

    await runCap("infer", "web", "fetch", "--url", "https://example.com", "--json");

    const { getCapabilityWebFetchCommandSecretTargets } =
      await import("./command-secret-targets.js");
    expect(mocks.resolveCommandConfigWithSecrets).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: "infer web fetch",
        targetIds: getCapabilityWebFetchCommandSecretTargets(unresolvedConfig as never).targetIds,
      }),
    );
    expect(webFetchRuntime.resolveWebFetchDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        config: resolvedConfig,
      }),
    );
  });

  it("uses the infer web fetch provider override when resolving fallback SecretRefs", async () => {
    const fallbackRef = { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" };
    const unresolvedConfig = {
      tools: { web: { fetch: { enabled: true } } },
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webSearch: {
                apiKey: fallbackRef,
              },
            },
          },
        },
      },
    };
    const resolvedConfig = {
      ...unresolvedConfig,
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webSearch: {
                apiKey: "resolved-firecrawl-key",
              },
            },
          },
        },
      },
    };
    mocks.loadConfig.mockReturnValue(unresolvedConfig);
    mocks.resolveCommandConfigWithSecrets.mockResolvedValueOnce({
      resolvedConfig,
      effectiveConfig: resolvedConfig,
      diagnostics: [],
    });
    const webFetchRuntime = await import("../web-fetch/runtime.js");
    vi.mocked(webFetchRuntime.resolveWebFetchDefinition).mockReturnValueOnce({
      provider: { id: "firecrawl" },
      definition: { execute: vi.fn(async () => ({ content: "ok" })) },
    } as never);

    await runCap(
      "infer",
      "web",
      "fetch",
      "--url",
      "https://example.com",
      "--provider",
      "firecrawl",
      "--json",
    );

    const { getCapabilityWebFetchCommandSecretTargets } =
      await import("./command-secret-targets.js");
    const scopedTargets = getCapabilityWebFetchCommandSecretTargets(unresolvedConfig as never, {
      providerId: "firecrawl",
    });
    const configResolutionCall = mocks.resolveCommandConfigWithSecrets.mock.calls.at(-1)?.[0];
    expect(configResolutionCall).toEqual(
      expect.objectContaining({
        commandName: "infer web fetch",
        targetIds: scopedTargets.targetIds,
        forcedActivePaths: scopedTargets.forcedActivePaths,
      }),
    );
    expect(configResolutionCall).not.toHaveProperty("allowedPaths");
    expect(webFetchRuntime.resolveWebFetchDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        config: resolvedConfig,
        providerId: "firecrawl",
      }),
    );
  });

  it("reports structured web fetch failures in the envelope and exits nonzero", async () => {
    const webFetchRuntime = await import("../web-fetch/runtime.js");
    vi.mocked(webFetchRuntime.resolveWebFetchDefinition).mockReturnValueOnce({
      provider: { id: "kitchen-sink-fetch" },
      definition: {
        execute: vi.fn(async () => ({
          ok: false,
          statusCode: 504,
          error: { code: "timeout", message: "Kitchen Sink fetch timed out." },
        })),
      },
    } as never);

    await expect(
      runCap("capability", "web", "fetch", "--url", "kitchen://fixture/timeout", "--json"),
    ).rejects.toThrow("exit 1");

    expect(firstJsonOutput()).toEqual(
      expect.objectContaining({
        ok: false,
        capability: "web.fetch",
        provider: "kitchen-sink-fetch",
        error: "Kitchen Sink fetch timed out.",
      }),
    );
  });

  it("surfaces available, configured, and selected for web providers", async () => {
    mocks.loadConfig.mockReturnValue({
      tools: {
        web: {
          search: { provider: "gemini" },
          fetch: { provider: "firecrawl" },
        },
      },
    });
    const webSearchRuntime = await import("../web-search/runtime.js");
    const webFetchRuntime = await import("../web-fetch/runtime.js");
    vi.mocked(webSearchRuntime.listWebSearchProviders).mockReturnValue([
      { id: "brave", envVars: ["BRAVE_API_KEY"] } as never,
      { id: "gemini", envVars: ["GEMINI_API_KEY"] } as never,
    ]);
    vi.mocked(webFetchRuntime.listWebFetchProviders).mockReturnValue([
      { id: "firecrawl", envVars: ["FIRECRAWL_API_KEY"] } as never,
    ]);
    mocks.isWebSearchProviderConfigured.mockReturnValueOnce(false).mockReturnValueOnce(true);
    mocks.isWebFetchProviderConfigured.mockReturnValueOnce(true);

    await runCapability("web", "providers", "--json");

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
      search: [
        {
          available: true,
          configured: false,
          selected: false,
          id: "brave",
          envVars: ["BRAVE_API_KEY"],
        },
        {
          available: true,
          configured: true,
          selected: true,
          id: "gemini",
          envVars: ["GEMINI_API_KEY"],
        },
      ],
      fetch: [
        {
          available: true,
          configured: true,
          selected: true,
          id: "firecrawl",
          envVars: ["FIRECRAWL_API_KEY"],
        },
      ],
    });
  });

  it("surfaces selected and configured embedding provider state", async () => {
    mocks.loadConfig.mockReturnValue({});
    mocks.resolveMemorySearchConfig.mockReturnValue({
      provider: "gemini",
      model: "gemini-embedding-001",
    } as never);
    mocks.listMemoryEmbeddingProviders.mockReturnValue([
      { id: "openai", defaultModel: "text-embedding-3-small", transport: "remote" },
      { id: "gemini", defaultModel: "gemini-embedding-001", transport: "remote" },
    ]);

    await runCapability("embedding", "providers", "--json");

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith([
      {
        available: true,
        configured: false,
        selected: false,
        id: "openai",
        defaultModel: "text-embedding-3-small",
        transport: "remote",
        autoSelectPriority: undefined,
      },
      {
        available: true,
        configured: true,
        selected: true,
        id: "gemini",
        defaultModel: "gemini-embedding-001",
        transport: "remote",
        autoSelectPriority: undefined,
      },
    ]);
  });

  it("includes generic embedding providers in embedding provider state", async () => {
    mocks.loadConfig.mockReturnValue({});
    mocks.resolveMemorySearchConfig.mockReturnValue({
      provider: "openai-compatible",
      model: "text-embedding-bge-m3",
    } as never);
    mocks.listMemoryEmbeddingProviders.mockReturnValue([
      { id: "openai", defaultModel: "text-embedding-3-small", transport: "remote" },
    ]);
    mocks.listEmbeddingProviders.mockReturnValue([
      { id: "openai-compatible", transport: "remote" },
    ] as never);

    await runCapability("embedding", "providers", "--json");

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith([
      {
        available: true,
        configured: false,
        selected: false,
        id: "openai",
        defaultModel: "text-embedding-3-small",
        transport: "remote",
        autoSelectPriority: undefined,
      },
      {
        available: true,
        configured: true,
        selected: true,
        id: "openai-compatible",
        defaultModel: undefined,
        transport: "remote",
        autoSelectPriority: undefined,
      },
    ]);
  });

  it("includes selected custom generic embedding provider aliases", async () => {
    mocks.loadConfig.mockReturnValue({
      models: {
        providers: {
          "tenant-embeddings": {
            api: "openai-responses",
            baseUrl: "http://127.0.0.1:1234/v1",
            models: [],
          },
        },
      },
    });
    mocks.resolveMemorySearchConfig.mockReturnValue({
      provider: "tenant-embeddings",
      model: "text-embedding-bge-m3",
    } as never);
    mocks.listMemoryEmbeddingProviders.mockReturnValue([
      { id: "openai", defaultModel: "text-embedding-3-small", transport: "remote" },
    ]);
    mocks.listEmbeddingProviders.mockReturnValue([
      { id: "openai-compatible", transport: "remote" },
    ] as never);

    await runCapability("embedding", "providers", "--json");

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith([
      {
        available: true,
        configured: false,
        selected: false,
        id: "openai",
        defaultModel: "text-embedding-3-small",
        transport: "remote",
        autoSelectPriority: undefined,
      },
      {
        available: true,
        configured: false,
        selected: false,
        id: "openai-compatible",
        defaultModel: undefined,
        transport: "remote",
        autoSelectPriority: undefined,
      },
      {
        available: true,
        configured: true,
        selected: true,
        id: "tenant-embeddings",
        defaultModel: "text-embedding-bge-m3",
        transport: "remote",
        autoSelectPriority: undefined,
      },
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
