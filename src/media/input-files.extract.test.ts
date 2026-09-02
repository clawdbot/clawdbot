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

  it.each([
    'text/plain; charset="windows-1252"',
    'Text/Plain; Charset="WINDOWS-1252"',
    'text/plain; charset="windows\\-1252"',
    'text/plain; note="a;charset=utf-8;b"; charset=windows-1252',
    "text/plain; charset=windows-1252; charset=utf-8",
    'text/plain; charset="windows-1252"; charset=utf-8',
    "text/plain; charset=; charset=windows-1252",
    "text/plain; charset= windows-1252",
  ])("decodes declared text bytes using %s", async (mediaType) => {
    const result = await extractFileContentFromSource({
      source: {
        type: "base64",
        data: Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80]).toString("base64"),
        mediaType,
      },
      limits: resolveInputFileLimits(),
    });

    expect(result.text).toBe("café €");
  });

  it.each([
    "text/plain",
    'text/plain; charset="utf-8"',
    "text/plain; charset=not-an-encoding; charset=windows-1252",
    'text/plain; charset=""; charset=windows-1252',
    "text/plain; charset =windows-1252",
  ])("keeps UTF-8 decoding for %s", async (mediaType) => {
    const result = await extractFileContentFromSource({
      source: { type: "base64", data: Buffer.from("café €").toString("base64"), mediaType },
      limits: resolveInputFileLimits(),
    });

    expect(result.text).toBe("café €");
  });

  it("keeps byte-detected UTF-16 ahead of a declared charset", async () => {
    const result = await extractFileContentFromSource({
      source: {
        type: "base64",
        data: Buffer.from("\ufeffcafé €", "utf16le").toString("base64"),
        mediaType: 'text/plain; charset="windows-1252"',
      },
      limits: resolveInputFileLimits(),
    });

    expect(result.text).toBe("café €");
  });

  it("keeps configured MIME synonyms while parsing charset parameters", async () => {
    const result = await extractFileContentFromSource({
      source: {
        type: "base64",
        data: Buffer.from("name: café").toString("base64"),
        mediaType: 'text/yaml; charset="utf-8"',
      },
      limits: resolveInputFileLimits({ allowedMimes: ["application/yaml"] }),
    });

    expect(result.text).toBe("name: café");
  });

  it.each([
    ['text/plain; charset="windows-1252', "café €"],
    ['text/plain; note="a; charset=windows-1252', "caf\uFFFD \uFFFD"],
    ["plain; charset=windows-1252", "caf\uFFFD \uFFFD"],
  ])("uses MIME parser recovery without changing admission for %s", async (mediaType, text) => {
    const result = await extractFileContentFromSource({
      source: {
        type: "base64",
        data: Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80]).toString("base64"),
        mediaType,
      },
      limits: resolveInputFileLimits(),
    });

    expect(result.text).toBe(text);
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
