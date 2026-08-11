// Media-store reference tests cover inbound media:// references that arrive in
// the attachment url field, as channel plugins produce after saveMediaBuffer.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { toInboundMediaFacts } from "../channels/inbound-event/media.js";
import type { ChannelInboundMediaInput } from "../channels/inbound-event/media.js";
import type { OpenClawConfig } from "../config/types.js";
import { saveMediaBuffer } from "../media/store.js";
import { withEnvAsync } from "../test-utils/env.js";
import { applyMediaUnderstanding } from "./apply.js";
import { MediaAttachmentCache } from "./attachments.js";
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

function createUrlDisabledFileCfg(): OpenClawConfig {
  return {
    tools: {
      media: {
        audio: { enabled: false },
        image: { enabled: false },
        video: { enabled: false },
      },
    },
    gateway: {
      http: {
        endpoints: {
          responses: {
            files: { allowUrl: false },
          },
        },
      },
    },
  };
}

async function withStoredInboundAudio<T>(
  run: (saved: { id: string; path: string }, stateDir: string) => Promise<T>,
): Promise<T> {
  // Realpath the temp root: macOS resolves os.tmpdir() through /private, and the
  // media store returns canonical paths that would otherwise miss the roots.
  const stateDir = await fs.realpath(tempDirs.make("openclaw-media-store-ref-", os.tmpdir()));
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, PATH: "" }, async () => {
    // Real inbound store write, exactly what a channel plugin does for an
    // inbound voice note before handing the reference to the agent turn.
    const saved = await saveMediaBuffer(
      createSafeAudioFixtureBuffer(2048, 0x52),
      "audio/ogg",
      "inbound",
    );
    return await run(saved, stateDir);
  });
}

async function withStoredInboundDocument<T>(
  run: (saved: { id: string; path: string }) => Promise<T>,
): Promise<T> {
  const stateDir = await fs.realpath(tempDirs.make("openclaw-media-store-ref-", os.tmpdir()));
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, PATH: "" }, async () => {
    const saved = await saveMediaBuffer(
      Buffer.from("stored document text", "utf8"),
      "text/plain",
      "inbound",
    );
    return await run(saved);
  });
}

