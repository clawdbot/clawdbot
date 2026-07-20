// @vitest-environment node
// Control UI tests cover message normalizer behavior.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isStandaloneToolMessageForDisplay,
  isToolResultMessage,
  normalizeMessage,
} from "./message-normalizer.ts";

const SENDER_METADATA_BLOCK =
  'Sender (untrusted metadata):\n```json\n{"label":"openclaw-control-ui","id":"openclaw-control-ui"}\n```';

describe("message-normalizer", () => {
  // Regression: gateway/transcript events can carry a null/undefined or
  // non-object entry (e.g. a transcript row without a `message`). `typeof
  // m.role` still reads `.role` off the object, so an undefined entry threw
  // "Cannot read properties of undefined (reading 'role')" inside the gateway
  // event handler. These entry points must degrade to a safe default instead.
  describe("malformed input never throws", () => {
    it.each([undefined, null, "raw string", 42, true])(
      "normalizeMessage(%o) yields role 'unknown' without throwing",
      (input) => {
        expect(() => normalizeMessage(input)).not.toThrow();
        expect(normalizeMessage(input).role).toBe("unknown");
      },
    );

    it.each([undefined, null, "raw string", 42, true])(
      "tool-message predicates return false for %o without throwing",
      (input) => {
        expect(() => isToolResultMessage(input)).not.toThrow();
        expect(() => isStandaloneToolMessageForDisplay(input)).not.toThrow();
        expect(isToolResultMessage(input)).toBe(false);
        expect(isStandaloneToolMessageForDisplay(input)).toBe(false);
      },
    );
  });

  describe("normalizeMessage", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("normalizes message with string content", () => {
      const result = normalizeMessage({
        role: "user",
        content: "Hello world",
        timestamp: 1000,
        id: "msg-1",
      });

      expect(result).toEqual({
        role: "user",
        content: [{ type: "text", text: "Hello world" }],
        timestamp: 1000,
        id: "msg-1",
        senderLabel: null,
      });
    });

    it("strips sender metadata blocks before displaying message text", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: `${SENDER_METADATA_BLOCK}\n\nVisible reply`,
      });

      expect(result.content).toEqual([{ type: "text", text: "Visible reply" }]);
    });

    it("drops standalone sender metadata blocks before display", () => {
      const result = normalizeMessage({
        role: "system",
        content: SENDER_METADATA_BLOCK,
      });

      expect(result.content).toStrictEqual([]);
    });

    it("does not reinterpret directive-like user string content", () => {
      const result = normalizeMessage({
        role: "user",
        content: "MEDIA:/tmp/example.png\n[[reply_to_current]]",
      });

      expect(result.content).toEqual([
        { type: "text", text: "MEDIA:/tmp/example.png\n[[reply_to_current]]" },
      ]);
      expect(result.replyTarget).toBeUndefined();
      expect(result.audioAsVoice).toBeUndefined();
    });

    it("normalizes message with array content", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: [
          { type: "text", text: "Here is the result" },
          { type: "tool_use", name: "bash", args: { command: "ls" } },
        ],
        timestamp: 2000,
      });

      expect(result.role).toBe("toolResult");
      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toEqual({
        type: "text",
        text: "Here is the result",
        name: undefined,
        args: undefined,
      });
      expect(result.content[1]).toEqual({
        type: "tool_use",
        text: undefined,
        name: "bash",
        args: { command: "ls" },
      });
    });

    it("normalizes persisted Responses text blocks as renderable text", () => {
      const user = normalizeMessage({
        role: "user",
        content: [{ type: "input_text", text: "Persisted user question" }],
      });
      const assistant = normalizeMessage({
        role: "assistant",
        content: [{ type: "output_text", text: "Persisted assistant answer" }],
      });

      expect(user.content).toEqual([
        {
          type: "text",
          text: "Persisted user question",
          name: undefined,
          args: undefined,
        },
      ]);
      expect(assistant.content).toEqual([{ type: "text", text: "Persisted assistant answer" }]);
    });

    it("accepts assistant Responses input blocks but rejects user output blocks", () => {
      const user = normalizeMessage({
        role: "user",
        content: [{ type: "output_text", text: "Assistant-only block" }],
      });
      const assistant = normalizeMessage({
        role: "assistant",
        content: [{ type: "input_text", text: "User-only block" }],
      });

      expect(user.content).not.toContainEqual({ type: "text", text: "Assistant-only block" });
      expect(assistant.content).toContainEqual({ type: "text", text: "User-only block" });
    });

    it("normalizes structured base64 audio content blocks as renderable attachments", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: [
          {
            type: "audio",
            label: "tts.mp3",
            source: {
              type: "base64",
              media_type: "audio/mpeg",
              data: "//uQAA==",
            },
          },
        ],
      });

      expect(result.content).toEqual([
        {
          type: "attachment",
          attachment: {
            url: "data:audio/mpeg;base64,//uQAA==",
            kind: "audio",
            label: "tts.mp3",
            mimeType: "audio/mpeg",
          },
        },
      ]);
    });

    it("normalizes structured URL audio content blocks as renderable attachments", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: [
          {
            type: "audio",
            label: "clip.mp3",
            source: {
              type: "url",
              media_type: "audio/mpeg",
              url: "/tmp/openclaw/clip.mp3",
            },
          },
        ],
      });

      expect(result.content).toEqual([
        {
          type: "attachment",
          attachment: {
            url: "/tmp/openclaw/clip.mp3",
            kind: "audio",
            label: "clip.mp3",
            mimeType: "audio/mpeg",
          },
        },
      ]);
    });

    it("does not normalize non-assistant structured audio blocks as attachments", () => {
      const result = normalizeMessage({
        role: "user",
        content: [
          {
            type: "audio",
            label: "upload.mp3",
            source: {
              type: "base64",
              media_type: "audio/mpeg",
              data: "//uQAA==",
            },
          },
        ],
      });

      expect(result.content).toEqual([]);
    });

    it("does not reinterpret directive-like user text blocks inside array content", () => {
      const result = normalizeMessage({
        role: "user",
        content: [{ type: "text", text: "MEDIA:/tmp/example.png\n[[audio_as_voice]]" }],
      });

      expect(result.content).toEqual([
        {
          type: "text",
          text: "MEDIA:/tmp/example.png\n[[audio_as_voice]]",
          name: undefined,
          args: undefined,
        },
      ]);
      expect(result.audioAsVoice).toBeUndefined();
    });

    it("normalizes message with text field (alternative format)", () => {
      const result = normalizeMessage({
        role: "user",
        text: "Alternative format",
      });

      expect(result.content).toEqual([{ type: "text", text: "Alternative format" }]);
    });

    it("expands [embed] shortcodes into canvas blocks", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: 'Here.\n[embed ref="cv_status" title="Status" height="320" /]',
      });

      expect(result.content).toEqual([
        { type: "text", text: "Here." },
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            viewId: "cv_status",
            url: "/__openclaw__/canvas/documents/cv_status/index.html",
            title: "Status",
            preferredHeight: 320,
          },
          rawText: null,
        },
      ]);
    });

    it("preserves a canvas preview sandbox ceiling from history", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: [
          {
            type: "canvas",
            preview: {
              kind: "canvas",
              surface: "assistant_message",
              render: "url",
              url: "/__openclaw__/canvas/documents/cv_widget/index.html",
              sandbox: "scripts",
            },
          },
        ],
      });

      expect(result.content[0]).toMatchObject({
        type: "canvas",
        preview: { sandbox: "scripts" },
      });
    });

    it("ignores [embed] shortcodes inside fenced code blocks", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: '```text\n[embed ref="cv_status" /]\n```',
      });

      expect(result.content).toEqual([
        {
          type: "text",
          text: '```text\n[embed ref="cv_status" /]\n```',
        },
      ]);
    });

    it("leaves block-form inline html embed shortcodes as plain text", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: '[embed content_type="html" title="Status"]\n<div>Ready</div>\n[/embed]',
      });

      expect(result.content).toEqual([
        {
          type: "text",
          text: '[embed content_type="html" title="Status"]\n<div>Ready</div>\n[/embed]',
        },
      ]);
    });

    it("extracts MEDIA attachments and reply metadata from assistant text", () => {
      const result = normalizeMessage({
        role: "assistant",
        content:
          "[[reply_to:thread-123]]Intro\nMEDIA:https://example.com/image.png\nOutro\nMEDIA:https://example.com/voice.ogg\n[[audio_as_voice]]",
      });

      expect(result.replyTarget).toEqual({ kind: "id", id: "thread-123" });
      expect(result.audioAsVoice).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "Intro" },
        {
          type: "attachment",
          attachment: {
            url: "https://example.com/image.png",
            kind: "image",
            label: "image.png",
            mimeType: "image/png",
          },
        },
        { type: "text", text: "Outro" },
        {
          type: "attachment",
          attachment: {
            url: "https://example.com/voice.ogg",
            kind: "audio",
            label: "voice.ogg",
            mimeType: "audio/ogg",
            isVoiceNote: true,
          },
        },
      ]);
    });

    it("marks media-only audio attachments as voice notes when audio_as_voice is present", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: "MEDIA:https://example.com/voice.ogg\n[[audio_as_voice]]",
      });

      expect(result.audioAsVoice).toBe(true);
      expect(result.content).toEqual([
        {
          type: "attachment",
          attachment: {
            url: "https://example.com/voice.ogg",
            kind: "audio",
            label: "voice.ogg",
            mimeType: "audio/ogg",
            isVoiceNote: true,
          },
        },
      ]);
    });

    it("classifies MPEG-2 audio attachments", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: "MEDIA:https://example.com/recording.m2a",
      });

      expect(result.content).toEqual([
        {
          type: "attachment",
          attachment: {
            url: "https://example.com/recording.m2a",
            kind: "audio",
            label: "recording.m2a",
            mimeType: "audio/mpeg",
          },
        },
      ]);
    });

    it("classifies encoded assistant MEDIA extensions", () => {
      const imageUrl = "https://cdn.example/render%2Epng?download=1";
      const videoUrl = "https://cdn.example/clip%2Emp4";
      const result = normalizeMessage({
        role: "assistant",
        content: `MEDIA:${imageUrl}\nMEDIA:${videoUrl}`,
      });

      expect(result.content).toEqual([
        {
          type: "attachment",
          attachment: {
            url: imageUrl,
            kind: "image",
            label: "render%2Epng",
            mimeType: "image/png",
          },
        },
        {
          type: "attachment",
          attachment: {
            url: videoUrl,
            kind: "video",
            label: "clip%2Emp4",
            mimeType: "video/mp4",
          },
        },
      ]);
    });

    it("keeps valid local MEDIA paths as assistant attachments", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: "Hello\nMEDIA:/tmp/openclaw/test-image.png\nWorld",
      });

      expect(result.content).toEqual([
        { type: "text", text: "Hello" },
        {
          type: "attachment",
          attachment: {
            url: "/tmp/openclaw/test-image.png",
            kind: "image",
            label: "test-image.png",
            mimeType: "image/png",
          },
        },
        { type: "text", text: "World" },
      ]);
    });

    it("keeps spaced local filenames together instead of leaking suffix text", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: "MEDIA:/tmp/openclaw/shinkansen kato - Google Shopping.pdf",
      });

      expect(result.content).toEqual([
        {
          type: "attachment",
          attachment: {
            url: "/tmp/openclaw/shinkansen kato - Google Shopping.pdf",
            kind: "document",
            label: "shinkansen kato - Google Shopping.pdf",
            mimeType: "application/pdf",
          },
        },
      ]);
    });

    it("keeps home-relative MEDIA paths as assistant attachments", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: "MEDIA:~/Pictures/My File.png",
      });

      expect(result.content).toEqual([
        {
          type: "attachment",
          attachment: {
            url: "~/Pictures/My File.png",
            kind: "image",
            label: "My File.png",
            mimeType: "image/png",
          },
        },
      ]);
    });

    it("preserves relative MEDIA references as visible text instead of dropping the assistant turn", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: "MEDIA:chart.png",
      });

      expect(result.content).toEqual([{ type: "text", text: "MEDIA:chart.png" }]);
    });

    it("strips reply_to_current without rendering a quoted preview", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: "[[reply_to_current]]\nReply body",
      });

      expect(result.replyTarget).toEqual({ kind: "current" });
      expect(result.content).toEqual([{ type: "text", text: "Reply body" }]);
    });

    it("does not restore stripped reply tags when no visible text remains", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: "[[reply_to_current]]",
      });

      expect(result.replyTarget).toEqual({ kind: "current" });
      expect(result.content).toStrictEqual([]);
    });

    it("preserves structured attachment content items", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: [
          {
            type: "attachment",
            attachment: {
              url: "~/Pictures/test image.png",
              kind: "image",
              label: "test image.png",
              mimeType: "image/png",
            },
          },
        ],
      });

      expect(result.content).toEqual([
        {
          type: "attachment",
          attachment: {
            url: "~/Pictures/test image.png",
            kind: "image",
            label: "test image.png",
            mimeType: "image/png",
          },
        },
      ]);
    });

    it("detects tool result by toolCallId", () => {
      const result = normalizeMessage({
        role: "assistant",
        toolCallId: "call-123",
        content: "Tool output",
      });

      expect(result.role).toBe("toolResult");
    });

    it("detects tool result by tool_call_id (snake_case)", () => {
      const result = normalizeMessage({
        role: "assistant",
        tool_call_id: "call-456",
        content: "Tool output",
      });

      expect(result.role).toBe("toolResult");
    });

    it("detects tool messages by toolcall content blocks", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: [{ type: "toolcall", name: "Bash", arguments: { command: "pwd" } }],
      });

      expect(result.role).toBe("toolResult");
      expect(result.content[0]).toEqual({
        type: "toolcall",
        text: undefined,
        name: "Bash",
        args: { command: "pwd" },
      });
    });

    it("handles missing role", () => {
      const result = normalizeMessage({ content: "No role" });
      expect(result.role).toBe("unknown");
    });

    it("handles missing content", () => {
      const result = normalizeMessage({ role: "user" });
      expect(result.content).toStrictEqual([]);
    });

    it("uses current timestamp when not provided", () => {
      const result = normalizeMessage({ role: "user", content: "Test" });
      expect(result.timestamp).toBe(Date.now());
    });

    it("handles arguments field (alternative to args)", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: [{ type: "tool_use", name: "test", arguments: { foo: "bar" } }],
      });

      expect((result.content[0] as { args?: unknown }).args).toEqual({ foo: "bar" });
    });

    it("handles input field for anthropic tool_use blocks", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "pwd" } }],
      });

      expect((result.content[0] as { args?: unknown }).args).toEqual({ command: "pwd" });
    });

    it("preserves top-level sender labels", () => {
      const result = normalizeMessage({
        role: "user",
        content: "Hello from QuietChat",
        senderLabel: "Iris",
      });

      expect(result.senderLabel).toBe("Iris");
    });

    it("formats durable sender metadata for transcript attribution", () => {
      const emailSender = normalizeMessage({
        role: "user",
        content: "Prompt from Alice",
        __openclaw: { senderId: "alice@example.com" },
      });
      expect(emailSender.senderLabel).toBe("alice");
      expect(emailSender.sender).toEqual({ id: "alice@example.com" });
      expect(
        normalizeMessage({
          role: "user",
          content: "Prompt from a profile",
          __openclaw: { senderId: "profile_123", senderName: "Alice Example" },
        }).senderLabel,
      ).toBe("Alice Example");
    });
  });
});

