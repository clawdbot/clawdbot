import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createSafeAudioFixtureBuffer } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

type ResolveApiKeyForProvider = typeof import("../agents/model-auth.js").resolveApiKeyForProvider;

const resolveApiKeyForProviderMock = vi.hoisted(() =>
  vi.fn<ResolveApiKeyForProvider>(async () => ({
    apiKey: "test-key", // pragma: allowlist secret
    source: "test",
    mode: "api-key",
  })),
);
const hasAvailableAuthForProviderMock = vi.hoisted(() =>
  vi.fn(async (...args: Parameters<ResolveApiKeyForProvider>) => {
    const resolved = await resolveApiKeyForProviderMock(...args);
    return Boolean(resolved?.apiKey);
  }),
);
const getApiKeyForModelMock = vi.hoisted(() =>
  vi.fn(async () => ({ apiKey: "test-key", source: "test", mode: "api-key" })),
);
const fetchRemoteMediaMock = vi.hoisted(() => vi.fn());
const runExecMock = vi.hoisted(() => vi.fn());
const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());
const mockDeliverOutboundPayloads = vi.hoisted(() => vi.fn());

const { MediaFetchErrorMock } = vi.hoisted(() => {
  class MediaFetchErrorMock extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = "MediaFetchError";
      this.code = code;
    }
  }
  return { MediaFetchErrorMock };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let applyMediaUnderstanding: typeof import("./apply.js").applyMediaUnderstanding;

const TEMP_MEDIA_PREFIX = "openclaw-echo-transcript-test-";
let suiteTempMediaRootDir = "";

async function createTempAudioFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(suiteTempMediaRootDir, "case-"));
  const filePath = path.join(dir, "note.ogg");
  await fs.writeFile(filePath, createSafeAudioFixtureBuffer(2048));
  return filePath;
}

function createAudioCtxWithProvider(mediaPath: string, extra?: Partial<MsgContext>): MsgContext {
  return {
    Body: "<media:audio>",
    MediaPath: mediaPath,
    MediaType: "audio/ogg",
    Provider: "voicechat",
    From: "+10000000001",
    AccountId: "acc1",
    ...extra,
  };
}

function createAudioConfigWithEcho(opts?: {
  echoTranscript?: boolean;
  echoFormat?: string;
  transcribedText?: string;
}): {
  cfg: OpenClawConfig;
  providers: Record<string, { id: string; transcribeAudio: () => Promise<{ text: string }> }>;
} {
  const cfg: OpenClawConfig = {
    tools: {
      media: {
        audio: {
          enabled: true,
          maxBytes: 1024 * 1024,
          models: [{ provider: "groq" }],
          echoTranscript: opts?.echoTranscript ?? true,
          ...(opts?.echoFormat !== undefined ? { echoFormat: opts.echoFormat } : {}),
        },
      },
    },
  };
  const providers = {
    groq: {
      id: "groq",
      transcribeAudio: async () => ({ text: opts?.transcribedText ?? "hello world" }),
    },
  };
  return { cfg, providers };
}

function expectSingleEchoDeliveryCall() {
  expect(mockDeliverOutboundPayloads).toHaveBeenCalledOnce();
  const callArgs = mockDeliverOutboundPayloads.mock.calls[0]?.[0];
  expect(callArgs).toBeDefined();
  return callArgs as {
    to?: string;
    channel?: string;
    accountId?: string;
    payloads: Array<{ text?: string }>;
  };
}

function createAudioConfigWithoutEchoFlag() {
  const { cfg, providers } = createAudioConfigWithEcho();
  const audio = cfg.tools?.media?.audio as { echoTranscript?: boolean } | undefined;
  if (audio && "echoTranscript" in audio) {
    delete audio.echoTranscript;
  }
  return { cfg, providers };
}

