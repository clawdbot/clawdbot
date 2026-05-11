import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerCapabilityCli } from "./capability-cli.js";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yf7kAAAAASUVORK5CYII=";

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
  loadAuthProfileStoreForRuntime: vi.fn(() => ({ profiles: {}, order: {} })),
  listProfilesForProvider: vi.fn(() => []),
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
  resolveMemorySearchConfig: vi.fn(() => null),
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
  describeImageFileWithModel: vi.fn(async () => ({
    text: "friendly lobster",
    model: "gpt-4.1-mini",
  })),
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
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
  setTtsPersona: vi.fn(),
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
  createEmbeddingProvider: vi.fn(async () => ({
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embedQuery: async () => [0.1, 0.2],
      embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2]),
    },
  })),
  registerMemoryEmbeddingProvider: vi.fn(),
  listMemoryEmbeddingProviders: vi.fn(() => [
    { id: "openai", defaultModel: "text-embedding-3-small", transport: "remote" },
  ]),
  registerBuiltInMemoryEmbeddingProviders: vi.fn(),
  buildMediaUnderstandingRegistry: vi.fn(() => new Map()),
  convertHeicToJpeg: vi.fn(async () => Buffer.from("jpeg-normalized")),
  isWebSearchProviderConfigured: vi.fn(() => false),
  isWebFetchProviderConfigured: vi.fn(() => false),
  modelsStatusCommand: vi.fn(
    async (_opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
      runtime.log(JSON.stringify({ ok: true, providers: [{ id: "openai" }] }));
    },
  ),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: { writeJson: (value: unknown) => void }, value: unknown) =>
    runtime.writeJson(value),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.loadConfig as typeof import("../config/config.js").getRuntimeConfig,
  loadConfig: mocks.loadConfig as typeof import("../config/config.js").loadConfig,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
  resolveAgentDir: () => "/tmp/agent",
  resolveAgentConfig: () => ({}),
  resolveAgentEffectiveModelPrimary: () => undefined,
  resolveAgentModelFallbacksOverride: () => [],
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog:
    mocks.loadModelCatalog as typeof import("../agents/model-catalog.js").loadModelCatalog,
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

vi.mock("../agents/auth-profiles/store.js", () => ({
  updateAuthProfileStoreWithLock:
    mocks.updateAuthProfileStoreWithLock as typeof import("../agents/auth-profiles/store.js").updateAuthProfileStoreWithLock,
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig:
    mocks.resolveMemorySearchConfig as typeof import("../agents/memory-search.js").resolveMemorySearchConfig,
}));

vi.mock("../commands/models/auth.js", () => ({
  modelsAuthLoginCommand: vi.fn(),
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
  describeImageFileWithModel:
    mocks.describeImageFileWithModel as typeof import("../media-understanding/runtime.js").describeImageFileWithModel,
  describeVideoFile: vi.fn(),
  transcribeAudioFile:
    mocks.transcribeAudioFile as typeof import("../media-understanding/runtime.js").transcribeAudioFile,
}));

vi.mock("../media-understanding/provider-registry.js", () => ({
  buildMediaUnderstandingRegistry:
    mocks.buildMediaUnderstandingRegistry as typeof import("../media-understanding/provider-registry.js").buildMediaUnderstandingRegistry,
}));

vi.mock("../media/image-ops.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/image-ops.js")>();
  return {
    ...actual,
    convertHeicToJpeg:
      mocks.convertHeicToJpeg as typeof import("../media/image-ops.js").convertHeicToJpeg,
  };
});

vi.mock("../plugins/memory-embedding-providers.js", () => ({
  listMemoryEmbeddingProviders:
    mocks.listMemoryEmbeddingProviders as unknown as typeof import("../plugins/memory-embedding-providers.js").listMemoryEmbeddingProviders,
  registerMemoryEmbeddingProvider:
    mocks.registerMemoryEmbeddingProvider as unknown as typeof import("../plugins/memory-embedding-providers.js").registerMemoryEmbeddingProvider,
}));

