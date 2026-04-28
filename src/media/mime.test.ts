import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { mediaKindFromMime } from "./constants.js";
import {
  detectMime,
  extensionForMime,
  FILE_TYPE_SNIFF_MAX_BYTES,
  imageMimeFromFormat,
  isAudioFileName,
  kindFromMime,
  normalizeMimeType,
  sliceMimeSniffBuffer,
} from "./mime.js";

async function makeOoxmlZip(opts: { mainMime: string; partPath: string }): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<Types><Override PartName="${opts.partPath}" ContentType="${opts.mainMime}.main+xml"/></Types>`,
  );
  zip.file(opts.partPath.slice(1), "<xml/>");
  return await zip.generateAsync({ type: "nodebuffer" });
}

describe("mime detection", () => {
  async function expectDetectedMime(params: {
    input: Parameters<typeof detectMime>[0];
    expected: string;
  }) {
    expect(await detectMime(params.input)).toBe(params.expected);
  }

  it.each([
    { format: "jpg", expected: "image/jpeg" },
    { format: "jpeg", expected: "image/jpeg" },
    { format: "png", expected: "image/png" },
    { format: "webp", expected: "image/webp" },
    { format: "gif", expected: "image/gif" },
    { format: "unknown", expected: undefined },
  ])("maps $format image format", ({ format, expected }) => {
    expect(imageMimeFromFormat(format)).toBe(expected);
  });

  it.each([
    {
      name: "detects docx from buffer",
      mainMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      partPath: "/word/document.xml",
      expected: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    {
      name: "detects pptx from buffer",
      mainMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      partPath: "/ppt/presentation.xml",
      expected: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
  ] as const)("$name", async ({ mainMime, partPath, expected }) => {
    await expectDetectedMime({
      input: {
        buffer: await makeOoxmlZip({ mainMime, partPath }),
        filePath: "/tmp/file.bin",
      },
      expected,
    });
  });

  it.each([
    {
      name: "prefers extension mapping over generic zip",
      input: async () => {
        const zip = new JSZip();
        zip.file("hello.txt", "hi");
        return {
          buffer: await zip.generateAsync({ type: "nodebuffer" }),
          filePath: "/tmp/file.xlsx",
        };
      },
      expected: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    {
      name: "uses extension mapping for JavaScript assets",
      input: async () => ({
        filePath: "/tmp/a2ui.bundle.js",
      }),
      expected: "text/javascript",
    },
  ] as const)("$name", async ({ input, expected }) => {
    await expectDetectedMime({
      input: await input(),
      expected,
    });
  });

  it("detects HTML files by extension (no magic bytes)", async () => {
    const buf = Buffer.from("<!DOCTYPE html><html><body>test</body></html>");
    const mime = await detectMime({ buffer: buf, filePath: "/tmp/report.html" });
    expect(mime).toBe("text/html");
  });

  it("detects .htm files by extension", async () => {
    const buf = Buffer.from("<html><body>test</body></html>");
    const mime = await detectMime({ buffer: buf, filePath: "/tmp/page.htm" });
    expect(mime).toBe("text/html");
  });

  it("detects XML files by extension", async () => {
    const mime = await detectMime({ filePath: "/tmp/data.xml" });
    expect(mime).toBe("text/xml");
  });

  it("detects CSS files by extension", async () => {
    const mime = await detectMime({ filePath: "/tmp/style.css" });
    expect(mime).toBe("text/css");
  });

  it("detects AAC from a bare filename when buffer sniffing is inconclusive", async () => {
    const mime = await detectMime({ buffer: Buffer.alloc(16), filePath: "voice.aac" });
    expect(mime).toBe("audio/aac");
  });

  it("detects Apple CAF audio by magic bytes when file-type does not recognize the container", async () => {
    // CAF files start with the four-byte ASCII tag "caff". `file-type` v22 has
    // no native CAF detector, so without the manual magic-byte fallback the
    // host-local-media validator drops `afconvert`-produced voice-memo CAFs as
    // unknown binary blobs. Regression guard for the BlueBubbles voice-memo
    // pre-transcode path.
    const buf = Buffer.concat([Buffer.from("caff", "ascii"), Buffer.alloc(60)]);
    const mime = await detectMime({ buffer: buf });
    expect(mime).toBe("audio/x-caf");
  });

  it("returns audio/x-caf when extension and CAF magic bytes both agree", async () => {
    const buf = Buffer.concat([Buffer.from("caff", "ascii"), Buffer.alloc(60)]);
    const mime = await detectMime({ buffer: buf, filePath: "/tmp/voice.caf" });
    expect(mime).toBe("audio/x-caf");
  });

  it("caps dependency sniffing to a bounded prefix", () => {
    const small = Buffer.alloc(32);
    const large = Buffer.alloc(FILE_TYPE_SNIFF_MAX_BYTES + 16);

    expect(sliceMimeSniffBuffer(small)).toBe(small);
    expect(sliceMimeSniffBuffer(large)).toHaveLength(FILE_TYPE_SNIFF_MAX_BYTES);
  });
});

describe("extensionForMime", () => {
  function expectMimeExtensionCase(
    mime: Parameters<typeof extensionForMime>[0],
    expected: ReturnType<typeof extensionForMime>,
  ) {
    expect(extensionForMime(mime)).toBe(expected);
  }

  it.each([
    { mime: "image/jpeg", expected: ".jpg" },
    { mime: "image/png", expected: ".png" },
    { mime: "image/webp", expected: ".webp" },
    { mime: "image/gif", expected: ".gif" },
    { mime: "image/heic", expected: ".heic" },
    { mime: "audio/mpeg", expected: ".mp3" },
    { mime: "audio/ogg", expected: ".ogg" },
    { mime: "audio/x-m4a", expected: ".m4a" },
    { mime: "audio/mp4", expected: ".m4a" },
    { mime: "video/mp4", expected: ".mp4" },
    { mime: "video/quicktime", expected: ".mov" },
    { mime: "application/pdf", expected: ".pdf" },
    { mime: "text/plain", expected: ".txt" },
    { mime: "text/markdown", expected: ".md" },
    { mime: "text/html", expected: ".html" },
    { mime: "text/xml", expected: ".xml" },
    { mime: "text/css", expected: ".css" },
    { mime: "application/xml", expected: ".xml" },
    { mime: "IMAGE/JPEG", expected: ".jpg" },
    { mime: "Audio/X-M4A", expected: ".m4a" },
    { mime: "Video/QuickTime", expected: ".mov" },
    { mime: "video/unknown", expected: undefined },
    { mime: "application/x-custom", expected: undefined },
    { mime: null, expected: undefined },
    { mime: undefined, expected: undefined },
  ] as const)("maps $mime to extension", ({ mime, expected }) => {
    expectMimeExtensionCase(mime, expected);
  });
});

describe("isAudioFileName", () => {
  function expectAudioFileNameCase(fileName: string, expected: boolean) {
    expect(isAudioFileName(fileName)).toBe(expected);
  }

  it.each([
    { fileName: "voice.mp3", expected: true },
    { fileName: "voice.caf", expected: true },
    { fileName: "voice.bin", expected: false },
  ] as const)("matches audio extension for $fileName", ({ fileName, expected }) => {
    expectAudioFileNameCase(fileName, expected);
  });
});

describe("normalizeMimeType", () => {
  function expectNormalizedMimeCase(
    input: Parameters<typeof normalizeMimeType>[0],
    expected: ReturnType<typeof normalizeMimeType>,
  ) {
    expect(normalizeMimeType(input)).toBe(expected);
  }

  it.each([
    { input: "Audio/MP4; codecs=mp4a.40.2", expected: "audio/mp4" },
    { input: "   ", expected: undefined },
    { input: null, expected: undefined },
    { input: undefined, expected: undefined },
  ] as const)("normalizes $input", ({ input, expected }) => {
    expectNormalizedMimeCase(input, expected);
  });
});

describe("mediaKindFromMime", () => {
  function expectMediaKindCase(
    mime: Parameters<typeof mediaKindFromMime>[0],
    expected: ReturnType<typeof mediaKindFromMime>,
  ) {
    expect(mediaKindFromMime(mime)).toBe(expected);
  }

  function expectMimeKindCase(
    mime: Parameters<typeof kindFromMime>[0],
    expected: ReturnType<typeof kindFromMime>,
  ) {
    expect(kindFromMime(mime)).toBe(expected);
  }

  it.each([
    { mime: "text/plain", expected: "document" },
    { mime: "text/csv", expected: "document" },
    { mime: "text/html; charset=utf-8", expected: "document" },
    { mime: "model/gltf+json", expected: undefined },
    { mime: null, expected: undefined },
    { mime: undefined, expected: undefined },
  ] as const)("classifies $mime", ({ mime, expected }) => {
    expectMediaKindCase(mime, expected);
  });

  it.each([
    { mime: " Audio/Ogg; codecs=opus ", expected: "audio" },
    { mime: undefined, expected: undefined },
    { mime: "model/gltf+json", expected: undefined },
  ] as const)("maps kindFromMime($mime) => $expected", ({ mime, expected }) => {
    expectMimeKindCase(mime, expected);
  });
});
