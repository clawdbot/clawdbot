import { describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { MIN_AUDIO_FILE_BYTES } from "./defaults.js";
import type {
  createMediaAttachmentCache,
  normalizeMediaAttachments,
} from "./runner.attachments.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import { withMediaFixture } from "./runner.test-utils.js";
import type { AudioTranscriptionRequest } from "./types.js";

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

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
  await withMediaFixture(
    {
      filePrefix: params.filePrefix,
      extension: params.extension,
      mediaType: params.mediaType,
      fileContents: params.fileContents,
    },
    params.run,
  );
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

  it("marks the decision as failed when every audio model attempt fails", async () => {
    await withAudioFixture({
      filePrefix: "openclaw-failed-audio",
      extension: "ogg",
      mediaType: "audio/ogg",
      fileContents: Buffer.alloc(MIN_AUDIO_FILE_BYTES + 100),
      run: async ({ ctx, media, cache }) => {
        const result = await runAudioCapabilityWithTranscriber({
          ctx,
          media,
          cache,
          transcribeAudio: async () => {
            throw new Error("upstream 500");
          },
        });

        expect(result.outputs).toHaveLength(0);
        expect(result.decision.outcome).toBe("failed");
        expect(result.decision.attachments).toHaveLength(1);
        expect(result.decision.attachments[0]?.attempts).toHaveLength(1);
        expect(result.decision.attachments[0]?.attempts[0]?.outcome).toBe("failed");
        expect(result.decision.attachments[0]?.attempts[0]?.reason).toContain("upstream 500");
      },
    });
  });
});
