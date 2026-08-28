// Hook import URL tests cover file URL conversion for hook modules.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildImportUrl } from "./import-url.js";

describe("buildImportUrl", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "import-url-test-"));
    tmpFile = path.join(tmpDir, "handler.js");
    fs.writeFileSync(tmpFile, "export default () => {};");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns bare URL for bundled hooks (no query string)", () => {
    const url = buildImportUrl(tmpFile, "openclaw-bundled");
    expect(url).not.toContain("?t=");
    expect(url).toMatch(/^file:\/\//);
  });

  it("appends file-metadata cache buster for workspace hooks", () => {
    const url = buildImportUrl(tmpFile, "openclaw-workspace");
    expect(url).toMatch(/\?t=[\d.]+&c=[\d.]+&s=\d+/);

    const { ctimeMs, mtimeMs, size } = fs.statSync(tmpFile);
    expect(url).toContain(`?t=${mtimeMs}`);
    expect(url).toContain(`&c=${ctimeMs}`);
    expect(url).toContain(`&s=${size}`);
  });

  it("appends file-metadata cache buster for managed hooks", () => {
    const url = buildImportUrl(tmpFile, "openclaw-managed");
    expect(url).toMatch(/\?t=[\d.]+&c=[\d.]+&s=\d+/);
  });

  it("appends file-metadata cache buster for plugin hooks", () => {
    const url = buildImportUrl(tmpFile, "openclaw-plugin");
    expect(url).toMatch(/\?t=[\d.]+&c=[\d.]+&s=\d+/);
  });

  it("returns same URL for bundled hooks across calls (cacheable)", () => {
    const url1 = buildImportUrl(tmpFile, "openclaw-bundled");
    const url2 = buildImportUrl(tmpFile, "openclaw-bundled");
    expect(url1).toBe(url2);
  });

  it("returns same URL for workspace hooks when file is unchanged", () => {
    const url1 = buildImportUrl(tmpFile, "openclaw-workspace");
    const url2 = buildImportUrl(tmpFile, "openclaw-workspace");
    expect(url1).toBe(url2);
  });

  it("reloads a workspace hook after a same-size edit with restored mtime", async () => {
    const initialSource = 'export default () => "before";\n';
    const editedSource = 'export default () => "after!";\n';
    expect(Buffer.byteLength(editedSource)).toBe(Buffer.byteLength(initialSource));

    fs.writeFileSync(tmpFile, initialSource);
    const cleanTime = new Date(Math.floor(Date.now() / 1000) * 1000);
    fs.utimesSync(tmpFile, cleanTime, cleanTime);
    const initialStat = fs.statSync(tmpFile);
    const initialUrl = buildImportUrl(tmpFile, "openclaw-workspace");
    const initialHandler = (await import(/* @vite-ignore */ initialUrl)).default as () => string;
    expect(initialHandler()).toBe("before");

    await vi.waitFor(
      () => {
        fs.writeFileSync(tmpFile, editedSource);
        fs.utimesSync(tmpFile, initialStat.atime, initialStat.mtime);
        expect(fs.statSync(tmpFile).ctimeMs).not.toBe(initialStat.ctimeMs);
      },
      { interval: 1, timeout: 1_000 },
    );

    const editedStat = fs.statSync(tmpFile);
    expect(editedStat.size).toBe(initialStat.size);
    expect(editedStat.mtimeMs).toBe(initialStat.mtimeMs);
    const editedUrl = buildImportUrl(tmpFile, "openclaw-workspace");
    const editedHandler = (await import(/* @vite-ignore */ editedUrl)).default as () => string;
    expect(editedHandler()).toBe("after!");
  });

  it("falls back to Date.now() when file does not exist", () => {
    const url = buildImportUrl("/nonexistent/handler.js", "openclaw-workspace");
    expect(url).toMatch(/\?t=\d+/);
  });
});
