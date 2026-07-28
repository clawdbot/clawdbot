// Browser tests cover proxy files plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-support.js";
import { BROWSER_PROXY_MAX_FILE_BYTES } from "../browser-proxy-envelope.js";
import { applyBrowserProxyPaths, persistBrowserProxyFiles } from "./proxy-files.js";

const BROWSER_PROXY_MAX_FILES = 256;
const BROWSER_PROXY_MAX_TOTAL_FILE_BYTES = 16 * 1024 * 1024;

describe("persistBrowserProxyFiles", () => {
  let tempHome: TempHomeEnv;

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-browser-proxy-files-");
  });

  afterEach(async () => {
    await tempHome.restore();
  });

  it("persists browser proxy files under the shared media store", async () => {
    const sourcePath = "/tmp/proxy-file.txt";
    const mapping = await persistBrowserProxyFiles([
      {
        path: sourcePath,
        base64: Buffer.from("hello from browser proxy").toString("base64"),
        mimeType: "text/plain",
      },
    ]);

    const savedPath = mapping.get(sourcePath);
    expect(typeof savedPath).toBe("string");
    expect(path.normalize(savedPath ?? "")).toContain(
      `${path.sep}.openclaw${path.sep}media${path.sep}browser${path.sep}`,
    );
    await expect(fs.readFile(savedPath ?? "", "utf8")).resolves.toBe("hello from browser proxy");
  });

  it("persists a file at the proxy limit above the shared media default", async () => {
    const sourcePath = "/tmp/above-default.bin";
    const buffer = Buffer.alloc(BROWSER_PROXY_MAX_FILE_BYTES, 0x41);
    const mapping = await persistBrowserProxyFiles([
      {
        path: sourcePath,
        base64: buffer.toString("base64"),
        mimeType: "application/octet-stream",
      },
    ]);

    await expect(fs.stat(mapping.get(sourcePath) ?? "")).resolves.toMatchObject({
      size: buffer.byteLength,
    });
  });

  it("rejects an oversized aggregate before persisting any files", async () => {
    const first = Buffer.alloc(BROWSER_PROXY_MAX_FILE_BYTES, 0x41);
    const second = Buffer.alloc(
      BROWSER_PROXY_MAX_TOTAL_FILE_BYTES - BROWSER_PROXY_MAX_FILE_BYTES + 1,
      0x42,
    );

    const error = await persistBrowserProxyFiles([
      {
        path: "/tmp/first.bin",
        base64: first.toString("base64"),
        mimeType: "application/octet-stream",
      },
      {
        path: "/tmp/second.bin",
        base64: second.toString("base64"),
        mimeType: "application/octet-stream",
      },
    ]).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("browser proxy files exceed 16 MiB aggregate limit");

    await expect(
      fs.stat(path.join(tempHome.home, ".openclaw", "media", "browser")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects a file above the proxy per-file limit", async () => {
    const oversized = Buffer.alloc(BROWSER_PROXY_MAX_FILE_BYTES + 1, 0x41);
    const error = await persistBrowserProxyFiles([
      {
        path: "/tmp/oversized.bin",
        base64: oversized.toString("base64"),
        mimeType: "application/octet-stream",
      },
    ]).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("browser proxy file exceeds 10 MiB limit");

    await expect(
      fs.stat(path.join(tempHome.home, ".openclaw", "media", "browser")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects too many files before persisting any", async () => {
    const files = Array.from({ length: BROWSER_PROXY_MAX_FILES + 1 }, (_, index) => ({
      path: `/tmp/file-${index}.bin`,
      base64: "",
      mimeType: "application/octet-stream",
    }));

    await expect(persistBrowserProxyFiles(files)).rejects.toThrow(
      "browser proxy response exceeds 256 file limit",
    );
    await expect(
      fs.stat(path.join(tempHome.home, ".openclaw", "media", "browser")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rewrites explicit proxy file paths without traversing nested page data", () => {
    const result = {
      ok: true,
      path: "/node/screenshot.png",
      imagePath: "/node/snapshot.png",
      download: { path: "/node/download.csv", suggestedFilename: "download.csv" },
      downloads: [
        { path: "/node/first.pdf", suggestedFilename: "first.pdf" },
        null,
        { path: 42 },
        { path: "/node/second.pdf", suggestedFilename: "second.pdf" },
        { path: "/node/first.pdf", suggestedFilename: "first-copy.pdf" },
      ],
      result: {
        path: "/node/page-controlled.txt",
        downloads: [{ path: "/node/page-controlled-download.txt" }],
      },
    };

    applyBrowserProxyPaths(
      result,
      new Map([
        ["/node/screenshot.png", "/gateway/screenshot.png"],
        ["/node/snapshot.png", "/gateway/snapshot.png"],
        ["/node/download.csv", "/gateway/download.csv"],
        ["/node/first.pdf", "/gateway/first.pdf"],
        ["/node/second.pdf", "/gateway/second.pdf"],
        ["/node/page-controlled.txt", "/gateway/should-not-rewrite.txt"],
        ["/node/page-controlled-download.txt", "/gateway/should-not-rewrite-download.txt"],
      ]),
    );

    expect(result).toEqual({
      ok: true,
      path: "/gateway/screenshot.png",
      imagePath: "/gateway/snapshot.png",
      download: { path: "/gateway/download.csv", suggestedFilename: "download.csv" },
      downloads: [
        { path: "/gateway/first.pdf", suggestedFilename: "first.pdf" },
        null,
        { path: 42 },
        { path: "/gateway/second.pdf", suggestedFilename: "second.pdf" },
        { path: "/gateway/first.pdf", suggestedFilename: "first-copy.pdf" },
      ],
      result: {
        path: "/node/page-controlled.txt",
        downloads: [{ path: "/node/page-controlled-download.txt" }],
      },
    });
  });
});
