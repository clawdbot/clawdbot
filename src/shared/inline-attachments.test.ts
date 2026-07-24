import { describe, expect, it } from "vitest";
import {
  DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS,
  MAX_INLINE_ATTACHMENT_BASENAME_BYTES,
  prepareInlineAttachmentSnapshots,
} from "./inline-attachments.js";

describe("inline attachment snapshots", () => {
  it("rejects portable manifest aliases and overlong UTF-8 basenames", () => {
    for (const name of [
      ".MANIFEST.JSON",
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
  });
});
