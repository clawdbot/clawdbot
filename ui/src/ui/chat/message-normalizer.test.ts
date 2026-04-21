import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  normalizeMessage,
  normalizeRoleForGrouping,
  isToolResultMessage,
} from "./message-normalizer.ts";

describe("message-normalizer", () => {
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

    it("does not fall back to raw text when an invalid MEDIA line is stripped", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: "MEDIA:~/Pictures/My File.png",
      });

      expect(result.content).toEqual([]);
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
      expect(result.content).toEqual([]);
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
      expect(result.content).toEqual([]);
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
  });

  describe("normalizeRoleForGrouping", () => {
    it("returns tool for toolresult", () => {
      expect(normalizeRoleForGrouping("toolresult")).toBe("tool");
      expect(normalizeRoleForGrouping("toolResult")).toBe("tool");
      expect(normalizeRoleForGrouping("TOOLRESULT")).toBe("tool");
    });

    it("returns tool for tool_result", () => {
      expect(normalizeRoleForGrouping("tool_result")).toBe("tool");
      expect(normalizeRoleForGrouping("TOOL_RESULT")).toBe("tool");
    });

    it("returns tool for tool", () => {
      expect(normalizeRoleForGrouping("tool")).toBe("tool");
      expect(normalizeRoleForGrouping("Tool")).toBe("tool");
    });

    it("returns tool for function", () => {
      expect(normalizeRoleForGrouping("function")).toBe("tool");
      expect(normalizeRoleForGrouping("Function")).toBe("tool");
    });

    it("preserves user role", () => {
      expect(normalizeRoleForGrouping("user")).toBe("user");
      expect(normalizeRoleForGrouping("User")).toBe("User");
    });

    it("preserves assistant role", () => {
      expect(normalizeRoleForGrouping("assistant")).toBe("assistant");
    });

    it("preserves system role", () => {
      expect(normalizeRoleForGrouping("system")).toBe("system");
    });
  });

  describe("isToolResultMessage", () => {
    it("returns true for toolresult role", () => {
      expect(isToolResultMessage({ role: "toolresult" })).toBe(true);
      expect(isToolResultMessage({ role: "toolResult" })).toBe(true);
      expect(isToolResultMessage({ role: "TOOLRESULT" })).toBe(true);
    });

    it("returns true for tool_result role", () => {
      expect(isToolResultMessage({ role: "tool_result" })).toBe(true);
      expect(isToolResultMessage({ role: "TOOL_RESULT" })).toBe(true);
    });

    it("returns false for other roles", () => {
      expect(isToolResultMessage({ role: "user" })).toBe(false);
      expect(isToolResultMessage({ role: "assistant" })).toBe(false);
      expect(isToolResultMessage({ role: "tool" })).toBe(false);
    });

    it("returns false for missing role", () => {
      expect(isToolResultMessage({})).toBe(false);
      expect(isToolResultMessage({ content: "test" })).toBe(false);
    });

    it("returns false for non-string role", () => {
      expect(isToolResultMessage({ role: 123 })).toBe(false);
      expect(isToolResultMessage({ role: null })).toBe(false);
    });
  });
});
