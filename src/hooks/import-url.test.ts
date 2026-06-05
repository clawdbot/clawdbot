// Hook import URL tests cover file URL conversion for hook modules.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

  it("appends mtime-based cache buster for workspace hooks", () => {
    const url = buildImportUrl(tmpFile, "openclaw-workspace");
    expect(url).toMatch(/\?t=[\d.]+&s=\d+/);

    const { mtimeMs, size } = fs.statSync(tmpFile);
    expect(url).toContain(`?t=${mtimeMs}`);
    expect(url).toContain(`&s=${size}`);
  });

  it("appends mtime-based cache buster for managed hooks", () => {
    const url = buildImportUrl(tmpFile, "openclaw-managed");
    expect(url).toMatch(/\?t=[\d.]+&s=\d+/);
  });

  it("appends mtime-based cache buster for plugin hooks", () => {
    const url = buildImportUrl(tmpFile, "openclaw-plugin");
    expect(url).toMatch(/\?t=[\d.]+&s=\d+/);
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

  it("falls back to Date.now() when file does not exist", () => {
    const url = buildImportUrl("/nonexistent/handler.js", "openclaw-workspace");
    expect(url).toMatch(/\?t=\d+/);
  });
});
