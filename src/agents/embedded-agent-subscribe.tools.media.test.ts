// Tool media extraction tests cover structured media payloads, image fallbacks,
// trust decisions, and filtering of local/remote media URLs.
import { describe, expect, it } from "vitest";
import {
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
} from "./embedded-agent-subscribe.tools.js";
import { isToolResultMediaTrusted } from "./embedded-agent-subscribe.tools.test-support.js";

describe("extractToolResultMediaArtifact", () => {
  it("returns undefined for null/undefined", () => {
    expect(extractToolResultMediaArtifact(null)).toBeUndefined();
    expect(extractToolResultMediaArtifact(undefined)).toBeUndefined();
  });

  it("returns undefined for non-object", () => {
    expect(extractToolResultMediaArtifact("hello")).toBeUndefined();
    expect(extractToolResultMediaArtifact(42)).toBeUndefined();
  });

  it("extracts structured details.media without content blocks", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            mediaUrls: ["/tmp/img.png", "/tmp/img-2.png"],
          },
        },
      }),
    ).toEqual({
      mediaUrls: ["/tmp/img.png", "/tmp/img-2.png"],
    });
  });

  it("does not deliver explicitly private image results", () => {
    expect(
      extractToolResultMediaArtifact({
        content: [{ type: "image", data: "base64data", mimeType: "image/png" }],
        details: {
          path: "/tmp/browser-screenshot.png",
          media: { outbound: false },
        },
      }),
    ).toBeUndefined();
  });

  it("extracts structured details.media top-level aliases", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            path: " /tmp/path.png ",
            filePath: "/tmp/file.png",
            url: "https://example.test/url.png",
            fileUrl: "https://example.test/file-url.png",
            media: "/tmp/media.png",
          },
        },
      }),
    ).toEqual({
      mediaUrls: [
        "/tmp/media.png",
        "/tmp/path.png",
        "https://example.test/url.png",
        "/tmp/file.png",
        "https://example.test/file-url.png",
      ],
    });
  });

  it("extracts structured details.media attachments", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            attachments: [
              { type: "audio", path: "/tmp/song.mp3", mimeType: "audio/mpeg" },
              { type: "image", url: "https://example.test/cover.png" },
              { type: "file", media: "/tmp/stems.zip" },
              { type: "file", fileUrl: "https://example.test/stems.zip" },
            ],
          },
        },
      }),
    ).toEqual({
      mediaUrls: [
        "/tmp/song.mp3",
        "https://example.test/cover.png",
        "/tmp/stems.zip",
        "https://example.test/stems.zip",
      ],
    });
  });

  it("returns undefined when content has no text or image blocks", () => {
    expect(extractToolResultMediaArtifact({ content: [{ type: "other" }] })).toBeUndefined();
  });

  it("extracts structured media with audioAsVoice", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            mediaUrl: "/tmp/reply.opus",
            audioAsVoice: true,
          },
        },
      }),
    ).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    });
  });

  it("extracts structured media trust markers", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            mediaUrl: "/tmp/reply.opus",
            trustedLocalMedia: true,
          },
        },
      }),
    ).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      trustedLocalMedia: true,
    });
  });

  it("ignores media-looking text content and uses details.path image fallback", () => {
    const result = {
      content: [
        { type: "text", text: "MEDIA:/tmp/screenshot.png" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      details: { path: "/tmp/screenshot.png" },
    };
    expect(extractToolResultMediaArtifact(result)).toEqual({
      mediaUrls: ["/tmp/screenshot.png"],
    });
  });

  it("ignores media-looking text content without structured media or image fallback", () => {
    const result = {
      content: [
        { type: "text", text: "MEDIA:/tmp/page1.png" },
        { type: "text", text: "MEDIA:/tmp/page2.png" },
      ],
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("falls back to details.path when image content exists", () => {
    // Embedded read image results omit structured media but include details.path,
    // so image content is the guard that makes that path media.
    // Embedded read tool doesn't include structured media but OpenClaw
    // imageResult sets details.path as fallback.
    const result = {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      details: { path: "/tmp/generated.png" },
    };
    expect(extractToolResultMediaArtifact(result)).toEqual({
      mediaUrls: ["/tmp/generated.png"],
    });
  });

  it("returns undefined when image content exists but no details.path", () => {
    // Embedded read tool: has image content but no path anywhere in the result.
    const result = {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("ignores null/undefined items in content array", () => {
    const result = {
      content: [null, undefined, { type: "text", text: "MEDIA:/tmp/ok.png" }],
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("returns empty array for text-only results", () => {
    const result = {
      content: [{ type: "text", text: "Command executed successfully" }],
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("ignores details.path when no image content exists", () => {
    // Plain file paths in details are not media unless the content proves an
    // image/audio/video artifact was produced.
    // details.path without image content is not media.
    const result = {
      content: [{ type: "text", text: "File saved" }],
      details: { path: "/tmp/data.json" },
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("handles details.path with whitespace", () => {
    const result = {
      content: [{ type: "image", data: "base64", mimeType: "image/png" }],
      details: { path: "  /tmp/image.png  " },
    };
    expect(extractToolResultMediaArtifact(result)).toEqual({
      mediaUrls: ["/tmp/image.png"],
    });
  });

  it("skips empty details.path", () => {
    const result = {
      content: [{ type: "image", data: "base64", mimeType: "image/png" }],
      details: { path: "   " },
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("does not match <media:audio> placeholder as media", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "<media:audio> placeholder with successful preflight voice transcript",
        },
      ],
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("does not match <media:image> placeholder as media", () => {
    const result = {
      content: [{ type: "text", text: "<media:image> (2 images)" }],
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("does not match other media placeholder variants", () => {
    for (const tag of [
      "<media:video>",
      "<media:document>",
      "<media:sticker>",
      "<media:attachment>",
    ]) {
      const result = {
        content: [{ type: "text", text: `${tag} some context` }],
      };
      expect(extractToolResultMediaArtifact(result)).toBeUndefined();
    }
  });

  it("does not match media-looking documentation text", () => {
    const result = {
      content: [
        {
          type: "text",
          text: 'Use MEDIA: "https://example.com/voice.ogg", asVoice: true to send voice',
        },
      ],
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("does not treat malformed media-looking prose as a file path", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "MEDIA:-prefixed paths (lenient whitespace) when loading outbound media",
        },
      ],
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("trusts image_generate local media paths", () => {
    expect(isToolResultMediaTrusted("image_generate")).toBe(true);
  });

  it("trusts music_generate local media paths", () => {
    expect(isToolResultMediaTrusted("music_generate")).toBe(true);
  });

  it("trusts video_generate local media paths", () => {
    expect(isToolResultMediaTrusted("video_generate")).toBe(true);
  });

  it("does not trust bundled plugin tool names without run-local metadata", () => {
    expect(isToolResultMediaTrusted("plugin_media_tool")).toBe(false);
  });

  it("trusts bundled plugin tool names carried by run-local metadata", () => {
    expect(
      isToolResultMediaTrusted("plugin_media_tool", undefined, new Set(["plugin_media_tool"])),
    ).toBe(true);
  });

  it("blocks trusted-media aliases that are not exact registered built-ins", () => {
    expect(
      filterToolResultMediaUrls("bash", ["/etc/passwd"], undefined, new Set(["exec"])),
    ).toStrictEqual([]);
    expect(
      filterToolResultMediaUrls("Web_Search", ["/etc/passwd"], undefined, new Set(["web_search"])),
    ).toStrictEqual([]);
  });

  it("keeps local media for exact registered built-in tool names", () => {
    expect(
      filterToolResultMediaUrls(
        "web_search",
        ["/tmp/screenshot.png"],
        undefined,
        new Set(["web_search"]),
      ),
    ).toEqual(["/tmp/screenshot.png"]);
  });

  it("keeps trusted TTS local media when the raw built-in name is absent", () => {
    expect(
      filterToolResultMediaUrls(
        "tts",
        ["/tmp/reply.opus"],
        {
          details: {
            media: {
              mediaUrl: "/tmp/reply.opus",
              trustedLocalMedia: true,
            },
          },
        },
        new Set(["web_search"]),
      ),
    ).toEqual(["/tmp/reply.opus"]);
  });

  it("keeps local media for bundled plugin tool names trusted in this run", () => {
    expect(
      filterToolResultMediaUrls(
        "plugin_media_tool",
        ["/tmp/meeting.wav"],
        undefined,
        new Set(["plugin_media_tool"]),
      ),
    ).toEqual(["/tmp/meeting.wav"]);
  });

  it("strips local media for plugin-name collisions when the plugin is not registered", () => {
    expect(
      filterToolResultMediaUrls(
        "Music_Generate",
        ["/etc/passwd"],
        undefined,
        new Set(["music_generate"]),
      ),
    ).toStrictEqual([]);
  });

  it("does not let non-TTS trustedLocalMedia bypass the exact-name gate", () => {
    expect(
      filterToolResultMediaUrls(
        "Web_Search",
        ["/etc/passwd"],
        {
          details: {
            media: {
              mediaUrl: "/etc/passwd",
              trustedLocalMedia: true,
            },
          },
        },
        new Set(["web_search"]),
      ),
    ).toStrictEqual([]);
  });

  it("still allows remote media for colliding aliases", () => {
    expect(
      filterToolResultMediaUrls(
        "bash",
        ["/etc/passwd", "https://example.com/file.png"],
        undefined,
        new Set(["exec"]),
      ),
    ).toEqual(["https://example.com/file.png"]);
  });

  it("does not trust local MEDIA paths for MCP-provenance results", () => {
    expect(
      filterToolResultMediaUrls("browser", ["/tmp/screenshot.png"], {
        details: {
          mcpServer: "probe",
          mcpTool: "browser",
        },
      }),
    ).toStrictEqual([]);
  });

  it("does not trust external TTS results with trustedLocalMedia", () => {
    expect(
      filterToolResultMediaUrls("tts", ["/tmp/reply.opus"], {
        details: {
          mcpServer: "probe",
          mcpTool: "tts",
          media: {
            mediaUrl: "/tmp/reply.opus",
            trustedLocalMedia: true,
          },
        },
      }),
    ).toStrictEqual([]);
  });

  it("still allows remote MEDIA urls for MCP-provenance results", () => {
    expect(
      filterToolResultMediaUrls("browser", ["https://example.com/screenshot.png"], {
        details: {
          mcpServer: "probe",
          mcpTool: "browser",
        },
      }),
    ).toEqual(["https://example.com/screenshot.png"]);
  });
});
