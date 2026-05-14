import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stageIMessageAttachments } from "./media-staging.js";

let tempDir: string;

async function writeTempFile(name: string, contents: Buffer | string): Promise<string> {
  const filePath = path.join(tempDir, name);
  await fs.writeFile(filePath, contents);
  return filePath;
}

describe("stageIMessageAttachments", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-media-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("copies allowed iMessage attachments into the inbound media store", async () => {
    const sourcePath = await writeTempFile("photo.png", Buffer.from("png-bytes"));
    const saveMediaBuffer = vi.fn(async () => ({
      id: "saved.png",
      path: "/state/media/inbound/saved.png",
      size: 9,
      contentType: "image/png",
    }));

    await expect(
      stageIMessageAttachments(
        [{ original_path: sourcePath, mime_type: "image/png", missing: false }],
        { maxBytes: 1024, allowedRoots: [tempDir], deps: { saveMediaBuffer } },
      ),
    ).resolves.toEqual([{ path: "/state/media/inbound/saved.png", contentType: "image/png" }]);

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      Buffer.from("png-bytes"),
      "image/png",
      "inbound",
      1024,
      "photo.png",
    );
  });

  it("drops attachments whose canonical path escapes the allowed root", async () => {
    const allowedRoot = path.join(tempDir, "allowed");
    const outsideRoot = path.join(tempDir, "outside");
    await fs.mkdir(allowedRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    const outsidePath = path.join(outsideRoot, "secret.png");
    await fs.writeFile(outsidePath, Buffer.from("secret-bytes"));
    await fs.symlink(outsideRoot, path.join(allowedRoot, "link"), "dir");

    const saveMediaBuffer = vi.fn();
    const logVerbose = vi.fn();

    await expect(
      stageIMessageAttachments(
        [
          {
            original_path: path.join(allowedRoot, "link", "secret.png"),
            mime_type: "image/png",
            missing: false,
          },
        ],
        { maxBytes: 1024, allowedRoots: [allowedRoot], deps: { saveMediaBuffer, logVerbose } },
      ),
    ).resolves.toEqual([]);

    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(logVerbose).toHaveBeenCalledWith(
      expect.stringContaining("attachment path resolves outside allowed roots"),
    );
  });

  it("converts HEIC iMessage attachments to JPEG before staging", async () => {
    const sourcePath = await writeTempFile("IMG_0001.HEIC", Buffer.from("heic-bytes"));
    const saveMediaBuffer = vi.fn(async () => ({
      id: "saved.jpg",
      path: "/state/media/inbound/saved.jpg",
      size: 10,
      contentType: "image/jpeg",
    }));
    const convertHeicToJpeg = vi.fn(async () => Buffer.from("jpeg-bytes"));

    await stageIMessageAttachments(
      [{ original_path: sourcePath, mime_type: "image/heic", missing: false }],
      { maxBytes: 1024, deps: { saveMediaBuffer, convertHeicToJpeg } },
    );

    expect(convertHeicToJpeg).toHaveBeenCalledWith(sourcePath, 1024);
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      Buffer.from("jpeg-bytes"),
      "image/jpeg",
      "inbound",
      1024,
      "IMG_0001.jpg",
    );
  });

  it("drops attachments over the inbound media limit", async () => {
    const sourcePath = await writeTempFile("huge.png", Buffer.from("too large"));
    const saveMediaBuffer = vi.fn();
    const logVerbose = vi.fn();

    await expect(
      stageIMessageAttachments(
        [{ original_path: sourcePath, mime_type: "image/png", missing: false }],
        { maxBytes: 4, deps: { saveMediaBuffer, logVerbose } },
      ),
    ).resolves.toEqual([]);

    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(logVerbose).toHaveBeenCalledWith(expect.stringContaining("failed to stage"));
  });
});
