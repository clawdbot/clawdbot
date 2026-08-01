// Media-store reference tests cover inbound media:// references that arrive in
// the attachment url field, as channel plugins produce after saveMediaBuffer.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { toInboundMediaFacts } from "../channels/inbound-event/media.js";
import type { ChannelInboundMediaInput } from "../channels/inbound-event/media.js";
import type { OpenClawConfig } from "../config/types.js";
import { saveMediaBuffer } from "../media/store.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.attachments.js";
import { formatDecisionSummary } from "./runner.entries.js";
import { runCapability } from "./runner.js";
import { createSafeAudioFixtureBuffer } from "./runner.test-utils.js";
import type { AudioTranscriptionRequest, MediaUnderstandingProvider } from "./types.js";

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

function createOpenAiAudioCfg(): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          apiKey: "test-key",
          models: [],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

async function runInboundVoiceNoteCase(params: {
  buildMedia: (saved: { id: string; path: string }) => ChannelInboundMediaInput;
}) {
  // Realpath the temp root: macOS resolves os.tmpdir() through /private, and the
  // media store returns canonical paths that would otherwise miss the roots.
  const stateDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-store-ref-")),
  );
  const transcribeAudio = vi.fn(async (req: AudioTranscriptionRequest) => ({
    text: "hello from the voice note",
    model: req.model ?? "unknown",
  }));
  try {
    return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, PATH: "" }, async () => {
      // Real inbound store write, exactly what a channel plugin does for an
      // inbound voice note before handing the reference to the agent turn.
      const saved = await saveMediaBuffer(
        createSafeAudioFixtureBuffer(2048, 0x52),
        "audio/ogg",
        "inbound",
      );
      // toInboundMediaFacts is the documented channel-plugin entry point for
      // inbound attachments (docs/plugins/sdk-channel-plugins.md).
      const ctx = { media: toInboundMediaFacts([params.buildMedia(saved)]) };
      const media = normalizeMediaAttachments(ctx);
      const cache = createMediaAttachmentCache(media, {
        localPathRoots: [path.dirname(saved.path)],
        includeDefaultLocalPathRoots: false,
      });
      const providerRegistry = new Map<string, MediaUnderstandingProvider>([
        ["openai", { id: "openai", capabilities: ["audio"], transcribeAudio }],
      ]);
      try {
        const result = await runCapability({
          capability: "audio",
          cfg: createOpenAiAudioCfg(),
          ctx,
          attachments: cache,
          media,
          providerRegistry,
        });
        return { result, transcribeAudio, saved };
      } finally {
        await cache.cleanup();
      }
    });
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("inbound media-store references in the attachment url field", () => {
  it("transcribes a voice note referenced only by media://inbound", async () => {
    const { result, transcribeAudio } = await runInboundVoiceNoteCase({
      buildMedia: (saved) => ({
        url: `media://inbound/${saved.id}`,
        contentType: "audio/ogg",
      }),
    });

    expect(formatDecisionSummary(result.decision)).toBe(
      "audio: success (1/1) via openai/gpt-4o-transcribe",
    );
    expect(result.outputs[0]?.text).toBe("hello from the voice note");
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
  });

  it("transcribes a voice note carrying both a local path and a media:// url", async () => {
    const { result, transcribeAudio } = await runInboundVoiceNoteCase({
      buildMedia: (saved) => ({
        path: saved.path,
        url: `media://inbound/${saved.id}`,
        contentType: "audio/ogg",
      }),
    });

    expect(result.decision.outcome).toBe("success");
    expect(result.outputs[0]?.text).toBe("hello from the voice note");
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
  });
});
