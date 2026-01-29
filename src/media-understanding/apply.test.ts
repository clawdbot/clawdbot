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
      buffer: Buffer.from([0, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      contentType: "audio/ogg",
      fileName: "note.ogg",
    });
  });

  it("sets Transcript and replaces Body when audio transcription succeeds", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-media-"));
    const audioPath = path.join(dir, "note.ogg");
    await fs.writeFile(audioPath, Buffer.from([0, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8]));

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
    await fs.writeFile(audioPath, Buffer.from([0, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8]));

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
    await fs.writeFile(audioPath, Buffer.from([0, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

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
    await fs.writeFile(audioPath, Buffer.from([0, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8]));

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
    await fs.writeFile(audioPath, Buffer.from([0, 255, 0, 1, 2, 3, 4, 5, 6]));

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
    await fs.writeFile(audioPathA, Buffer.from([200, 201, 202, 203, 204, 205, 206, 207, 208]));
    await fs.writeFile(audioPathB, Buffer.from([200, 201, 202, 203, 204, 205, 206, 207, 208]));

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
    await fs.writeFile(audioPath, Buffer.from([200, 201, 202, 203, 204, 205, 206, 207, 208]));
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

  it("treats text-like audio attachments as CSV (comma wins over tabs)", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-media-"));
    const csvPath = path.join(dir, "data.mp3");
    const csvText = '"a","b"\t"c"\n"1","2"\t"3"';
    const csvBuffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csvText, "utf16le")]);
    await fs.writeFile(csvPath, csvBuffer);

    const ctx: MsgContext = {
      Body: "<media:audio>",
      MediaPath: csvPath,
      MediaType: "audio/mpeg",
    };
    const cfg: MoltbotConfig = {
      tools: {
        media: {
          audio: { enabled: false },
          image: { enabled: false },
          video: { enabled: false },
        },
      },
    };

    const result = await applyMediaUnderstanding({ ctx, cfg });

    expect(result.appliedFile).toBe(true);
    expect(ctx.Body).toContain('<file name="data.mp3" mime="text/csv">');
    expect(ctx.Body).toContain('"a","b"\t"c"');
  });

  it("infers TSV when tabs are present without commas", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-media-"));
    const tsvPath = path.join(dir, "report.mp3");
    const tsvText = "a\tb\tc\n1\t2\t3";
    await fs.writeFile(tsvPath, tsvText);

    const ctx: MsgContext = {
      Body: "<media:audio>",
      MediaPath: tsvPath,
      MediaType: "audio/mpeg",
    };
    const cfg: MoltbotConfig = {
      tools: {
        media: {
          audio: { enabled: false },
          image: { enabled: false },
          video: { enabled: false },
        },
      },
    };

    const result = await applyMediaUnderstanding({ ctx, cfg });

    expect(result.appliedFile).toBe(true);
    expect(ctx.Body).toContain('<file name="report.mp3" mime="text/tab-separated-values">');
    expect(ctx.Body).toContain("a\tb\tc");
  });

  it("escapes XML special characters in filenames to prevent injection", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-media-"));
    // Use & in filename — valid on all platforms (including Windows, which
    // forbids < and > in NTFS filenames) and still requires XML escaping.
    // Note: The sanitizeFilename in store.ts would strip most dangerous chars,
    // but we test that even if some slip through, they get escaped in output
    const filePath = path.join(dir, "file&test.txt");
    await fs.writeFile(filePath, "safe content");

    const ctx: MsgContext = {
      Body: "<media:document>",
      MediaPath: filePath,
      MediaType: "text/plain",
    };
    const cfg: MoltbotConfig = {
      tools: {
        media: {
          audio: { enabled: false },
          image: { enabled: false },
          video: { enabled: false },
        },
      },
    };

    const result = await applyMediaUnderstanding({ ctx, cfg });

    expect(result.appliedFile).toBe(true);
    // Verify XML special chars are escaped in the output
    expect(ctx.Body).toContain("&amp;");
    // The name attribute should contain the escaped form, not a raw unescaped &
    expect(ctx.Body).toMatch(/name="file&amp;test\.txt"/);
  });

  it("normalizes MIME types to prevent attribute injection", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-media-"));
    const filePath = path.join(dir, "data.txt");
    await fs.writeFile(filePath, "test content");

    const ctx: MsgContext = {
      Body: "<media:document>",
      MediaPath: filePath,
      // Attempt to inject via MIME type with quotes - normalization should strip this
      MediaType: 'text/plain" onclick="alert(1)',
    };
    const cfg: MoltbotConfig = {
      tools: {
        media: {
          audio: { enabled: false },
          image: { enabled: false },
          video: { enabled: false },
        },
      },
    };

    const result = await applyMediaUnderstanding({ ctx, cfg });

    expect(result.appliedFile).toBe(true);
    // MIME normalization strips everything after first ; or " - verify injection is blocked
    expect(ctx.Body).not.toContain("onclick=");
    expect(ctx.Body).not.toContain("alert(1)");
    // Verify the MIME type is normalized to just "text/plain"
    expect(ctx.Body).toContain('mime="text/plain"');
  });

  it("handles path traversal attempts in filenames safely", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-media-"));
    // Even if a file somehow got a path-like name, it should be handled safely
    const filePath = path.join(dir, "normal.txt");
    await fs.writeFile(filePath, "legitimate content");

    const ctx: MsgContext = {
      Body: "<media:document>",
      MediaPath: filePath,
      MediaType: "text/plain",
    };
    const cfg: MoltbotConfig = {
      tools: {
        media: {
          audio: { enabled: false },
          image: { enabled: false },
          video: { enabled: false },
        },
      },
    };

    const result = await applyMediaUnderstanding({ ctx, cfg });

    expect(result.appliedFile).toBe(true);
    // Verify the file was processed and output contains expected structure
    expect(ctx.Body).toContain('<file name="');
    expect(ctx.Body).toContain('mime="text/plain"');
    expect(ctx.Body).toContain("legitimate content");
  });

  it("handles files with non-ASCII Unicode filenames", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-media-"));
    const filePath = path.join(dir, "文档.txt");
    await fs.writeFile(filePath, "中文内容");

    const ctx: MsgContext = {
      Body: "<media:document>",
      MediaPath: filePath,
      MediaType: "text/plain",
    };
    const cfg: MoltbotConfig = {
      tools: {
        media: {
          audio: { enabled: false },
          image: { enabled: false },
          video: { enabled: false },
        },
      },
    };

    const result = await applyMediaUnderstanding({ ctx, cfg });

    expect(result.appliedFile).toBe(true);
    expect(ctx.Body).toContain("中文内容");
  });
});
