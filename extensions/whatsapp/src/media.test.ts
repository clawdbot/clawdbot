// Whatsapp tests cover media plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import {
  createGrayscaleAlphaPngBuffer,
  createSolidPngBuffer,
} from "openclaw/plugin-sdk/test-fixtures";
import { withMockedWindowsPlatform, withRestoredMocks } from "openclaw/plugin-sdk/test-node-mocks";
import { optimizeImageToPng } from "openclaw/plugin-sdk/web-media";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  LocalMediaAccessError,
  loadWebMedia,
  loadWebMediaRaw,
  optimizeImageToJpeg,
} from "./media.js";

let fixtureRoot = "";
let fixtureFileCount = 0;
let largeJpegBuffer: Buffer;
let largeJpegFile = "";
let tinyPngBuffer: Buffer;
let tinyPngFile = "";
let tinyPngWrongExtFile = "";
let alphaPngBuffer: Buffer;
let alphaPngFile = "";
let fallbackPngFile = "";
let fallbackPngCap = 0;
let stateDirSnapshot: ReturnType<typeof captureEnv>;

async function writeTempFile(buffer: Buffer, ext: string): Promise<string> {
  const file = path.join(fixtureRoot, `media-${fixtureFileCount++}${ext}`);
  await fs.writeFile(file, buffer);
  return file;
}

async function createLargeTestJpeg(): Promise<{ buffer: Buffer; file: string }> {
  return { buffer: largeJpegBuffer, file: largeJpegFile };
}

function cloneStatWithDev<T extends { dev: number | bigint }>(stat: T, dev: number | bigint): T {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev }) as T;
}

