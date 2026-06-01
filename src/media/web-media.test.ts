import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { resolveStateDir } from "../config/paths.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { resizeToJpeg } from "./media-services.js";
import { encodePngRgba, fillPixel } from "./png-encode.js";

let effectiveImageBytesCap: typeof import("./web-media.js").effectiveImageBytesCap;
let LocalMediaAccessError: typeof import("./web-media.js").LocalMediaAccessError;
let loadWebMedia: typeof import("./web-media.js").loadWebMedia;
let loadWebMediaRaw: typeof import("./web-media.js").loadWebMediaRaw;
let optimizeImageToJpeg: typeof import("./web-media.js").optimizeImageToJpeg;
let resolveImageCompressionGrid: typeof import("./web-media.js").resolveImageCompressionGrid;

const TINY_PNG_BUFFER = createSolidPngBuffer(1, 1, { r: 255, g: 255, b: 255 });
const TINY_PNG_BASE64 = TINY_PNG_BUFFER.toString("base64");
const CANVAS_HOST_PATH = "/__openclaw__/canvas";

let fixtureRoot = "";
let tinyPngFile = "";
let stateDir = "";
let canvasPngFile = "";
let workspaceDir = "";
let workspacePngFile = "";

function installCanvasMediaResolver() {
  const registry = createEmptyPluginRegistry();
  registry.hostedMediaResolvers = [
    {
      pluginId: "canvas",
      resolver: (mediaUrl) =>
        mediaUrl === `${CANVAS_HOST_PATH}/documents/cv_test/collection.media/tiny.png`
          ? canvasPngFile
          : null,
      source: "test",
    },
  ];
  setActivePluginRegistry(registry);
}

beforeAll(async () => {
  ({
    effectiveImageBytesCap,
    LocalMediaAccessError,
    loadWebMedia,
    loadWebMediaRaw,
    optimizeImageToJpeg,
    resolveImageCompressionGrid,
  } = await import("./web-media.js"));
  fixtureRoot = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "web-media-core-"));
  tinyPngFile = path.join(fixtureRoot, "tiny.png");
  await fs.writeFile(tinyPngFile, Buffer.from(TINY_PNG_BASE64, "base64"));
  workspaceDir = path.join(fixtureRoot, "workspace");
  workspacePngFile = path.join(workspaceDir, "chart.png");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(workspacePngFile, Buffer.from(TINY_PNG_BASE64, "base64"));
  stateDir = resolveStateDir();
  canvasPngFile = path.join(
    stateDir,
    "canvas",
    "documents",
    "cv_test",
    "collection.media",
    "tiny.png",
  );
  await fs.mkdir(path.dirname(canvasPngFile), { recursive: true });
  await fs.writeFile(canvasPngFile, Buffer.from(TINY_PNG_BASE64, "base64"));
  installCanvasMediaResolver();
});

afterAll(async () => {
  resetPluginRuntimeStateForTest();
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
  if (stateDir) {
    await fs.rm(path.join(stateDir, "canvas", "documents", "cv_test"), {
      recursive: true,
      force: true,
    });
  }
});

