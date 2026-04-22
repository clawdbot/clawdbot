import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { optimizeImageToPng } from "openclaw/plugin-sdk/media-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { captureEnv } from "openclaw/plugin-sdk/testing";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/testing";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sendVoiceMessageDiscord } from "../../discord/src/send.js";
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
let fallbackPngBuffer: Buffer;
let fallbackPngFile = "";
let fallbackPngCap = 0;
let stateDirSnapshot: ReturnType<typeof captureEnv>;

async function writeTempFile(buffer: Buffer, ext: string): Promise<string> {
  const file = path.join(fixtureRoot, `media-${fixtureFileCount++}${ext}`);
  await fs.writeFile(file, buffer);
  return file;
}

function buildDeterministicBytes(length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let seed = 0x12345678;
  for (let i = 0; i < length; i++) {
    seed = (1103515245 * seed + 12345) & 0x7fffffff;
    buffer[i] = seed & 0xff;
  }
  return buffer;
}

async function createLargeTestJpeg(): Promise<{ buffer: Buffer; file: string }> {
  return { buffer: largeJpegBuffer, file: largeJpegFile };
}

function cloneStatWithDev<T extends { dev: number | bigint }>(stat: T, dev: number | bigint): T {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev }) as T;
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-media-test-"),
  );
  largeJpegBuffer = await sharp({
    create: {
      width: 400,
      height: 400,
      channels: 3,
      background: "#ff0000",
    },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
  largeJpegFile = await writeTempFile(largeJpegBuffer, ".jpg");
  tinyPngBuffer = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "#00ff00" },
  })
    .png()
    .toBuffer();
  tinyPngFile = await writeTempFile(tinyPngBuffer, ".png");
  tinyPngWrongExtFile = await writeTempFile(tinyPngBuffer, ".bin");
  alphaPngBuffer = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  alphaPngFile = await writeTempFile(alphaPngBuffer, ".png");
  // Keep this small so the alpha-fallback test stays deterministic but fast.
  const size = 24;
  const raw = buildDeterministicBytes(size * size * 4);
  fallbackPngBuffer = await sharp(raw, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer();
  fallbackPngFile = await writeTempFile(fallbackPngBuffer, ".png");
  const smallestPng = await optimizeImageToPng(fallbackPngBuffer, 1);
  fallbackPngCap = Math.max(1, smallestPng.optimizedSize - 1);
  const jpegOptimized = await optimizeImageToJpeg(fallbackPngBuffer, fallbackPngCap);
  if (jpegOptimized.buffer.length >= smallestPng.optimizedSize) {
    throw new Error(
      `JPEG fallback did not shrink below PNG (jpeg=${jpegOptimized.buffer.length}, png=${smallestPng.optimizedSize})`,
    );
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
    expect(result.contentType).toBe("image/jpeg");
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
      headers: { get: () => "image/png" },
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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      body: true,
      arrayBuffer: async () => Buffer.from("%PDF-1.4").buffer,
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
      headers: { get: () => "image/gif" },
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
    const meta = await sharp(result.buffer).metadata();
    expect(meta.hasAlpha).toBe(true);
  });

  it("falls back to JPEG when PNG alpha cannot fit under cap", async () => {
    const result = await loadWebMedia(fallbackPngFile, fallbackPngCap);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/jpeg");
    expect(result.buffer.length).toBeLessThanOrEqual(fallbackPngCap);
  });
});

describe("Discord voice message input hardening", () => {
  it("rejects unsafe voice message inputs", async () => {
    const cases = [
      {
        name: "local path outside allowed media roots",
        candidate: path.join(process.cwd(), "package.json"),
        expectedMessage: /Local media path is not under an allowed directory/i,
      },
      {
        name: "private-network URL",
        candidate: "http://127.0.0.1/voice.ogg",
        expectedMessage: /Failed to fetch media|Blocked|private|internal/i,
      },
      {
        name: "non-http URL scheme",
        candidate: "rtsp://example.com/voice.ogg",
        expectedMessage: /Local media path is not under an allowed directory|ENOENT|no such file/i,
      },
    ] as const;

    for (const testCase of cases) {
      await expect(
        sendVoiceMessageDiscord("channel:123", testCase.candidate, { cfg: {} as never }),
        testCase.name,
      ).rejects.toThrow(testCase.expectedMessage);
    }
  });
});