async function expectLocalMediaAccessCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LocalMediaAccessError);
    expect((error as { code?: unknown }).code).toBe(code);
    return;
  }
  throw new Error(`expected local media access error ${code}`);
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-media-test-"),
  );
  largeJpegBuffer = await fs.readFile("docs/assets/showcase/roof-camera-sky.jpg");
  largeJpegFile = await writeTempFile(largeJpegBuffer, ".jpg");
  tinyPngBuffer = createSolidPngBuffer(10, 10, { r: 0, g: 255, b: 0 });
  tinyPngFile = await writeTempFile(tinyPngBuffer, ".png");
  tinyPngWrongExtFile = await writeTempFile(tinyPngBuffer, ".bin");
  alphaPngBuffer = createSolidPngBuffer(64, 64, { r: 255, g: 0, b: 0, a: 128 });
  alphaPngFile = await writeTempFile(alphaPngBuffer, ".png");
  for (const size of [24, 32, 40, 48, 64]) {
    const buffer = createGrayscaleAlphaPngBuffer(size, size);
    const smallestPng = await optimizeImageToPng(buffer, 1);
    const cap = Math.max(1, Math.min(buffer.length, smallestPng.optimizedSize) - 1);
    const jpegOptimized = await optimizeImageToJpeg(buffer, cap);
    if (jpegOptimized.buffer.length <= cap) {
      fallbackPngFile = await writeTempFile(buffer, ".png");
      fallbackPngCap = cap;
      break;
    }
  }
  if (!fallbackPngFile) {
    throw new Error("No PNG alpha fallback fixture could fit the JPEG cap");
  }
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("web media loading", () => {
  beforeAll(() => {
    // Ensure state dir is stable and not influenced by other tests that stub OPENCLAW_STATE_DIR.
    // Also keep it outside the OpenClaw temp root so default localRoots doesn't accidentally make all state readable.
    stateDirSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    process.env.OPENCLAW_STATE_DIR = path.join(
      path.parse(os.tmpdir()).root,
      "var",
      "lib",
      "openclaw-media-state-test",
    );
  });

  afterAll(() => {
    stateDirSnapshot.restore();
  });

  beforeAll(() => {
    mockPinnedHostnameResolution();
  });

  it("strips MEDIA: prefix before reading local file (including whitespace variants)", async () => {
    for (const input of [`MEDIA:${tinyPngFile}`, `  MEDIA :  ${tinyPngFile}`]) {
      const result = await loadWebMedia(input, 1024 * 1024);
      expect(result.kind).toBe("image");
      expect(result.buffer.length).toBeGreaterThan(0);
    }
  });

  it("compresses large local images under the provided cap", async () => {
    const { buffer, file } = await createLargeTestJpeg();

    const cap = Math.floor(buffer.length * 0.8);
    const result = await loadWebMedia(file, cap);

    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeLessThanOrEqual(cap);
    expect(result.buffer.length).toBeLessThan(buffer.length);
  });

  it("optimizes images when options object omits optimizeImages", async () => {
    const { buffer, file } = await createLargeTestJpeg();
    const cap = Math.max(1, Math.floor(buffer.length * 0.8));

    const result = await loadWebMedia(file, { maxBytes: cap });

    expect(result.buffer.length).toBeLessThanOrEqual(cap);
    expect(result.buffer.length).toBeLessThan(buffer.length);
  });

  it("allows callers to disable optimization via options object", async () => {
    const { buffer, file } = await createLargeTestJpeg();
    const cap = Math.max(1, Math.floor(buffer.length * 0.8));

    await expect(loadWebMedia(file, { maxBytes: cap, optimizeImages: false })).rejects.toThrow(
      /Media exceeds/i,
    );
  });

  it("sniffs mime before extension when loading local files", async () => {
    const result = await loadWebMedia(tinyPngWrongExtFile, 1024 * 1024);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/png");
  });

  it("includes URL + status in fetch errors", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      body: true,
      text: async () => "Not Found",
      headers: { get: () => null },
      status: 404,
      statusText: "Not Found",
      url: "https://example.com/missing.jpg",
    } as unknown as Response);

    await expect(loadWebMedia("https://example.com/missing.jpg", 1024 * 1024)).rejects.toThrow(
      /Failed to fetch media from https:\/\/example\.com\/missing\.jpg.*HTTP 404/i,
    );

    fetchMock.mockRestore();
  });

  it("blocks SSRF URLs before fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const cases = [
      {
        name: "private network host",
        url: "http://127.0.0.1:8080/internal-api",
        expectedMessage: /blocked|private|internal/i,
      },
      {
        name: "cloud metadata hostname",
        url: "http://metadata.google.internal/computeMetadata/v1/",
        expectedMessage: /blocked|private|internal|metadata/i,
      },
    ] as const;

    for (const testCase of cases) {
      await expect(loadWebMedia(testCase.url, 1024 * 1024), testCase.name).rejects.toThrow(
        testCase.expectedMessage,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("respects maxBytes for raw URL fetches", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      body: true,
      arrayBuffer: async () => Buffer.alloc(2048).buffer,
      headers: {
        get: (name: string) => (name === "content-type" ? "image/png" : null),
      },
      status: 200,
    } as unknown as Response);

    await expect(loadWebMediaRaw("https://example.com/too-big.png", 1024)).rejects.toThrow(
      /exceeds maxBytes 1024/i,
    );

    fetchMock.mockRestore();
  });

  it("keeps raw mode when options object sets optimizeImages true", async () => {
    const { buffer, file } = await createLargeTestJpeg();
    const cap = Math.max(1, Math.floor(buffer.length * 0.8));

    await expect(
      loadWebMediaRaw(file, {
        maxBytes: cap,
        optimizeImages: true,
      }),
    ).rejects.toThrow(/Media exceeds/i);
  });

  it("uses content-disposition filename when available", async () => {
    const pdfBytes = Buffer.from("%PDF-1.4");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      body: true,
      arrayBuffer: async () =>
        pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength),
      headers: {
        get: (name: string) => {
          if (name === "content-disposition") {
            return 'attachment; filename="report.pdf"';
          }
          if (name === "content-type") {
            return "application/pdf";
          }
          return null;
        },
      },
      status: 200,
    } as unknown as Response);

    const result = await loadWebMedia("https://example.com/download?id=1", 1024 * 1024);

    expect(result.kind).toBe("document");
    expect(result.fileName).toBe("report.pdf");

    fetchMock.mockRestore();
  });

  it("preserves GIF from URL without JPEG conversion", async () => {
    const gifBytes = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x01, 0x44, 0x00, 0x3b,
    ]);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      body: true,
      arrayBuffer: async () =>
        gifBytes.buffer.slice(gifBytes.byteOffset, gifBytes.byteOffset + gifBytes.byteLength),
      headers: {
        get: (name: string) => (name === "content-type" ? "image/gif" : null),
      },
      status: 200,
    } as unknown as Response);

    const result = await loadWebMedia("https://example.com/animation.gif", 1024 * 1024);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/gif");
    expect(result.buffer.slice(0, 3).toString()).toBe("GIF");

    fetchMock.mockRestore();
  });

  it("preserves PNG alpha when under the cap", async () => {
    const result = await loadWebMedia(alphaPngFile, 1024 * 1024);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/png");
    expect(result.buffer[25]).toBe(6);
  });

  it("falls back to JPEG when PNG alpha cannot fit under cap", async () => {
    const result = await loadWebMedia(fallbackPngFile, fallbackPngCap);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/jpeg");
    expect(result.buffer.length).toBeLessThanOrEqual(fallbackPngCap);
  });
});