describe("loadWebMedia", () => {
  function createLargeColorBlockPng(size: number): Buffer {
    const buf = Buffer.alloc(size * size * 4, 255);
    const centerStart = Math.floor(size * 0.25);
    const centerEnd = Math.floor(size * 0.75);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const inCenter = x >= centerStart && x < centerEnd && y >= centerStart && y < centerEnd;
        fillPixel(buf, x, y, size, inCenter ? 230 : 30, inCenter ? 40 : 110, inCenter ? 35 : 220);
      }
    }
    return encodePngRgba(buf, size, size);
  }

  function createLargeTransparentColorBlockPng(size: number): Buffer {
    const buf = Buffer.alloc(size * size * 4, 0);
    const centerStart = Math.floor(size * 0.25);
    const centerEnd = Math.floor(size * 0.75);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const inCenter = x >= centerStart && x < centerEnd && y >= centerStart && y < centerEnd;
        fillPixel(
          buf,
          x,
          y,
          size,
          inCenter ? 230 : 30,
          inCenter ? 40 : 110,
          inCenter ? 35 : 220,
          inCenter ? 255 : 96,
        );
      }
    }
    return encodePngRgba(buf, size, size);
  }

  function readPngDimensions(buffer: Buffer): { width: number; height: number } {
    if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") {
      throw new Error("PNG dimensions not found");
    }
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  function createGifHeader(width: number, height: number): Buffer {
    const buffer = Buffer.alloc(10);
    buffer.write("GIF89a", 0, "ascii");
    buffer.writeUInt16LE(width, 6);
    buffer.writeUInt16LE(height, 8);
    return buffer;
  }

  function readJpegDimensions(buffer: Buffer): { width: number; height: number } {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }
      const segmentLength = buffer.readUInt16BE(offset);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          height: buffer.readUInt16BE(offset + 3),
          width: buffer.readUInt16BE(offset + 5),
        };
      }
      offset += segmentLength;
    }
    throw new Error("JPEG dimensions not found");
  }

  function makeStallingFetch(firstChunk: Uint8Array) {
    return vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(firstChunk);
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/pdf" },
          },
        ),
    );
  }

  async function expectWebMediaIdleTimeout(
    createLoadPromise: () => Promise<unknown>,
    idleTimeoutMs: number,
  ) {
    vi.useFakeTimers();
    try {
      const outcome = createLoadPromise().then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      await vi.advanceTimersByTimeAsync(idleTimeoutMs + 5);
      await expect(
        Promise.race([outcome, Promise.resolve({ status: "pending" as const })]),
      ).resolves.toMatchObject({ status: "rejected" });
      const result = await outcome;
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(String(result.error)).toMatch(/stalled|no data received/i);
      }
    } finally {
      vi.useRealTimers();
    }
  }

  function createLocalWebMediaOptions() {
    return {
      maxBytes: 1024 * 1024,
      localRoots: [fixtureRoot],
    };
  }

  async function expectRejectedWebMedia(
    url: string,
    expectedError: Record<string, unknown> | RegExp,
    setup?: () => { restore?: () => void; mockRestore?: () => void } | undefined,
  ) {
    const restoreHandle = setup?.();
    try {
      if (expectedError instanceof RegExp) {
        await expect(loadWebMedia(url, createLocalWebMediaOptions())).rejects.toThrow(
          expectedError,
        );
        return;
      }
      await expectLoadWebMediaErrorFields(
        loadWebMedia(url, createLocalWebMediaOptions()),
        expectedError,
      );
    } finally {
      restoreHandle?.mockRestore?.();
      restoreHandle?.restore?.();
    }
  }

  async function expectLoadWebMediaErrorFields(
    promise: Promise<unknown>,
    expectedFields: Record<string, unknown>,
  ) {
    let mediaError: unknown;
    try {
      await promise;
    } catch (error) {
      mediaError = error;
    }
    expect(mediaError).toBeInstanceOf(LocalMediaAccessError);
    if (!(mediaError instanceof LocalMediaAccessError)) {
      throw new Error("expected LocalMediaAccessError");
    }
    for (const [key, value] of Object.entries(expectedFields)) {
      expect(Reflect.get(mediaError, key)).toStrictEqual(value);
    }
  }

  async function expectLoadWebMediaErrorCode(promise: Promise<unknown>, code: string) {
    await expectLoadWebMediaErrorFields(promise, { code });
  }

  async function expectRejectedWebMediaWithoutFilesystemAccess(params: {
    url: string;
    expectedError: Record<string, unknown> | RegExp;
    setup?: () => { restore?: () => void; mockRestore?: () => void } | undefined;
  }) {
    const realpathSpy = vi.spyOn(fs, "realpath");
    try {
      await expectRejectedWebMedia(params.url, params.expectedError, params.setup);
      expect(realpathSpy).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
    }
  }

  async function expectLoadedWebMediaCase(url: string) {
    const result = await loadWebMedia(url, createLocalWebMediaOptions());
    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeGreaterThan(0);
  }

  async function loadDocumentWithHostRead(fileName: string, body: Buffer | string) {
    const textFile = path.join(fixtureRoot, fileName);
    await fs.writeFile(textFile, body);
    return loadWebMedia(textFile, {
      maxBytes: 1024 * 1024,
      localRoots: "any",
      readFile: async (filePath) => await fs.readFile(filePath),
      hostReadCapability: true,
    });
  }

  it.each([
    {
      name: "allows localhost file URLs for local files",
      createUrl: () => {
        const fileUrl = pathToFileURL(tinyPngFile);
        fileUrl.hostname = "localhost";
        return fileUrl.href;
      },
    },
  ] as const)("$name", async ({ createUrl }) => {
    await expectLoadedWebMediaCase(createUrl());
  });

  it.each([
    {
      name: "rejects remote-host file URLs before filesystem checks",
      url: "file://attacker/share/evil.png",
      expectedError: { code: "invalid-file-url" },
    },
    {
      name: "rejects remote-host file URLs with the explicit error message before filesystem checks",
      url: "file://attacker/share/evil.png",
      expectedError: /remote hosts are not allowed/i,
    },
    {
      name: "rejects Windows network paths before filesystem checks",
      url: "\\\\attacker\\share\\evil.png",
      expectedError: { code: "network-path-not-allowed" },
      setup: () => vi.spyOn(process, "platform", "get").mockReturnValue("win32"),
    },
  ] as const)("$name", async (testCase) => {
    await expectRejectedWebMediaWithoutFilesystemAccess(testCase);
  });

  it("loads browser-style canvas media paths as managed local files", async () => {
    installCanvasMediaResolver();
    const result = await loadWebMedia(
      `${CANVAS_HOST_PATH}/documents/cv_test/collection.media/tiny.png`,
      { maxBytes: 1024 * 1024 },
    );
    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("keeps trying hosted media resolvers after one throws", async () => {
    const registry = createEmptyPluginRegistry();
    registry.hostedMediaResolvers = [
      {
        pluginId: "broken",
        resolver: () => {
          throw new Error("resolver failed");
        },
        source: "test",
      },
      {
        pluginId: "canvas",
        resolver: (mediaUrl) =>
          mediaUrl === `${CANVAS_HOST_PATH}/documents/cv_test/collection.media/tiny.png`
            ? canvasPngFile
            : null,
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    const result = await loadWebMedia(
      `${CANVAS_HOST_PATH}/documents/cv_test/collection.media/tiny.png`,
      { maxBytes: 1024 * 1024 },
    );

    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("surfaces Rastermill decode failures when image optimization cannot produce a JPEG", async () => {
    await expect(optimizeImageToJpeg(Buffer.from("not an image"), 8)).rejects.toThrow(
      /Unable to determine image dimensions/,
    );
  });

  it("uses model metadata-aware image compression grids", () => {
    expect(
      resolveImageCompressionGrid({
        models: [{ maxSidePx: 2576, preferredSidePx: 2576 }],
        quality: "high",
      }).sides[0],
    ).toBe(2576);
    expect(
      resolveImageCompressionGrid({
        models: [{ maxSidePx: 1568, preferredSidePx: 1568 }],
        quality: "high",
      }).sides[0],
    ).toBe(1568);
    expect(
      resolveImageCompressionGrid({
        models: [{ maxSidePx: 6000, preferredSidePx: 2048 }],
        quality: "high",
      }).sides[0],
    ).toBe(6000);
    expect(
      resolveImageCompressionGrid({
        models: [{ maxSidePx: 6000, preferredSidePx: 2048 }],
        quality: "balanced",
      }).sides[0],
    ).toBe(2048);
    expect(
      resolveImageCompressionGrid({
        models: [{ maxSidePx: 6000, maxPixels: 12845056, preferredSidePx: 2048 }],
        quality: "high",
      }).sides[0],
    ).toBe(3584);
    expect(
      resolveImageCompressionGrid({
        models: [{ maxPixels: 33177600, preferredSidePx: 2048 }],
        quality: "high",
      }).sides[0],
    ).toBe(5760);
    expect(
      resolveImageCompressionGrid({
        models: [
          { maxSidePx: 6000, preferredSidePx: 2048 },
          { maxSidePx: 1568, preferredSidePx: 1568 },
        ],
        quality: "high",
      }).sides[0],
    ).toBe(1568);
    expect(
      resolveImageCompressionGrid({
        models: [{ maxSidePx: 512, preferredSidePx: 512, maxBytes: 64 * 1024 }],
        quality: "balanced",
      }).sides,
    ).toEqual([512, 384, 256, 192, 128]);
  });

  it("adapts automatic image compression for many-image turns", () => {
    const single = resolveImageCompressionGrid({
      models: [{ maxSidePx: 2576, preferredSidePx: 2576 }],
      quality: "auto",
      imageCount: 1,
    });
    const many = resolveImageCompressionGrid({
      models: [{ maxSidePx: 2576, preferredSidePx: 2576 }],
      quality: "auto",
      imageCount: 8,
    });

    expect(single.sides[0]).toBe(2576);
    expect(single.qualities).toEqual([80, 70, 60, 50, 40]);
    expect(many.sides[0]).toBe(1280);
    expect(many.qualities).toEqual([70, 60, 50, 40]);
  });

  it("preserves in-limit GIF buffers when optimizing direct image buffers", async () => {
    const { optimizeImageBufferForWebMedia } = await import("./web-media.js");
    const buffer = createGifHeader(16, 16);
    const result = await optimizeImageBufferForWebMedia({
      buffer,
      contentType: "image/gif",
      maxBytes: 1024,
      imageCompression: { models: [{ maxSidePx: 64 }] },
    });

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/gif");
    expect(result.buffer.equals(buffer)).toBe(true);
  });

  it("does not bypass model dimensions for GIF buffers", async () => {
    const { optimizeImageBufferForWebMedia } = await import("./web-media.js");
    await expect(
      optimizeImageBufferForWebMedia({
        buffer: createGifHeader(1600, 1600),
        contentType: "image/gif",
        maxBytes: 1024,
        imageCompression: { models: [{ maxSidePx: 512 }] },
      }),
    ).rejects.toThrow(/dimensions exceed model image limits/i);
  });

  it("applies model image maxBytes to the effective image cap", async () => {
    await expect(
      loadWebMediaRaw(tinyPngFile, {
        maxBytes: 1024 * 1024,
        localRoots: [fixtureRoot],
        imageCompression: {
          models: [{ maxBytes: 8 }],
        },
      }),
    ).rejects.toThrow(/exceeds/i);
  });

  it("uses the strictest model image maxBytes across fallback candidates", () => {
    expect(
      effectiveImageBytesCap(16 * 1024 * 1024, {
        models: [{ maxBytes: 8 * 1024 * 1024 }, {}, { maxBytes: 2 * 1024 * 1024 }],
      }),
    ).toBe(2 * 1024 * 1024);
    expect(effectiveImageBytesCap(undefined, { models: [{ maxBytes: 1024 }] })).toBe(1024);
  });

  it("downscales oversized JPEGs to the resolved model side limit before returning media", async () => {
    const sourcePng = createLargeColorBlockPng(1600);
    const sourceJpeg = await resizeToJpeg({
      buffer: sourcePng,
      maxSide: 1600,
      quality: 92,
      withoutEnlargement: true,
    });
    expect(Math.max(...Object.values(readJpegDimensions(sourceJpeg)))).toBe(1600);

    const largeImage = path.join(fixtureRoot, "large-center-red.jpg");
    await fs.writeFile(largeImage, sourceJpeg);
    const result = await loadWebMedia(largeImage, {
      maxBytes: 16 * 1024 * 1024,
      localRoots: [fixtureRoot],
      imageCompression: {
        quality: "high",
        models: [{ maxSidePx: 512, preferredSidePx: 512 }],
      },
    });

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/jpeg");
    const dimensions = readJpegDimensions(result.buffer);
    expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(512);
  });

  it("downscales alpha PNGs to the resolved model side limit before returning media", async () => {
    const sourcePng = createLargeTransparentColorBlockPng(1600);
    expect(Math.max(...Object.values(readPngDimensions(sourcePng)))).toBe(1600);

    const largeImage = path.join(fixtureRoot, "large-transparent.png");
    await fs.writeFile(largeImage, sourcePng);
    const result = await loadWebMedia(largeImage, {
      maxBytes: 16 * 1024 * 1024,
      localRoots: [fixtureRoot],
      imageCompression: {
        quality: "high",
        models: [{ maxSidePx: 512, preferredSidePx: 512 }],
      },
    });

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/png");
    const dimensions = readPngDimensions(result.buffer);
    expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(512);
  });

  it("uses low default dimensions when model metadata is unavailable", async () => {
    expect(
      resolveImageCompressionGrid({
        quality: "high",
        models: [{}],
      }).sides[0],
    ).toBe(2048);
  });

  it("resolves relative local media paths against the provided workspace directory", async () => {
    const result = await loadWebMedia("chart.png", {
      maxBytes: 1024 * 1024,
      localRoots: [workspaceDir],
      workspaceDir,
    });
    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("does not treat image-named generic container bytes as local image media", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    const fakeImage = path.join(fixtureRoot, "fake.png");
    await fs.writeFile(fakeImage, await zip.generateAsync({ type: "nodebuffer" }));

    const result = await loadWebMedia(fakeImage, createLocalWebMediaOptions());

    expect(result.kind).toBe("document");
    expect(result.contentType).toBe("application/zip");
    expect(result.fileName).toBe("fake.png");
  });

  it("uses only the leaf filename from Windows-style sandbox-validated media paths", async () => {
    const result = await loadWebMedia(String.raw`C:\workspace\captures\tiny.png`, {
      maxBytes: 1024 * 1024,
      sandboxValidated: true,
      readFile: async () => Buffer.from(TINY_PNG_BASE64, "base64"),
    });

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/png");
    expect(result.fileName).toBe("tiny.png");
  });

  it("resolves home-relative local media paths through allowed local roots", async () => {
    vi.stubEnv("OPENCLAW_HOME", fixtureRoot);
    try {
      const result = await loadWebMedia("~/workspace/chart.png", {
        maxBytes: 1024 * 1024,
        localRoots: [workspaceDir],
      });
      expect(result.kind).toBe("image");
      expect(result.buffer.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("allows validated host-read TXT files", async () => {
    const txtFile = path.join(fixtureRoot, "notes.txt");
    await fs.writeFile(txtFile, "plain text\n", "utf8");
    const result = await loadWebMedia(txtFile, {
      maxBytes: 1024 * 1024,
      localRoots: "any",
      readFile: async (filePath) => await fs.readFile(filePath),
      hostReadCapability: true,
    });
    expect(result.kind).toBe("document");
    expect(result.contentType).toBe("text/plain");
  });

  it("rejects host-read LOG files even though they map to text/plain", async () => {
    const logFile = path.join(fixtureRoot, "debug.log");
    await fs.writeFile(logFile, "plain text\n", "utf8");
    await expect(
      loadWebMedia(logFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
    ).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });

  it("rejects renamed host-read text files even when the extension looks allowed", async () => {
    const disguisedPdf = path.join(fixtureRoot, "secret.pdf");
    await fs.writeFile(disguisedPdf, "secret", "utf8");
    await expectLoadWebMediaErrorCode(
      loadWebMedia(disguisedPdf, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
  });

  it("allows host-read CSV files", async () => {
    const csvFile = path.join(fixtureRoot, "data.csv");
    await fs.writeFile(csvFile, "name,value\nfoo,1\nbar,2\n", "utf8");
    const result = await loadWebMedia(csvFile, {
      maxBytes: 1024 * 1024,
      localRoots: "any",
      readFile: async (filePath) => await fs.readFile(filePath),
      hostReadCapability: true,
    });
    expect(result.kind).toBe("document");
    expect(result.contentType).toBe("text/csv");
  });

  it("allows host-read Markdown files", async () => {
    const mdFile = path.join(fixtureRoot, "notes.md");
    await fs.writeFile(mdFile, "# Title\n\nSome **bold** text.\n", "utf8");
    const result = await loadWebMedia(mdFile, {
      maxBytes: 1024 * 1024,
      localRoots: "any",
      readFile: async (filePath) => await fs.readFile(filePath),
      hostReadCapability: true,
    });
    expect(result.kind).toBe("document");
    expect(result.contentType).toBe("text/markdown");
  });

  it("allows trusted generated host-read HTML reports under OpenClaw temp root", async () => {
    const htmlFile = path.join(fixtureRoot, "report.html");
    await fs.writeFile(htmlFile, "<!doctype html><title>Report</title><h1>Report</h1>\n", "utf8");
    const result = await loadWebMedia(htmlFile, {
      maxBytes: 1024 * 1024,
      localRoots: "any",
      readFile: async (filePath) => await fs.readFile(filePath),
      hostReadCapability: true,
    });
    expect(result.kind).toBe("document");
    expect(result.contentType).toBe("text/html");
  });

  it("rejects host-read HTML files outside the trusted OpenClaw temp root", async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-media-host-html-"));
    const htmlFile = path.join(outsideRoot, "report.html");
    await fs.writeFile(htmlFile, "<!doctype html><title>Report</title><h1>Report</h1>\n", "utf8");
    try {
      await expectLoadWebMediaErrorCode(
        loadWebMedia(htmlFile, {
          maxBytes: 1024 * 1024,
          localRoots: "any",
          readFile: async (filePath) => await fs.readFile(filePath),
          hostReadCapability: true,
        }),
        "path-not-allowed",
      );
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects trusted host-read HTML symlinks that resolve outside OpenClaw temp root", async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-media-host-html-"));
    const outsideHtml = path.join(outsideRoot, "report.html");
    const htmlLink = path.join(fixtureRoot, "linked-report.html");
    await fs.writeFile(
      outsideHtml,
      "<!doctype html><title>Outside</title><body>secret</body>\n",
      "utf8",
    );
    try {
      await fs.symlink(outsideHtml, htmlLink);
    } catch (error) {
      await fs.rm(outsideRoot, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw error;
    }
    try {
      await expectLoadWebMediaErrorCode(
        loadWebMedia(htmlLink, {
          maxBytes: 1024 * 1024,
          localRoots: "any",
          readFile: async (filePath) => await fs.readFile(filePath),
          hostReadCapability: true,
        }),
        "path-not-allowed",
      );
    } finally {
      await fs.rm(htmlLink, { force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects trusted host-read HTML hardlinks to files outside OpenClaw temp root", async () => {
    const outsideRoot = await fs.mkdtemp(
      path.join(path.dirname(resolvePreferredOpenClawTmpDir()), "web-media-host-html-"),
    );
    const outsideHtml = path.join(outsideRoot, "report.html");
    const htmlLink = path.join(fixtureRoot, "hardlinked-report.html");
    await fs.writeFile(
      outsideHtml,
      "<!doctype html><title>Outside</title><body>secret</body>\n",
      "utf8",
    );
    try {
      await fs.link(outsideHtml, htmlLink);
    } catch (error) {
      await fs.rm(outsideRoot, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw error;
    }
    try {
      await expectLoadWebMediaErrorCode(
        loadWebMedia(htmlLink, {
          maxBytes: 1024 * 1024,
          localRoots: "any",
          readFile: async (filePath) => await fs.readFile(filePath),
          hostReadCapability: true,
        }),
        "path-not-allowed",
      );
    } finally {
      await fs.rm(htmlLink, { force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects trusted host-read HTML paths without HTML document shape", async () => {
    const htmlFile = path.join(fixtureRoot, "report.html");
    await fs.writeFile(htmlFile, "status,value\nok,1\n", "utf8");
    await expectLoadWebMediaErrorCode(
      loadWebMedia(htmlFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
  });

  it.each([
    {
      label: "ZIP",
      fileName: "archive.zip",
      body: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      contentType: "application/zip",
    },
    {
      label: "gzip",
      fileName: "archive.gz",
      body: Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0x03]),
      contentType: "application/gzip",
    },
    {
      label: "tar",
      fileName: "archive.tar",
      body: (() => {
        const buffer = Buffer.alloc(512);
        buffer.write("ustar", 257, "ascii");
        return buffer;
      })(),
      contentType: "application/x-tar",
    },
    {
      label: "7z",
      fileName: "archive.7z",
      body: Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]),
      contentType: "application/x-7z-compressed",
    },
    {
      label: "JSON",
      fileName: "data.json",
      body: '{"ok":true}\n',
      contentType: "application/json",
    },
    {
      label: "YAML",
      fileName: "config.yaml",
      body: "ok: true\n",
      contentType: "application/yaml",
    },
    {
      label: "YML",
      fileName: "config.yml",
      body: "ok: true\n",
      contentType: "application/yaml",
    },
  ])("allows host-read $label files", async ({ fileName, body, contentType }) => {
    const result = await loadDocumentWithHostRead(fileName, body);
    expect(result.kind).toBe("document");
    expect(result.contentType).toBe(contentType);
  });

  it("rejects binary data disguised as a CSV file", async () => {
    const fakeCsv = path.join(fixtureRoot, "evil.csv");
    // Declared plain-text aliases must use the text validator path even when the
    // buffer sniffs as an otherwise allowed archive type.
    await fs.writeFile(fakeCsv, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await expectLoadWebMediaErrorCode(
      loadWebMedia(fakeCsv, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
  });

  it.each([
    { label: "CSV", fileName: "opaque.csv" },
    { label: "HTML", fileName: "opaque.html" },
    { label: "Markdown", fileName: "opaque.md" },
    { label: "TXT", fileName: "opaque.txt" },
    { label: "JSON", fileName: "opaque.json" },
    { label: "YAML", fileName: "opaque.yaml" },
    { label: "YML", fileName: "opaque.yml" },
  ])("rejects opaque non-NUL binary data disguised as $label", async ({ fileName }) => {
    const fakeTextFile = path.join(fixtureRoot, fileName);
    const opaqueBinary = Buffer.alloc(9000);
    for (let i = 0; i < opaqueBinary.length; i += 1) {
      opaqueBinary[i] = (i % 255) + 1;
    }
    await fs.writeFile(fakeTextFile, opaqueBinary);
    await expectLoadWebMediaErrorCode(
      loadWebMedia(fakeTextFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
  });

  it.each([
    { label: "CSV", fileName: "prefix-tail.csv" },
    { label: "HTML", fileName: "prefix-tail.html" },
    { label: "Markdown", fileName: "prefix-tail.md" },
  ])(
    "rejects %s files with a text prefix and binary tail after the old sample window",
    async ({ fileName }) => {
      const fakeTextFile = path.join(fixtureRoot, fileName);
      const textPrefix = Buffer.from(`name,value\n${"row,1\n".repeat(1400)}`, "utf8");
      expect(textPrefix.length).toBeGreaterThan(8192);
      const binaryTail = Buffer.from([0x00, 0xff, 0x10, 0x80]);
      await fs.writeFile(fakeTextFile, Buffer.concat([textPrefix, binaryTail]));
      await expectLoadWebMediaErrorCode(
        loadWebMedia(fakeTextFile, {
          maxBytes: 1024 * 1024,
          localRoots: "any",
          readFile: async (filePath) => await fs.readFile(filePath),
          hostReadCapability: true,
        }),
        "path-not-allowed",
      );
    },
  );

  it.each([
    {
      label: "CSV",
      fileName: "punctuation.csv",
      contentType: "text/csv",
      body: ",,,,,,,,,,\n",
    },
    {
      label: "Markdown",
      fileName: "punctuation.md",
      contentType: "text/markdown",
      body: "---\n***\n> > >\n",
    },
  ])(
    "loads valid punctuation-heavy %s files when host-read capability is enabled",
    async ({ fileName, contentType, body }) => {
      const result = await loadDocumentWithHostRead(fileName, Buffer.from(body, "utf8"));
      expect(result.kind).toBe("document");
      expect(result.contentType).toBe(contentType);
    },
  );

  it.each([
    {
      label: "CSV",
      fileName: "legacy.csv",
      contentType: "text/csv",
      body: Buffer.from("caf\xe9,ni\xf1o\n", "latin1"),
    },
    {
      label: "Markdown",
      fileName: "legacy.md",
      contentType: "text/markdown",
      body: Buffer.from("R\xe9sum\xe9\nni\xf1o\n", "latin1"),
    },
  ])(
    "loads valid single-byte encoded %s files when host-read capability is enabled",
    async ({ fileName, contentType, body }) => {
      const result = await loadDocumentWithHostRead(fileName, body);
      expect(result.kind).toBe("document");
      expect(result.contentType).toBe(contentType);
    },
  );

  it.each([
    { label: "CSV", fileName: "nul-padded.csv" },
    { label: "HTML", fileName: "nul-padded.html" },
    { label: "Markdown", fileName: "nul-padded.md" },
  ])("rejects NUL-padded binary data disguised as %s", async ({ fileName }) => {
    const fakeTextFile = path.join(fixtureRoot, fileName);
    // Alternating 0x00/0xFF — UTF-8 decode fails (0xFF is invalid UTF-8), then
    // hasSingleByteTextShape rejects because 0x00 bytes are control chars (< 0x20).
    const nulPadded = Buffer.alloc(9000);
    for (let i = 0; i < nulPadded.length; i += 1) {
      nulPadded[i] = i % 2 === 0 ? 0x00 : 0xff;
    }
    await fs.writeFile(fakeTextFile, nulPadded);
    await expectLoadWebMediaErrorCode(
      loadWebMedia(fakeTextFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
  });

  it.each([
    { label: "CSV", fileName: "bom-binary.csv" },
    { label: "HTML", fileName: "bom-binary.html" },
    { label: "Markdown", fileName: "bom-binary.md" },
  ])("rejects UTF-16 BOM-prefixed binary data disguised as %s", async ({ fileName }) => {
    const fakeTextFile = path.join(fixtureRoot, fileName);
    // UTF-16LE BOM + repeating 0xFF bytes: if UTF-16 decoding were attempted,
    // every byte pair would produce a printable code point and pass getTextStats.
    // With UTF-16 decoding removed, falls through to UTF-8 strict decode (throws
    // on 0xFF), then hasSingleByteTextShape rejects due to high-byte ratio > 30%.
    const bom = Buffer.from([0xff, 0xfe]);
    const garbage = Buffer.alloc(9000, 0xff);
    await fs.writeFile(fakeTextFile, Buffer.concat([bom, garbage]));
    await expectLoadWebMediaErrorCode(
      loadWebMedia(fakeTextFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
  });

  it.each([
    { label: "CSV", fileName: "alternating-high.csv" },
    { label: "HTML", fileName: "alternating-high.html" },
    { label: "Markdown", fileName: "alternating-high.md" },
  ])("rejects alternating ASCII/high-byte data disguised as %s", async ({ fileName }) => {
    const fakeTextFile = path.join(fixtureRoot, fileName);
    // Alternating 0x41 ('A') and 0xFF — exactly 50% ASCII, 50% high bytes.
    // With the old 50% threshold hasSingleByteTextShape would accept this;
    // the tightened 70%/30% thresholds must reject it.
    const mixed = Buffer.alloc(9000);
    for (let i = 0; i < mixed.length; i += 1) {
      mixed[i] = i % 2 === 0 ? 0x41 : 0xff;
    }
    await fs.writeFile(fakeTextFile, mixed);
    await expectLoadWebMediaErrorCode(
      loadWebMedia(fakeTextFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
  });

  it.each([
    { label: "CSV", fileName: "high-bytes.csv" },
    { label: "HTML", fileName: "high-bytes.html" },
    { label: "Markdown", fileName: "high-bytes.md" },
  ])("rejects high-byte opaque data disguised as %s", async ({ fileName }) => {
    const fakeTextFile = path.join(fixtureRoot, fileName);
    const opaqueBinary = Buffer.alloc(9000);
    for (let i = 0; i < opaqueBinary.length; i += 1) {
      opaqueBinary[i] = 0xa0 + (i % 96);
    }
    await fs.writeFile(fakeTextFile, opaqueBinary);
    await expectLoadWebMediaErrorCode(
      loadWebMedia(fakeTextFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
  });

  it("rejects traversal-style canvas media paths before filesystem access", async () => {
    await expectLoadWebMediaErrorCode(
      loadWebMedia(`${CANVAS_HOST_PATH}/documents/../collection.media/tiny.png`),
      "path-not-allowed",
    );
  });

  it("hydrates inbound media store URIs before allowed-root checks", async () => {
    const id = `signal-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      const result = await loadWebMedia(`media://inbound/${id}`, {
        maxBytes: 1024 * 1024,
      });

      expect(result.kind).toBe("image");
      expect(result.buffer.length).toBeGreaterThan(0);
      expect(result.fileName).toBe(id);
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("accepts legacy MEDIA prefixes around inbound media store URIs", async () => {
    const id = `signal-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      const result = await loadWebMedia(`  media :  media://inbound/${id}`, {
        maxBytes: 1024 * 1024,
      });

      expect(result.kind).toBe("image");
      expect(result.buffer.length).toBeGreaterThan(0);
      expect(result.fileName).toBe(id);
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("allows managed inbound absolute paths before allowed-root checks", async () => {
    const id = `signal-path-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      const result = await loadWebMedia(filePath, {
        maxBytes: 1024 * 1024,
        localRoots: [],
      });

      expect(result.kind).toBe("image");
      expect(result.buffer.length).toBeGreaterThan(0);
      expect(result.fileName).toBe(id);
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("applies the shared remote read idle timeout for raw web media loads", async () => {
    const readIdleTimeoutMs = 20;
    const fetchImpl = makeStallingFetch(new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    await expectWebMediaIdleTimeout(
      () =>
        loadWebMediaRaw("https://example.test/stalled.pdf", {
          maxBytes: 1024 * 1024,
          fetchImpl,
          readIdleTimeoutMs,
          ssrfPolicy: { allowedHostnames: ["example.test"] },
        }),
      readIdleTimeoutMs,
    );
  });

  it("loads a valid remote PDF when the raw web media read stays active", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(Buffer.from("%PDF-1.4\n%%EOF"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    );

    const result = await loadWebMediaRaw("https://example.test/ok.pdf", {
      maxBytes: 1024 * 1024,
      fetchImpl,
      readIdleTimeoutMs: 20,
      ssrfPolicy: { allowedHostnames: ["example.test"] },
    });

    expect(result.kind).toBe("document");
    expect(result.contentType).toBe("application/pdf");
    expect(result.buffer.toString()).toContain("%PDF-1.4");
  });

  it("rejects unsupported media store URI locations", async () => {
    await expectLoadWebMediaErrorCode(
      loadWebMedia("media://outbound/tiny.png"),
      "path-not-allowed",
    );
  });

  it("rejects media store URI ids with encoded path separators", async () => {
    await expectLoadWebMediaErrorCode(
      loadWebMedia("media://inbound/nested%2Ftiny.png"),
      "invalid-path",
    );
  });

  it("rejects media store URIs without an id", async () => {
    await expectLoadWebMediaErrorCode(loadWebMedia("media://inbound/"), "invalid-path");
  });
});
