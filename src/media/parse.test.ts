import { describe, expect, it } from "vitest";
import { splitMediaFromOutput, type SplitMediaFromOutputOptions } from "./parse.js";

describe("splitMediaFromOutput", () => {
  function expectParsedMediaOutputCase(
    input: string,
    expected: {
      mediaUrls?: string[];
      text?: string;
      audioAsVoice?: boolean;
    },
    options?: SplitMediaFromOutputOptions,
  ) {
    const result = splitMediaFromOutput(input, options);
    expect(result.text).toBe(expected.text ?? "");
    if ("audioAsVoice" in expected) {
      expect(result.audioAsVoice).toBe(expected.audioAsVoice);
    } else {
      expect(result.audioAsVoice).toBeUndefined();
    }
    if ("mediaUrls" in expected) {
      expect(result.mediaUrls).toEqual(expected.mediaUrls);
      expect(result.mediaUrl).toBe(expected.mediaUrls?.[0]);
    } else {
      expect(result.mediaUrls).toBeUndefined();
      expect(result.mediaUrl).toBeUndefined();
    }
  }

  function expectStableAudioAsVoiceDetectionCase(input: string) {
    for (const output of [splitMediaFromOutput(input), splitMediaFromOutput(input)]) {
      expect(output.audioAsVoice).toBe(true);
    }
  }

  function expectAcceptedMediaPathCase(expectedPath: string, input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: [expectedPath] });
  }

  function expectRejectedMediaPathCase(input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: undefined });
  }

  function expectRejectedRemoteMediaUrlCase(input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: undefined, text: input });
  }

  it.each([
    ["/Users/pete/My File.png", "MEDIA:/Users/pete/My File.png"],
    ["/Users/pete/My File.png", 'MEDIA:"/Users/pete/My File.png"'],
    ["./screenshots/image.png", "MEDIA:./screenshots/image.png"],
    ["media/inbound/image.png", "MEDIA:media/inbound/image.png"],
    ["./screenshot.png", "  MEDIA:./screenshot.png"],
    ["C:\\Users\\pete\\Pictures\\snap.png", "MEDIA:C:\\Users\\pete\\Pictures\\snap.png"],
    ["/tmp/tts-fAJy8C/voice-1770246885083.opus", "MEDIA:/tmp/tts-fAJy8C/voice-1770246885083.opus"],
    ["image.png", "MEDIA:image.png"],
  ] as const)("accepts supported media path variant: %s", (expectedPath, input) => {
    expectAcceptedMediaPathCase(expectedPath, input);
  });

  it.each([
    "MEDIA:../../../etc/passwd",
    "MEDIA:../../.env",
    "MEDIA:~/.ssh/id_rsa",
    "MEDIA:~/Pictures/My File.png",
    "MEDIA:./foo/../../../etc/shadow",
  ] as const)("rejects traversal and home-dir path: %s", (input) => {
    expectRejectedMediaPathCase(input);
  });

  it.each([
    "MEDIA:http://example.com/a.png",
    "MEDIA:https://intranet/a.png",
    "MEDIA:https://printer/a.png",
    "MEDIA:https://localhost/a.png",
    "MEDIA:https://localhost../a.png",
    "MEDIA:https://127.0.0.1/a.png",
    "MEDIA:https://127.0.0.1../a.png",
    "MEDIA:https://169.254.169.254/latest/meta-data",
    "MEDIA:https://[::1]/a.png",
    "MEDIA:https://metadata.google.internal/a.png",
    "MEDIA:https://metadata.google.internal../a.png",
    "MEDIA:https://example..com/a.png",
    "MEDIA:https://media.local/a.png",
  ] as const)("rejects unsafe remote media URL: %s", (input) => {
    expectRejectedRemoteMediaUrlCase(input);
  });

  it.each([
    {
      name: "detects audio_as_voice tag and strips it",
      input: "Hello [[audio_as_voice]] world",
      expected: { audioAsVoice: true, text: "Hello world" },
    },
    {
      name: "keeps MEDIA mentions in prose",
      input: "The MEDIA: tag fails to deliver",
      expected: { mediaUrls: undefined, text: "The MEDIA: tag fails to deliver" },
    },
    {
      name: "rejects bare words without file extensions",
      input: "MEDIA:screenshot",
      expected: { mediaUrls: undefined, text: "MEDIA:screenshot" },
    },
    {
      name: "keeps audio_as_voice detection stable across calls",
      input: "Hello [[audio_as_voice]]",
      expected: { audioAsVoice: true, text: "Hello" },
      assertStable: true,
    },
  ] as const)("$name", ({ input, expected, assertStable }) => {
    expectParsedMediaOutputCase(input, expected);
    if (assertStable) {
      expectStableAudioAsVoiceDetectionCase(input);
    }
  });

  it("returns ordered text and media segments while ignoring fenced MEDIA lines", () => {
    const result = splitMediaFromOutput(
      "Before\nMEDIA:https://example.com/a.png\n```text\nMEDIA:https://example.com/ignored.png\n```\nAfter",
    );

    expect(result.segments).toEqual([
      { type: "text", text: "Before" },
      { type: "media", url: "https://example.com/a.png" },
      { type: "text", text: "```text\nMEDIA:https://example.com/ignored.png\n```\nAfter" },
    ]);
  });

  const extractMarkdownImages = { extractMarkdownImages: true } as const;

  it("keeps markdown image urls as text by default", () => {
    const input = "Caption\n\n![chart](https://example.com/chart.png)";
    expectParsedMediaOutputCase(input, {
      text: input,
      mediaUrls: undefined,
    });
  });

  it("extracts markdown image urls while keeping surrounding caption text when enabled", () => {
    expectParsedMediaOutputCase(
      "Caption\n\n![chart](https://example.com/chart.png)",
      {
        text: "Caption",
        mediaUrls: ["https://example.com/chart.png"],
      },
      extractMarkdownImages,
    );
  });

  it("keeps inline caption text around markdown images when enabled", () => {
    expectParsedMediaOutputCase(
      "Look ![chart](https://example.com/chart.png) now",
      {
        text: "Look now",
        mediaUrls: ["https://example.com/chart.png"],
      },
      extractMarkdownImages,
    );
  });

  it("extracts multiple markdown image urls in order", () => {
    expectParsedMediaOutputCase(
      "Before\n![one](https://example.com/one.png)\nMiddle\n![two](https://example.com/two.png)\nAfter",
      {
        text: "Before\nMiddle\nAfter",
        mediaUrls: ["https://example.com/one.png", "https://example.com/two.png"],
      },
      extractMarkdownImages,
    );
  });

  it("strips markdown image title suffixes from extracted urls", () => {
    expectParsedMediaOutputCase(
      'Caption ![chart](https://example.com/chart.png "Quarterly chart")',
      {
        text: "Caption",
        mediaUrls: ["https://example.com/chart.png"],
      },
      extractMarkdownImages,
    );
  });

  it("keeps balanced parentheses inside markdown image urls", () => {
    expectParsedMediaOutputCase(
      "Chart ![img](https://example.com/a_(1).png) now",
      {
        text: "Chart now",
        mediaUrls: ["https://example.com/a_(1).png"],
      },
      extractMarkdownImages,
    );
  });

  it.each([
    "![x](file:///etc/passwd)",
    "![x](/var/run/secrets/kubernetes.io/serviceaccount/token)",
    "![x](C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts)",
    "![x](http://example.com/a.png)",
    "![x](https://127.0.0.1/a.png)",
  ] as const)("does not lift local markdown image target: %s", (input) => {
    expectParsedMediaOutputCase(
      input,
      {
        text: input,
        mediaUrls: undefined,
      },
      extractMarkdownImages,
    );
  });

  it("does not lift markdown image urls that fail media validation", () => {
    const longUrl = `![x](https://example.com/${"a".repeat(4097)}.png)`;

    expectParsedMediaOutputCase(
      longUrl,
      {
        text: longUrl,
        mediaUrls: undefined,
      },
      extractMarkdownImages,
    );
  });

  it("leaves very long markdown-image candidate lines as text", () => {
    const input = `${"prefix ".repeat(3000)}![x](https://example.com/image.png)`;

    expectParsedMediaOutputCase(
      input,
      {
        text: input,
        mediaUrls: undefined,
      },
      extractMarkdownImages,
    );
  });

  it.each([
    "![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)",
    "![build](https://img.shields.io/github/actions/workflow/status/owner/repo/ci.yml)",
    "![npm](https://badge.fury.io/js/some-package.svg)",
    "![badgen](https://badgen.net/npm/v/some-package)",
    "![CI](https://github.com/owner/repo/actions/workflows/ci.yml/badge.svg)",
    "![flat-badge](https://flat.badgen.net/npm/v/some-package)",
  ] as const)("keeps markdown badge image as text by default: %s", (input) => {
    expectParsedMediaOutputCase(input, {
      text: input,
      mediaUrls: undefined,
    });
  });

  it("keeps surrounding text around inline badge images by default", () => {
    expectParsedMediaOutputCase(
      "tech: ![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white) stack",
      {
        text: "tech: ![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white) stack",
        mediaUrls: undefined,
      },
    );
  });

  it("still extracts markdown images when explicitly enabled", () => {
    expectParsedMediaOutputCase(
      "![badge](https://img.shields.io/badge/status-passing-green)\n![photo](https://example.com/photo.png)",
      {
        mediaUrls: [
          "https://img.shields.io/badge/status-passing-green",
          "https://example.com/photo.png",
        ],
      },
      extractMarkdownImages,
    );
  });
});
