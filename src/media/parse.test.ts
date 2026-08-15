// Media parse tests cover media reference parsing from text and payloads.
import { describe, expect, it } from "vitest";
import { splitMediaFromOutput } from "./parse.js";

type SplitMediaFromOutputOptions = NonNullable<Parameters<typeof splitMediaFromOutput>[1]>;

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
    } else {
      expect(result.mediaUrls).toBeUndefined();
    }
  }

  function expectStableAudioAsVoiceDetectionCase(input: string) {
    for (const output of [splitMediaFromOutput(input), splitMediaFromOutput(input)]) {
      expect(output.audioAsVoice).toBe(true);
    }
  }

  function expectAcceptedMediaPathCase(expectedPath: string, input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: [expectedPath] });
    expect(splitMediaFromOutput(input).segments).toEqual([{ type: "media", url: expectedPath }]);
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
    [
      "/Users/pete/My Files/Project Assets/render final.png",
      "MEDIA:/Users/pete/My Files/Project Assets/render final.png",
    ],
    [
      "/Users/pete/My Files/Project Assets/render final.png",
      'MEDIA:"/Users/pete/My Files/Project Assets/render final.png"',
    ],
    ["/tmp/album.v1/photo.png copy.png", "MEDIA:/tmp/album.v1/photo.png copy.png"],
    ["./screenshots/image.png", "MEDIA:./screenshots/image.png"],
    ["media/inbound/image.png", "MEDIA:media/inbound/image.png"],
    ["./screenshot.png", "  MEDIA:./screenshot.png"],
    ["~/Pictures/My File.png", "MEDIA:~/Pictures/My File.png"],
    ["~/.openclaw/media/browser/snap.png", "MEDIA:~/.openclaw/media/browser/snap.png"],
    ["C:\\Users\\pete\\Pictures\\snap.png", "MEDIA:C:\\Users\\pete\\Pictures\\snap.png"],
    [
      "C:\\Users\\First Last\\workspace\\shot.png",
      "MEDIA:C:\\Users\\First Last\\workspace\\shot.png",
    ],
    [
      "C:\\Users\\First  Last\\workspace\\shot.png",
      "MEDIA:C:\\Users\\First  Last\\workspace\\shot.png",
    ],
    [
      "\\\\server\\My Files\\Project Assets\\render final.png",
      "MEDIA:\\\\server\\My Files\\Project Assets\\render final.png",
    ],
    ["/tmp/tts-fAJy8C/voice-1770246885083.opus", "MEDIA:/tmp/tts-fAJy8C/voice-1770246885083.opus"],
    ["image.png", "MEDIA:image.png"],
    [
      "/path/to/image.png",
      'MEDIA:/path/to/image.png"}],"details":{"provider":"openai","model":"gpt-image-2"}',
    ],
    [
      "/path/to/image.png",
      String.raw`MEDIA:/path/to/image.png\"}],\"details\":{\"provider\":\"openai\"}`,
    ],
    ["/tmp/render,final.png", "MEDIA:/tmp/render,final.png"],
    ["/tmp/generated.png", "MEDIA:FILE:///tmp/generated.png"],
    ["/tmp/generated.png", "MEDIA:FILE:/tmp/generated.png"],
    ["/tmp/generated.png", "MEDIA:file:///tmp/generated.png"],
    ["/Users/pete/My File.png", "MEDIA:FILE:///Users/pete/My File.png"],
    ["/Users/pete/My File.png", "MEDIA:file:///Users/pete/My File.png"],
  ] as const)("accepts supported media path variant: %s", (expectedPath, input) => {
    expectAcceptedMediaPathCase(expectedPath, input);
  });

  it.each([
    ["bare image", "Generated image\nMEDIA:image.png", ["image.png"]],
    ["bare audio", "Generated audio\nMEDIA:voice.ogg", ["voice.ogg"]],
    ["bare document", "Generated document\nMEDIA:report.pdf", ["report.pdf"]],
    ["caption after bare filename", "MEDIA:image.png\nGenerated image", ["image.png"]],
    ["quoted bare filename", 'Generated image\nMEDIA:"image.png"', ["image.png"]],
    [
      "quoted bare filename with spaces",
      'Generated image\nMEDIA:"render final.png"',
      ["render final.png"],
    ],
    ["unquoted bare filename with spaces", "MEDIA:render final.png", ["render final.png"]],
    [
      "remote followed by bare filename",
      "MEDIA:https://example.com/remote.png\nMEDIA:image.png",
      ["https://example.com/remote.png", "image.png"],
    ],
    [
      "bare filenames surrounding remote media",
      "MEDIA:image.png\nMEDIA:https://example.com/remote.png\nMEDIA:voice.ogg",
      ["image.png", "https://example.com/remote.png", "voice.ogg"],
    ],
    ["explicit relative sibling", "MEDIA:./image.png", ["./image.png"]],
    ["absolute sibling", "MEDIA:/tmp/image.png", ["/tmp/image.png"]],
    [
      "multiple paths on one directive",
      "MEDIA:/tmp/image.png /tmp/voice.ogg",
      ["/tmp/image.png", "/tmp/voice.ogg"],
    ],
  ] as const)(
    "projects every accepted media URL into ordered segments: %s",
    (_name, input, urls) => {
      const result = splitMediaFromOutput(input);

      expect(result.mediaUrls).toEqual(urls);
      expect(result.segments?.filter((segment) => segment.type === "media")).toEqual(
        urls.map((url) => ({ type: "media", url })),
      );
    },
  );

  it.each([
    ["MEDIA:/tmp/a.png /tmp/b.png", ["/tmp/a.png", "/tmp/b.png"]],
    ["MEDIA:media/a.png media/b.png", ["media/a.png", "media/b.png"]],
    ["MEDIA:/tmp/a.png media/b.png", ["/tmp/a.png", "media/b.png"]],
    ["MEDIA:./a.png ./b.png", ["./a.png", "./b.png"]],
    ["MEDIA:/tmp/a.png https://example.com/b.png", ["/tmp/a.png", "https://example.com/b.png"]],
    [
      "MEDIA:C:\\Users\\First Last\\workspace\\shot.png D:\\Other User\\second.png",
      ["C:\\Users\\First Last\\workspace\\shot.png", "D:\\Other User\\second.png"],
    ],
    [
      "MEDIA:C:\\Users\\First Last\\workspace\\shot.png media/second.png",
      ["C:\\Users\\First Last\\workspace\\shot.png", "media/second.png"],
    ],
    [
      "MEDIA:/tmp/project screenshots/shot.png media\\second.png",
      ["/tmp/project screenshots/shot.png", "media\\second.png"],
    ],
    [
      "MEDIA:/tmp/project screenshots/shot.png file:///tmp/second.png",
      ["/tmp/project screenshots/shot.png", "/tmp/second.png"],
    ],
    ["MEDIA:C:\\Users\\First Last\\..\\secret.png D:\\safe\\second.png", ["D:\\safe\\second.png"]],
    ["MEDIA:/tmp/project screenshots/../../.env /tmp/safe/second.png", ["/tmp/safe/second.png"]],
  ] as const)("keeps separate media items on one directive line: %s", (input, mediaUrls) => {
    expectParsedMediaOutputCase(input, { mediaUrls: [...mediaUrls] });
  });

  it.each([
    "MEDIA:../../../etc/passwd",
    "MEDIA:../../.env",
    "MEDIA:~user/Pictures/My File.png",
    "MEDIA:~/Pictures/../../.ssh/id_rsa",
    "MEDIA:./foo/../../../etc/shadow",
    "MEDIA:C:\\Users\\First Last\\..\\secret.png",
    "MEDIA:/tmp/project screenshots/../../.env",
  ] as const)("rejects traversal and unsupported home-dir path: %s", (input) => {
    expectRejectedMediaPathCase(input);
  });

  it("does not absorb an unsafe remote URL into a spaced local media path", () => {
    expectParsedMediaOutputCase(
      "MEDIA:C:\\Users\\First Last\\workspace\\shot.png https://127.0.0.1/secret.png",
      {
        mediaUrls: ["C:\\Users\\First Last\\workspace\\shot.png"],
        text: "https://127.0.0.1/secret.png",
      },
    );
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

  it("preserves paragraph breaks in ordered media text segments", () => {
    const result = splitMediaFromOutput(
      "First paragraph\n\nSecond paragraph\nMEDIA:https://example.com/a.png",
    );

    expect(result.segments).toEqual([
      { type: "text", text: "First paragraph\n\nSecond paragraph" },
      { type: "media", url: "https://example.com/a.png" },
    ]);
  });

  it.each([
    ["before", "First paragraph\n\nMEDIA:https://example.com/a.png\nSecond paragraph"],
    ["after", "First paragraph\nMEDIA:https://example.com/a.png\n\nSecond paragraph"],
    ["around", "First paragraph\n\nMEDIA:https://example.com/a.png\n\nSecond paragraph"],
    ["with spaces", "First paragraph\n \nMEDIA:https://example.com/a.png\n  \nSecond paragraph"],
    ["with tabs", "First paragraph\n\t\nMEDIA:https://example.com/a.png\n\t\nSecond paragraph"],
  ])("preserves a paragraph separator %s an attachment", (_placement, input) => {
    const result = splitMediaFromOutput(input);

    expect(result.segments).toEqual([
      { type: "text", text: "First paragraph\n" },
      { type: "media", url: "https://example.com/a.png" },
      { type: "text", text: "Second paragraph" },
    ]);
  });

  it.each(["    ", "\t"])("does not emit a whitespace-only media caption: %j", (whitespace) => {
    const result = splitMediaFromOutput(`${whitespace}\nMEDIA:https://example.com/a.png`);

    expect(result.text).toBe("");
    expect(result.segments).toEqual([{ type: "media", url: "https://example.com/a.png" }]);
  });

  it("drops separator-only lines before the caption after extracting leading media", () => {
    expectParsedMediaOutputCase("MEDIA:https://example.com/a.png\n\nCaption", {
      text: "Caption",
      mediaUrls: ["https://example.com/a.png"],
    });
  });

  it.each([
    {
      name: "a marker carrying trailing text",
      lines: ["```python", "value = 'a  b'", "``` not a close", "other = 'c  d'", "```"],
    },
    {
      name: "an unclosed fence",
      lines: ["```python", "value = 'a  b'", "other = 'c  d'"],
    },
    {
      name: "an indented closing fence",
      lines: ["```python", "value = 'a  b'", "   ```"],
    },
  ])("preserves canonical code fences with $name", ({ lines }) => {
    const code = lines.join("\n");

    expectParsedMediaOutputCase(`MEDIA:https://example.com/a.png\n${code}`, {
      text: code,
      mediaUrls: ["https://example.com/a.png"],
    });
    expectParsedMediaOutputCase(`[[audio_as_voice]]\nMEDIA:https://example.com/a.png\n${code}`, {
      text: code,
      mediaUrls: ["https://example.com/a.png"],
      audioAsVoice: true,
    });
  });

  const extractMarkdownImages = { extractMarkdownImages: true } as const;
  const formattedMediaReply = [
    "Here is the code.",
    "",
    "```python",
    "def summarize(rows):",
    "    totals = {}",
    "    for row in rows:",
    "        totals[row] = 1",
    "    return totals",
    "```",
    "",
    "The attachment is ready.",
  ].join("\n");

  it.each([
    {
      name: "a MEDIA directive",
      input: `${formattedMediaReply}\n\nMEDIA:https://example.com/config.png`,
      mediaUrl: "https://example.com/config.png",
      options: undefined,
      audioAsVoice: undefined,
    },
    {
      name: "an extracted Markdown image",
      input: `${formattedMediaReply}\n\n![chart](https://example.com/chart.png)`,
      mediaUrl: "https://example.com/chart.png",
      options: extractMarkdownImages,
      audioAsVoice: undefined,
    },
    {
      name: "an audio directive and media",
      input: `[[audio_as_voice]]\n${formattedMediaReply}\n\nMEDIA:https://example.com/recording.ogg`,
      mediaUrl: "https://example.com/recording.ogg",
      options: undefined,
      audioAsVoice: true,
    },
  ])("preserves code indentation and paragraph breaks with $name", (testCase) => {
    expectParsedMediaOutputCase(
      testCase.input,
      {
        text: formattedMediaReply,
        mediaUrls: [testCase.mediaUrl],
        ...(testCase.audioAsVoice ? { audioAsVoice: true } : {}),
      },
      testCase.options,
    );
  });

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
