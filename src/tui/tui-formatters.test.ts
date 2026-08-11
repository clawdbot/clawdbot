// Covers formatting helpers used by TUI status and message rendering.
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { markInboundContextLabel } from "../auto-reply/reply/inbound-context-marker.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../shared/assistant-error-format.js";
import {
  extractContentFromMessage,
  extractTextFromMessage,
  extractThinkingFromMessage,
  formatTuiFooter,
  formatTuiErrorMessage,
  isolateRtlRenderedLine,
  isTerminalSafeAutocompleteValue,
  isCommandMarkedMessage,
  sanitizeMarkdownSource,
  sanitizeRenderableLine,
  sanitizeRenderableText,
} from "./tui-formatters.js";

describe("formatTuiFooter", () => {
  it("shows session modes and the process delivery mode in one compact summary", () => {
    expect(
      formatTuiFooter({
        agentLabel: "Main",
        sessionLabel: "work",
        sessionInfo: {
          model: "gpt-5.6-sol@openai:setup-64cddea3-938c-431e-be3b-aa47090577c7",
          fastMode: "auto",
          verboseLevel: "full",
          traceLevel: "raw",
          reasoningLevel: "stream",
          totalTokens: 1_200,
          contextTokens: 128_000,
        },
        thinkingLevel: "high",
        deliver: true,
      }),
    ).toBe(
      "agent Main | session work | gpt-5.6-sol high | fast:auto | verbose full | trace:raw | reasoning:stream | deliver:on | tokens 1.2k/128k (1%)",
    );
  });

  it("keeps disabled session modes hidden while reporting disabled delivery", () => {
    expect(
      formatTuiFooter({
        agentLabel: "Main",
        sessionLabel: "main",
        sessionInfo: { model: "fixture-model" },
        deliver: false,
      }),
    ).toBe("agent Main | session main | fixture-model | deliver:off | tokens ?");
  });

  it("wraps the compact summary within the terminal width", () => {
    const summary = formatTuiFooter({
      agentLabel: "Main",
      sessionLabel: "a-long-session-name",
      sessionInfo: {
        model: "fixture-provider/a-long-model-name",
        traceLevel: "raw",
        reasoningLevel: "stream",
      },
      deliver: true,
    });

    expect(new Text(summary, 1, 0).render(48).every((line) => visibleWidth(line) <= 48)).toBe(true);
  });

  it("sanitizes terminal controls and collapses footer fields to one line", () => {
    const attacks = [
      "\u001b[38;5;201m",
      "\u001b[3J",
      "\u001b]0;footer-title\u0007",
      "\u001b]52;c;footer-clipboard\u0007",
      "\u009b2K",
      "\u009d0;footer-c1-title\u009c",
    ];
    const footer = formatTuiFooter({
      agentLabel: `agent-start${attacks[0]}agent-end\nمرحبا`,
      sessionLabel: `session-start${attacks[2]}session-end\r\nשלום`,
      sessionInfo: {
        model: `provider/model-start${attacks[1]}middle${attacks[3]}${attacks[4]}${attacks[5]}model-end\tUnicode`,
      },
      deliver: true,
    });

    expect(footer).toContain("agent-startagent-end");
    expect(footer).toContain("مرحبا");
    expect(footer).toContain("session-startsession-end");
    expect(footer).toContain("שלום");
    expect(footer).toContain("model-startmiddlemodel-end Unicode");
    expect(footer).toContain("\u2067");
    expect(footer).toContain("\u2069");
    expect(footer).not.toMatch(/[\r\n\t]/u);
    for (const attack of attacks) {
      expect(footer).not.toContain(attack);
    }
  });

  it("renders active goal usage", () => {
    const footer = formatTuiFooter({
      agentLabel: "Main",
      sessionLabel: "main",
      sessionInfo: {
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "land PR",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 0,
          tokensUsed: 12_000,
          tokenBudget: 30_000,
          continuationTurns: 0,
        },
      },
      deliver: false,
    });

    expect(footer).toContain("Pursuing goal (12k/30k)");
  });

  it("renders resumable blocked goals", () => {
    const footer = formatTuiFooter({
      agentLabel: "Main",
      sessionLabel: "main",
      sessionInfo: {
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "land PR",
          status: "blocked",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 0,
          tokensUsed: 0,
          continuationTurns: 0,
        },
      },
      deliver: false,
    });

    expect(footer).toContain("Goal blocked (/goal resume)");
  });
});

