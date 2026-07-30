import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS,
  MAX_INLINE_ATTACHMENT_BASENAME_BYTES,
  MAX_INLINE_ATTACHMENT_MIME_TYPE_BYTES,
  MAX_INLINE_ATTACHMENT_MOUNT_PATH_BYTES,
  parseInlineAttachmentMountPath,
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
          { name: "ΐ.txt", content: "first" },
          { name: "Ϊ́.txt", content: "second" },
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
      "CLOCK$",
      "CLOCK$.txt",
      "CLOCK$ .txt",
      "clock$.TXT",
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

  it("accepts only canonical base64 with exact decoded-size accounting", () => {
    for (const content of ["Z g==", "Zg==\n", "Zh==", "Zg="]) {
      expect(() =>
        prepareInlineAttachmentSnapshots({
          attachments: [{ name: "snapshot.bin", content, encoding: "base64" }],
          limits: DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS,
        }),
      ).toThrow("attachments_invalid_base64_or_too_large");
    }

    const bytes = Buffer.alloc(DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS.maxFileBytes, 0x61);
    const prepared = prepareInlineAttachmentSnapshots({
      attachments: [
        {
          name: "snapshot.bin",
          content: bytes.toString("base64"),
          encoding: "base64",
          mimeType: "m".repeat(MAX_INLINE_ATTACHMENT_MIME_TYPE_BYTES),
        },
      ],
      limits: DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS,
    });
    expect(prepared.totalBytes).toBe(bytes.length);
  });

  it("bounds raw MIME metadata and mount-path representations", () => {
    for (const [mimeType, expected] of [
      [
        ` ${"m".repeat(MAX_INLINE_ATTACHMENT_MIME_TYPE_BYTES - 1)}`,
        "attachments_invalid_member (attachmentIndex=0 reason=mime_type_whitespace)",
      ],
      [
        `${"m".repeat(MAX_INLINE_ATTACHMENT_MIME_TYPE_BYTES - 1)} `,
        "attachments_invalid_member (attachmentIndex=0 reason=mime_type_whitespace)",
      ],
      [
        "text/\u0001plain",
        "attachments_invalid_member (attachmentIndex=0 reason=mime_type_control_characters)",
      ],
      [
        "text/\uD800plain",
        "attachments_invalid_member (attachmentIndex=0 reason=mime_type_invalid_unicode)",
      ],
      [
        "m".repeat(MAX_INLINE_ATTACHMENT_MIME_TYPE_BYTES + 1),
        "attachments_invalid_member (attachmentIndex=0 reason=mime_type_too_long maxMimeTypeBytes=256)",
      ],
    ] as const) {
      expect(() =>
        prepareInlineAttachmentSnapshots({
          attachments: [{ name: "snapshot.bin", content: "x", mimeType }],
          limits: DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS,
        }),
      ).toThrow(expected);
    }

    expect(
      parseInlineAttachmentMountPath("a".repeat(MAX_INLINE_ATTACHMENT_MOUNT_PATH_BYTES)),
    ).toEqual({ status: "valid", mountPath: "a".repeat(MAX_INLINE_ATTACHMENT_MOUNT_PATH_BYTES) });
    expect(
      parseInlineAttachmentMountPath("a".repeat(MAX_INLINE_ATTACHMENT_MOUNT_PATH_BYTES + 1)),
    ).toEqual({ status: "invalid", reason: "too_long" });
    expect(parseInlineAttachmentMountPath("unsafe\npath")).toEqual({
      status: "invalid",
      reason: "unsupported_characters",
    });
  });

  it("measures UTF-8 snapshots before allocating rejected file or total bytes", () => {
    const limits = { maxFiles: 2, maxFileBytes: 4, maxTotalBytes: 5 };
    const from = vi.spyOn(Buffer, "from");
    try {
      expect(() =>
        prepareInlineAttachmentSnapshots({
          attachments: [{ name: "too-large.txt", content: "ééé" }],
          limits,
        }),
      ).toThrow("attachments_file_bytes_exceeded");
      expect(from).not.toHaveBeenCalled();

      expect(() =>
        prepareInlineAttachmentSnapshots({
          attachments: [
            { name: "first.txt", content: "abc" },
            { name: "second.txt", content: "abc" },
          ],
          limits,
        }),
      ).toThrow("attachments_total_bytes_exceeded");
      expect(from).toHaveBeenCalledTimes(1);
    } finally {
      from.mockRestore();
    }
  });

  it("rejects ill-formed UTF-16 content before byte measurement or allocation", () => {
    for (const content of ["\uD800", "\uDC00"]) {
      expect(() =>
        prepareInlineAttachmentSnapshots({
          attachments: [{ name: "snapshot.txt", content }],
          limits: DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS,
        }),
      ).toThrow("attachments_invalid_content (attachmentIndex=0 reason=invalid_unicode)");
    }

    const prepared = prepareInlineAttachmentSnapshots({
      attachments: [{ name: "supplementary.txt", content: "A😀B" }],
      limits: DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS,
    });
    expect(prepared.attachments[0]?.bytes).toBe(Buffer.byteLength("A😀B", "utf8"));
  });
});
