// Signal tests cover install signal cli plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import JSZip from "jszip";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseAsset } from "./install-signal-cli.js";

const {
  fetchWithSsrFGuardMock,
  resolveBrewExecutableMock,
  runPluginCommandWithTimeoutMock,
  tempDownloadPaths,
} = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  resolveBrewExecutableMock: vi.fn(),
  runPluginCommandWithTimeoutMock: vi.fn(),
  tempDownloadPaths: [] as string[],
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("openclaw/plugin-sdk/setup-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/setup-tools")>();
  return {
    ...actual,
    resolveBrewExecutable: resolveBrewExecutableMock,
  };
});

vi.mock("openclaw/plugin-sdk/run-command", () => ({
  runPluginCommandWithTimeout: runPluginCommandWithTimeoutMock,
}));

vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>();
  return {
    ...actual,
    withTempDownloadPath: async (
      params: { prefix: string; fileName?: string; tmpDir?: string },
      run: (tmpPath: string) => Promise<unknown>,
    ) =>
      await actual.withTempDownloadPath(params, async (tmpPath) => {
        tempDownloadPaths.push(tmpPath);
        return await run(tmpPath);
      }),
  };
});

const {
  downloadToFile,
  extractSignalCliArchive,
  installSignalCli,
  installSignalCliFromRelease,
  looksLikeArchive,
  MAX_SIGNAL_CLI_EXTRACTED_BYTES,
  pickAsset,
} = await import("./install-signal-cli.js");

const SAMPLE_ASSETS: ReleaseAsset[] = [
  {
    name: "signal-cli-0.13.14-Linux-native.tar.gz",
    browser_download_url: "https://example.com/linux-native.tar.gz",
  },
  {
    name: "signal-cli-0.13.14-Linux-native.tar.gz.asc",
    browser_download_url: "https://example.com/linux-native.tar.gz.asc",
  },
  {
    name: "signal-cli-0.13.14-macOS-native.tar.gz",
    browser_download_url: "https://example.com/macos-native.tar.gz",
  },
  {
    name: "signal-cli-0.13.14-macOS-native.tar.gz.asc",
    browser_download_url: "https://example.com/macos-native.tar.gz.asc",
  },
  {
    name: "signal-cli-0.13.14-Windows-native.zip",
    browser_download_url: "https://example.com/windows-native.zip",
  },
  {
    name: "signal-cli-0.13.14-Windows-native.zip.asc",
    browser_download_url: "https://example.com/windows-native.zip.asc",
  },
  { name: "signal-cli-0.13.14.tar.gz", browser_download_url: "https://example.com/jvm.tar.gz" },
  {
    name: "signal-cli-0.13.14.tar.gz.asc",
    browser_download_url: "https://example.com/jvm.tar.gz.asc",
  },
];

function okDownloadResponse(body: BodyInit, init: ResponseInit = {}) {
  return {
    response: new Response(body, { status: 200, ...init }),
    release: vi.fn().mockResolvedValue(undefined),
  };
}

async function withTempFile(run: (filePath: string) => Promise<void>) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-download-"));
  try {
    await run(path.join(workDir, "signal-cli.tgz"));
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const originalPlatform = process.platform;
const originalArch = process.arch;

function setProcessPlatform(platform: NodeJS.Platform, arch: string) {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  Object.defineProperty(process, "arch", { configurable: true, value: arch });
}

beforeEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  resolveBrewExecutableMock.mockReset();
  runPluginCommandWithTimeoutMock.mockReset();
  tempDownloadPaths.length = 0;
});

afterEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  Object.defineProperty(process, "arch", { configurable: true, value: originalArch });
});

function requireAsset(asset: ReleaseAsset | undefined, label: string): ReleaseAsset {
  if (!asset) {
    throw new Error(`expected release asset for ${label}`);
  }
  return asset;
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
    throw new Error(`expected ${targetPath} to be missing`);
  } catch (error) {
    expect((error as { code?: string }).code).toBe("ENOENT");
  }
}

async function expectTempDownloadDirMissing(): Promise<void> {
  expect(tempDownloadPaths).toHaveLength(1);
  const [tmpPath] = tempDownloadPaths;
  if (!tmpPath) {
    throw new Error("expected one captured temp download path");
  }
  await expectPathMissing(path.dirname(tmpPath));
}