describe("extractTextFromMessage", () => {
  it.each([
    {
      name: "a browser image block",
      content: [
        {
          type: "image",
          url: "/persisted-image.png",
          source: { type: "url", url: "/persisted-image.png" },
        },
      ],
      expected: "Attached image",
    },
    {
      name: "a persisted image block",
      content: [{ type: "image", source: { type: "url", url: "/persisted-image.png" } }],
      expected: "Attached image",
    },
    {
      name: "a browser document block",
      content: [
        {
          type: "attachment",
          attachment: {
            url: "/report.pdf",
            kind: "document",
            label: "report.pdf",
            mimeType: "application/pdf",
          },
        },
      ],
      expected: "Attached file: report.pdf",
    },
    {
      name: "a browser audio block",
      content: [
        {
          type: "attachment",
          attachment: {
            url: "/voice.ogg",
            kind: "audio",
            label: "voice.ogg",
            mimeType: "audio/ogg",
          },
        },
      ],
      expected: "Attached file: voice.ogg",
    },
    {
      name: "a browser file with the default label",
      content: [
        {
          type: "attachment",
          attachment: { url: "/document", kind: "document", label: "Attached file" },
        },
      ],
      expected: "Attached file",
    },
    {
      name: "multiple ordered browser attachments",
      content: [
        { type: "image", source: { type: "url", url: "/image.png" } },
        {
          type: "attachment",
          attachment: { url: "/report.pdf", kind: "document", label: "report.pdf" },
        },
      ],
      expected: "Attached image\nAttached file: report.pdf",
    },
  ])("renders an attachment-only user turn containing $name", ({ content, expected }) => {
    expect(extractTextFromMessage({ role: "user", content })).toBe(expected);
  });

  it.each([
    {
      name: "image",
      media: [{ path: "/media/inbound/generated-image.png", contentType: "image/png" }],
      expected: "Attached image",
    },
    {
      name: "image inferred from its canonical path",
      media: [{ path: "/media/inbound/media-only.png" }],
      expected: "Attached image",
    },
    {
      name: "file",
      media: [{ path: "/media/inbound/generated-report.pdf", contentType: "application/pdf" }],
      expected: "Attached file",
    },
    {
      name: "ordered image and file",
      media: [
        { path: "/media/inbound/generated-image.png", contentType: "image/png" },
        { path: "/media/inbound/generated-report.pdf", contentType: "application/pdf" },
      ],
      expected: "Attached image\nAttached file",
    },
  ])("renders an empty durable user turn with canonical $name media", ({ media, expected }) => {
    expect(
      extractTextFromMessage({
        role: "user",
        content: "",
        __openclaw: { media },
      }),
    ).toBe(expected);
  });

  it("keeps an ordinary user prompt unchanged when it also has attachments", () => {
    expect(
      extractTextFromMessage({
        role: "user",
        content: [
          { type: "text", text: "Describe this image" },
          { type: "image", source: { type: "url", url: "/image.png" } },
        ],
      }),
    ).toBe("Describe this image");
  });

  it("sanitizes the display name of an attachment-only user turn", () => {
    expect(
      extractTextFromMessage({
        role: "user",
        content: [
          {
            type: "attachment",
            attachment: {
              url: "/report.pdf",
              kind: "document",
              label: "\u001b[31mreport.pdf\u001b[0m\u0000",
            },
          },
        ],
      }),
    ).toBe("Attached file: report.pdf");
  });

  it.each([
    { name: "image", block: { type: "image", data: "secret-image" }, expected: "Attached image" },
    {
      name: "audio",
      block: { type: "audio", source: { type: "base64", data: "secret-audio" } },
      expected: "Attached audio",
    },
    {
      name: "video",
      block: { type: "video", url: "file:///Users/operator/private/clip.mp4" },
      expected: "Attached video",
    },
    {
      name: "file",
      block: { type: "file", url: "file:///etc/passwd", title: "private.txt" },
      expected: "Attached file",
    },
    {
      name: "nested audio attachment",
      block: {
        type: "attachment",
        attachment: {
          kind: "audio",
          label: "private.ogg",
          url: "file:///Users/operator/private/audio.ogg",
        },
      },
      expected: "Attached audio",
    },
    {
      name: "provider image URL block",
      block: { type: "image_url", image_url: { url: "https://secret.test/image?ticket=secret" } },
      expected: "Attached image",
    },
  ])("renders a terminal-safe assistant $name summary", ({ block, expected }) => {
    const text = extractTextFromMessage({ role: "assistant", content: [block] });
    expect(text).toBe(expected);
    expect(text).not.toMatch(/secret|file:|operator|passwd|private/i);
  });

  it("renders canonical and legacy assistant media without exposing references", () => {
    expect(
      extractTextFromMessage({
        role: "assistant",
        content: [],
        __openclaw: {
          media: [
            { kind: "image", path: "/private/generated.png" },
            { kind: "audio", url: "https://secret.test/voice.ogg?ticket=secret" },
            { kind: "video", fileName: "private.mov" },
            { kind: "document", path: "/etc/passwd" },
          ],
        },
      }),
    ).toBe("Attached image\nAttached audio\nAttached video\nAttached file");
    expect(
      extractTextFromMessage({
        role: "assistant",
        content: [],
        mediaUrl: "file:///private/one.png",
        mediaUrls: ["https://secret.test/two.mp3?ticket=secret"],
      }),
    ).toBe("Attached media\nAttached media");
  });

  it("prefers final_answer text over commentary text for assistant messages", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Commentary that should not render",
          textSignature: JSON.stringify({ v: 1, id: "c1", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Final answer for the TUI",
          textSignature: JSON.stringify({ v: 1, id: "f1", phase: "final_answer" }),
        },
      ],
    });

    expect(text).toBe("Final answer for the TUI");
  });

  it("renders errorMessage when assistant content is empty", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage:
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\\u0027s rate limit. Please try again later."},"request_id":"req_123"}',
    });

    expect(text).toContain("HTTP 429");
    expect(text).toContain("rate_limit_error");
    expect(text).toContain("This request would exceed your account's rate limit.");
  });

  it("renders malformed streaming fragment errors with friendly text", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
    });

    expect(text).toBe("LLM streaming response contained a malformed fragment. Please try again.");
  });

  it("falls back to a generic message when errorMessage is missing", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "",
    });

    expect(text).toContain("unknown error");
  });

  it("joins multiple text blocks with single newlines", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });

    expect(text).toBe("first\nsecond");
  });

  it("preserves internal newlines for string content", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: "Line 1\nLine 2\nLine 3",
    });

    expect(text).toBe("Line 1\nLine 2\nLine 3");
  });

  it("preserves internal newlines for text blocks", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: [{ type: "text", text: "Line 1\nLine 2\nLine 3" }],
    });

    expect(text).toBe("Line 1\nLine 2\nLine 3");
  });

  it("places thinking before content when included", () => {
    const text = extractTextFromMessage(
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "ponder" },
        ],
      },
      { includeThinking: true },
    );

    expect(text).toBe("[thinking]\nponder\n\nhello");
  });

  it("sanitizes ANSI and control chars from string content", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: "Hello\x1b[31m red\x1b[0m\x00world",
    });

    expect(text).toBe("Hello redworld");
  });

  it("redacts heavily corrupted binary-like lines", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: [{ type: "text", text: "������������������������" }],
    });

    expect(text).toBe("[binary data omitted]");
  });

  it("strips leading inbound metadata blocks for user messages", () => {
    const text = extractTextFromMessage({
      role: "user",
      content: [
        markInboundContextLabel("Conversation info:"),
        "```json",
        "{",
        '  "message_id": "abc123"',
        "}",
        "```",
        "",
        markInboundContextLabel("Sender:"),
        "```json",
        "{",
        '  "label": "Someone"',
        "}",
        "```",
        "",
        "Actual user message",
      ].join("\n"),
    });

    expect(text).toBe("Actual user message");
  });

  it("strips leading inbound metadata blocks for command messages (#59871)", () => {
    const text = extractTextFromMessage({
      command: true,
      content: [
        markInboundContextLabel("Conversation info:"),
        "```json",
        "{",
        '  "message_id": "abc123"',
        "}",
        "```",
        "",
        markInboundContextLabel("Sender:"),
        "```json",
        "{",
        '  "label": "Someone"',
        "}",
        "```",
        "",
        "Exec completed: task finished successfully",
      ].join("\n"),
    });

    expect(text).toBe("Exec completed: task finished successfully");
  });

  it("keeps metadata-like blocks for non-user messages", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: [
        markInboundContextLabel("Conversation info:"),
        "```json",
        '{"message_id":"abc123"}',
        "```",
        "",
        "Assistant body",
      ].join("\n"),
    });

    expect(text).toContain(markInboundContextLabel("Conversation info:"));
    expect(text).toContain("Assistant body");
  });

  it("does not strip metadata-like blocks that are not a leading prefix", () => {
    const text = extractTextFromMessage({
      role: "user",
      content: 'Hello world\nConversation info:\n```json\n{"message_id":"123"}\n```\n\nFollow-up',
    });

    expect(text).toBe(
      'Hello world\nConversation info:\n```json\n{"message_id":"123"}\n```\n\nFollow-up',
    );
  });

  it("strips trailing untrusted context metadata suffix blocks for user messages", () => {
    const text = extractTextFromMessage({
      role: "user",
      content: `Hello world

${markInboundContextLabel("Context:")}
<<<EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>
Source: Channel metadata
---
Channel metadata (guildchat)
Sender labels:
example
<<<END_EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>`,
    });

    expect(text).toBe("Hello world");
  });

  it("strips leading active-memory prompt prefix blocks for user messages", () => {
    const text = extractTextFromMessage({
      role: "user",
      content: `Context:
<active_memory_plugin>
User prefers aisle seats and extra buffer on connections.
</active_memory_plugin>

What should I grab on the way?`,
    });

    expect(text).toBe("What should I grab on the way?");
  });

  it("strips active-memory prompt prefix blocks for user messages even when earlier text precedes them", () => {
    const text = extractTextFromMessage({
      role: "user",
      content: `Queued earlier user turn

Context:
<active_memory_plugin>
User prefers aisle seats and extra buffer on connections.
</active_memory_plugin>

What should I grab on the way?`,
    });

    expect(text).toBe("Queued earlier user turn\n\nWhat should I grab on the way?");
  });
});

