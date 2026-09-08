// Browser tests cover proxy files plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { extractOriginalFilename } from "openclaw/plugin-sdk/media-runtime";
import { createTempHomeEnv, type TempHomeEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BROWSER_PROXY_MAX_FILE_BYTES } from "../browser-proxy-envelope.js";
import { persistBrowserProxyResultFiles } from "./proxy-files.js";

const BROWSER_PROXY_MAX_FILES = 256;
const BROWSER_PROXY_MAX_TOTAL_FILE_BYTES = 16 * 1024 * 1024;

describe("persistBrowserProxyResultFiles", () => {
  let tempHome: TempHomeEnv;

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-browser-proxy-files-");
  });

  afterEach(async () => {
    await tempHome.restore();
  });

  it("persists browser proxy files under the shared media store", async () => {
    const sourcePath = "/tmp/proxy-file.txt";
    const result = { path: sourcePath };
    await persistBrowserProxyResultFiles(result, [
      {
        path: sourcePath,
        base64: Buffer.from("hello from browser proxy").toString("base64"),
        mimeType: "text/plain",
      },
    ]);

    const savedPath = result.path;
    expect(typeof savedPath).toBe("string");
    expect(path.normalize(savedPath ?? "")).toContain(
      `${path.sep}.openclaw${path.sep}media${path.sep}browser${path.sep}`,
    );
    await expect(fs.readFile(savedPath ?? "", "utf8")).resolves.toBe("hello from browser proxy");
  });

  it.each([
    { sourcePath: "/tmp/quarterly-report.pdf", expectedFilename: "quarterly-report.pdf" },
    { sourcePath: "C:\\downloads\\quarterly-report.pdf", expectedFilename: "quarterly-report.pdf" },
    { sourcePath: "/tmp/my <file>:test!.bin", expectedFilename: "my_filetest.pdf" },
  ])("preserves a safe filename from $sourcePath", async ({ sourcePath, expectedFilename }) => {
    const contents = "%PDF-1.7 browser proxy download";
    const result = { download: { path: sourcePath, suggestedFilename: "website-title.pdf" } };
    await persistBrowserProxyResultFiles(result, [
      {
        path: sourcePath,
        base64: Buffer.from(contents).toString("base64"),
        mimeType: "application/pdf",
      },
    ]);

    const savedPath = result.download.path;
    expect(path.dirname(savedPath)).toBe(path.join(tempHome.home, ".openclaw", "media", "browser"));
    expect(extractOriginalFilename(savedPath)).toBe(expectedFilename);
    expect(result.download.suggestedFilename).toBe("website-title.pdf");
    await expect(fs.readFile(savedPath, "utf8")).resolves.toBe(contents);
  });

  it("persists legitimate empty browser proxy downloads", async () => {
    const sourcePath = "/tmp/empty-browser-download.bin";
    const result = { path: sourcePath };
    await persistBrowserProxyResultFiles(result, [
      { path: sourcePath, base64: "", mimeType: "application/octet-stream" },
    ]);

    const savedPath = result.path;
    expect(typeof savedPath).toBe("string");
    await expect(fs.stat(savedPath ?? "")).resolves.toMatchObject({ size: 0 });
    await expect(fs.readFile(savedPath ?? "")).resolves.toHaveLength(0);
  });

  it.each([
    { name: "valid unpadded base64", base64: "aGVsbG8" },
    { name: "valid whitespace-separated base64", base64: " aG Vs bG8= \n" },
  ])("persists $name without corrupting the download", async ({ base64 }) => {
    const sourcePath = "/tmp/normalized-browser-download.txt";
    const result = { path: sourcePath };
    await persistBrowserProxyResultFiles(result, [
      { path: sourcePath, base64, mimeType: "text/plain" },
    ]);

    await expect(fs.readFile(result.path, "utf8")).resolves.toBe("hello");
  });

  it("persists a file at the proxy limit above the shared media default", async () => {
    const sourcePath = "/tmp/above-default.bin";
    const buffer = Buffer.alloc(BROWSER_PROXY_MAX_FILE_BYTES, 0x41);
    const result = { path: sourcePath };
    await persistBrowserProxyResultFiles(result, [
      {
        path: sourcePath,
        base64: buffer.toString("base64"),
        mimeType: "application/octet-stream",
      },
    ]);

    await expect(fs.stat(result.path)).resolves.toMatchObject({
      size: buffer.byteLength,
    });
  });

  it("rejects an oversized aggregate before persisting any files", async () => {
    const first = Buffer.alloc(BROWSER_PROXY_MAX_FILE_BYTES, 0x41);
    const second = Buffer.alloc(
      BROWSER_PROXY_MAX_TOTAL_FILE_BYTES - BROWSER_PROXY_MAX_FILE_BYTES + 1,
      0x42,
    );

    const error = await persistBrowserProxyResultFiles(
      { downloads: [{ path: "/tmp/first.bin" }, { path: "/tmp/second.bin" }] },
      [
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
      ],
    ).then(
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
    const error = await persistBrowserProxyResultFiles({ path: "/tmp/oversized.bin" }, [
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

  it.each([
    { name: "invalid alphabet", base64: "aGVsbG8$" },
    { name: "invalid padding", base64: "aGVsbG8===" },
    { name: "nonzero padding bits", base64: "ZE==" },
    { name: "impossible unpadded length", base64: "S" },
    { name: "whitespace without encoded data", base64: " \n\t" },
  ])("rejects $name before creating the media directory", async ({ base64 }) => {
    const error = await persistBrowserProxyResultFiles(
      { path: "/tmp/malformed-browser-download.bin" },
      [
        {
          path: "/tmp/malformed-browser-download.bin",
          base64,
          mimeType: "application/octet-stream",
        },
      ],
    ).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", "browser proxy file contains malformed base64 data");

    await expect(
      fs.stat(path.join(tempHome.home, ".openclaw", "media", "browser")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects a later malformed file without persisting an earlier valid file", async () => {
    await expect(
      persistBrowserProxyResultFiles(
        {
          downloads: [
            { path: "/tmp/valid-browser-download.txt" },
            { path: "/tmp/malformed-browser-download.bin" },
          ],
        },
        [
          {
            path: "/tmp/valid-browser-download.txt",
            base64: Buffer.from("valid browser download").toString("base64"),
            mimeType: "text/plain",
          },
          { path: "/tmp/malformed-browser-download.bin", base64: "ZE==" },
        ],
      ),
    ).rejects.toThrow("browser proxy file contains malformed base64 data");

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

    await expect(
      persistBrowserProxyResultFiles(
        { downloads: files.map((file) => ({ path: file.path })) },
        files,
      ),
    ).rejects.toThrow("browser proxy response exceeds 256 file limit");
    await expect(
      fs.stat(path.join(tempHome.home, ".openclaw", "media", "browser")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });

  it.each([
    {
      name: "missing payload",
      result: { path: "/node/missing.png" },
      files: undefined,
    },
    {
      name: "duplicate payload path",
      result: { path: "/node/duplicate.png" },
      files: [
        { path: "/node/duplicate.png", base64: "" },
        { path: "/node/duplicate.png", base64: "" },
      ],
    },
    {
      name: "unreferenced extra payload",
      result: { path: "/node/owned.png" },
      files: [
        { path: "/node/owned.png", base64: "" },
        { path: "/node/unowned.png", base64: "" },
      ],
    },
  ])("rejects $name before persisting any files", async ({ result, files }) => {
    await expect(persistBrowserProxyResultFiles(result, files)).rejects.toThrow(
      "browser proxy returned an invalid file envelope",
    );
    await expect(
      fs.stat(path.join(tempHome.home, ".openclaw", "media", "browser")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rewrites a complete file mapping without traversing nested page data", async () => {
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

    const routePaths = [
      "/node/screenshot.png",
      "/node/snapshot.png",
      "/node/download.csv",
      "/node/first.pdf",
      "/node/second.pdf",
    ];
    await persistBrowserProxyResultFiles(
      result,
      routePaths.map((filePath) => ({
        path: filePath,
        base64: Buffer.from(filePath).toString("base64"),
      })),
    );

    expect(result.path).not.toBe(routePaths[0]);
    expect(result.imagePath).not.toBe(routePaths[1]);
    expect(result.download.path).not.toBe(routePaths[2]);
    expect(result.downloads[0]?.path).not.toBe(routePaths[3]);
    expect(result.downloads[3]?.path).not.toBe(routePaths[4]);
    expect(result.downloads[4]?.path).toBe(result.downloads[0]?.path);
    expect(result.result).toEqual({
      path: "/node/page-controlled.txt",
      downloads: [{ path: "/node/page-controlled-download.txt" }],
    });
  });
});
