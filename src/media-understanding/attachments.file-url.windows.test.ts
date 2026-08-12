import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { MediaAttachmentCache } from "./attachments.js";
import { normalizeAttachmentPath } from "./attachments.normalize.js";

describe.runIf(process.platform === "win32")("media attachment Windows file URLs", () => {
  it("reads a single-slash uppercase file URL through the attachment cache", async () => {
    await withTempDir({ prefix: "openclaw-media-file-url-" }, async (base) => {
      const filePath = path.join(base, "café photo.png");
      const contents = Buffer.from("media-understanding-file-url");
      await fs.writeFile(filePath, contents);
      const fileUrl = pathToFileURL(filePath).href.replace(/^file:\/\//u, "FILE:");
      const cache = new MediaAttachmentCache([{ index: 0, path: fileUrl }], {
        includeDefaultLocalPathRoots: false,
        localPathRoots: [base],
      });

      const result = await cache.getBuffer({
        attachmentIndex: 0,
        maxBytes: 1024,
        timeoutMs: 1000,
      });

      expect(result.buffer).toEqual(contents);
      expect(result.fileName).toBe("café photo.png");
    });
  });

  it.each([
    "FILE://attacker/share/photo.png",
    "FILE:///C:/safe%2Fescape/photo.png",
    "FILE:///C:/safe%5Cescape/photo.png",
    "FILE:////attacker/share/photo.png",
  ])("rejects unsafe uppercase file URL %s", (fileUrl) => {
    expect(normalizeAttachmentPath(fileUrl)).toBeUndefined();
  });
});
