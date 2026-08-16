// Attachment path normalization tests cover file URL host checks and Windows
// network path rejection.
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  normalizeAttachmentPath,
  normalizeAttachments,
  resolveAttachmentKind,
} from "./attachments.normalize.js";

describe("normalizeAttachmentPath", () => {
  it("allows localhost file URLs", () => {
    const localPath = path.join(os.tmpdir(), "photo.png");
    const fileUrl = pathToFileURL(localPath);
    fileUrl.hostname = "localhost";

    expect(normalizeAttachmentPath(fileUrl.href)).toBe(localPath);
  });

  it("recognizes file URL schemes case-insensitively", () => {
    const localPath = path.join(os.tmpdir(), "photo with space.png");
    const fileUrl = pathToFileURL(localPath).href.replace(/^file:/u, "FILE:");

    expect(normalizeAttachmentPath(fileUrl)).toBe(localPath);
  });

  it("rejects remote-host file URLs", () => {
    expect(normalizeAttachmentPath("file://attacker/share/photo.png")).toBeUndefined();
    expect(normalizeAttachmentPath("FILE://attacker/share/photo.png")).toBeUndefined();
  });

  it("rejects Windows network paths", () => {
    withMockedPlatform("win32", () => {
      expect(normalizeAttachmentPath("\\\\attacker\\share\\photo.png")).toBeUndefined();
    });
  });
});

