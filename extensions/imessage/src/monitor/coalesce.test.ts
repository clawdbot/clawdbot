import { describe, expect, it } from "vitest";
import {
  combineIMessagePayloads,
  MAX_COALESCED_ATTACHMENTS,
  MAX_COALESCED_ENTRIES,
  MAX_COALESCED_TEXT_CHARS,
} from "./coalesce.js";
import type { IMessagePayload } from "./types.js";

const makePayload = (overrides: Partial<IMessagePayload> = {}): IMessagePayload => ({
  guid: `msg-${Math.random().toString(36).slice(2, 10)}`,
  chat_id: 1,
  sender: "+15555550100",
  is_from_me: false,
  is_group: false,
  text: null,
  attachments: null,
  created_at: new Date(2025, 0, 1).toISOString(),
  ...overrides,
});

describe("combineIMessagePayloads", () => {
  it("throws on empty input", () => {
    expect(() => combineIMessagePayloads([])).toThrow(
      "combineIMessagePayloads: cannot combine empty payloads",
    );
  });

  it("returns the lone payload unchanged when only one entry", () => {
    const payload = makePayload({ text: "alone", guid: "solo" });
    const result = combineIMessagePayloads([payload]);
    expect(result).toBe(payload);
    expect(result.guid).toBe("solo");
  });

  it("merges Dump + URL split-send into one payload anchored on the first GUID", () => {
    const text = makePayload({ text: "Dump", guid: "row-1", created_at: "2025-01-01T00:00:00Z" });
    const balloon = makePayload({
      text: "https://example.com/article",
      guid: "row-2",
      created_at: "2025-01-01T00:00:01.500Z",
    });
    const merged = combineIMessagePayloads([text, balloon]);

    expect(merged.text).toBe("Dump https://example.com/article");
    expect(merged.guid).toBe("row-1");
    expect(merged.created_at).toBe("2025-01-01T00:00:01.500Z");
    expect(merged.coalescedMessageGuids).toEqual(["row-1", "row-2"]);
  });

  it("preserves attachments instead of dropping them on merge", () => {
    const text = makePayload({ text: "Save", guid: "row-1" });
    const image = makePayload({
      text: "caption",
      guid: "row-2",
      attachments: [{ original_path: "/tmp/a.jpg", mime_type: "image/jpeg" }],
    });
    const merged = combineIMessagePayloads([text, image]);

    expect(merged.attachments).toEqual([{ original_path: "/tmp/a.jpg", mime_type: "image/jpeg" }]);
  });

  it("dedupes identical text appearing in both rows (URL in text and balloon)", () => {
    const a = makePayload({ text: "https://example.com", guid: "row-1" });
    const b = makePayload({ text: "https://example.com", guid: "row-2" });
    const merged = combineIMessagePayloads([a, b]);

    expect(merged.text).toBe("https://example.com");
    expect(merged.coalescedMessageGuids).toEqual(["row-1", "row-2"]);
  });

  it("caps merged text length and appends the truncated marker", () => {
    const longA = makePayload({ text: "A".repeat(3000), guid: "row-1" });
    const longB = makePayload({ text: "B".repeat(3000), guid: "row-2" });
    const merged = combineIMessagePayloads([longA, longB]);

    expect(merged.text?.endsWith("…[truncated]")).toBe(true);
    expect(merged.text?.length).toBeLessThanOrEqual(
      MAX_COALESCED_TEXT_CHARS + "…[truncated]".length,
    );
  });

  it("caps the attachment count", () => {
    // 5 attachments per row × 6 rows = 30 attachments offered, capped at 20.
    // Stays under the entry cap so the merge isn't pruned for that reason.
    const payloads = Array.from({ length: 6 }, (_, i) =>
      makePayload({
        guid: `row-${i}`,
        attachments: Array.from({ length: 5 }, (_, j) => ({
          original_path: `/tmp/${i}-${j}.jpg`,
          mime_type: "image/jpeg",
        })),
      }),
    );
    const merged = combineIMessagePayloads(payloads);

    expect(merged.attachments?.length).toBe(MAX_COALESCED_ATTACHMENTS);
  });

  it("keeps first + most recent when entry count exceeds the cap, but tracks every GUID", () => {
    const payloads = Array.from({ length: 25 }, (_, i) =>
      makePayload({ text: `msg ${i}`, guid: `row-${i}` }),
    );
    const merged = combineIMessagePayloads(payloads);

    // First payload's GUID anchors the merged shape.
    expect(merged.guid).toBe("row-0");
    // Every source GUID is tracked, even those whose text was dropped by the cap.
    expect(merged.coalescedMessageGuids?.length).toBe(25);
    expect(merged.coalescedMessageGuids?.[0]).toBe("row-0");
    expect(merged.coalescedMessageGuids?.[24]).toBe("row-24");
    // Merged text contains only first MAX_COALESCED_ENTRIES-1 entries plus the latest.
    expect(merged.text).toContain("msg 0");
    expect(merged.text).toContain("msg 24");
    expect(merged.text).not.toContain("msg 10"); // dropped by cap
  });

  it("preserves reply context from any entry that carries one", () => {
    const noReply = makePayload({ text: "hello", guid: "row-1" });
    const reply = makePayload({
      text: "follow-up",
      guid: "row-2",
      reply_to_id: "parent-msg",
      reply_to_text: "earlier",
      reply_to_sender: "+15555550199",
    });
    const merged = combineIMessagePayloads([noReply, reply]);

    expect(merged.reply_to_id).toBe("parent-msg");
    expect(merged.reply_to_text).toBe("earlier");
    expect(merged.reply_to_sender).toBe("+15555550199");
  });

  it("does not set coalescedMessageGuids when no entry carries a GUID", () => {
    const a = makePayload({ text: "a", guid: null });
    const b = makePayload({ text: "b", guid: null });
    const merged = combineIMessagePayloads([a, b]);

    expect(merged.coalescedMessageGuids).toBeUndefined();
  });

  it("respects the documented entry cap value", () => {
    expect(MAX_COALESCED_ENTRIES).toBeGreaterThan(1);
  });
});