describe("sender label opaque-id stripping", () => {
  it("strips a baked profile-UUID suffix and preserves it as sender identity", () => {
    const normalized = normalizeMessage({
      role: "user",
      content: "hi",
      senderLabel: "steipete (c3e32452-0467-47e5-aafa-233cd5dae29f)",
    });
    expect(normalized.senderLabel).toBe("steipete");
    // Legacy rows have no structured sender; the UUID from the label is the
    // only author key, so it must survive as non-display identity.
    expect(normalized.sender).toEqual({
      id: "c3e32452-0467-47e5-aafa-233cd5dae29f",
      name: "steipete",
    });
  });

  it("prefers durable metadata identity over the legacy label identity", () => {
    const normalized = normalizeMessage({
      role: "user",
      content: "hi",
      senderLabel: "steipete (c3e32452-0467-47e5-aafa-233cd5dae29f)",
      __openclaw: { senderId: "meta-profile", senderName: "Meta Name" },
    });
    expect(normalized.sender).toEqual({ id: "meta-profile", name: "Meta Name" });
    expect(normalized.senderLabel).toBe("steipete");
  });

  it("keeps human-meaningful parenthesized suffixes", () => {
    expect(
      normalizeMessage({
        role: "user",
        content: "hi",
        senderLabel: "Peter (+436641234567)",
      }).senderLabel,
    ).toBe("Peter (+436641234567)");
  });

  it("keeps a label that is only a UUID rather than emptying it", () => {
    expect(
      normalizeMessage({
        role: "user",
        content: "hi",
        senderLabel: "(c3e32452-0467-47e5-aafa-233cd5dae29f)",
      }).senderLabel,
    ).toBe("(c3e32452-0467-47e5-aafa-233cd5dae29f)");
  });

  it("attributes a bare-UUID legacy label to that profile", () => {
    const normalized = normalizeMessage({
      role: "user",
      content: "hi",
      senderLabel: "c3e32452-0467-47e5-aafa-233cd5dae29f",
    });
    // Nameless legacy senders keep the UUID as last-resort display, but the
    // row still attributes (and resolves its avatar) to that profile instead
    // of falling back to the local viewer identity.
    expect(normalized.senderLabel).toBe("c3e32452-0467-47e5-aafa-233cd5dae29f");
    expect(normalized.sender).toEqual({ id: "c3e32452-0467-47e5-aafa-233cd5dae29f" });
  });
});