describe("looksLikeArchive", () => {
  it("recognises .tar.gz", () => {
    expect(looksLikeArchive("foo.tar.gz")).toBe(true);
  });

  it("recognises .tgz", () => {
    expect(looksLikeArchive("foo.tgz")).toBe(true);
  });

  it("recognises .zip", () => {
    expect(looksLikeArchive("foo.zip")).toBe(true);
  });

  it("rejects signature files", () => {
    expect(looksLikeArchive("foo.tar.gz.asc")).toBe(false);
  });

  it("rejects unrelated files", () => {
    expect(looksLikeArchive("README.md")).toBe(false);
  });
});

describe("pickAsset", () => {
  describe("linux", () => {
    it("selects the Linux-native asset on x64", () => {
      const result = requireAsset(pickAsset(SAMPLE_ASSETS, "linux", "x64"), "linux x64");
      expect(result.name).toContain("Linux-native");
      expect(result.name).toMatch(/\.tar\.gz$/);
    });

    it("returns undefined on arm64 (triggers brew fallback)", () => {
      const result = pickAsset(SAMPLE_ASSETS, "linux", "arm64");
      expect(result).toBeUndefined();
    });

    it("returns undefined on arm (32-bit)", () => {
      const result = pickAsset(SAMPLE_ASSETS, "linux", "arm");
      expect(result).toBeUndefined();
    });
  });

  describe("darwin", () => {
    it("selects the macOS-native asset", () => {
      const result = requireAsset(pickAsset(SAMPLE_ASSETS, "darwin", "arm64"), "darwin arm64");
      expect(result.name).toContain("macOS-native");
    });

    it("selects the macOS-native asset on x64", () => {
      const result = requireAsset(pickAsset(SAMPLE_ASSETS, "darwin", "x64"), "darwin x64");
      expect(result.name).toContain("macOS-native");
    });

    it("does not fall back to Linux client archives when macOS assets are absent", () => {
      const currentUpstreamAssets: ReleaseAsset[] = [
        {
          name: "signal-cli-0.14.5-Linux-client.tar.gz",
          browser_download_url: "https://example.com/linux-client.tar.gz",
        },
        {
          name: "signal-cli-0.14.5-Linux-native.tar.gz",
          browser_download_url: "https://example.com/linux-native.tar.gz",
        },
        {
          name: "signal-cli-0.14.5.tar.gz",
          browser_download_url: "https://example.com/jvm.tar.gz",
        },
      ];

      expect(pickAsset(currentUpstreamAssets, "darwin", "arm64")).toBeUndefined();
    });
  });

  describe("win32", () => {
    it("selects the Windows-native asset", () => {
      const result = requireAsset(pickAsset(SAMPLE_ASSETS, "win32", "x64"), "win32 x64");
      expect(result.name).toContain("Windows-native");
      expect(result.name).toMatch(/\.zip$/);
    });
  });

  describe("edge cases", () => {
    it("returns undefined for an empty asset list", () => {
      expect(pickAsset([], "linux", "x64")).toBeUndefined();
    });

    it("skips assets with missing name or url", () => {
      const partial: ReleaseAsset[] = [
        { name: "signal-cli.tar.gz" },
        { browser_download_url: "https://example.com/file.tar.gz" },
      ];
      expect(pickAsset(partial, "linux", "x64")).toBeUndefined();
    });

    it("falls back to first archive for unknown platform", () => {
      const result = requireAsset(
        pickAsset(SAMPLE_ASSETS, "freebsd" as NodeJS.Platform, "x64"),
        "unknown platform",
      );
      expect(result.name).toMatch(/\.tar\.gz$/);
    });

    it("never selects .asc signature files", () => {
      const result = requireAsset(pickAsset(SAMPLE_ASSETS, "linux", "x64"), "linux x64");
      expect(result.name).not.toMatch(/\.asc$/);
    });
  });
});