async function runInboundVoiceNoteCase(params: {
  buildMedia: (
    saved: { id: string; path: string },
    stateDir: string,
  ) => ChannelInboundMediaInput | Promise<ChannelInboundMediaInput>;
}) {
  return await withStoredInboundAudio(async (saved, stateDir) => {
    const transcribeAudio = vi.fn(async (req: AudioTranscriptionRequest) => ({
      text: "hello from the voice note",
      model: req.model ?? "unknown",
    }));
    const mediaInput = await params.buildMedia(saved, stateDir);
    // toInboundMediaFacts is the documented channel-plugin entry point for
    // inbound attachments (docs/plugins/sdk-channel-plugins.md).
    const ctx = { media: toInboundMediaFacts([mediaInput]) };
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
}

describe("inbound media-store references in the attachment url field", () => {
  it("extracts a stored document when remote URLs are disabled", async () => {
    await withStoredInboundDocument(async (saved) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const ctx: MsgContext = {
        Body: "<media:document>",
        media: toInboundMediaFacts([
          {
            url: `media://inbound/${saved.id}`,
            contentType: "text/plain",
            kind: "document",
          },
        ]),
      };

      try {
        const result = await applyMediaUnderstanding({
          ctx,
          cfg: createUrlDisabledFileCfg(),
        });

        expect(result.appliedFile).toBe(true);
        expect(ctx.Body).toContain("stored document text");
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  it("reports blocked HTTP documents when remote URLs are disabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ctx: MsgContext = {
      Body: "<media:document>",
      media: toInboundMediaFacts([
        {
          url: "https://example.test/report.txt",
          contentType: "text/plain",
          kind: "document",
        },
      ]),
    };

    try {
      const result = await applyMediaUnderstanding({
        ctx,
        cfg: createUrlDisabledFileCfg(),
      });

      expect(result.appliedFile).toBe(true);
      expect(ctx.Body).toContain("[Attachment skipped: URL file sources are disabled]");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("never renders signed URL query credentials as attachment names", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ctx: MsgContext = {
      Body: "<media:document>",
      media: toInboundMediaFacts([
        {
          url: "https://cdn.example.test/docs/report.docx?X-Amz-Signature=SECRETSIG&X-Amz-Credential=AKIA123",
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          kind: "document",
        },
      ]),
    };

    try {
      const result = await applyMediaUnderstanding({
        ctx,
        cfg: createUrlDisabledFileCfg(),
      });

      expect(result.appliedFile).toBe(true);
      expect(ctx.Body).toContain("[Attachment skipped: URL file sources are disabled]");
      expect(ctx.Body).toContain('name="report.docx"');
      expect(ctx.Body).not.toContain("SECRETSIG");
      expect(ctx.Body).not.toContain("AKIA123");
    } finally {
      fetchSpy.mockRestore();
    }
  });

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

  it("prefers a valid local path over a conflicting media:// alias", async () => {
    const { result, transcribeAudio } = await runInboundVoiceNoteCase({
      buildMedia: async (saved) => {
        const alternatePath = path.join(path.dirname(saved.path), "alternate.ogg");
        await fs.writeFile(alternatePath, createSafeAudioFixtureBuffer(2048, 0x41));
        return {
          path: alternatePath,
          url: `media://inbound/${saved.id}`,
          contentType: "audio/ogg",
        };
      },
    });

    expect(result.decision.outcome).toBe("success");
    expect(result.outputs[0]?.text).toBe("hello from the voice note");
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(transcribeAudio.mock.calls[0]?.[0].buffer).toEqual(
      createSafeAudioFixtureBuffer(2048, 0x41),
    );
  });

  it("prefers the media:// alias when the supplied path is stale", async () => {
    const { result, transcribeAudio } = await runInboundVoiceNoteCase({
      buildMedia: (saved) => ({
        path: path.join(path.dirname(saved.path), "missing.ogg"),
        url: `media://inbound/${saved.id}`,
        contentType: "audio/ogg",
      }),
    });

    expect(result.decision.outcome).toBe("success");
    expect(result.outputs[0]?.text).toBe("hello from the voice note");
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
  });

  it("prefers the media:// alias when the supplied path is blocked", async () => {
    const { result, transcribeAudio } = await runInboundVoiceNoteCase({
      buildMedia: async (saved, stateDir) => {
        const blockedPath = path.join(stateDir, "blocked.ogg");
        await fs.writeFile(blockedPath, "blocked");
        return {
          path: blockedPath,
          url: `media://inbound/${saved.id}`,
          contentType: "audio/ogg",
        };
      },
    });

    expect(result.decision.outcome).toBe("success");
    expect(result.outputs[0]?.text).toBe("hello from the voice note");
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
  });

  it("falls back to a valid path when the media:// alias is invalid", async () => {
    const { result, transcribeAudio } = await runInboundVoiceNoteCase({
      buildMedia: (saved) => ({
        path: saved.path,
        url: "media://outbound/not-an-inbound-file.ogg",
        contentType: "audio/ogg",
      }),
    });

    expect(result.decision.outcome).toBe("success");
    expect(result.outputs[0]?.text).toBe("hello from the voice note");
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
  });

  it("returns the stored path for media:// aliases", async () => {
    await withStoredInboundAudio(async (saved) => {
      const cache = new MediaAttachmentCache(
        [{ index: 0, url: `media://inbound/${saved.id}`, mime: "audio/ogg" }],
        {
          localPathRoots: [path.dirname(saved.path)],
          includeDefaultLocalPathRoots: false,
        },
      );
      try {
        const result = await cache.getPath({
          attachmentIndex: 0,
          maxBytes: 4096,
          timeoutMs: 1000,
        });

        expect(result.path).toBe(await fs.realpath(saved.path));
        expect(result.cleanup).toBeUndefined();
      } finally {
        await cache.cleanup();
      }
    });
  });

  it("returns the stored path after a stale path fails", async () => {
    await withStoredInboundAudio(async (saved) => {
      const cache = new MediaAttachmentCache(
        [
          {
            index: 0,
            path: `${saved.path}.missing`,
            url: `media://inbound/${saved.id}`,
            mime: "audio/ogg",
          },
        ],
        {
          localPathRoots: [path.dirname(saved.path)],
          includeDefaultLocalPathRoots: false,
        },
      );
      try {
        const result = await cache.getPath({
          attachmentIndex: 0,
          maxBytes: 4096,
          timeoutMs: 1000,
        });

        expect(result.path).toBe(await fs.realpath(saved.path));
        expect(result.cleanup).toBeUndefined();
      } finally {
        await cache.cleanup();
      }
    });
  });

  it("does not bypass a path maxBytes failure through the media:// alias", async () => {
    await withStoredInboundAudio(async (saved) => {
      const oversizedPath = path.join(path.dirname(saved.path), "oversized.ogg");
      await fs.writeFile(oversizedPath, createSafeAudioFixtureBuffer(8192, 0x41));
      const cache = new MediaAttachmentCache(
        [
          {
            index: 0,
            path: oversizedPath,
            url: `media://inbound/${saved.id}`,
            mime: "audio/ogg",
          },
        ],
        {
          localPathRoots: [path.dirname(saved.path)],
          includeDefaultLocalPathRoots: false,
        },
      );
      try {
        await expect(
          cache.getBuffer({ attachmentIndex: 0, maxBytes: 4096, timeoutMs: 1000 }),
        ).rejects.toMatchObject({ reason: "maxBytes" });
      } finally {
        await cache.cleanup();
      }
    });
  });

  it("rejects malformed media:// aliases without attempting a remote fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const cache = new MediaAttachmentCache([{ index: 0, url: "media://inbound/%" }]);

    try {
      await expect(
        cache.getBuffer({ attachmentIndex: 0, maxBytes: 4096, timeoutMs: 1000 }),
      ).rejects.toMatchObject({ reason: "empty" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