function createRegistryMediaProviders(): Record<string, MediaUnderstandingProvider> {
  const createAudioProvider = (id: string): MediaUnderstandingProvider => ({
    id,
    capabilities: ["audio"],
    transcribeAudio: async () => ({ text: "transcribed text" }),
  });
  return {
    groq: createAudioProvider("groq"),
    deepgram: createAudioProvider("deepgram"),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyMediaUnderstanding – echo transcript", () => {
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("../agents/model-auth.js", () => ({
      resolveApiKeyForProvider: resolveApiKeyForProviderMock,
      hasAvailableAuthForProvider: hasAvailableAuthForProviderMock,
      requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => {
        if (auth?.apiKey) {
          return auth.apiKey;
        }
        throw new Error(
          `No API key resolved for provider "${provider}" (auth mode: ${auth?.mode}).`,
        );
      },
      resolveAwsSdkEnvVarName: vi.fn(() => undefined),
      resolveEnvApiKey: vi.fn(() => null),
      resolveModelAuthMode: vi.fn(() => "api-key"),
      getApiKeyForModel: getApiKeyForModelMock,
      getCustomProviderApiKey: vi.fn(() => undefined),
      ensureAuthProfileStore: vi.fn(async () => ({})),
      resolveAuthProfileOrder: vi.fn(() => []),
    }));
    vi.doMock("../media/fetch.js", () => ({
      fetchRemoteMedia: fetchRemoteMediaMock,
      MediaFetchError: MediaFetchErrorMock,
    }));
    vi.doMock("../process/exec.js", () => ({
      runExec: runExecMock,
      runCommandWithTimeout: runCommandWithTimeoutMock,
    }));
    vi.doMock("../infra/outbound/deliver-runtime.js", () => ({
      deliverOutboundPayloads: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
    }));
    vi.doMock("../utils/message-channel.js", () => ({
      isDeliverableMessageChannel: (channel: string) => channel === "voicechat",
    }));
    vi.doMock("./provider-registry.js", async () => {
      const actual =
        await vi.importActual<typeof import("./provider-registry.js")>("./provider-registry.js");
      const registryProviders = createRegistryMediaProviders();
      return {
        ...actual,
        buildMediaUnderstandingRegistry: (
          overrides?: Record<string, MediaUnderstandingProvider>,
        ) => {
          const registry = new Map<string, MediaUnderstandingProvider>(
            Object.entries(registryProviders),
          );
          for (const [key, provider] of Object.entries(overrides ?? {})) {
            const normalizedKey = actual.normalizeMediaProviderId(key);
            const existing = registry.get(normalizedKey);
            registry.set(
              normalizedKey,
              existing
                ? {
                    ...existing,
                    ...provider,
                    capabilities: provider.capabilities ?? existing.capabilities,
                  }
                : provider,
            );
          }
          return registry;
        },
      };
    });

    const baseDir = resolvePreferredOpenClawTmpDir();
    await fs.mkdir(baseDir, { recursive: true });
    suiteTempMediaRootDir = await fs.mkdtemp(path.join(baseDir, TEMP_MEDIA_PREFIX));
    const mod = await import("./apply.js");
    applyMediaUnderstanding = mod.applyMediaUnderstanding;
  });

  beforeEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    hasAvailableAuthForProviderMock.mockClear();
    getApiKeyForModelMock.mockClear();
    fetchRemoteMediaMock.mockClear();
    runExecMock.mockReset();
    runCommandWithTimeoutMock.mockReset();
    mockDeliverOutboundPayloads.mockClear();
    mockDeliverOutboundPayloads.mockResolvedValue([{ channel: "voicechat", messageId: "echo-1" }]);
  });

  afterAll(async () => {
    if (!suiteTempMediaRootDir) {
      return;
    }
    await fs.rm(suiteTempMediaRootDir, { recursive: true, force: true });
    suiteTempMediaRootDir = "";
  });

  it("does NOT echo when echoTranscript is false (default)", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const { cfg, providers } = createAudioConfigWithEcho({ echoTranscript: false });

    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does NOT echo when echoTranscript is absent (default)", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const { cfg, providers } = createAudioConfigWithoutEchoFlag();

    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("echoes transcript with default format when echoTranscript is true", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const { cfg, providers } = createAudioConfigWithEcho({
      echoTranscript: true,
      transcribedText: "hello world",
    });

    await applyMediaUnderstanding({ ctx, cfg, providers });

    const callArgs = expectSingleEchoDeliveryCall();
    expect(callArgs.channel).toBe("voicechat");
    expect(callArgs.to).toBe("+10000000001");
    expect(callArgs.accountId).toBe("acc1");
    expect(callArgs.payloads).toHaveLength(1);
    expect(callArgs.payloads[0].text).toBe('📝 "hello world"');
  });

  it("does NOT echo when there are no audio attachments", async () => {
    // Image-only context — no audio attachment
    const dir = await fs.mkdtemp(path.join(suiteTempMediaRootDir, "img-"));
    const imgPath = path.join(dir, "photo.jpg");
    await fs.writeFile(imgPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    const ctx: MsgContext = {
      Body: "<media:image>",
      MediaPath: imgPath,
      MediaType: "image/jpeg",
      Provider: "voicechat",
      From: "+10000000001",
    };

    const { cfg, providers } = createAudioConfigWithEcho({
      echoTranscript: true,
      transcribedText: "should not appear",
    });
    cfg.tools!.media!.image = { enabled: false };

    await applyMediaUnderstanding({ ctx, cfg, providers });

    // No audio outputs → Transcript not set → no echo
    expect(ctx.Transcript).toBeUndefined();
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does NOT echo when transcription fails", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const { cfg, providers } = createAudioConfigWithEcho({ echoTranscript: true });
    providers.groq.transcribeAudio = async () => {
      throw new Error("transcription provider failure");
    };

    // Should not throw; transcription failure is swallowed by runner
    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(ctx.Transcript).toBeUndefined();
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });
});