describe("downloadToFile", () => {
  it("cancels non-success response bodies before rejecting", async () => {
    const response = new Response("service unavailable", { status: 503 });
    const cancel = vi.spyOn(response.body!, "cancel").mockRejectedValueOnce(new Error("closed"));
    fetchWithSsrFGuardMock.mockResolvedValue({ response, release: vi.fn() });

    await withTempFile(async (filePath) => {
      await expect(downloadToFile("https://example.com/signal-cli.tgz", filePath)).rejects.toThrow(
        "HTTP 503",
      );
    });

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("downloads through the SSRF guard with an explicit timeout", async () => {
    const fetchResult = okDownloadResponse("archive");
    fetchWithSsrFGuardMock.mockResolvedValue(fetchResult);

    await withTempFile(async (filePath) => {
      await downloadToFile("https://example.com/signal-cli.tgz", filePath);

      await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("archive");
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://example.com/signal-cli.tgz",
      maxRedirects: 5,
      requireHttps: true,
      timeoutMs: 5 * 60_000,
      capture: false,
      auditContext: "signal-cli-install-archive",
    });
    expect(fetchResult.release).toHaveBeenCalledTimes(1);
  });

  it("rejects declared archives above the download cap", async () => {
    const fetchResult = okDownloadResponse("archive", {
      headers: { "content-length": "12" },
    });
    fetchWithSsrFGuardMock.mockResolvedValue(fetchResult);

    await withTempFile(async (filePath) => {
      await expect(
        downloadToFile("https://example.com/signal-cli.tgz", filePath, 5, 8),
      ).rejects.toThrow("declared 12");

      await expectPathMissing(filePath);
    });

    expect(fetchResult.release).toHaveBeenCalledTimes(1);
  });

  it.each(["1e3", "0x10", `1${"0".repeat(309)}`])(
    "ignores malformed declared archive lengths: %s",
    async (contentLength) => {
      const fetchResult = okDownloadResponse("archive", {
        headers: { "content-length": contentLength },
      });
      fetchWithSsrFGuardMock.mockResolvedValue(fetchResult);

      await withTempFile(async (filePath) => {
        await downloadToFile("https://example.com/signal-cli.tgz", filePath, 5, 8);

        await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("archive");
      });

      expect(fetchResult.release).toHaveBeenCalledTimes(1);
    },
  );

  it("aborts streamed archives above the download cap and removes partial files", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
        controller.close();
      },
    });
    const fetchResult = okDownloadResponse(body);
    fetchWithSsrFGuardMock.mockResolvedValue(fetchResult);

    await withTempFile(async (filePath) => {
      await expect(
        downloadToFile("https://example.com/signal-cli.tgz", filePath, 5, 8),
      ).rejects.toThrow("8-byte download cap");

      await expectPathMissing(filePath);
    });

    expect(fetchResult.release).toHaveBeenCalledTimes(1);
  });
});