vi.mock("../plugin-sdk/memory-core-bundled-runtime.js", () => ({
  createEmbeddingProvider:
    mocks.createEmbeddingProvider as unknown as typeof import("../plugin-sdk/memory-core-bundled-runtime.js").createEmbeddingProvider,
  registerBuiltInMemoryEmbeddingProviders:
    mocks.registerBuiltInMemoryEmbeddingProviders as typeof import("../plugin-sdk/memory-core-bundled-runtime.js").registerBuiltInMemoryEmbeddingProviders,
}));

vi.mock("../image-generation/runtime.js", () => ({
  generateImage: (...args: unknown[]) => mocks.generateImage(...args),
  listRuntimeImageGenerationProviders: vi.fn(() => []),
}));

vi.mock("../video-generation/runtime.js", () => ({
  generateVideo: mocks.generateVideo,
  listRuntimeVideoGenerationProviders: vi.fn(() => []),
}));

vi.mock("../tts/tts.js", () => ({
  getTtsPersona: vi.fn(() => undefined),
  getTtsProvider: vi.fn(() => "openai"),
  listTtsPersonas: vi.fn(() => []),
  listSpeechVoices: vi.fn(async () => []),
  resolveTtsConfig: vi.fn(() => ({})),
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
  listSpeechProviders: vi.fn(() => []),
}));

