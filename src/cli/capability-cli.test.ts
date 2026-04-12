import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerCapabilityCli } from "./capability-cli.js";

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
  agentCommand: vi.fn(async () => ({
    payloads: [{ text: "local reply" }],
    meta: { agentMeta: { provider: "openai", model: "gpt-5.4" } },
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
  loadConfig: mocks.loadConfig as typeof import("../config/config.js").loadConfig,
}));

vi.mock("../agents/agent-command.js", () => ({
  agentCommand:
    mocks.agentCommand as unknown as typeof import("../agents/agent-command.js").agentCommand,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
  resolveAgentDir: () => "/tmp/agent",
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog:
    mocks.loadModelCatalog as typeof import("../agents/model-catalog.js").loadModelCatalog,
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

vi.mock("../commands/models.js", () => ({
  modelsAuthLoginCommand: vi.fn(),
  modelsStatusCommand:
    mocks.modelsStatusCommand as typeof import("../commands/models.js").modelsStatusCommand,
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
  describeVideoFile: vi.fn(),
  transcribeAudioFile:
    mocks.transcribeAudioFile as typeof import("../media-understanding/runtime.js").transcribeAudioFile,
}));

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
  getTtsProvider: vi.fn(() => "openai"),
  listSpeechVoices: vi.fn(async () => []),
  resolveTtsConfig: vi.fn(() => ({})),
  resolveTtsPrefsPath: vi.fn(() => "/tmp/tts.json"),
  setTtsEnabled: vi.fn(),
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
    mocks.agentCommand.mockClear();
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
    mocks.generateImage.mockReset();
    mocks.generateVideo.mockReset();
    mocks.transcribeAudioFile.mockClear();
    mocks.textToSpeech.mockClear();
    mocks.setTtsProvider.mockClear();
    mocks.resolveExplicitTtsOverrides.mockClear();
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

  it("lists canonical capabilities", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "list", "--json"],
    });

    const payload = mocks.runtime.writeJson.mock.calls[0]?.[0] as Array<{ id: string }>;
    expect(payload.some((entry) => entry.id === "model.run")).toBe(true);
    expect(payload.some((entry) => entry.id === "image.describe")).toBe(true);
  });

  it("defaults model run to local transport", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "model", "run", "--prompt", "hello", "--json"],
    });

    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "model.run",
        transport: "local",
      }),
    );
  });

  it("defaults tts status to gateway transport", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "tts", "status", "--json"],
    });

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "tts.status" }),
    );
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ transport: "gateway" }),
    );
  });

  it("routes image describe through media understanding, not generation", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "image", "describe", "--file", "photo.jpg", "--json"],
    });

    expect(mocks.describeImageFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: expect.stringMatching(/photo\.jpg$/) }),
    );
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "image.describe",
        outputs: [expect.objectContaining({ kind: "image.description" })],
      }),
    );
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

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [
          expect.objectContaining({
            path: tempOutput.replace(/\.png$/, ".jpg"),
            mimeType: "image/jpeg",
          }),
        ],
      }),
    );
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
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/generated-video.mp4",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(await fs.readFile(outputPath, "utf8")).toBe("video-bytes");
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "video.generate",
        provider: "vydra",
        outputs: [
          expect.objectContaining({
            path: outputPath,
            mimeType: "video/mp4",
            size: 11,
          }),
        ],
      }),
    );
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
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Video asset at index 0 has neither buffer nor url"),
    );
  });

  it("routes audio transcribe through transcription, not realtime", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "audio", "transcribe", "--file", "memo.m4a", "--json"],
    });

    expect(mocks.transcribeAudioFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: expect.stringMatching(/memo\.m4a$/) }),
    );
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "audio.transcribe",
        outputs: [expect.objectContaining({ kind: "audio.transcription" })],
      }),
    );
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

    expect(mocks.transcribeAudioFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: expect.stringMatching(/memo\.m4a$/),
        language: "en",
        prompt: "Focus on names",
      }),
    );
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

    expect(mocks.textToSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: expect.objectContaining({
          provider: "openai",
          providerOverrides: expect.objectContaining({
            openai: expect.objectContaining({
              modelId: "gpt-4o-mini-tts",
              voiceId: "alloy",
            }),
          }),
        }),
      }),
    );
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

    expect(mocks.textToSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        disableFallback: true,
      }),
    );
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

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "tts.convert",
        params: expect.objectContaining({
          provider: undefined,
          voiceId: "alloy",
        }),
      }),
    );
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

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("--output is not supported for remote gateway TTS yet"),
    );
  });

  it("uses only embedding providers for embedding creation", async () => {
    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "embedding", "create", "--text", "hello", "--json"],
    });

    expect(mocks.createEmbeddingProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "auto",
        fallback: "none",
      }),
    );
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "embedding.create",
        provider: "openai",
        model: "text-embedding-3-small",
      }),
    );
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

    expect(mocks.createEmbeddingProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        fallback: "none",
        model: "text-embedding-3-large",
      }),
    );
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

    expect(updatedStore).toMatchObject({
      profiles: {
        "anthropic:default": { id: "anthropic:default" },
      },
      order: {},
      lastGood: {},
      usageStats: {
        "anthropic:default": { errorCount: 3 },
      },
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

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to remove saved auth profiles for provider openai."),
    );
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

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Model overrides must use the form <provider/model>."),
    );
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

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Model overrides must use the form <provider/model>."),
    );
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

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Model overrides must use the form <provider/model>."),
    );
    expect(vi.mocked(mediaRuntime.describeVideoFile)).not.toHaveBeenCalled();
  });

  it("bootstraps built-in embedding providers when the registry is empty", async () => {
    mocks.listMemoryEmbeddingProviders.mockReturnValueOnce([]);

    await runRegisteredCli({
      register: registerCapabilityCli as (program: Command) => void,
      argv: ["capability", "embedding", "providers", "--json"],
    });

    expect(mocks.registerBuiltInMemoryEmbeddingProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        registerMemoryEmbeddingProvider: expect.any(Function),
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
