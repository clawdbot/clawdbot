// Regression: input_file callers declare their MIME; a cosmetic filename must
// not reroute classification past an operator-configured allowlist.
import { classifyAttachmentBytes } from "@openclaw/media-core/attachment-classify";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INPUT_IMAGE_MIMES,
  extractFileContentFromBuffer,
  extractFileContentFromSource,
  extractImageContentFromSource,
  resolveInputFileLimits,
} from "./input-files.js";

describe("extractFileContentFromSource", () => {
  it("preserves the encoding used to recognize otherwise untyped text", async () => {
    const text = "Café notes: résumé et météo pour demain.";
    const result = await extractFileContentFromSource({
      source: { type: "base64", data: Buffer.from(text, "latin1").toString("base64") },
      limits: resolveInputFileLimits(),
    });

    expect(result.text).toBe(text);
  });

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
    ["plain; charset=windows-1252", "café €"],
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

describe("file text output limits", () => {
  const unicodeText = `\ufeff${"é".repeat(8190)}🙂\ufefftail`;
  const asciiPrefix = Buffer.alloc(16_383, "a");
  it.each([
    { name: "UTF-8 Unicode and BOMs", charset: "utf-8", buffer: Buffer.from(unicodeText) },
    {
      name: "UTF-16LE Unicode and BOMs",
      charset: "utf-16le",
      buffer: Buffer.from(unicodeText, "utf16le"),
    },
    {
      name: "UTF-16BE Unicode and BOMs",
      charset: "utf-16be",
      buffer: Buffer.from(unicodeText, "utf16le").swap16(),
    },
    {
      name: "Windows-1252",
      charset: "windows-1252",
      buffer: Buffer.concat([asciiPrefix, Buffer.from([0x80, 0x21])]),
    },
    {
      name: "unsupported charset fallback",
      charset: "unsupported-encoding",
      buffer: Buffer.from(unicodeText),
      fallback: "utf-8",
    },
    {
      name: "incomplete UTF-8 at EOF",
      charset: "utf-8",
      buffer: Buffer.concat([asciiPrefix, Buffer.from([0xf0, 0x9f])]),
    },
    {
      name: "ISO-2022-JP shift state",
      charset: "iso-2022-jp",
      buffer: Buffer.concat([
        Buffer.alloc(16_382, "a"),
        Buffer.from([0x1b, 0x24, 0x42, 0x24, 0x22, 0x1b, 0x28, 0x42]),
      ]),
    },
    {
      name: "incomplete ISO-2022-JP escape at EOF",
      charset: "iso-2022-jp",
      buffer: Buffer.concat([asciiPrefix, Buffer.from([0x1b, 0x28])]),
    },
  ])("preserves full-decoding prefixes for $name", async ({ charset, buffer, fallback }) => {
    const decoded = new TextDecoder(fallback ?? charset).decode(buffer);
    for (const maxChars of [0, 1, 8191, 8192, 16_384.9, Infinity]) {
      const result = await extractFileContentFromBuffer({
        buffer,
        charset,
        classification: { class: "text", mime: "text/plain" },
        limits: resolveInputFileLimits({ maxChars }),
      });
      expect(result.text, `maxChars=${maxChars}`).toBe(truncateUtf16Safe(decoded, maxChars));
    }
  });
});
