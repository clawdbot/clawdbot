import { describe, expect, it } from "vitest";
import {
  buildMergedMessageContext,
  buildPendingHistoryContext,
  clearPendingHistory,
  formatAttachmentTags,
  formatMessageContent,
  inferAttachmentType,
  recordPendingHistoryEntry,
  toAttachmentSummaries,
  type HistoryEntry,
} from "./history.js";

function makeMap(): Map<string, HistoryEntry[]> {
  return new Map();
}

function entry(sender: string, body: string, extras: Partial<HistoryEntry> = {}): HistoryEntry {
  return { sender, body, ...extras };
}

describe("engine/group/history", () => {
  describe("inferAttachmentType", () => {
    it("maps image/* → image", () => {
      expect(inferAttachmentType("image/png")).toBe("image");
    });

    it("maps voice / audio / silk / amr → voice", () => {
      expect(inferAttachmentType("voice")).toBe("voice");
      expect(inferAttachmentType("audio/mpeg")).toBe("voice");
      expect(inferAttachmentType("application/silk")).toBe("voice");
      expect(inferAttachmentType("audio/amr")).toBe("voice");
    });

    it("maps video / application / text → their category", () => {
      expect(inferAttachmentType("video/mp4")).toBe("video");
      expect(inferAttachmentType("application/pdf")).toBe("file");
      expect(inferAttachmentType("text/plain")).toBe("file");
    });

    it("unknown content types fall back to unknown", () => {
      expect(inferAttachmentType()).toBe("unknown");
      expect(inferAttachmentType("weird/thing")).toBe("unknown");
    });
  });

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
      ]);
      expect(result).toEqual([
        { type: "image", filename: "a.png", transcript: undefined, url: "https://x/a.png" },
        { type: "voice", filename: undefined, transcript: "hello", url: undefined },
      ]);
    });
  });

  describe("formatAttachmentTags", () => {
    it("returns empty string for empty input", () => {
      expect(formatAttachmentTags()).toBe("");
      expect(formatAttachmentTags([])).toBe("");
    });

    it("renders MEDIA:path for entries with a source", () => {
      expect(formatAttachmentTags([{ type: "image", localPath: "/tmp/a.png" }])).toBe(
        "MEDIA:/tmp/a.png",
      );
      expect(formatAttachmentTags([{ type: "image", url: "https://x/b.png" }])).toBe(
        "MEDIA:https://x/b.png",
      );
    });

    it("inlines transcript for voice w/ source", () => {
      expect(
        formatAttachmentTags([{ type: "voice", localPath: "/tmp/v.wav", transcript: "hi" }]),
      ).toBe('MEDIA:/tmp/v.wav (transcript: "hi")');
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
      ).toBe('MEDIA:/tmp/a.png\n[voice (transcript: "hi")]');
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
      ).toBe("see MEDIA:https://x/a.png");
    });
  });

  describe("recordPendingHistoryEntry / buildPendingHistoryContext", () => {
    it("no-ops when limit is 0", () => {
      const map = makeMap();
      const entries = recordPendingHistoryEntry({
        historyMap: map,
        historyKey: "G",
        entry: entry("A", "hi"),
        limit: 0,
      });
      expect(entries).toStrictEqual([]);
      expect(map.size).toBe(0);
    });

    it("no-ops when entry is null", () => {
      const map = makeMap();
      recordPendingHistoryEntry({
        historyMap: map,
        historyKey: "G",
        entry: null,
        limit: 10,
      });
      expect(map.size).toBe(0);
    });

    it("appends and caps at the limit", () => {
      const map = makeMap();
      for (let i = 0; i < 5; i++) {
        recordPendingHistoryEntry({
          historyMap: map,
          historyKey: "G",
          entry: entry("A", `m${i}`),
          limit: 3,
        });
      }
      const entries = map.get("G")!;
      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.body)).toEqual(["m2", "m3", "m4"]);
    });

    it("builds a history-wrapped message when entries exist", () => {
      const map = makeMap();
      recordPendingHistoryEntry({
        historyMap: map,
        historyKey: "G",
        entry: entry("Alice", "hello"),
        limit: 10,
      });
      const out = buildPendingHistoryContext({
        historyMap: map,
        historyKey: "G",
        limit: 10,
        currentMessage: "[Bob] @bot",
        formatEntry: (e) => `${e.sender}: ${e.body}`,
      });
      expect(out).toContain("[Chat messages since your last reply — CONTEXT ONLY]");
      expect(out).toContain("Alice: hello");
      expect(out).toContain("[CURRENT MESSAGE — reply to this]");
      expect(out.endsWith("[Bob] @bot")).toBe(true);
    });

    it("returns current message unchanged when buffer is empty or disabled", () => {
      const map = makeMap();
      expect(
        buildPendingHistoryContext({
          historyMap: map,
          historyKey: "G",
          limit: 10,
          currentMessage: "hi",
          formatEntry: () => "x",
        }),
      ).toBe("hi");
      expect(
        buildPendingHistoryContext({
          historyMap: map,
          historyKey: "G",
          limit: 0,
          currentMessage: "hi",
          formatEntry: () => "x",
        }),
      ).toBe("hi");
    });
  });

  describe("LRU eviction across groups", () => {
    it("evicts oldest keys past the implicit cap (smoke check)", () => {
      const map = makeMap();
      // Just ensure the cache doesn't explode. The hard cap (1000) is an
      // implementation detail; here we confirm the data structure keeps
      // re-inserting without error at modest volume.
      for (let i = 0; i < 100; i++) {
        recordPendingHistoryEntry({
          historyMap: map,
          historyKey: `G${i}`,
          entry: entry("A", `m${i}`),
          limit: 1,
        });
      }
      expect(map.size).toBe(100);
    });

    it("refreshes LRU ordering on subsequent writes to the same key", () => {
      const map = makeMap();
      recordPendingHistoryEntry({
        historyMap: map,
        historyKey: "OLD",
        entry: entry("A", "1"),
        limit: 5,
      });
      recordPendingHistoryEntry({
        historyMap: map,
        historyKey: "NEW",
        entry: entry("A", "2"),
        limit: 5,
      });
      recordPendingHistoryEntry({
        historyMap: map,
        historyKey: "OLD",
        entry: entry("A", "3"),
        limit: 5,
      });
      // After re-writing OLD, its iteration order should come last.
      const keys = [...map.keys()];
      expect(keys).toEqual(["NEW", "OLD"]);
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

  describe("clearPendingHistory", () => {
    it("resets the buffer to empty", () => {
      const map = makeMap();
      recordPendingHistoryEntry({
        historyMap: map,
        historyKey: "G",
        entry: entry("A", "m"),
        limit: 5,
      });
      clearPendingHistory({ historyMap: map, historyKey: "G", limit: 5 });
      expect(map.get("G")).toStrictEqual([]);
    });

    it("no-ops when disabled", () => {
      const map = makeMap();
      map.set("G", [entry("A", "m")]);
      clearPendingHistory({ historyMap: map, historyKey: "G", limit: 0 });
      expect(map.get("G")).toHaveLength(1);
    });
  });
});