describe("local media root guard", () => {
  it("rejects local paths outside allowed roots", async () => {
    // Explicit roots that don't contain the temp file.
    await expectLocalMediaAccessCode(
      loadWebMedia(tinyPngFile, 1024 * 1024, { localRoots: ["/nonexistent-root"] }),
      "path-not-allowed",
    );
  });

  it("allows local paths under an explicit root", async () => {
    const result = await loadWebMedia(tinyPngFile, 1024 * 1024, {
      localRoots: [resolvePreferredOpenClawTmpDir()],
    });
    expect(result.kind).toBe("image");
  });

  it("rejects remote-host file URLs before filesystem checks", async () => {
    const realpathSpy = vi.spyOn(fs, "realpath");

    try {
      await expectLocalMediaAccessCode(
        loadWebMedia("file://attacker/share/evil.png", 1024 * 1024, {
          localRoots: [resolvePreferredOpenClawTmpDir()],
        }),
        "invalid-file-url",
      );
      expect(realpathSpy).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("accepts win32 dev=0 stat mismatch for local file loads", async () => {
    const actualLstat = await fs.lstat(tinyPngFile);
    const actualStat = await fs.stat(tinyPngFile);
    const zeroDev = typeof actualLstat.dev === "bigint" ? 0n : 0;
    // Resolve before mocking platform: under `win32` the helper returns the
    // os.tmpdir() fallback rather than the POSIX `/tmp/openclaw` root that
    // actually holds `tinyPngFile` on this Linux test runner (#60713).
    const realTmpRoot = resolvePreferredOpenClawTmpDir();

    await withMockedWindowsPlatform(async () => {
      const lstatSpy = vi
        .spyOn(fs, "lstat")
        .mockResolvedValue(cloneStatWithDev(actualLstat, zeroDev));
      const statSpy = vi.spyOn(fs, "stat").mockResolvedValue(cloneStatWithDev(actualStat, zeroDev));

      await withRestoredMocks([lstatSpy, statSpy], async () => {
        const result = await loadWebMedia(tinyPngFile, 1024 * 1024, {
          localRoots: [realTmpRoot],
        });
        expect(result.kind).toBe("image");
        expect(result.buffer.length).toBeGreaterThan(0);
      });
    });
  });

  it("rejects Windows network paths before filesystem checks", async () => {
    const realTmpRoot = resolvePreferredOpenClawTmpDir();

    await withMockedWindowsPlatform(async () => {
      const realpathSpy = vi.spyOn(fs, "realpath");

      await withRestoredMocks([realpathSpy], async () => {
        await expectLocalMediaAccessCode(
          loadWebMedia("\\\\attacker\\share\\evil.png", 1024 * 1024, {
            localRoots: [realTmpRoot],
          }),
          "network-path-not-allowed",
        );
        expect(realpathSpy).not.toHaveBeenCalled();
      });
    });
  });

  it("requires readFile override for localRoots bypass", async () => {
    await expectLocalMediaAccessCode(
      loadWebMedia(tinyPngFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
      }),
      "unsafe-bypass",
    );
  });

  it("allows any path when localRoots is 'any'", async () => {
    const result = await loadWebMedia(tinyPngFile, {
      maxBytes: 1024 * 1024,
      localRoots: "any",
      readFile: (filePath) => fs.readFile(filePath),
    });
    expect(result.kind).toBe("image");
  });

  it("rejects filesystem root entries in localRoots", async () => {
    await expectLocalMediaAccessCode(
      loadWebMedia(tinyPngFile, 1024 * 1024, {
        localRoots: [path.parse(tinyPngFile).root],
      }),
      "invalid-root",
    );
  });

  it("allows default OpenClaw state workspace and sandbox roots", async () => {
    const stateDir = resolveStateDir();
    const readFile = vi.fn(async () => Buffer.from("generated-media"));

    const workspaceResult = await loadWebMedia(
      path.join(stateDir, "workspace", "tmp", "render.bin"),
      {
        maxBytes: 1024 * 1024,
        readFile,
      },
    );
    expect(workspaceResult.kind).toBeUndefined();

    const sandboxResult = await loadWebMedia(
      path.join(stateDir, "sandboxes", "session-1", "frame.bin"),
      {
        maxBytes: 1024 * 1024,
        readFile,
      },
    );
    expect(sandboxResult.kind).toBeUndefined();
  });

  it("rejects default OpenClaw state per-agent workspace-* roots without explicit local roots", async () => {
    const stateDir = resolveStateDir();
    const readFile = vi.fn(async () => Buffer.from("generated-media"));

    await expectLocalMediaAccessCode(
      loadWebMedia(path.join(stateDir, "workspace-clawdy", "tmp", "render.bin"), {
        maxBytes: 1024 * 1024,
        readFile,
      }),
      "path-not-allowed",
    );
  });

  it("allows per-agent workspace-* paths with explicit local roots", async () => {
    const stateDir = resolveStateDir();
    const readFile = vi.fn(async () => Buffer.from("generated-media"));
    const agentWorkspaceDir = path.join(stateDir, "workspace-clawdy");

    const result = await loadWebMedia(path.join(agentWorkspaceDir, "tmp", "render.bin"), {
      maxBytes: 1024 * 1024,
      localRoots: [agentWorkspaceDir],
      readFile,
    });
    expect(result.kind).toBeUndefined();
  });
});