describe("extractThinkingFromMessage", () => {
  it("collects only thinking blocks", () => {
    const text = extractThinkingFromMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "alpha" },
        { type: "text", text: "hello" },
        { type: "thinking", thinking: "beta" },
      ],
    });

    expect(text).toBe("alpha\nbeta");
  });
});

describe("extractContentFromMessage", () => {
  it("collects only text blocks", () => {
    const text = extractContentFromMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "alpha" },
        { type: "text", text: "hello" },
      ],
    });

    expect(text).toBe("hello");
  });

  it("renders error text when stopReason is error and content is not an array", () => {
    const text = extractContentFromMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: '429 {"error":{"message":"rate limit"}}',
    });

    expect(text).toContain("HTTP 429");
  });

  it("formats malformed streaming fragment errors when content is not an array", () => {
    const text = extractContentFromMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
    });

    expect(text).toBe("LLM streaming response contained a malformed fragment. Please try again.");
  });
});

describe("isCommandMarkedMessage", () => {
  it("detects command-marked messages", () => {
    expect(isCommandMarkedMessage({ command: true })).toBe(true);
    expect(isCommandMarkedMessage({ command: false })).toBe(false);
    expect(isCommandMarkedMessage({})).toBe(false);
  });
});

describe("formatTuiErrorMessage", () => {
  it("redacts and sanitizes terminal escapes in nested error causes", () => {
    const secret = "sk-abcdefghijklmnopqrstuv";
    const cause = new Error(`\u001b[31mAuthorization: Bearer ${secret}\u001b[0m`);

    const formatted = formatTuiErrorMessage(new Error("gateway down", { cause }));

    expect(formatted).toContain("gateway down");
    expect(formatted).toContain("Authorization: Bearer");
    expect(formatted).not.toContain(secret);
    expect(formatted).not.toContain("\u001b");
  });
});