describe("normalizeAttachments", () => {
  it("preserves original fact indexes when empty slots are not materializable", () => {
    expect(
      normalizeAttachments({
        media: [
          {},
          { path: "/tmp/voice.ogg", contentType: "audio/ogg" },
          { url: "https://example.test/photo.jpg", contentType: "image/jpeg" },
        ],
      }).map((attachment) => attachment.index),
    ).toEqual([1, 2]);
  });

  it("normalizes ordered facts", () => {
    expect(
      normalizeAttachments({
        media: [
          { path: " /tmp/voice.ogg ", contentType: " audio/ogg ", transcribed: true },
          { url: "https://example.test/photo.jpg", kind: "image" },
        ],
      }),
    ).toEqual([
      {
        path: "/tmp/voice.ogg",
        url: undefined,
        mime: "audio/ogg",
        kind: "audio",
        index: 0,
        alreadyTranscribed: true,
      },
      {
        path: undefined,
        url: "https://example.test/photo.jpg",
        mime: undefined,
        kind: "image",
        index: 1,
        alreadyTranscribed: false,
      },
    ]);
  });

  it("uses staged fact paths at the attachment consumer", () => {
    expect(
      normalizeAttachments({
        media: [
          {
            path: "/tmp/staged/voice.ogg",
            url: "/tmp/staged/voice.ogg",
            contentType: "audio/ogg",
            workspaceDir: "/tmp/staged",
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        path: "/tmp/staged/voice.ogg",
        url: "/tmp/staged/voice.ogg",
        workspaceDir: "/tmp/staged",
      }),
    ]);
  });

  it("preserves authoritative media kinds without inventing MIME metadata", () => {
    expect(
      normalizeAttachments({
        media: [{ url: "https://cdn.example.test/download?token=fixture", kind: "image" }],
      }),
    ).toEqual([
      {
        path: undefined,
        url: "https://cdn.example.test/download?token=fixture",
        mime: undefined,
        kind: "image",
        index: 0,
        alreadyTranscribed: false,
      },
    ]);
  });

  it("distinguishes an explicit document from generic binary MIME inference", () => {
    const attachments = normalizeAttachments({
      media: [
        { path: "/tmp/upload.avif", contentType: "application/octet-stream" },
        {
          path: "/tmp/report.png",
          contentType: "application/octet-stream",
          kind: "document",
        },
      ],
    });

    expect(attachments.map(({ kind }) => kind)).toEqual([undefined, "document"]);
    expect(attachments.map(resolveAttachmentKind)).toEqual(["image", "unknown"]);
  });

  it("omits optional attachment fields when canonical facts do not declare them", () => {
    const [attachment] = normalizeAttachments({
      media: [{ path: "/tmp/photo.png", contentType: "application/octet-stream" }],
    });

    expect(attachment).toEqual({
      path: "/tmp/photo.png",
      url: undefined,
      mime: "application/octet-stream",
      index: 0,
      alreadyTranscribed: false,
    });
  });
});

describe("resolveAttachmentKind", () => {
  it.each([
    { source: "/tmp/photo.avif", expected: "image" },
    { source: "/tmp/photo.HEIC", expected: "image" },
    { source: "/tmp/photo.heif", expected: "image" },
    { source: "/tmp/scan.tif", expected: "image" },
    { source: "/tmp/scan.TIFF", expected: "image" },
    { source: "/tmp/clip.flv", expected: "video" },
    { source: "/tmp/clip.m4v", expected: "video" },
    { source: "/tmp/clip.wmv", expected: "video" },
    { source: "/tmp/voice.aiff", expected: "audio" },
    { source: "https://cdn.example.test/photo%2EHEIC?download=1", expected: "image" },
  ] as const)(
    "classifies $source as $expected from canonical media metadata",
    ({ source, expected }) => {
      expect(resolveAttachmentKind({ path: source, index: 0 })).toBe(expected);
    },
  );

  it.each(["image", "audio", "video"] as const)(
    "preserves an authoritative %s kind for an extensionless URL",
    (kind) => {
      expect(
        resolveAttachmentKind({ url: "https://cdn.example.test/download", kind, index: 0 }),
      ).toBe(kind);
    },
  );

  it.each([
    { mime: undefined, expected: "image" },
    { mime: "image/webp", expected: "image" },
    { mime: "audio/ogg", expected: "image" },
  ] as const)(
    "treats sticker facts as authoritative image media with MIME $mime",
    ({ mime, expected }) => {
      expect(
        resolveAttachmentKind({
          url: "https://cdn.example.test/sticker",
          kind: "sticker",
          mime,
          index: 0,
        }),
      ).toBe(expected);
    },
  );

  it("does not let the unknown category mask a concrete audio MIME", () => {
    expect(
      resolveAttachmentKind({
        url: "https://cdn.example.test/download",
        kind: "unknown",
        mime: "audio/ogg",
        index: 0,
      }),
    ).toBe("audio");
  });

  it.each([
    { source: "/tmp/report.png", mime: undefined },
    { source: "/tmp/report.png", mime: "application/pdf" },
    { source: "/tmp/report.png", mime: "application/octet-stream" },
    { source: "/tmp/report.png", mime: "image/png" },
    { source: "/tmp/report.ogg", mime: "audio/ogg" },
    { source: "/tmp/report.mp4", mime: "video/mp4" },
    { source: "/tmp/report.tiff", mime: undefined },
  ])("keeps explicit documents authoritative for $source and MIME $mime", ({ source, mime }) => {
    expect(resolveAttachmentKind({ path: source, kind: "document", mime, index: 0 })).toBe(
      "unknown",
    );
  });

  it.each([undefined, "application/octet-stream"] as const)(
    "infers an unknown-kind image from its canonical filename with MIME %s",
    (mime) => {
      expect(
        resolveAttachmentKind({ path: "/tmp/upload.png", kind: "unknown", mime, index: 0 }),
      ).toBe("image");
    },
  );

  it.each(["application/pdf", "application/zip", "text/plain", "application/json"] as const)(
    "never infers an image over authoritative non-image MIME %s",
    (mime) => {
      expect(
        resolveAttachmentKind({ path: "/tmp/report.png", kind: "unknown", mime, index: 0 }),
      ).toBe("unknown");
      expect(resolveAttachmentKind({ path: "/tmp/report.png", mime, index: 0 })).toBe("unknown");
    },
  );

  it("prefers the authoritative kind over conflicting MIME and filename hints", () => {
    expect(
      resolveAttachmentKind({
        path: "/tmp/video.mp4",
        mime: "video/mp4",
        kind: "image",
        index: 0,
      }),
    ).toBe("image");
  });

  it("preserves explicit MIME precedence over a conflicting filename", () => {
    expect(resolveAttachmentKind({ path: "/tmp/video.mp4", mime: "image/heic", index: 0 })).toBe(
      "image",
    );
  });

  it("keeps filename-only SVG out of raster image understanding", () => {
    expect(resolveAttachmentKind({ path: "/tmp/diagram.svg", index: 0 })).toBe("unknown");
  });

  it("preserves explicitly identified SVG images", () => {
    expect(
      resolveAttachmentKind({ path: "/tmp/diagram.svg", mime: "image/svg+xml", index: 0 }),
    ).toBe("image");
  });

  it("falls back to canonical filename metadata when the declared MIME is not media", () => {
    expect(
      resolveAttachmentKind({
        path: "/tmp/photo.avif",
        mime: "application/octet-stream",
        index: 0,
      }),
    ).toBe("image");
  });
});
