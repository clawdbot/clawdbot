import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { MIN_AUDIO_FILE_BYTES } from "./defaults.js";
import { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.attachments.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import type { AudioTranscriptionRequest } from "./types.js";

const modelAuthMocks = vi.hoisted(() => ({
  hasAvailableAuthForProvider: vi.fn(() => true),
  resolveApiKeyForProvider: vi.fn(async () => ({
    apiKey: "test-key",
    source: "test",
    mode: "api-key",
  })),
  requireApiKey: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? "test-key"),
}));

vi.mock("../agents/model-auth.js", () => ({
  hasAvailableAuthForProvider: modelAuthMocks.hasAvailableAuthForProvider,
  resolveApiKeyForProvider: modelAuthMocks.resolveApiKeyForProvider,
  requireApiKey: modelAuthMocks.requireApiKey,
}));

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));

async function withAudioFixture(params: {
  filePrefix: string;
  extension: string;
  mediaType: string;
  fileContents: Buffer;
  run: (params: {
    ctx: MsgContext;
    media: ReturnType<typeof normalizeMediaAttachments>;
    cache: ReturnType<typeof createMediaAttachmentCache>;
  }) => Promise<void>;
}) {
  const originalPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";

  const tmpPath = path.join(
    os.tmpdir(),
    `${params.filePrefix}-${Date.now().toString()}.${params.extension}`,
  );
  await fs.writeFile(tmpPath, params.fileContents);

  const ctx: MsgContext = { MediaPath: tmpPath, MediaType: params.mediaType };
  const media = normalizeMediaAttachments(ctx);
  const cache = createMediaAttachmentCache(media, {
    localPathRoots: [path.dirname(tmpPath)],
    includeDefaultLocalPathRoots: false,
  });

  try {
    await params.run({ ctx, media, cache });
  } finally {
    process.env.PATH = originalPath;
    await cache.cleanup();
    await fs.unlink(tmpPath).catch(() => {});
  }
}

const AUDIO_CAPABILITY_CFG = {
  models: {
    providers: {
      openai: {
        apiKey: "test-key", // pragma: allowlist secret
        models: [],
      },
    },
  },
} as unknown as OpenClawConfig;

async function runAudioCapabilityWithTranscriber(params: {
  ctx: MsgContext;
  media: ReturnType<typeof normalizeMediaAttachments>;
  cache: ReturnType<typeof createMediaAttachmentCache>;
  transcribeAudio: (req: AudioTranscriptionRequest) => Promise<{ text: string; model: string }>;
}) {
  const providerRegistry = buildProviderRegistry({
    openai: {
      id: "openai",
      capabilities: ["audio"],
      transcribeAudio: params.transcribeAudio,
    },
  });

  return await runCapability({
    capability: "audio",
    cfg: AUDIO_CAPABILITY_CFG,
    ctx: params.ctx,
    attachments: params.cache,
    media: params.media,
    providerRegistry,
  });
}

describe("runCapability skips tiny audio files", () => {
  it("skips audio transcription when file is smaller than MIN_AUDIO_FILE_BYTES", async () => {
    await withAudioFixture({
      filePrefix: "openclaw-tiny-audio",
      extension: "wav",
      mediaType: "audio/wav",
      fileContents: Buffer.alloc(100), // 100 bytes, way below 1024
      run: async ({ ctx, media, cache }) => {
        let transcribeCalled = false;
        const result = await runAudioCapabilityWithTranscriber({
          ctx,
          media,
          cache,
          transcribeAudio: async (req) => {
            transcribeCalled = true;
            return { text: "should not happen", model: req.model ?? "whisper-1" };
          },
        });

        // The provider should never be called
        expect(transcribeCalled).toBe(false);

        // The result should indicate the attachment was skipped
        expect(result.outputs).toHaveLength(0);
        expect(result.decision.outcome).toBe("skipped");
        expect(result.decision.attachments).toHaveLength(1);
        expect(result.decision.attachments[0].attempts).toHaveLength(1);
        expect(result.decision.attachments[0].attempts[0].outcome).toBe("skipped");
        expect(result.decision.attachments[0].attempts[0].reason).toContain("tooSmall");
      },
    });
  });

  it("skips audio transcription for empty (0-byte) files", async () => {
    await withAudioFixture({
      filePrefix: "openclaw-empty-audio",
      extension: "ogg",
      mediaType: "audio/ogg",
      fileContents: Buffer.alloc(0),
      run: async ({ ctx, media, cache }) => {
        let transcribeCalled = false;
        const result = await runAudioCapabilityWithTranscriber({
          ctx,
          media,
          cache,
          transcribeAudio: async () => {
            transcribeCalled = true;
            return { text: "nope", model: "whisper-1" };
          },
        });

        expect(transcribeCalled).toBe(false);
        expect(result.outputs).toHaveLength(0);
      },
    });
  });

  it("proceeds with transcription when file meets minimum size", async () => {
    await withAudioFixture({
      filePrefix: "openclaw-ok-audio",
      extension: "wav",
      mediaType: "audio/wav",
      fileContents: Buffer.alloc(MIN_AUDIO_FILE_BYTES + 100),
      run: async ({ ctx, media, cache }) => {
        let transcribeCalled = false;
        const result = await runAudioCapabilityWithTranscriber({
          ctx,
          media,
          cache,
          transcribeAudio: async (req) => {
            transcribeCalled = true;
            return { text: "hello world", model: req.model ?? "whisper-1" };
          },
        });

        expect(transcribeCalled).toBe(true);
        expect(result.outputs).toHaveLength(1);
        expect(result.outputs[0].text).toBe("hello world");
        expect(result.decision.outcome).toBe("success");
      },
    });
  });
});