describe("local media root guard", () => {
  it("rejects local paths outside allowed roots", async () => {
    // Explicit roots that don't contain the temp file.
    await expect(
      loadWebMedia(tinyPngFile, 1024 * 1024, { localRoots: ["/nonexistent-root"] }),
    ).rejects.toMatchObject({ code: "path-not-allowed" });
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
      await expect(
        loadWebMedia("file://attacker/share/evil.png", 1024 * 1024, {
          localRoots: [resolvePreferredOpenClawTmpDir()],
        }),
      ).rejects.toMatchObject({ code: "invalid-file-url" });
      expect(realpathSpy).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("accepts win32 dev=0 stat mismatch for local file loads", async () => {
    const actualLstat = await fs.lstat(tinyPngFile);
    const actualStat = await fs.stat(tinyPngFile);
    const zeroDev = typeof actualLstat.dev === "bigint" ? 0n : 0;

    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const lstatSpy = vi
      .spyOn(fs, "lstat")
      .mockResolvedValue(cloneStatWithDev(actualLstat, zeroDev));
    const statSpy = vi.spyOn(fs, "stat").mockResolvedValue(cloneStatWithDev(actualStat, zeroDev));

    try {
      const result = await loadWebMedia(tinyPngFile, 1024 * 1024, {
        localRoots: [resolvePreferredOpenClawTmpDir()],
      });
      expect(result.kind).toBe("image");
      expect(result.buffer.length).toBeGreaterThan(0);
    } finally {
      statSpy.mockRestore();
      lstatSpy.mockRestore();
      platformSpy.mockRestore();
    }
  });

  it("rejects Windows network paths before filesystem checks", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const realpathSpy = vi.spyOn(fs, "realpath");

    try {
      await expect(
        loadWebMedia("\\\\attacker\\share\\evil.png", 1024 * 1024, {
          localRoots: [resolvePreferredOpenClawTmpDir()],
        }),
      ).rejects.toMatchObject({ code: "network-path-not-allowed" });
      expect(realpathSpy).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
      platformSpy.mockRestore();
    }
  });

  it("requires readFile override for localRoots bypass", async () => {
    await expect(
      loadWebMedia(tinyPngFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
      }),
    ).rejects.toBeInstanceOf(LocalMediaAccessError);
    await expect(
      loadWebMedia(tinyPngFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
      }),
    ).rejects.toMatchObject({ code: "unsafe-bypass" });
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
    await expect(
      loadWebMedia(tinyPngFile, 1024 * 1024, {
        localRoots: [path.parse(tinyPngFile).root],
      }),
    ).rejects.toMatchObject({ code: "invalid-root" });
  });

  it("allows default OpenClaw state workspace and sandbox roots", async () => {
    const stateDir = resolveStateDir();
    const readFile = vi.fn(async () => Buffer.from("generated-media"));

    await expect(
      loadWebMedia(path.join(stateDir, "workspace", "tmp", "render.bin"), {
        maxBytes: 1024 * 1024,
        readFile,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: undefined,
      }),
    );

    await expect(
      loadWebMedia(path.join(stateDir, "sandboxes", "session-1", "frame.bin"), {
        maxBytes: 1024 * 1024,
        readFile,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: undefined,
      }),
    );
  });

  it("rejects default OpenClaw state per-agent workspace-* roots without explicit local roots", async () => {
    const stateDir = resolveStateDir();
    const readFile = vi.fn(async () => Buffer.from("generated-media"));

    await expect(
      loadWebMedia(path.join(stateDir, "workspace-clawdy", "tmp", "render.bin"), {
        maxBytes: 1024 * 1024,
        readFile,
      }),
    ).rejects.toMatchObject({ code: "path-not-allowed" });
  });

  it("allows per-agent workspace-* paths with explicit local roots", async () => {
    const stateDir = resolveStateDir();
    const readFile = vi.fn(async () => Buffer.from("generated-media"));
    const agentWorkspaceDir = path.join(stateDir, "workspace-clawdy");

    await expect(
      loadWebMedia(path.join(agentWorkspaceDir, "tmp", "render.bin"), {
        maxBytes: 1024 * 1024,
        localRoots: [agentWorkspaceDir],
        readFile,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: undefined,
      }),
    );
  });
});
