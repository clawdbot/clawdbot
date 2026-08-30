// Regression: input_file callers declare their MIME; a cosmetic filename must
// not reroute classification past an operator-configured allowlist.
import { classifyAttachmentBytes } from "@openclaw/media-core/attachment-classify";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INPUT_IMAGE_MIMES,
  extractFileContentFromSource,
  extractImageContentFromSource,
  resolveInputFileLimits,
} from "./input-files.js";

describe("extractFileContentFromSource", () => {
  const avi = Buffer.from("524946463800000041564920" + "00".repeat(52), "hex");
  const aviSource = { type: "base64", data: avi.toString("base64"), filename: "clip.avi" } as const;

  it.each([
    { allowedMimes: ["video/x-msvideo"] },
    { allowedMimes: ["video/vnd.avi"] },
    { allowedMimes: [" VIDEO/VND.AVI; codec=DIVX "] },
    { allowedMimes: ["video/x-msvideo", "video/vnd.avi"] },
  ])(
    "matches actual AVI bytes to equivalent configured MIME values $allowedMimes",
    async ({ allowedMimes }) => {
      const classification = await classifyAttachmentBytes({ buffer: avi, name: "clip.avi" });
      expect(classification).toEqual({ mime: "video/x-msvideo", class: "video" });
      const limits = resolveInputFileLimits({ allowedMimes });
      expect(limits.allowedMimes).toEqual(new Set(["video/x-msvideo"]));

      await expect(
        extractFileContentFromSource({ source: aviSource, limits }),
      ).resolves.toMatchObject({
        filename: "clip.avi",
      });
    },
  );

  it("keeps actual AVI bytes outside the default text/PDF allowlist", async () => {
    await expect(
      extractFileContentFromSource({ source: aviSource, limits: resolveInputFileLimits() }),
    ).rejects.toThrow(/Unsupported file MIME type/);
  });

  it("rejects actual AVI bytes declared as an image under the default image allowlist", async () => {
    await expect(
      extractImageContentFromSource(
        { ...aviSource, mediaType: "image/jpeg" },
        {
          allowUrl: false,
          allowedMimes: new Set(DEFAULT_INPUT_IMAGE_MIMES),
          maxBytes: 1024,
          maxRedirects: 0,
          timeoutMs: 1000,
        },
      ),
    ).rejects.toThrow(/Unsupported image MIME type: video\//);
  });

  it("keeps the declared MIME when the filename suggests plain text", async () => {
    const payload = JSON.stringify({ report: "q3", revenue: 12345 });
    const limits = resolveInputFileLimits({ allowedMimes: ["application/json"] });

    const result = await extractFileContentFromSource({
      source: {
        type: "base64",
        data: Buffer.from(payload, "utf8").toString("base64"),
        mediaType: "application/json",
        filename: "notes.txt",
      },
      limits,
    });

    expect(result.text).toContain('"revenue"');
  });
});