vi.mock("../web-search/runtime.js", () => ({
  listWebSearchProviders: vi.fn(() => []),
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

describe("capability cli", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.loadModelCatalog
      .mockReset()
      .mockResolvedValue([{ id: "gpt-5.4", provider: "openai", name: "GPT-5.4" }] as never);
    mocks.loadAuthProfileStoreForRuntime.mockReset().mockReturnValue({ profiles: {}, order: {} });
    mocks.listProfilesForProvider.mockReset().mockReturnValue([]);
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
    mocks.callGateway.mockClear().mockImplementation((async ({ method }: { method: string }) => {
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
    }) as never);
    mocks.describeImageFile.mockClear();
    mocks.describeImageFileWithModel.mockClear();
    mocks.generateImage.mockReset();
    mocks.generateVideo.mockReset();
    mocks.transcribeAudioFile.mockClear();
    mocks.textToSpeech.mockClear();
    mocks.setTtsProvider.mockClear();
    mocks.resolveExplicitTtsOverrides.mockClear();
    mocks.buildMediaUnderstandingRegistry.mockReset().mockReturnValue(new Map());
    mocks.convertHeicToJpeg.mockClear();
    mocks.createEmbeddingProvider.mockClear();
    mocks.registerMemoryEmbeddingProvider.mockClear();
    mocks.registerBuiltInMemoryEmbeddingProviders.mockClear();
    mocks.isWebSearchProviderConfigured.mockReset().mockReturnValue(false);
    mocks.isWebFetchProviderConfigured.mockReset().mockReturnValue(false);
    mocks.modelsStatusCommand.mockClear();
    mocks.callGateway.mockImplementation((async ({ method }: { method: string }) => {
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
  });

  async function runModelRunWithModel(model: string, transport: "local" | "gateway") {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
        "model",
        "run",
        "--model",
        model,
        "--prompt",
        "hello",
        ...(transport === "gateway" ? ["--gateway"] : []),
        "--json",
      ],
    });
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
    model?: unknown;
    prompt?: unknown;
    provider?: unknown;
    timeoutMs?: unknown;
  };

  function firstGatewayCall() {
    return mocks.callGateway.mock.calls[0]?.[0] as GatewayCall | undefined;
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
    return mocks.runtime.writeJson.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  }

  function imageDescribeCall(index = 0) {
    const calls = mocks.describeImageFile.mock.calls as unknown as Array<[ImageDescribeParams]>;
    return calls[index]?.[0];
  }

  function firstImageDescribeWithModelCall() {
    const calls = mocks.describeImageFileWithModel.mock.calls as unknown as Array<
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

  function firstAudioTranscriptionCall() {
    const calls = mocks.transcribeAudioFile.mock.calls as unknown as Array<
      [{ filePath?: string; language?: unknown; prompt?: unknown }]
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
    expect(runtimeErrorMessages().some((message) => message.includes(expected))).toBe(true);
  }

  it("lists canonical capabilities", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "list", "--json"],
    });

    const payload = mocks.runtime.writeJson.mock.calls[0]?.[0] as Array<{ id: string }>;
    const ids = payload.map((entry) => entry.id);
    expect(ids).toContain("model.run");
    expect(ids).toContain("image.describe");
  });

  it("defaults model run to local transport", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "model", "run", "--prompt", "hello", "--json"],
    });

    expect(mocks.prepareSimpleCompletionModelForAgent).toHaveBeenCalledTimes(1);
    expect(mocks.completeWithPreparedSimpleCompletionModel).toHaveBeenCalledTimes(1);
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(firstJsonOutput()?.capability).toBe("model.run");
    expect(firstJsonOutput()?.transport).toBe("local");
  });

  it("runs local model probes through the lean completion path", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "model", "run", "--prompt", "hello", "--json"],
    });

    const preparedParams = firstPreparedModelParams();
    expect(preparedParams?.agentId).toBe("main");
    expect(preparedParams?.allowMissingApiKeyModes).toEqual(["aws-sdk"]);
    expect(preparedParams?.skipPiDiscovery).toBe(true);
    const call = firstCompletionCall();
    expect(call?.context?.messages?.[0]?.role).toBe("user");
    expect(call?.context?.messages?.[0]?.content).toBe("hello");
    expect(call?.context).not.toHaveProperty("systemPrompt");
  });

  it("opts explicit local provider/model probes into bundled static catalog fallback", async () => {
    await runModelRunWithModel("mistral/mistral-medium-3-5", "local");

    const params = firstPreparedModelParams();
    expect(params?.modelRef).toBe("mistral/mistral-medium-3-5");
    expect(params?.allowBundledStaticCatalogFallback).toBe(true);
    expect(params?.skipPiDiscovery).toBe(true);
  });

  it("does not enable bundled static catalog fallback without an explicit provider/model override", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "model", "run", "--prompt", "hello", "--json"],
    });

    const calls = mocks.prepareSimpleCompletionModelForAgent.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    const params = calls[0]?.[0];
    expect(params).toBeDefined();
    expect(params).not.toHaveProperty("allowBundledStaticCatalogFallback");
  });

  it("passes image files to local model probes", async () => {
    const tempInput = path.join(os.tmpdir(), `openclaw-model-run-image-${Date.now()}.png`);
    await fs.writeFile(tempInput, Buffer.from(PNG_1X1_BASE64, "base64"));

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
        "model",
        "run",
        "--prompt",
        "describe this",
        "--file",
        tempInput,
        "--json",
      ],
    });

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

  it("adds minimal instructions only for openai-codex local model probes", async () => {
    mocks.prepareSimpleCompletionModelForAgent.mockResolvedValueOnce({
      selection: {
        provider: "openai-codex",
        modelId: "gpt-5.5",
        agentDir: "/tmp/agent",
      },
      model: {
        provider: "openai-codex",
        id: "gpt-5.5",
        api: "openai-codex-responses",
        maxTokens: 128,
      },
      auth: {
        apiKey: "codex-app-server",
        source: "codex-app-server",
        mode: "token",
      },
    } as never);

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
        "model",
        "run",
        "--model",
        "openai-codex/gpt-5.5",
        "--prompt",
        "hello",
        "--json",
      ],
    });

    const call = firstCompletionCall();
    expect(call?.context?.systemPrompt).toBe(
      "You are a personal assistant running inside OpenClaw.",
    );
    expect(call?.context?.messages?.[0]?.role).toBe("user");
    expect(call?.context?.messages?.[0]?.content).toBe("hello");
  });

  it("passes thinking overrides to local model probes", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "model", "run", "--prompt", "hello", "--thinking", "high", "--json"],
    });

    expect(firstCompletionCall()?.options?.reasoning).toBe("high");
  });

  it("passes image files to gateway model probes as attachments", async () => {
    const tempInput = path.join(os.tmpdir(), `openclaw-model-run-gateway-image-${Date.now()}.png`);
    await fs.writeFile(tempInput, Buffer.from(PNG_1X1_BASE64, "base64"));

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
        "model",
        "run",
        "--prompt",
        "describe this",
        "--file",
        tempInput,
        "--gateway",
        "--json",
      ],
    });

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

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
        "model",
        "run",
        "--prompt",
        "describe this",
        "--file",
        tempInput,
        "--json",
      ],
    });

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

  it("rejects non-image files for model probes", async () => {
    const tempInput = path.join(os.tmpdir(), `openclaw-model-run-audio-${Date.now()}.mp3`);
    await fs.writeFile(tempInput, Buffer.from("not really audio"));

    await expect(
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: [
          "capability",
          "model",
          "run",
          "--prompt",
          "transcribe this",
          "--file",
          tempInput,
          "--json",
        ],
      }),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Only image files are supported");
    expect(mocks.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("fails local model probes when the provider returns no text output", async () => {
    mocks.completeWithPreparedSimpleCompletionModel.mockResolvedValueOnce({
      content: [],
    } as never);

    await expect(
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: ["capability", "model", "run", "--prompt", "hello", "--json"],
      }),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains('No text output returned for provider "openai" model "gpt-5.4"');
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("surfaces provider errors when local model probes return no text output", async () => {
    mocks.completeWithPreparedSimpleCompletionModel.mockResolvedValueOnce({
      content: [],
      stopReason: "error",
      errorMessage: '{"detail":"Instructions are required"}',
    } as never);

    await expect(
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: ["capability", "model", "run", "--prompt", "hello", "--json"],
      }),
    ).rejects.toThrow("exit 1");

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
        api: "openai-codex-responses",
      },
      auth: {
        apiKey: "codex-app-server",
        source: "codex-app-server",
        mode: "token",
      },
    } as never);

    await expect(
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: [
          "capability",
          "model",
          "run",
          "--model",
          "codex/gpt-5.4",
          "--prompt",
          "hello",
          "--json",
        ],
      }),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Codex app-server agent runtime");
    expect(mocks.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "\n\t"])(
    "rejects empty model run prompts before local dispatch (%j)",
    async (prompt) => {
      await expect(
        runRegisteredCli({
          register: registerCapabilityCli as (program: Command) => void,
          argv: ["capability", "model", "run", "--prompt", prompt, "--json"],
        }),
      ).rejects.toThrow("exit 1");

      expectRuntimeErrorContains("--prompt cannot be empty or whitespace-only.");
      expect(mocks.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
      expect(mocks.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
      expect(mocks.callGateway).not.toHaveBeenCalled();
      expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    },
  );

  it("runs gateway model probes without chat-agent prompt policy or tools", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "model", "run", "--prompt", "hello", "--gateway", "--json"],
    });

    const gatewayCall = firstGatewayCall();
    expect(gatewayCall?.method).toBe("agent");
    expect(gatewayCall?.params?.cleanupBundleMcpOnRunEnd).toBe(true);
    expect(gatewayCall?.params?.modelRun).toBe(true);
    expect(gatewayCall?.params?.promptMode).toBe("none");
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

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "model", "run", "--prompt", "hello", "--gateway", "--json"],
    });

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
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
        "model",
        "run",
        "--prompt",
        "hello",
        "--gateway",
        "--model",
        "anthropic/claude-haiku-4-5",
        "--json",
      ],
    });

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
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
        "model",
        "run",
        "--prompt",
        "hello",
        "--gateway",
        "--thinking",
        "high",
        "--json",
      ],
    });

    const gatewayCall = firstGatewayCall();
    expect(gatewayCall?.method).toBe("agent");
    expect(gatewayCall?.params?.thinking).toBe("high");
    expect(gatewayCall?.params?.modelRun).toBe(true);
    expect(gatewayCall?.params?.promptMode).toBe("none");
  });

  it("rejects invalid model run thinking overrides before dispatch", async () => {
    await expect(
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: [
          "capability",
          "model",
          "run",
          "--prompt",
          "hello",
          "--thinking",
          "turbo-mode",
          "--json",
        ],
      }),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Invalid thinking level.");
    expect(mocks.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
    expect(mocks.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("rejects empty model run prompts before gateway dispatch", async () => {
    await expect(
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: ["capability", "model", "run", "--prompt", " ", "--gateway", "--json"],
      }),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("--prompt cannot be empty or whitespace-only.");
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("defaults tts status to gateway transport", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "tts", "status", "--json"],
    });

    expect(firstGatewayCall()?.method).toBe("tts.status");
    expect(firstJsonOutput()?.transport).toBe("gateway");
  });

  it("routes image describe through media understanding, not generation", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "image", "describe", "--file", "photo.jpg", "--json"],
    });

    const describeCall = imageDescribeCall();
    expect(path.basename(describeCall?.filePath ?? "")).toBe("photo.jpg");
    const output = firstJsonOutput();
    const outputs = output?.outputs as Array<Record<string, unknown>>;
    expect(output?.capability).toBe("image.describe");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.kind).toBe("image.description");
  });

  it("passes image describe prompts through media understanding", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
        "image",
        "describe",
        "--file",
        "photo.jpg",
        "--prompt",
        "Read the menu text",
        "--timeout-ms",
        "90000",
        "--json",
      ],
    });

    const describeCall = imageDescribeCall();
    expect(path.basename(describeCall?.filePath ?? "")).toBe("photo.jpg");
    expect(describeCall?.prompt).toBe("Read the menu text");
    expect(describeCall?.timeoutMs).toBe(90000);
  });

  it("uses the explicit media-understanding provider for image describe model overrides", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
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
      ],
    });

    const describeCall = firstImageDescribeWithModelCall();
    expect(path.basename(describeCall?.filePath ?? "")).toBe("photo.jpg");
    expect(describeCall?.provider).toBe("ollama");
    expect(describeCall?.model).toBe("qwen2.5vl:7b");
    expect(describeCall?.prompt).toBe("Count visible buttons");
    expect(describeCall?.timeoutMs).toBe(120000);
    expect(mocks.describeImageFile).not.toHaveBeenCalled();
    expect(firstJsonOutput()?.provider).toBe("ollama");
    expect(firstJsonOutput()?.model).toBe("gpt-4.1-mini");
  });

  it("passes describe-many prompts to each image", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
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
      ],
    });

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
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: ["capability", "image", "describe", "--file", "photo.jpg", "--json"],
      }),
    ).rejects.toThrow("exit 1");
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringMatching(/No description returned for image/),
    );
  });

  it("reports missing image understanding configuration for image describe", async () => {
    mocks.describeImageFile.mockResolvedValueOnce({
      text: undefined,
      decision: {
        capability: "image",
        outcome: "skipped",
        attachments: [{ attachmentIndex: 0, attempts: [] }],
      },
    } as never);

    await expect(
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: ["capability", "image", "describe", "--file", "photo.jpg", "--json"],
      }),
    ).rejects.toThrow("exit 1");
    expectRuntimeErrorContains("No image understanding provider is configured or ready");
    expectRuntimeErrorContains("agents.defaults.imageModel.primary");
  });

  it("reports missing image understanding configuration for image describe-many", async () => {
    mocks.describeImageFile.mockResolvedValueOnce({
      text: undefined,
      decision: {
        capability: "image",
        outcome: "skipped",
        attachments: [{ attachmentIndex: 0, attempts: [] }],
      },
    } as never);

    await expect(
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: ["capability", "image", "describe-many", "--file", "photo.jpg", "--json"],
      }),
    ).rejects.toThrow("exit 1");
    expectRuntimeErrorContains("No image understanding provider is configured or ready");
  });

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

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
        "image",
        "generate",
        "--prompt",
        "friendly lobster",
        "--output",
        tempOutput,
        "--json",
      ],
    });

    const outputs = firstJsonOutput()?.outputs as Array<Record<string, unknown>>;
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.path).toBe(tempOutput.replace(/\.png$/, ".jpg"));
    expect(outputs[0]?.mimeType).toBe("image/jpeg");
  });

  it("passes image generation timeout through to runtime", async () => {
    mocks.generateImage.mockResolvedValue({
      provider: "openai",
      model: "gpt-image-1",
      attempts: [],
      images: [
        {
          buffer: Buffer.from("png-bytes"),
          mimeType: "image/png",
          fileName: "provider-output.png",
        },
      ],
    });

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
        "image",
        "generate",
        "--prompt",
        "friendly lobster",
        "--timeout-ms",
        "180000",
        "--json",
      ],
    });

    expect(firstImageGenerationCall()?.prompt).toBe("friendly lobster");
    expect(firstImageGenerationCall()?.timeoutMs).toBe(180000);
  });

  it("passes image output format and generic background hints through to generation runtime", async () => {
    mocks.generateImage.mockResolvedValue({
      provider: "openai",
      model: "gpt-image-1.5",
      attempts: [],
      images: [
        {
          buffer: Buffer.from("png-bytes"),
          mimeType: "image/png",
          fileName: "transparent.png",
        },
      ],
    });

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
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
      ],
    });

    const generationCall = firstImageGenerationCall();
    expect(generationCall?.prompt).toBe("transparent sticker");
    expect(generationCall?.modelOverride).toBe("openai/gpt-image-1.5");
    expect(generationCall?.outputFormat).toBe("png");
    expect(generationCall?.background).toBe("transparent");
    expect(generationCall?.providerOptions).toBeUndefined();
  });

  it("passes image output format and OpenAI background hints through to edit runtime", async () => {
    mocks.generateImage.mockResolvedValue({
      provider: "openai",
      model: "gpt-image-1.5",
      attempts: [],
      images: [
        {
          buffer: Buffer.from("png-bytes"),
          mimeType: "image/png",
          fileName: "transparent-edit.png",
        },
      ],
    });
    const inputPath = path.join(os.tmpdir(), `openclaw-image-edit-${Date.now()}.png`);
    await fs.writeFile(inputPath, Buffer.from("png-input"));

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
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
        "--json",
      ],
    });

    const generationCall = firstImageGenerationCall();
    const inputImages = generationCall?.inputImages as Array<Record<string, unknown>>;
    expect(generationCall?.prompt).toBe("make background transparent");
    expect(generationCall?.modelOverride).toBe("openai/gpt-image-1.5");
    expect(generationCall?.outputFormat).toBe("png");
    expect(generationCall?.background).toBeUndefined();
    expect(generationCall?.providerOptions).toEqual({
      openai: {
        background: "transparent",
      },
    });
    expect(inputImages).toHaveLength(1);
    expect(inputImages[0]?.fileName).toBe(path.basename(inputPath));
  });

  it("rejects unsupported image output format and background hints", async () => {
    await expect(
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: [
          "capability",
          "image",
          "generate",
          "--prompt",
          "transparent sticker",
          "--output-format",
          "gif",
          "--json",
        ],
      }),
    ).rejects.toThrow("exit 1");
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Error: --output-format must be one of png, jpeg, or webp",
    );

    mocks.runtime.error.mockClear();
    await expect(
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: [
          "capability",
          "image",
          "generate",
          "--prompt",
          "transparent sticker",
          "--openai-background",
          "clear",
          "--json",
        ],
      }),
    ).rejects.toThrow("exit 1");
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Error: --openai-background must be one of transparent, opaque, or auto",
    );

    mocks.runtime.error.mockClear();
    await expect(
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: [
          "capability",
          "image",
          "generate",
          "--prompt",
          "transparent sticker",
          "--background",
          "clear",
          "--json",
        ],
      }),
    ).rejects.toThrow("exit 1");
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Error: --background must be one of transparent, opaque, or auto",
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

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
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
      ],
    });

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
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "inspect", "--name", "image.edit", "--json"],
    });

    expect(firstJsonOutput()?.id).toBe("image.edit");
    expect(firstJsonOutput()?.flags).toEqual([
      "--file",
      "--prompt",
      "--model",
      "--size",
      "--aspect-ratio",
      "--resolution",
      "--output-format",
      "--background",
      "--openai-background",
      "--timeout-ms",
      "--output",
      "--json",
    ]);
  });

  it("streams url-only generated videos to --output paths", async () => {
    mocks.generateVideo.mockResolvedValue({
      provider: "vydra",
      model: "veo3",
      attempts: [],
      videos: [
        {
          url: "https://example.com/generated-video.mp4",
          mimeType: "video/mp4",
          fileName: "provider-name.mp4",
        },
      ],
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(Buffer.from("video-bytes"), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-video-generate-"));
    const outputBase = path.join(tempDir, "result");

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
        "video",
        "generate",
        "--prompt",
        "friendly lobster",
        "--output",
        outputBase,
        "--json",
      ],
    });

    const outputPath = `${outputBase}.mp4`;
    const fetchCall = fetchMock.mock.calls[0] as unknown as
      | [string, { signal?: unknown }]
      | undefined;
    expect(fetchCall?.[0]).toBe("https://example.com/generated-video.mp4");
    expect(fetchCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(await fs.readFile(outputPath, "utf8")).toBe("video-bytes");
    const output = firstJsonOutput();
    const outputs = output?.outputs as Array<Record<string, unknown>>;
    expect(output?.capability).toBe("video.generate");
    expect(output?.provider).toBe("vydra");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.path).toBe(outputPath);
    expect(outputs[0]?.mimeType).toBe("video/mp4");
    expect(outputs[0]?.size).toBe(11);
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

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
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
      ],
    });

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
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: ["capability", "video", "generate", "--prompt", "friendly lobster", "--json"],
      }),
    ).rejects.toThrow("exit 1");
    expectRuntimeErrorContains("Video asset at index 0 has neither buffer nor url");
  });

  it("routes audio transcribe through transcription, not realtime", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "audio", "transcribe", "--file", "memo.m4a", "--json"],
    });

    expect(path.basename(firstAudioTranscriptionCall()?.filePath ?? "")).toBe("memo.m4a");
    const output = firstJsonOutput();
    const outputs = output?.outputs as Array<Record<string, unknown>>;
    expect(output?.capability).toBe("audio.transcribe");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.kind).toBe("audio.transcription");
  });

  it("fails audio transcribe when no transcript text is returned", async () => {
    mocks.transcribeAudioFile.mockResolvedValueOnce({ text: undefined } as never);

    await expect(
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: ["capability", "audio", "transcribe", "--file", "memo.m4a", "--json"],
      }),
    ).rejects.toThrow("exit 1");
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringMatching(/No transcript returned for audio/),
    );
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
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: ["capability", "audio", "transcribe", "--file", "memo.m4a", "--json"],
      }),
    ).rejects.toThrow("exit 1");
    expectRuntimeErrorContains("No audio transcription provider is configured or ready");
    expectRuntimeErrorContains("tools.media.audio.models");
  });

  it("surfaces the underlying transcription failure for audio transcribe", async () => {
    mocks.transcribeAudioFile.mockRejectedValueOnce(
      new Error("Audio transcription response missing text"),
    );

    await expect(
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: ["capability", "audio", "transcribe", "--file", "memo.m4a", "--json"],
      }),
    ).rejects.toThrow("exit 1");
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringMatching(/Audio transcription response missing text/),
    );
  });

  it("forwards transcription prompt and language hints", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
        "audio",
        "transcribe",
        "--file",
        "memo.m4a",
        "--language",
        "en",
        "--prompt",
        "Focus on names",
        "--json",
      ],
    });

    const transcribeCall = firstAudioTranscriptionCall();
    expect(path.basename(transcribeCall?.filePath ?? "")).toBe("memo.m4a");
    expect(transcribeCall?.language).toBe("en");
    expect(transcribeCall?.prompt).toBe("Focus on names");
  });

  it("uses request-scoped TTS overrides without mutating prefs", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
        "tts",
        "convert",
        "--text",
        "hello",
        "--model",
        "openai/gpt-4o-mini-tts",
        "--voice",
        "alloy",
        "--json",
      ],
    });

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

  it("disables TTS fallback when explicit provider or voice/model selection is requested", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
        "tts",
        "convert",
        "--text",
        "hello",
        "--model",
        "openai/gpt-4o-mini-tts",
        "--voice",
        "alloy",
        "--json",
      ],
    });

    expect(firstTextToSpeechCall()?.disableFallback).toBe(true);
  });

  it("does not infer and forward a local provider guess for gateway TTS overrides", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
        "tts",
        "convert",
        "--gateway",
        "--text",
        "hello",
        "--voice",
        "alloy",
        "--json",
      ],
    });

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
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: [
          "capability",
          "tts",
          "convert",
          "--gateway",
          "--text",
          "hello",
          "--output",
          "hello.mp3",
          "--json",
        ],
      }),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("--output is not supported for remote gateway TTS yet");
  });

  it("uses only embedding providers for embedding creation", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "embedding", "create", "--text", "hello", "--json"],
    });

    expect(firstEmbeddingProviderCall()?.provider).toBe("auto");
    expect(firstEmbeddingProviderCall()?.fallback).toBe("none");
    expect(firstJsonOutput()?.capability).toBe("embedding.create");
    expect(firstJsonOutput()?.provider).toBe("openai");
    expect(firstJsonOutput()?.model).toBe("text-embedding-3-small");
  });

  it("derives the embedding provider from a provider/model override", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: [
        "capability",
        "embedding",
        "create",
        "--text",
        "hello",
        "--model",
        "openai/text-embedding-3-large",
        "--json",
      ],
    });

    expect(firstEmbeddingProviderCall()?.provider).toBe("openai");
    expect(firstEmbeddingProviderCall()?.fallback).toBe("none");
    expect(firstEmbeddingProviderCall()?.model).toBe("text-embedding-3-large");
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

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "model", "auth", "logout", "--provider", "openai", "--json"],
    });

    expect(updatedStore).not.toBeNull();
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
  });

  it("fails logout if the auth store update does not complete", async () => {
    mocks.listProfilesForProvider.mockReturnValue(["openai:default"] as never);
    mocks.updateAuthProfileStoreWithLock.mockResolvedValueOnce(null as never);

    await expect(
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: ["capability", "model", "auth", "logout", "--provider", "openai", "--json"],
      }),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Failed to remove saved auth profiles for provider openai.");
  });

  it("rejects providerless audio model overrides", async () => {
    await expect(
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: [
          "capability",
          "audio",
          "transcribe",
          "--file",
          "memo.m4a",
          "--model",
          "whisper-1",
          "--json",
        ],
      }),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Model overrides must use the form <provider/model>.");
    expect(mocks.transcribeAudioFile).not.toHaveBeenCalled();
  });

  it("rejects providerless image describe model overrides", async () => {
    await expect(
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: [
          "capability",
          "image",
          "describe",
          "--file",
          "photo.jpg",
          "--model",
          "gpt-4.1-mini",
          "--json",
        ],
      }),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Model overrides must use the form <provider/model>.");
    expect(mocks.describeImageFile).not.toHaveBeenCalled();
  });

  it("rejects providerless video describe model overrides", async () => {
    const mediaRuntime = await import("../media-understanding/runtime.js");
    vi.mocked(mediaRuntime.describeVideoFile).mockResolvedValue({
      text: "friendly lobster",
      provider: "openai",
      model: "gpt-4.1-mini",
    } as never);

    await expect(
      runRegisteredCli({
        register: registerCapabilityCli as (program: Command) => void,
        argv: [
          "capability",
          "video",
          "describe",
          "--file",
          "clip.mp4",
          "--model",
          "gpt-4.1-mini",
          "--json",
        ],
      }),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Model overrides must use the form <provider/model>.");
    expect(vi.mocked(mediaRuntime.describeVideoFile)).not.toHaveBeenCalled();
  });

  it("bootstraps built-in embedding providers when the registry is empty", async () => {
    mocks.listMemoryEmbeddingProviders.mockReturnValueOnce([]);

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "embedding", "providers", "--json"],
    });

    const bootstrapArg = mocks.registerBuiltInMemoryEmbeddingProviders.mock.calls[0]?.[0] as
      | { registerMemoryEmbeddingProvider?: unknown }
      | undefined;
    expect(typeof bootstrapArg?.registerMemoryEmbeddingProvider).toBe("function");
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

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "audio", "providers", "--json"],
    });

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

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "web", "providers", "--json"],
    });

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

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "embedding", "providers", "--json"],
    });

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
});
