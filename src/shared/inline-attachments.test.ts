import { describe, expect, it } from "vitest";
import {
  DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS,
  MAX_INLINE_ATTACHMENT_BASENAME_BYTES,
  prepareInlineAttachmentSnapshots,
} from "./inline-attachments.js";

describe("inline attachment snapshots", () => {
  it("rejects portable manifest aliases, trailing Windows aliases, and overlong UTF-8 basenames", () => {
    for (const name of [
      ".MANIFEST.JSON",
      ".manifest.json.",
      "handoff.txt ",
      " foo.txt",
      ".manifest.json\u00A0",
      "é".repeat(Math.floor(MAX_INLINE_ATTACHMENT_BASENAME_BYTES / 2) + 1),
    ]) {
      expect(() =>
        prepareInlineAttachmentSnapshots({
          attachments: [{ name, content: "snapshot" }],
          limits: DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS,
        }),
      ).toThrow("attachments_invalid_name");
    }
  });

  it("rejects normalized and case-folded filename collisions", () => {
    expect(() =>
      prepareInlineAttachmentSnapshots({
        attachments: [
          { name: "Café.txt", content: "first" },
          { name: "cafe\u0301.TXT", content: "second" },
        ],
        limits: DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS,
      }),
    ).toThrow("attachments_duplicate_name");

    expect(() =>
      prepareInlineAttachmentSnapshots({
        attachments: [
          { name: "Σ.txt", content: "first" },
          { name: "ς.txt", content: "second" },
        ],
        limits: DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS,
      }),
    ).toThrow("attachments_duplicate_name");
  });

  it("rejects names that Node filesystem encoding would alias or Windows cannot represent", () => {
    for (const name of [
      "\uD800",
      "\uD801",
      "\uFFFD",
      "CON.txt",
      "CON .txt",
      "CONIN$.txt",
      "CONOUT$.txt",
      "PRN.txt",
      "AUX.txt",
      "NUL.txt",
      "COM1.txt",
      "LPT9.txt",
      "report?.txt",
    ]) {
      expect(() =>
        prepareInlineAttachmentSnapshots({
          attachments: [{ name, content: "snapshot" }],
          limits: DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS,
        }),
      ).toThrow("attachments_invalid_name");
    }
  });

  it("permits percent and exclamation attachment names", () => {
    const prepared = prepareInlineAttachmentSnapshots({
      attachments: [
        { name: "100%.txt", content: "percent" },
        { name: "wow!.txt", content: "exclamation" },
      ],
      limits: DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS,
    });
    expect(prepared.attachments.map((attachment) => attachment.name)).toEqual([
      "100%.txt",
      "wow!.txt",
    ]);
  });
});
