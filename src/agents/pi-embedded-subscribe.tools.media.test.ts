import { describe, expect, it } from "vitest";
import {
  extractToolResultMediaArtifact,
  extractToolResultMediaPaths,
  filterToolResultMediaUrls,
  isToolResultMediaTrusted,
} from "./pi-embedded-subscribe.tools.js";

describe("extractToolResultMediaPaths", () => {
  it("returns empty array for null/undefined", () => {
    expect(extractToolResultMediaPaths(null)).toEqual([]);
    expect(extractToolResultMediaPaths(undefined)).toEqual([]);
  });

  it("returns empty array for non-object", () => {
    expect(extractToolResultMediaPaths("hello")).toEqual([]);
    expect(extractToolResultMediaPaths(42)).toEqual([]);
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

  it("returns empty array when content has no text or image blocks", () => {
    expect(extractToolResultMediaPaths({ content: [{ type: "other" }] })).toEqual([]);
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

  it("extracts audioAsVoice from text MEDIA directives", () => {
    expect(
      extractToolResultMediaArtifact({
        content: [
          { type: "text", text: "Generated audio\n[[audio_as_voice]]\nMEDIA:/tmp/reply.opus" },
        ],
      }),
    ).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    });
  });

  it("keeps audioAsVoice when the tag and MEDIA path are in separate text blocks", () => {
    expect(
      extractToolResultMediaArtifact({
        content: [
          { type: "text", text: "[[audio_as_voice]]" },
          { type: "text", text: "MEDIA:/tmp/reply.opus" },
        ],
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

  it("extracts MEDIA: path from text content block", () => {
    const result = {
      content: [
        { type: "text", text: "MEDIA:/tmp/screenshot.png" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      details: { path: "/tmp/screenshot.png" },
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/screenshot.png"]);
  });

  it("extracts MEDIA: path with extra text in the block", () => {
    const result = {
      content: [{ type: "text", text: "Here is the image\nMEDIA:/tmp/output.jpg\nDone" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/output.jpg"]);
  });

  it("extracts multiple MEDIA: paths from different text blocks", () => {
    const result = {
      content: [
        { type: "text", text: "MEDIA:/tmp/page1.png" },
        { type: "text", text: "MEDIA:/tmp/page2.png" },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/page1.png", "/tmp/page2.png"]);
  });

  it("falls back to details.path when image content exists but no MEDIA: text", () => {
    // Pi SDK read tool doesn't include MEDIA: but OpenClaw imageResult
    // sets details.path as fallback.
    const result = {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      details: { path: "/tmp/generated.png" },
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/generated.png"]);
  });

  it("returns empty array when image content exists but no MEDIA: and no details.path", () => {
    // Pi SDK read tool: has image content but no path anywhere in the result.
    const result = {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("does not fall back to details.path when MEDIA: paths are found", () => {
    const result = {
      content: [
        { type: "text", text: "MEDIA:/tmp/from-text.png" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      details: { path: "/tmp/from-details.png" },
    };
    // MEDIA: text takes priority; details.path is NOT also included.
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/from-text.png"]);
  });

  it("handles backtick-wrapped MEDIA: paths", () => {
    const result = {
      content: [{ type: "text", text: "MEDIA: `/tmp/screenshot.png`" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/screenshot.png"]);
  });

  it("ignores null/undefined items in content array", () => {
    const result = {
      content: [null, undefined, { type: "text", text: "MEDIA:/tmp/ok.png" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/ok.png"]);
  });

  it("returns empty array for text-only results without MEDIA:", () => {
    const result = {
      content: [{ type: "text", text: "Command executed successfully" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("ignores details.path when no image content exists", () => {
    // details.path without image content is not media.
    const result = {
      content: [{ type: "text", text: "File saved" }],
      details: { path: "/tmp/data.json" },
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("handles details.path with whitespace", () => {
    const result = {
      content: [{ type: "image", data: "base64", mimeType: "image/png" }],
      details: { path: "  /tmp/image.png  " },
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/image.png"]);
  });

  it("skips empty details.path", () => {
    const result = {
      content: [{ type: "image", data: "base64", mimeType: "image/png" }],
      details: { path: "   " },
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("does not match <media:audio> placeholder as a MEDIA: token", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "<media:audio> placeholder with successful preflight voice transcript",
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("does not match <media:image> placeholder as a MEDIA: token", () => {
    const result = {
      content: [{ type: "text", text: "<media:image> (2 images)" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
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
      expect(extractToolResultMediaPaths(result)).toEqual([]);
    }
  });

  it("does not match mid-line MEDIA: in documentation text", () => {
    const result = {
      content: [
        {
          type: "text",
          text: 'Use MEDIA: "https://example.com/voice.ogg", asVoice: true to send voice',
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("does not treat malformed MEDIA:-prefixed prose as a file path", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "MEDIA:-prefixed paths (lenient whitespace) when loading outbound media",
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("still extracts MEDIA: at line start after other text lines", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "Generated screenshot\nMEDIA:/tmp/screenshot.png\nDone",
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/screenshot.png"]);
  });

  it("extracts indented MEDIA: line", () => {
    const result = {
      content: [{ type: "text", text: "  MEDIA:/tmp/indented.png" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/indented.png"]);
  });

  it("extracts valid MEDIA: line while ignoring <media:audio> on another line", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "<media:audio> was transcribed\nMEDIA:/tmp/tts-output.opus\nDone",
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/tts-output.opus"]);
  });

  it("extracts multiple MEDIA: lines from a single text block", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "MEDIA:/tmp/page1.png\nSome text\nMEDIA:/tmp/page2.png",
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/page1.png", "/tmp/page2.png"]);
  });

  it("trusts image_generate local MEDIA paths", () => {
    expect(isToolResultMediaTrusted("image_generate")).toBe(true);
  });

  it("trusts music_generate local MEDIA paths", () => {
    expect(isToolResultMediaTrusted("music_generate")).toBe(true);
  });

  it("trusts video_generate local MEDIA paths", () => {
    expect(isToolResultMediaTrusted("video_generate")).toBe(true);
  });

  it("trusts bundled plugin tool local MEDIA paths", () => {
    expect(isToolResultMediaTrusted("music_generate")).toBe(true);
  });

  it("blocks trusted-media aliases that are not exact registered built-ins", () => {
    expect(
      filterToolResultMediaUrls("bash", ["/etc/passwd"], undefined, new Set(["exec"])),
    ).toEqual([]);
    expect(
      filterToolResultMediaUrls("Web_Search", ["/etc/passwd"], undefined, new Set(["web_search"])),
    ).toEqual([]);
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

  it("keeps local media for bundled plugin tool names registered in this run", () => {
    // music_generate is a bundled-plugin trusted tool; when the runner
    // registers it for this run, its raw name must be allowed through the
    // exact-name gate just like a core built-in.
    expect(
      filterToolResultMediaUrls(
        "music_generate",
        ["/tmp/song.mp3"],
        undefined,
        new Set(["music_generate"]),
      ),
    ).toEqual(["/tmp/song.mp3"]);
  });

  it("strips local media for plugin-name collisions when the plugin is not registered", () => {
    expect(
      filterToolResultMediaUrls(
        "Music_Generate",
        ["/etc/passwd"],
        undefined,
        new Set(["music_generate"]),
      ),
    ).toEqual([]);
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
    ).toEqual([]);
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
    ).toEqual([]);
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
    ).toEqual([]);
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
