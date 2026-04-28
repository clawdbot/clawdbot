import { describe, expect, it } from "vitest";
import {
  formatAttachmentTags,
  renderAttachmentTags,
  TRANSCRIPT_SOURCE_LABELS,
  type AttachmentSummary,
} from "./attachment-tags.js";

describe("engine/utils/attachment-tags", () => {
  // ────────────────────────── shared body (mode-agnostic) ──────────────────────────

  describe("shared tag body", () => {
    it("returns empty string for missing/empty input", () => {
      expect(formatAttachmentTags()).toBe("");
      expect(formatAttachmentTags([])).toBe("");
    });

    it("collapses to MEDIA:{source} when a path/url is present", () => {
      expect(formatAttachmentTags([{ type: "image", localPath: "/tmp/a.png" }])).toBe(
        "MEDIA:/tmp/a.png",
      );
      expect(formatAttachmentTags([{ type: "file", url: "https://x/y.pdf" }])).toBe(
        "MEDIA:https://x/y.pdf",
      );
    });

    it("inlines voice transcript only for voice attachments", () => {
      expect(
        formatAttachmentTags([{ type: "voice", localPath: "/tmp/v.wav", transcript: "hi" }]),
      ).toBe('MEDIA:/tmp/v.wav (transcript: "hi")');
      // Non-voice attachments never get the transcript suffix even if one
      // is present on the summary.
      expect(
        formatAttachmentTags([
          { type: "image", localPath: "/tmp/i.png", transcript: "unused" } as AttachmentSummary,
        ]),
      ).toBe("MEDIA:/tmp/i.png");
    });

    it("falls back to bracketed tags when no source is available", () => {
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

    it("joins multiple entries with newline in inline mode", () => {
      expect(
        formatAttachmentTags([
          { type: "image", localPath: "/tmp/a.png" },
          { type: "voice", transcript: "hi" },
        ]),
      ).toBe('MEDIA:/tmp/a.png\n[voice (transcript: "hi")]');
    });
  });

  // ────────────────────────── ref mode = body + source suffix ──────────────────────────

  describe("ref mode consistency with inline", () => {
    it("produces the same body as inline for non-voice attachments", () => {
      const att: AttachmentSummary[] = [
        { type: "image", localPath: "/tmp/a.png" },
        { type: "file", filename: "b.pdf" },
      ];
      // Rendered one at a time so separator differences don't matter.
      for (const a of att) {
        expect(renderAttachmentTags([a], { mode: "inline" })).toBe(
          renderAttachmentTags([a], { mode: "ref" }),
        );
      }
    });

    it("produces the same body as inline for voice without transcriptSource", () => {
      const cases: AttachmentSummary[] = [
        { type: "voice" },
        { type: "voice", transcript: "hi" },
        { type: "voice", localPath: "/tmp/v.wav", transcript: "hi" },
      ];
      for (const a of cases) {
        expect(renderAttachmentTags([a], { mode: "inline" })).toBe(
          renderAttachmentTags([a], { mode: "ref" }),
        );
      }
    });

    it("appends ' [source: …]' ONLY for voice + transcript + transcriptSource in ref mode", () => {
      // ref mode: suffix appears.
      expect(
        renderAttachmentTags(
          [{ type: "voice", localPath: "/tmp/v.wav", transcript: "hi", transcriptSource: "stt" }],
          { mode: "ref" },
        ),
      ).toBe('MEDIA:/tmp/v.wav (transcript: "hi") [source: local STT]');

      // inline mode: suffix NEVER appears, even with transcriptSource set.
      expect(
        renderAttachmentTags(
          [{ type: "voice", localPath: "/tmp/v.wav", transcript: "hi", transcriptSource: "stt" }],
          { mode: "inline" },
        ),
      ).toBe('MEDIA:/tmp/v.wav (transcript: "hi")');
    });

    it("omits the source suffix when transcriptSource is missing (both modes identical)", () => {
      const att: AttachmentSummary = { type: "voice", transcript: "hi" };
      expect(renderAttachmentTags([att], { mode: "ref" })).toBe(
        renderAttachmentTags([att], { mode: "inline" }),
      );
    });

    it("joins with space in ref mode", () => {
      expect(
        renderAttachmentTags(
          [
            { type: "image", filename: "a.png" },
            { type: "voice", transcript: "hi" },
          ],
          { mode: "ref" },
        ),
      ).toBe('[image: a.png] [voice (transcript: "hi")]');
    });
  });

  // ────────────────────────── Prompt-contract regression guards ──────────────────────────

  describe("prompt contract", () => {
    it("exposes the transcript-source labels table", () => {
      expect(TRANSCRIPT_SOURCE_LABELS.stt).toBe("local STT");
      expect(TRANSCRIPT_SOURCE_LABELS.asr).toBe("platform ASR");
      expect(TRANSCRIPT_SOURCE_LABELS.tts).toBe("TTS source");
      expect(TRANSCRIPT_SOURCE_LABELS.fallback).toBe("fallback text");
    });

    it("uses the single canonical keyword 'transcript:' (never 'content:')", () => {
      // If anyone reintroduces 'content:' the regex below will match and fail the test.
      const samples = [
        formatAttachmentTags([{ type: "voice", transcript: "t" }]),
        renderAttachmentTags([{ type: "voice", transcript: "t", transcriptSource: "asr" }], {
          mode: "ref",
        }),
      ];
      for (const s of samples) {
        expect(s).toMatch(/transcript:/);
        expect(s).not.toMatch(/content:/);
      }
    });

    it("uses the single canonical type label 'voice' (never 'voice message')", () => {
      const samples = [
        renderAttachmentTags([{ type: "voice" }], { mode: "inline" }),
        renderAttachmentTags([{ type: "voice", transcript: "hi" }], { mode: "ref" }),
      ];
      for (const s of samples) {
        expect(s).not.toMatch(/voice message/);
      }
    });
  });

  // ────────────────────────── Options ──────────────────────────

  describe("options", () => {
    it("respects a custom separator", () => {
      expect(
        renderAttachmentTags(
          [
            { type: "image", filename: "a" },
            { type: "video", filename: "b" },
          ],
          { mode: "inline", separator: " | " },
        ),
      ).toBe("[image: a] | [video: b]");
    });

    it("returns the emptyFallback when input is empty", () => {
      expect(renderAttachmentTags(undefined, { mode: "ref", emptyFallback: "(none)" })).toBe(
        "(none)",
      );
      expect(renderAttachmentTags([], { mode: "inline", emptyFallback: "" })).toBe("");
    });
  });
});