describe("sanitizeRenderableText", () => {
  function expectTokenWidthUnderLimit(input: string) {
    const sanitized = sanitizeRenderableText(input);
    const longestSegment = Math.max(...sanitized.split(/\s+/).map((segment) => segment.length));
    expect(longestSegment).toBeLessThanOrEqual(32);
  }

  it("strips C1 CSI and OSC without exposing their final byte or payload", () => {
    const input = "before\u009b@middle\u009d0;title\u009cafter";

    expect(sanitizeRenderableText(input)).toBe("beforemiddleafter");
  });

  it.each([
    { label: "very long", input: "a".repeat(140) },
    { label: "moderately long", input: "b".repeat(90) },
  ])("breaks $label unbroken tokens to protect narrow terminals", ({ input }) => {
    expectTokenWidthUnderLimit(input);
  });

  it("keeps surrogate pairs intact when breaking long prose tokens", () => {
    const input = `${"a".repeat(31)}😀b`;

    expect(sanitizeRenderableText(input)).toBe(`${"a".repeat(31)} 😀b`);
  });

  it("preserves long CJK prose without inserting display spaces", () => {
    const input =
      "特蕾莎修女是一个极端投入极有宗教信念愿意亲身服务底层苦难者的人但她不是现代公共卫生意义上的慈善改革者";
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
    expect(sanitized).not.toContain("苦难 者");
  });

  it("preserves mixed long CJK prose without inserting display spaces", () => {
    const input =
      "MotherTeresa更像是宗教慈悲的象征而不是现代慈善治理的典范她值得尊重的地方是真实走进极端苦难";
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("preserves long filesystem paths verbatim for copy safety", () => {
    const input =
      "/Users/jasonshawn/PerfectXiao/a_very_long_directory_name_designed_specifically_to_test_the_line_wrapping_issue/file.txt";
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("preserves long urls verbatim for copy safety", () => {
    const input =
      "https://example.com/this/is/a/very/long/url/segment/that/should/remain/contiguous/when/rendered";
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("preserves long file-like underscore tokens for copy safety", () => {
    const input = "administrators_authorized_keys_with_extra_suffix".repeat(2);
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("preserves long credential-like mixed alnum tokens for copy safety", () => {
    const input = "e3b19c3b87bcf364b23eebb2c276e96ec478956ba1d84c93"; // pragma: allowlist secret
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("preserves quoted credential-like mixed alnum tokens for copy safety", () => {
    const input = "'e3b19c3b87bcf364b23eebb2c276e96ec478956ba1d84c93'"; // pragma: allowlist secret
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("wraps rtl lines with directional isolation marks", () => {
    const input = "مرحبا بالعالم";
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe("\u2067مرحبا بالعالم\u2069");
  });

  it("only wraps lines that contain rtl script", () => {
    const input = "hello\nمرحبا";
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe("hello\n\u2067مرحبا\u2069");
  });

  it("does not double-wrap lines that already include bidi controls", () => {
    const input = "\u2067مرحبا\u2069";
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("removes untrusted bidi overrides before adding trusted RTL isolation", () => {
    expect(sanitizeRenderableText("\u202eمرحبا\u202c")).toBe("\u2067مرحبا\u2069");
    expect(sanitizeRenderableText("\u061cمرحبا\u200f")).toBe("\u2067مرحبا\u2069");
  });

  it("preserves long camelCase identifiers wrapped in inline code spans (#48432)", () => {
    const input = "- `requireConfirmationForMutatingActions: false`";
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("preserves long hyphenated package names in inline code spans (#48432)", () => {
    const input = "Install `ubuntu-budgie-desktop-environment` to fix it.";
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("preserves dotted entity IDs in inline code spans (#39505)", () => {
    const input = "See `binary_sensor.sense_energy_monitor_power` for the live reading.";
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("preserves bare hyphenated package names in prose", () => {
    const input = "Run apt install ubuntu-budgie-desktop-environment after enabling the PPA.";
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("preserves bare dotted entity IDs in prose", () => {
    const input = "Watch binary_sensor.sense_energy_monitor_power.daily_energy after midnight.";
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("preserves backtick-fenced code blocks verbatim", () => {
    const input = [
      "Run this:",
      "```bash",
      "sudo cp -a /var/lib/machines/fc41/etc/systemd/network/. \\",
      "           /var/lib/machines/fc43/etc/systemd/network/",
      "```",
      "Done.",
    ].join("\n");
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("preserves tilde-fenced code blocks verbatim", () => {
    const input = [
      "Example:",
      "~~~typescript",
      "const requireConfirmationForMutatingActions = false;",
      "~~~",
    ].join("\n");
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("preserves long base64-like blobs inside inline code spans", () => {
    const input = "token: `e3b19c3b87bcf364b23eebb2c276e96ec478956ba1d84c93deadbeef`"; // pragma: allowlist secret
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("still chunks long unbroken prose tokens outside code spans", () => {
    const input = `prefix ${"x".repeat(120)} suffix`;
    const sanitized = sanitizeRenderableText(input);

    const longestSegment = Math.max(...sanitized.split(/\s+/).map((s) => s.length));
    expect(longestSegment).toBeLessThanOrEqual(32);
  });

  it("preserves prose around code blocks while chunking long prose tokens", () => {
    const input = [
      `before ${"x".repeat(120)}`,
      "```",
      "code line preserved verbatim",
      "```",
      `after ${"y".repeat(80)}`,
    ].join("\n");
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toContain("code line preserved verbatim");
    expect(sanitized).not.toContain("x".repeat(33));
    expect(sanitized).not.toContain("y".repeat(33));
  });

  it("does not chunk box-drawing horizontal rules used in tables", () => {
    const input = "─".repeat(60);
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("does not insert spaces before backslash line-continuations in fenced code", () => {
    const longContinuation = `cmd ${"a".repeat(40)} \\`;
    const input = ["```bash", longContinuation, "  next", "```"].join("\n");
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toContain(longContinuation);
    expect(sanitized).not.toContain("\\ ");
  });

  it("strips ANSI escapes inside fenced code blocks (sanitization runs before segmentation)", () => {
    const input = "Hello\n```\nlet x = 1;[31m injected[0m\n```\nbye";
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).not.toContain("");
    expect(sanitized).toContain("let x = 1;");
  });

  it("strips control chars inside inline code spans (sanitization runs before segmentation)", () => {
    const input = "Hello `safe\x00content` world";
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe("Hello `safecontent` world");
  });

  it("redacts heavily corrupted lines even inside fenced code blocks", () => {
    const input = `Header\n\`\`\`\n${"�".repeat(40)}\n\`\`\`\nFooter`;
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toContain("[binary data omitted]");
  });
});

describe("Markdown display safety", () => {
  it("strips hostile controls from source without adding directional isolates", () => {
    const input = "\u202e# مرحبا\u202c\n\u009b31m> שלום\u009b0m";
    const sanitized = sanitizeMarkdownSource(input);

    expect(sanitized).toBe("# مرحبا\n> שלום");
    expect(sanitized).not.toMatch(/[\u2066-\u2069]/u);
  });

  it("isolates rendered RTL lines without changing visible width", () => {
    const rendered = "\x1b[1mمرحبا\x1b[0m";
    const isolated = isolateRtlRenderedLine(rendered);

    expect(isolated).toBe(`\u2067${rendered}\u2069`);
    expect(visibleWidth(isolated)).toBe(visibleWidth(rendered));
  });

  it("keeps rendered padding outside RTL isolates", () => {
    const rendered = "  \x1b[1mمرحبا\x1b[0m   ";
    const isolated = isolateRtlRenderedLine(rendered);

    expect(isolated).toBe(`  \u2067\x1b[1mمرحبا\x1b[0m\u2069   `);
    expect(visibleWidth(isolated)).toBe(visibleWidth(rendered));
  });
});

describe("isTerminalSafeAutocompleteValue", () => {
  it("accepts ordinary Unicode and rejects terminal or bidi controls", () => {
    expect(isTerminalSafeAutocompleteValue("/tmp/مرحبا-東京.txt")).toBe(true);
    for (const value of [
      "bad\x1b[31m",
      "bad\tvalue",
      "bad\u009bvalue",
      "bad\u200evalue",
      "bad\u202evalue",
    ]) {
      expect(isTerminalSafeAutocompleteValue(value)).toBe(false);
    }
  });
});

describe("sanitizeRenderableLine", () => {
  it("preserves RTL isolation while collapsing carriage returns, newlines, and tabs", () => {
    expect(sanitizeRenderableLine("left\r\nمرحبا\tשלום right")).toBe(
      "\u2067left مرحبا שלום right\u2069",
    );
  });

  it("preserves long exact labels without prose token splitting", () => {
    const label = "a".repeat(300);

    expect(sanitizeRenderableLine(label)).toBe(label);
  });

  it("strips terminal controls and redacts binary-like lines before collapsing whitespace", () => {
    const input = `safe\x1b]52;c;Y2xpcGJvYXJk\x07\r\n${"�".repeat(20)}\tمرحبا`;

    expect(sanitizeRenderableLine(input)).toBe("safe [binary data omitted]");
  });
});
