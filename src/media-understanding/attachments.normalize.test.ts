// Attachment path normalization tests cover file URL host checks and Windows
// network path rejection.
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { normalizeAttachmentPath, normalizeAttachments } from "./attachments.normalize.js";

describe("normalizeAttachmentPath", () => {
  it("allows localhost file URLs", () => {
    const localPath = path.join(os.tmpdir(), "photo.png");
    const fileUrl = pathToFileURL(localPath);
    fileUrl.hostname = "localhost";

    expect(normalizeAttachmentPath(fileUrl.href)).toBe(localPath);
  });

  it("rejects remote-host file URLs", () => {
    expect(normalizeAttachmentPath("file://attacker/share/photo.png")).toBeUndefined();
  });

  it("rejects Windows network paths", () => {
    withMockedPlatform("win32", () => {
      expect(normalizeAttachmentPath("\\\\attacker\\share\\photo.png")).toBeUndefined();
    });
  });
});

describe("normalizeAttachments", () => {
  it("prefers ordered facts over conflicting legacy projections", () => {
    expect(
      normalizeAttachments({
        media: [
          { path: " /tmp/voice.ogg ", contentType: " audio/ogg ", transcribed: true },
          { url: "https://example.test/photo.jpg", kind: "image" },
        ],
        MediaPaths: ["/tmp/stale.bin"],
        MediaTypes: ["application/octet-stream"],
      }),
    ).toEqual([
      {
        path: "/tmp/voice.ogg",
        url: undefined,
        mime: "audio/ogg",
        index: 0,
        alreadyTranscribed: true,
      },
      {
        path: undefined,
        url: "https://example.test/photo.jpg",
        mime: "image",
        index: 1,
        alreadyTranscribed: false,
      },
    ]);
  });

  it("uses explicitly staged compatibility paths at the attachment consumer", () => {
    expect(
      normalizeAttachments({
        media: [{ path: "/remote/voice.ogg", contentType: "audio/ogg" }],
        MediaStaged: true,
        MediaPath: "/tmp/staged/voice.ogg",
        MediaPaths: ["/tmp/staged/voice.ogg"],
        MediaUrl: "/tmp/staged/voice.ogg",
        MediaUrls: ["/tmp/staged/voice.ogg"],
      }),
    ).toEqual([
      expect.objectContaining({
        path: "/tmp/staged/voice.ogg",
        url: "/tmp/staged/voice.ogg",
      }),
    ]);
  });
});