describe("installSignalCliFromRelease", () => {
  it("cancels non-success release metadata before returning the fetch error", async () => {
    const response = new Response("service unavailable", { status: 503 });
    const cancel = vi.spyOn(response.body!, "cancel").mockRejectedValueOnce(new Error("closed"));
    const release = vi.fn().mockResolvedValue(undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({ response, release });

    await expect(
      installSignalCliFromRelease({ log: vi.fn() } as unknown as RuntimeEnv),
    ).resolves.toEqual({
      ok: false,
      error: "Failed to fetch release info (503)",
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns an installer error when GitHub release metadata is malformed JSON", async () => {
    const fetchResult = okDownloadResponse("{not json", {
      headers: { "content-type": "application/json" },
    });
    fetchWithSsrFGuardMock.mockResolvedValue(fetchResult);

    const result = await installSignalCliFromRelease({ log: vi.fn() } as unknown as RuntimeEnv);

    expect(result).toEqual({
      ok: false,
      error: "Failed to parse signal-cli release info.",
    });
    expect(fetchResult.release).toHaveBeenCalledTimes(1);
  });

  it("bounds oversized GitHub release metadata and cancels the stream", async () => {
    const chunkSize = 1024 * 1024;
    const chunkCount = 20; // 20 MiB — over the 16 MiB cap
    let readCount = 0;
    let canceled = false;
    const oversized = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (readCount >= chunkCount) {
            controller.close();
            return;
          }
          readCount += 1;
          controller.enqueue(new Uint8Array(chunkSize));
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    const releaseMock = vi.fn().mockResolvedValue(undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({ response: oversized, release: releaseMock });

    const result = await installSignalCliFromRelease({ log: vi.fn() } as unknown as RuntimeEnv);

    expect(result).toEqual({ ok: false, error: "Failed to parse signal-cli release info." });
    expect(canceled).toBe(true);
    expect(readCount).toBeLessThan(chunkCount);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("bounds the release metadata request with an explicit timeout", async () => {
    const fetchResult = okDownloadResponse(JSON.stringify({ tag_name: "v0.14.3", assets: [] }), {
      headers: { "content-type": "application/json" },
    });
    fetchWithSsrFGuardMock.mockResolvedValue(fetchResult);

    const result = await installSignalCliFromRelease({ log: vi.fn() } as unknown as RuntimeEnv);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("No compatible release asset found for this platform.");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://api.github.com/repos/AsamK/signal-cli/releases/latest",
      maxRedirects: 5,
      requireHttps: true,
      timeoutMs: 30_000,
      capture: false,
      auditContext: "signal-cli-release-info",
      init: {
        headers: {
          "User-Agent": "openclaw",
          Accept: "application/vnd.github+json",
        },
      },
    });
    expect(fetchResult.release).toHaveBeenCalledTimes(1);
  });

  it("removes the download temp dir even when extraction fails", async () => {
    setProcessPlatform("linux", "x64");
    fetchWithSsrFGuardMock.mockResolvedValueOnce(
      okDownloadResponse(
        JSON.stringify({
          tag_name: "v0.0.0-leak-test",
          assets: [
            {
              name: "signal-cli-0.0.0-Linux-native.tar.gz",
              browser_download_url: "https://example.com/linux-native.tar.gz",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    fetchWithSsrFGuardMock.mockResolvedValueOnce(okDownloadResponse("not-a-real-archive"));

    const result = await installSignalCliFromRelease({ log: vi.fn() } as unknown as RuntimeEnv);

    expect(result.ok).toBe(false);
    await expectTempDownloadDirMissing();
  });

  it("removes the download temp dir on the success path too", async () => {
    setProcessPlatform("linux", "x64");
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-staging-"));
    try {
      const inner = path.join(staging, "signal-cli-0.0.0-success-test");
      await fs.mkdir(inner, { recursive: true });
      await fs.writeFile(path.join(inner, "signal-cli"), "#!/bin/sh\necho ok\n", "utf-8");
      const archivePath = path.join(staging, "signal-cli-0.0.0-Linux-native.tar.gz");
      await tar.c({ cwd: staging, file: archivePath, gzip: true }, [
        "signal-cli-0.0.0-success-test",
      ]);
      const archiveBytes = await fs.readFile(archivePath);

      fetchWithSsrFGuardMock.mockResolvedValueOnce(
        okDownloadResponse(
          JSON.stringify({
            tag_name: "v0.0.0-success-test",
            assets: [
              {
                name: "signal-cli-0.0.0-Linux-native.tar.gz",
                browser_download_url: "https://example.com/linux-native.tar.gz",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
      fetchWithSsrFGuardMock.mockResolvedValueOnce(okDownloadResponse(archiveBytes));

      const result = await installSignalCliFromRelease({ log: vi.fn() } as unknown as RuntimeEnv);

      expect(result.ok).toBe(true);
      if (!result.cliPath) {
        throw new Error("expected the installed signal-cli path");
      }
      const installedStat = await fs.stat(result.cliPath);
      expect(installedStat.isFile()).toBe(true);
      expect(installedStat.mode & 0o111).not.toBe(0);
      await expectTempDownloadDirMissing();
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("removes the download temp dir when the download throws", async () => {
    setProcessPlatform("linux", "x64");
    fetchWithSsrFGuardMock.mockResolvedValueOnce(
      okDownloadResponse(
        JSON.stringify({
          tag_name: "v0.0.0-download-failure-test",
          assets: [
            {
              name: "signal-cli-0.0.0-Linux-native.tar.gz",
              browser_download_url: "https://example.com/linux-native.tar.gz",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("download failed"));

    await expect(
      installSignalCliFromRelease({ log: vi.fn() } as unknown as RuntimeEnv),
    ).rejects.toThrow("download failed");

    await expectTempDownloadDirMissing();
  });
});

describe("installSignalCli", () => {
  it("uses Homebrew on macOS instead of downloading the first GitHub release archive", async () => {
    setProcessPlatform("darwin", "arm64");
    const brewPrefix = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-brew-"));
    await fs.mkdir(path.join(brewPrefix, "bin"), { recursive: true });
    await fs.writeFile(path.join(brewPrefix, "bin", "signal-cli"), "");
    resolveBrewExecutableMock.mockReturnValue("/opt/homebrew/bin/brew");
    runPluginCommandWithTimeoutMock
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: `${brewPrefix}\n`, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "signal-cli 0.14.5\n", stderr: "" });

    try {
      const result = await installSignalCli({ log: vi.fn() } as unknown as RuntimeEnv);

      expect(result).toEqual({
        ok: true,
        cliPath: path.join(brewPrefix, "bin", "signal-cli"),
        version: "0.14.5",
      });
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(brewPrefix, { recursive: true, force: true });
    }
  });
});

describe("extractSignalCliArchive", () => {
  async function withArchiveWorkspace(run: (workDir: string) => Promise<void>) {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-install-"));
    try {
      await run(workDir);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function expectExtractedSignalCli(archivePath: string, extractDir: string) {
    await extractSignalCliArchive(archivePath, extractDir, 5_000);

    const extracted = await fs.readFile(path.join(extractDir, "root", "signal-cli"), "utf-8");
    expect(extracted).toBe("bin");
  }

  it("rejects zip slip path traversal", async () => {
    await withArchiveWorkspace(async (workDir) => {
      const archivePath = path.join(workDir, "bad.zip");
      const extractDir = path.join(workDir, "extract");
      await fs.mkdir(extractDir, { recursive: true });

      const zip = new JSZip();
      zip.file("../pwned.txt", "pwnd");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

      await expect(extractSignalCliArchive(archivePath, extractDir, 5_000)).rejects.toThrow(
        /(escapes destination|absolute)/i,
      );
    });
  });

  it("extracts zip archives", async () => {
    await withArchiveWorkspace(async (workDir) => {
      const archivePath = path.join(workDir, "ok.zip");
      const extractDir = path.join(workDir, "extract");
      await fs.mkdir(extractDir, { recursive: true });

      const zip = new JSZip();
      zip.file("root/signal-cli", "bin");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

      await expectExtractedSignalCli(archivePath, extractDir);
    });
  });

  it("extracts tar.gz archives", async () => {
    await withArchiveWorkspace(async (workDir) => {
      const archivePath = path.join(workDir, "ok.tgz");
      const extractDir = path.join(workDir, "extract");
      const rootDir = path.join(workDir, "root");
      await fs.mkdir(rootDir, { recursive: true });
      await fs.writeFile(path.join(rootDir, "signal-cli"), "bin", "utf-8");
      await tar.c({ cwd: workDir, file: archivePath, gzip: true }, ["root"]);

      await fs.mkdir(extractDir, { recursive: true });
      await expectExtractedSignalCli(archivePath, extractDir);
    });
  });

  it("rejects native entries beyond the Signal-specific extraction limit", async () => {
    await withArchiveWorkspace(async (workDir) => {
      const archivePath = path.join(workDir, "oversized.tgz");
      const extractDir = path.join(workDir, "extract");
      const headerBlock = Buffer.alloc(512);
      const header = new tar.Header({
        path: "signal-cli",
        type: "File",
        mode: 0o755,
        size: MAX_SIGNAL_CLI_EXTRACTED_BYTES + 1,
      });
      header.encode(headerBlock);
      await fs.writeFile(archivePath, gzipSync(Buffer.concat([headerBlock, Buffer.alloc(1024)])));
      await fs.mkdir(extractDir, { recursive: true });

      await expect(extractSignalCliArchive(archivePath, extractDir, 5_000)).rejects.toThrow(
        "archive entry extracted size exceeds limit",
      );
      await expectPathMissing(path.join(extractDir, "signal-cli"));
    });
  });
});
