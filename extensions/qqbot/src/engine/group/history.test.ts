// Qqbot tests cover history plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildMergedMessageContext,
  formatAttachmentTags,
  formatMessageContent,
  toAttachmentSummaries,
} from "./history.js";

describe("engine/group/history", () => {
  describe("toAttachmentSummaries", () => {
    it("returns undefined for empty input", () => {
      expect(toAttachmentSummaries()).toBeUndefined();
      expect(toAttachmentSummaries([])).toBeUndefined();
    });

    it("normalizes raw fields", () => {
      const result = toAttachmentSummaries([
        {
          content_type: "image/png",
          filename: "a.png",
          url: "https://x/a.png",
        },
        {
          content_type: "voice",
          asr_refer_text: "hello",
        },
        { content_type: "application/pdf", filename: "doc.pdf" },
        { content_type: "weird/thing" },
      ]);
      expect(result).toEqual([
        { type: "image", filename: "a.png", transcript: undefined, url: "https://x/a.png" },
        { type: "voice", filename: undefined, transcript: "hello", url: undefined },
        { type: "file", filename: "doc.pdf", transcript: undefined, url: undefined },
        { type: "unknown", filename: undefined, transcript: undefined, url: undefined },
      ]);
    });
  });

  describe("formatAttachmentTags", () => {
    it("returns empty string for empty input", () => {
      expect(formatAttachmentTags()).toBe("");
      expect(formatAttachmentTags([])).toBe("");
    });

    it("renders bracketed source tags for entries with a source", () => {
      expect(formatAttachmentTags([{ type: "image", localPath: "/tmp/a.png" }])).toBe(
        "[image: /tmp/a.png]",
      );
      expect(formatAttachmentTags([{ type: "image", url: "https://x/b.png" }])).toBe(
        "[image: https://x/b.png]",
      );
    });

    it("inlines transcript for voice w/ source", () => {
      expect(
        formatAttachmentTags([{ type: "voice", localPath: "/tmp/v.wav", transcript: "hi" }]),
      ).toBe('[voice: /tmp/v.wav] (transcript: "hi")');
    });

    it("uses descriptive tags when no source is available", () => {
      expect(formatAttachmentTags([{ type: "image" }])).toBe("[image]");
      expect(formatAttachmentTags([{ type: "image", filename: "a.png" }])).toBe("[image: a.png]");
      expect(formatAttachmentTags([{ type: "voice" }])).toBe("[voice]");
      expect(formatAttachmentTags([{ type: "voice", transcript: "t" }])).toBe(
        '[voice (transcript: "t")]',
      );
      expect(formatAttachmentTags([{ type: "video" }])).toBe("[video]");
      expect(formatAttachmentTags([{ type: "file", filename: "b.pdf" }])).toBe("[file: b.pdf]");
      expect(formatAttachmentTags([{ type: "unknown" }])).toBe("[attachment]");
    });

    it("joins multiple entries with newline", () => {
      expect(
        formatAttachmentTags([
          { type: "image", localPath: "/tmp/a.png" },
          { type: "voice", transcript: "hi" },
        ]),
      ).toBe('[image: /tmp/a.png]\n[voice (transcript: "hi")]');
    });
  });

  describe("formatMessageContent", () => {
    it("passes content through parseFaceTags (no-op for plain text)", () => {
      // parseFaceTags only rewrites the `<faceType=...>` tag form; plain
      // text must round-trip unchanged so regressions in the pipeline
      // don't silently mangle user input.
      expect(formatMessageContent({ content: "hello world" })).toBe("hello world");
    });

    it("strips mentions only for group chat", () => {
      expect(
        formatMessageContent({
          content: "<@X>hi",
          chatType: "group",
          mentions: [{ member_openid: "X", is_you: true }],
        }),
      ).toBe("hi");
      // Non-group: strip is NOT applied.
      expect(
        formatMessageContent({
          content: "<@X>hi",
          chatType: "c2c",
          mentions: [{ member_openid: "X", is_you: true }],
        }),
      ).toBe("<@X>hi");
    });

    it("appends attachment tags", () => {
      expect(
        formatMessageContent({
          content: "see",
          attachments: [{ content_type: "image/png", url: "https://x/a.png" }],
        }),
      ).toBe("see [image: https://x/a.png]");
    });
  });

  describe("buildMergedMessageContext", () => {
    it("returns current message unchanged when no preceding parts", () => {
      expect(buildMergedMessageContext({ precedingParts: [], currentMessage: "hi" })).toBe("hi");
    });

    it("wraps preceding parts with tags", () => {
      const out = buildMergedMessageContext({
        precedingParts: ["a", "b"],
        currentMessage: "c",
      });
      expect(out).toContain("[Merged earlier messages — CONTEXT ONLY]");
      expect(out).toContain("a\nb");
      expect(out).toContain("[CURRENT MESSAGE — reply using the context above]");
      expect(out.endsWith("c")).toBe(true);
    });
  });
});
