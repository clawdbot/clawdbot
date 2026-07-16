import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import type { ReleaseAsset } from "./install-signal-cli.js";
import { extractSignalCliArchive, looksLikeArchive, pickAsset } from "./install-signal-cli.js";

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
      const result = pickAsset(SAMPLE_ASSETS, "linux", "x64");
      expect(result).toBeDefined();
      expect(result!.name).toContain("Linux-native");
      expect(result!.name).toMatch(/\.tar\.gz$/);
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
      const result = pickAsset(SAMPLE_ASSETS, "darwin", "arm64");
      expect(result).toBeDefined();
      expect(result!.name).toContain("macOS-native");
    });

    it("selects the macOS-native asset on x64", () => {
      const result = pickAsset(SAMPLE_ASSETS, "darwin", "x64");
      expect(result).toBeDefined();
      expect(result!.name).toContain("macOS-native");
    });
  });

  describe("win32", () => {
    it("selects the Windows-native asset", () => {
      const result = pickAsset(SAMPLE_ASSETS, "win32", "x64");
      expect(result).toBeDefined();
      expect(result!.name).toContain("Windows-native");
      expect(result!.name).toMatch(/\.zip$/);
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
      const result = pickAsset(SAMPLE_ASSETS, "freebsd" as NodeJS.Platform, "x64");
      expect(result).toBeDefined();
      expect(result!.name).toMatch(/\.tar\.gz$/);
    });

    it("never selects .asc signature files", () => {
      const result = pickAsset(SAMPLE_ASSETS, "linux", "x64");
      expect(result).toBeDefined();
      expect(result!.name).not.toMatch(/\.asc$/);
    });
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

      await extractSignalCliArchive(archivePath, extractDir, 5_000);

      const extracted = await fs.readFile(path.join(extractDir, "root", "signal-cli"), "utf-8");
      expect(extracted).toBe("bin");
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
      await extractSignalCliArchive(archivePath, extractDir, 5_000);

      const extracted = await fs.readFile(path.join(extractDir, "root", "signal-cli"), "utf-8");
      expect(extracted).toBe("bin");
    });
  });
});
