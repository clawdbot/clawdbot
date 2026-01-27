import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MoltbotConfig } from "../config/config.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { fetchRemoteMedia } from "../media/fetch.js";

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: vi.fn(async () => ({
    apiKey: "test-key",
    source: "test",
    mode: "api-key",
  })),
  requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => {
    if (auth?.apiKey) return auth.apiKey;
    throw new Error(`No API key resolved for provider "${provider}" (auth mode: ${auth?.mode}).`);
  },
}));

vi.mock("../media/fetch.js", () => ({
  fetchRemoteMedia: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runExec: vi.fn(),
}));

async function loadApply() {
  return await import("./apply.js");
}

describe("applyMediaUnderstanding", () => {
  const mockedResolveApiKey = vi.mocked(resolveApiKeyForProvider);
  const mockedFetchRemoteMedia = vi.mocked(fetchRemoteMedia);

  beforeEach(() => {
    mockedResolveApiKey.mockClear();
    mockedFetchRemoteMedia.mockReset();
    mockedFetchRemoteMedia.mockResolvedValue({
      buffer: Buffer.from("audio-bytes"),
      contentType: "audio/ogg",
      fileName: "note.ogg",
    });
  });

  it("sets Transcript and replaces Body when audio transcription succeeds", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-media-"));
    const audioPath = path.join(dir, "note.ogg");
    await fs.writeFile(audioPath, "hello");

    const ctx: MsgContext = {
      Body: "<media:audio>",
      MediaPath: audioPath,
      MediaType: "audio/ogg",
    };
    const cfg: MoltbotConfig = {
      tools: {
        media: {
          audio: {
            enabled: true,
            maxBytes: 1024 * 1024,
            models: [{ provider: "groq" }],
          },
        },
      },
    };

    const result = await applyMediaUnderstanding({
      ctx,
      cfg,
      providers: {
        groq: {
          id: "groq",
          transcribeAudio: async () => ({ text: "transcribed text" }),
        },
      },
    });

    expect(result.appliedAudio).toBe(true);
    expect(ctx.Transcript).toBe("transcribed text");
    expect(ctx.Body).toBe("[Audio]\nTranscript:\ntranscribed text");
    expect(ctx.CommandBody).toBe("transcribed text");
    expect(ctx.RawBody).toBe("transcribed text");
    expect(ctx.BodyForAgent).toBe(ctx.Body);
    expect(ctx.BodyForCommands).toBe("transcribed text");
  });

  it("keeps caption for command parsing when audio has user text", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-media-"));
    const audioPath = path.join(dir, "note.ogg");
    await fs.writeFile(audioPath, "hello");

    const ctx: MsgContext = {
      Body: "<media:audio> /capture status",
      MediaPath: audioPath,
      MediaType: "audio/ogg",
    };
    const cfg: MoltbotConfig = {
      tools: {
        media: {
          audio: {
            enabled: true,
            maxBytes: 1024 * 1024,
            models: [{ provider: "groq" }],
          },
        },
      },
    };

    const result = await applyMediaUnderstanding({
      ctx,
      cfg,
      providers: {
        groq: {
          id: "groq",
          transcribeAudio: async () => ({ text: "transcribed text" }),
        },
      },
    });

    expect(result.appliedAudio).toBe(true);
    expect(ctx.Transcript).toBe("transcribed text");
    expect(ctx.Body).toBe("[Audio]\nUser text:\n/capture status\nTranscript:\ntranscribed text");
    expect(ctx.CommandBody).toBe("/capture status");
    expect(ctx.RawBody).toBe("/capture status");
    expect(ctx.BodyForCommands).toBe("/capture status");
  });

  it("handles URL-only attachments for audio transcription", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const ctx: MsgContext = {
      Body: "<media:audio>",
      MediaUrl: "https://example.com/note.ogg",
      MediaType: "audio/ogg",
      ChatType: "dm",
    };
    const cfg: MoltbotConfig = {
      tools: {
        media: {
          audio: {
            enabled: true,
            maxBytes: 1024 * 1024,
            scope: {
              default: "deny",
              rules: [{ action: "allow", match: { chatType: "direct" } }],
            },
            models: [{ provider: "groq" }],
          },
        },
      },
    };

    const result = await applyMediaUnderstanding({
      ctx,
      cfg,
      providers: {
        groq: {
          id: "groq",
          transcribeAudio: async () => ({ text: "remote transcript" }),
        },
      },
    });

    expect(result.appliedAudio).toBe(true);
    expect(ctx.Transcript).toBe("remote transcript");
    expect(ctx.Body).toBe("[Audio]\nTranscript:\nremote transcript");
  });

  it("skips audio transcription when attachment exceeds maxBytes", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-media-"));
    const audioPath = path.join(dir, "large.wav");
    await fs.writeFile(audioPath, "0123456789");

    const ctx: MsgContext = {
      Body: "<media:audio>",
      MediaPath: audioPath,
      MediaType: "audio/wav",
    };
    const transcribeAudio = vi.fn(async () => ({ text: "should-not-run" }));
    const cfg: MoltbotConfig = {
      tools: {
        media: {
          audio: {
            enabled: true,
            maxBytes: 4,
            models: [{ provider: "groq" }],
          },
        },
      },
    };

    const result = await applyMediaUnderstanding({
      ctx,
      cfg,
      providers: { groq: { id: "groq", transcribeAudio } },
    });

    expect(result.appliedAudio).toBe(false);
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(ctx.Body).toBe("<media:audio>");
  });

  it("falls back to CLI model when provider fails", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-media-"));
    const audioPath = path.join(dir, "note.ogg");
    await fs.writeFile(audioPath, "hello");

    const ctx: MsgContext = {
      Body: "<media:audio>",
      MediaPath: audioPath,
      MediaType: "audio/ogg",
    };
    const cfg: MoltbotConfig = {
      tools: {
        media: {
          audio: {
            enabled: true,
            models: [
              { provider: "groq" },
              {
                type: "cli",
                command: "whisper",
                args: ["{{MediaPath}}"],
              },
            ],
          },
        },
      },
    };

    const execModule = await import("../process/exec.js");
    vi.mocked(execModule.runExec).mockResolvedValue({
      stdout: "cli transcript\n",
      stderr: "",
    });

    const result = await applyMediaUnderstanding({
      ctx,
      cfg,
      providers: {
        groq: {
          id: "groq",
          transcribeAudio: async () => {
            throw new Error("boom");
          },
        },
      },
    });

    expect(result.appliedAudio).toBe(true);
    expect(ctx.Transcript).toBe("cli transcript");
    expect(ctx.Body).toBe("[Audio]\nTranscript:\ncli transcript");
  });

  it("uses CLI image understanding and preserves caption for commands", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-media-"));
    const imagePath = path.join(dir, "photo.jpg");
    await fs.writeFile(imagePath, "image-bytes");

    const ctx: MsgContext = {
      Body: "<media:image> show Dom",
      MediaPath: imagePath,
      MediaType: "image/jpeg",
    };
    const cfg: MoltbotConfig = {
      tools: {
        media: {
          image: {
            enabled: true,
            models: [
              {
                type: "cli",
                command: "gemini",
                args: ["--file", "{{MediaPath}}", "--prompt", "{{Prompt}}"],
              },
            ],
          },
        },
      },
    };

    const execModule = await import("../process/exec.js");
    vi.mocked(execModule.runExec).mockResolvedValue({
      stdout: "image description\n",
      stderr: "",
    });

    const result = await applyMediaUnderstanding({
      ctx,
      cfg,
    });

    expect(result.appliedImage).toBe(true);
    expect(ctx.Body).toBe("[Image]\nUser text:\nshow Dom\nDescription:\nimage description");
    expect(ctx.CommandBody).toBe("show Dom");
    expect(ctx.RawBody).toBe("show Dom");
    expect(ctx.BodyForAgent).toBe(ctx.Body);
    expect(ctx.BodyForCommands).toBe("show Dom");
  });

  it("uses shared media models list when capability config is missing", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-media-"));
    const imagePath = path.join(dir, "shared.jpg");
    await fs.writeFile(imagePath, "image-bytes");

    const ctx: MsgContext = {
      Body: "<media:image>",
      MediaPath: imagePath,
      MediaType: "image/jpeg",
    };
    const cfg: MoltbotConfig = {
      tools: {
        media: {
          models: [
            {
              type: "cli",
              command: "gemini",
              args: ["--allowed-tools", "read_file", "{{MediaPath}}"],
              capabilities: ["image"],
            },
          ],
        },
      },
    };

    const execModule = await import("../process/exec.js");
    vi.mocked(execModule.runExec).mockResolvedValue({
      stdout: "shared description\n",
      stderr: "",
    });

    const result = await applyMediaUnderstanding({
      ctx,
      cfg,
    });

    expect(result.appliedImage).toBe(true);
    expect(ctx.Body).toBe("[Image]\nDescription:\nshared description");
  });

  it("uses active model when enabled and models are missing", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-media-"));
    const audioPath = path.join(dir, "fallback.ogg");
    await fs.writeFile(audioPath, "hello");

    const ctx: MsgContext = {
      Body: "<media:audio>",
      MediaPath: audioPath,
      MediaType: "audio/ogg",
    };
    const cfg: MoltbotConfig = {
      tools: {
        media: {
          audio: {
            enabled: true,
          },
        },
      },
    };

    const result = await applyMediaUnderstanding({
      ctx,
      cfg,
      activeModel: { provider: "groq", model: "whisper-large-v3" },
      providers: {
        groq: {
          id: "groq",
          transcribeAudio: async () => ({ text: "fallback transcript" }),
        },
      },
    });

    expect(result.appliedAudio).toBe(true);
    expect(ctx.Transcript).toBe("fallback transcript");
  });

  it("handles multiple audio attachments when attachment mode is all", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-media-"));
    const audioPathA = path.join(dir, "note-a.ogg");
    const audioPathB = path.join(dir, "note-b.ogg");
    await fs.writeFile(audioPathA, "hello");
    await fs.writeFile(audioPathB, "world");

    const ctx: MsgContext = {
      Body: "<media:audio>",
      MediaPaths: [audioPathA, audioPathB],
      MediaTypes: ["audio/ogg", "audio/ogg"],
    };
    const cfg: MoltbotConfig = {
      tools: {
        media: {
          audio: {
            enabled: true,
            attachments: { mode: "all", maxAttachments: 2 },
            models: [{ provider: "groq" }],
          },
        },
      },
    };

    const result = await applyMediaUnderstanding({
      ctx,
      cfg,
      providers: {
        groq: {
          id: "groq",
          transcribeAudio: async (req) => ({ text: req.fileName }),
        },
      },
    });

    expect(result.appliedAudio).toBe(true);
    expect(ctx.Transcript).toBe("Audio 1:\nnote-a.ogg\n\nAudio 2:\nnote-b.ogg");
    expect(ctx.Body).toBe(
      ["[Audio 1/2]\nTranscript:\nnote-a.ogg", "[Audio 2/2]\nTranscript:\nnote-b.ogg"].join("\n\n"),
    );
  });

  it("orders mixed media outputs as image, audio, video", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-media-"));
    const imagePath = path.join(dir, "photo.jpg");
    const audioPath = path.join(dir, "note.ogg");
    const videoPath = path.join(dir, "clip.mp4");
    await fs.writeFile(imagePath, "image-bytes");
    await fs.writeFile(audioPath, "audio-bytes");
    await fs.writeFile(videoPath, "video-bytes");

    const ctx: MsgContext = {
      Body: "<media:mixed>",
      MediaPaths: [imagePath, audioPath, videoPath],
      MediaTypes: ["image/jpeg", "audio/ogg", "video/mp4"],
    };
    const cfg: MoltbotConfig = {
      tools: {
        media: {
          image: { enabled: true, models: [{ provider: "openai", model: "gpt-5.2" }] },
          audio: { enabled: true, models: [{ provider: "groq" }] },
          video: { enabled: true, models: [{ provider: "google", model: "gemini-3" }] },
        },
      },
    };

    const result = await applyMediaUnderstanding({
      ctx,
      cfg,
      agentDir: dir,
      providers: {
        openai: {
          id: "openai",
          describeImage: async () => ({ text: "image ok" }),
        },
        groq: {
          id: "groq",
          transcribeAudio: async () => ({ text: "audio ok" }),
        },
        google: {
          id: "google",
          describeVideo: async () => ({ text: "video ok" }),
        },
      },
    });

    expect(result.appliedImage).toBe(true);
    expect(result.appliedAudio).toBe(true);
    expect(result.appliedVideo).toBe(true);
    expect(ctx.Body).toBe(
      [
        "[Image]\nDescription:\nimage ok",
        "[Audio]\nTranscript:\naudio ok",
        "[Video]\nDescription:\nvideo ok",
      ].join("\n\n"),
    );
    expect(ctx.Transcript).toBe("audio ok");
    expect(ctx.CommandBody).toBe("audio ok");
    expect(ctx.BodyForCommands).toBe("audio ok");
  });
});
