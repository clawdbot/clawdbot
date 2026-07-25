// Media Core tests cover mime behavior.
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { mediaKindFromMime } from "./constants.js";
import {
  detectMime,
  extensionForMime,
  FILE_TYPE_SNIFF_MAX_BYTES,
  getFileExtension,
  imageMimeFromFormat,
  isAudioFileName,
  isGifMedia,
  kindFromMime,
  mimeTypeFromFilePath,
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

// file-type classifies this generic ISO-BMFF brand as video/mp4 without track metadata.
const ISOM_BRAND_BUFFER = Buffer.from(
  "0000001c6674797069736f6d0000000069736f6d0000000000000000",
  "hex",
);

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
      name: "does not let image extensions override generic zip bytes",
      input: async () => {
        const zip = new JSZip();
        zip.file("hello.txt", "hi");
        return {
          buffer: await zip.generateAsync({ type: "nodebuffer" }),
          filePath: "/tmp/fake.png",
        };
      },
      expected: "application/zip",
    },
    {
      name: "does not let image headers override generic zip bytes",
      input: async () => {
        const zip = new JSZip();
        zip.file("hello.txt", "hi");
        return {
          buffer: await zip.generateAsync({ type: "nodebuffer" }),
          headerMime: "image/png",
        };
      },
      expected: "application/zip",
    },
    {
      name: "uses extension mapping for JavaScript assets",
      input: async () => ({
        filePath: "/tmp/a2ui.bundle.js",
      }),
      expected: "text/javascript",
    },
    {
      name: "uses extension mapping for YAML assets",
      input: async () => ({
        filePath: "/tmp/config.yml",
      }),
      expected: "application/yaml",
    },
    {
      name: "uses extension mapping for YAML documents",
      input: async () => ({
        filePath: "/tmp/config.yaml",
      }),
      expected: "application/yaml",
    },
  ] as const)("$name", async ({ input, expected }) => {
    await expectDetectedMime({
      input: await input(),
      expected,
    });
  });

  it.each([
    "application/epub+zip",
    "application/java-archive",
    "application/vnd.apple.pages",
    "application/vnd.google-earth.kmz",
    "application/vnd.ms-word.document.macroenabled.12",
    "application/vnd.ms-visio.drawing",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ])("uses %s metadata to refine extensionless generic ZIP bytes", async (headerMime) => {
    const zip = new JSZip();
    zip.file("hello.txt", "hi");

    await expectDetectedMime({
      input: { buffer: await zip.generateAsync({ type: "nodebuffer" }), headerMime },
      expected: headerMime,
    });
  });

  it("does not let unrelated document metadata override generic ZIP bytes", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "hi");

    await expectDetectedMime({
      input: {
        buffer: await zip.generateAsync({ type: "nodebuffer" }),
        headerMime: "application/pdf",
      },
      expected: "application/zip",
    });
  });

  it.each(["application/vnd.oasis.opendocument.text-flat-xml", "application/vnd.visio"])(
    "does not let non-ZIP %s metadata override generic ZIP bytes",
    async (headerMime) => {
      const zip = new JSZip();
      zip.file("hello.txt", "hi");

      await expectDetectedMime({
        input: { buffer: await zip.generateAsync({ type: "nodebuffer" }), headerMime },
        expected: "application/zip",
      });
    },
  );

  it("prefers ZIP-compatible metadata over an incompatible filename extension", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    await expectDetectedMime({
      input: {
        buffer: await zip.generateAsync({ type: "nodebuffer" }),
        filePath: "upload.pdf",
        headerMime: docxMime,
      },
      expected: docxMime,
    });
  });

  it("preserves audio metadata for ambiguous WebM container bytes", async () => {
    // Minimal EBML header declaring WebM; file-type correctly recognizes the container
    // but defaults it to video/webm because no track metadata is present.
    const webm = Buffer.from("1a45dfa3874282847765626d", "hex");

    await expectDetectedMime({
      input: { buffer: webm, filePath: "voice.webm", headerMime: "audio/webm" },
      expected: "audio/webm",
    });
  });

  it("uses a secondary audio hint when primary metadata is stale", async () => {
    const webm = Buffer.from("1a45dfa3874282847765626d", "hex");

    await expectDetectedMime({
      input: {
        buffer: webm,
        filePath: "voice.webm",
        headerMime: "application/pdf",
        additionalMimeHints: ["audio/webm"],
      },
      expected: "audio/webm",
    });
  });

  it.each([
    {
      name: "audio/mp4 header",
      filePath: "voice.mp4",
      headerMime: "audio/mp4",
      expected: "audio/mp4",
    },
    {
      name: "audio/x-m4a header",
      filePath: "voice.m4a",
      headerMime: "audio/x-m4a",
      expected: "audio/x-m4a",
    },
    {
      name: "audio/m4a header",
      filePath: "voice.m4a",
      headerMime: "audio/m4a",
      expected: "audio/m4a",
    },
    {
      name: "m4a extension",
      filePath: "voice.m4a",
      headerMime: undefined,
      expected: "audio/x-m4a",
    },
    {
      name: "mp4 extension without an audio hint",
      filePath: "clip.mp4",
      headerMime: undefined,
      expected: "video/mp4",
    },
    {
      name: "audio/aac elementary-stream metadata",
      filePath: "voice.aac",
      headerMime: "audio/aac",
      expected: "video/mp4",
    },
  ] as const)("resolves ambiguous isom-brand bytes from $name", async (testCase) => {
    await expectDetectedMime({
      input: {
        buffer: ISOM_BRAND_BUFFER,
        filePath: testCase.filePath,
        headerMime: testCase.headerMime,
      },
      expected: testCase.expected,
    });
  });

  it("does not let conflicting audio metadata override MPEG video bytes", async () => {
    const mpegProgramStream = Buffer.from([0x00, 0x00, 0x01, 0xba, 0x00, 0x00, 0x00, 0x00]);

    await expectDetectedMime({
      input: { buffer: mpegProgramStream, headerMime: "audio/mpeg" },
      expected: "video/mpeg",
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

  it("detects MIME types from encoded URL extensions", async () => {
    const mime = await detectMime({
      filePath: "https://cdn.example.com/render%2Emp4?download=1#preview",
    });

    expect(mime).toBe("video/mp4");
  });

  it("detects AAC from a bare filename when buffer sniffing is inconclusive", async () => {
    const mime = await detectMime({ buffer: Buffer.alloc(16), filePath: "voice.aac" });
    expect(mime).toBe("audio/aac");
  });

  it("detects Apple CAF audio by magic bytes when file-type does not recognize the container", async () => {
    // CAF files start with the four-byte ASCII tag "caff". `file-type` v22 has
    // no native CAF detector, so without the manual magic-byte fallback the
    // host-local-media validator drops `afconvert`-produced voice-memo CAFs as
    // unknown binary blobs. Regression guard for the iMessage voice-memo
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

describe("getFileExtension", () => {
  it.each([
    { filePath: "https://cdn.example.com/render.mp4", expected: ".mp4" },
    { filePath: "https://cdn.example.com/render.mp4/", expected: undefined },
    {
      filePath: "https://cdn.example.com/render.mp4%2Fpreview",
      expected: ".mp4%2fpreview",
    },
    {
      filePath: "https://cdn.example.com/render.mp4%5Cpreview",
      expected: ".mp4%5cpreview",
    },
    { filePath: "https://cdn.example.com/bad%ZZ%2Emp4", expected: undefined },
    { filePath: "https://cdn.example.com/render%2Emp4/", expected: undefined },
    { filePath: String.raw`C:\media\clip.MP4`, expected: ".mp4" },
    { filePath: String.raw`C:\media.folder\clip`, expected: undefined },
    { filePath: String.raw`C:\media.folder\clip.MP4`, expected: ".mp4" },
  ] as const)("extracts $expected from $filePath", ({ filePath, expected }) => {
    expect(getFileExtension(filePath)).toBe(expected);
  });
});

describe("mimeTypeFromFilePath", () => {
  it.each([
    { filePath: "image.bmp", expected: "image/bmp" },
    { filePath: "photo.jpg", expected: "image/jpeg" },
    { filePath: "photo.JPG", expected: "image/jpeg" },
    { filePath: "voice.mp3", expected: "audio/mpeg" },
    { filePath: "voice.m2a", expected: "audio/mpeg" },
    { filePath: "voice.oga", expected: "audio/ogg" },
    { filePath: "voice.wav", expected: "audio/wav" },
    { filePath: "clip.avi", expected: "video/x-msvideo" },
    { filePath: "clip.mkv", expected: "video/x-matroska" },
    { filePath: "clip.webm", expected: "video/webm" },
    {
      filePath: "https://cdn.example.com/render%2Emp4?download=1#preview",
      expected: "video/mp4",
    },
    { filePath: "https://cdn.example.com/render%2Em%70%34", expected: "video/mp4" },
    { filePath: "https://cdn.example.com/render%2EMP4", expected: "video/mp4" },
    { filePath: "https://cdn.example.com/clip%2Ewebm", expected: "video/webm" },
    { filePath: "https://cdn.example.com/bad%ZZ/render%2Emp4", expected: "video/mp4" },
    { filePath: "https://cdn.example.com/archive%2Fclip.mp4", expected: "video/mp4" },
    { filePath: "https://cdn.example.com/archive%2Fclip%2Emp4", expected: "video/mp4" },
    { filePath: "https://cdn.example.com/archive%5Cclip%2Emp4", expected: "video/mp4" },
    { filePath: "https://cdn.example.com/render.mp4%2Fpreview", expected: undefined },
    { filePath: "https://cdn.example.com/render.mp4%5Cpreview", expected: undefined },
    { filePath: "clip.flv", expected: "video/x-flv" },
    { filePath: "clip.wmv", expected: "video/x-ms-wmv" },
    { filePath: "https://cdn.example.com/bad%E0%A4%A%2Emp4", expected: undefined },
    { filePath: "debug.log", expected: "text/plain" },
    { filePath: "config.yml", expected: "application/yaml" },
    { filePath: "config.yaml", expected: "application/yaml" },
    { filePath: "page.xml", expected: "text/xml" },
    { filePath: "unknown.bin", expected: undefined },
  ] as const)("maps $filePath", ({ filePath, expected }) => {
    expect(mimeTypeFromFilePath(filePath)).toBe(expected);
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
    { mime: "image/jpg", expected: ".jpg" },
    { mime: "image/bmp", expected: ".bmp" },
    { mime: "image/png", expected: ".png" },
    { mime: "image/svg+xml", expected: ".svg" },
    { mime: "image/webp", expected: ".webp" },
    { mime: "image/gif", expected: ".gif" },
    { mime: "image/heic", expected: ".heic" },
    { mime: "audio/mpeg", expected: ".mp3" },
    { mime: "audio/mp3", expected: ".mp3" },
    { mime: "audio/ogg", expected: ".ogg" },
    { mime: "audio/x-wav", expected: ".wav" },
    { mime: "audio/webm", expected: ".webm" },
    { mime: "audio/x-m4a", expected: ".m4a" },
    { mime: "audio/m4a", expected: ".m4a" },
    { mime: "audio/mp4", expected: ".m4a" },
    { mime: "video/x-msvideo", expected: ".avi" },
    { mime: "video/mp4", expected: ".mp4" },
    { mime: "video/x-matroska", expected: ".mkv" },
    { mime: "video/webm", expected: ".webm" },
    { mime: "video/x-flv", expected: ".flv" },
    { mime: "video/x-ms-wmv", expected: ".wmv" },
    { mime: "video/quicktime", expected: ".mov" },
    { mime: "application/pdf", expected: ".pdf" },
    { mime: "application/yaml", expected: ".yaml" },
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
    { fileName: "voice.M2A", expected: true },
    { fileName: "voice.oga", expected: true },
    { fileName: "voice.webm", expected: false },
    { fileName: "voice.bin", expected: false },
  ] as const)("matches audio extension for $fileName", ({ fileName, expected }) => {
    expectAudioFileNameCase(fileName, expected);
  });
});

describe("isGifMedia", () => {
  it.each([
    {
      opts: { contentType: "image/gif; charset=binary" },
      expected: true,
    },
    {
      opts: { contentType: " IMAGE/GIF " },
      expected: true,
    },
    {
      opts: { contentType: "image/png" },
      expected: false,
    },
    {
      opts: { fileName: "animation.GIF" },
      expected: true,
    },
  ] as const)("detects GIF media from normalized metadata %#", ({ opts, expected }) => {
    expect(isGifMedia(opts)).toBe(expected);
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
    { input: "image/apng", expected: "image/png" },
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
