import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  jsonSupportBundleFile,
  textSupportBundleFile,
  writeSupportBundleDirectory,
  writeSupportBundleZip,
} from "./diagnostic-support-bundle.js";

describe("diagnostic support bundle helpers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-support-bundle-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes directory bundles with restrictive file permissions and byte inventory", () => {
    const outputDir = path.join(tempDir, "bundle");
    const contents = writeSupportBundleDirectory({
      outputDir,
      files: [
        jsonSupportBundleFile("manifest.json", { ok: true }),
        textSupportBundleFile("nested/summary.md", "hello"),
      ],
    });

    expect(contents).toEqual([
      {
        path: "manifest.json",
        mediaType: "application/json",
        bytes: Buffer.byteLength('{\n  "ok": true\n}\n', "utf8"),
      },
      {
        path: "nested/summary.md",
        mediaType: "text/plain; charset=utf-8",
        bytes: Buffer.byteLength("hello\n", "utf8"),
      },
    ]);
    expect(fs.statSync(path.join(outputDir, "manifest.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(outputDir, "nested", "summary.md")).mode & 0o777).toBe(0o600);
  });

  it("rejects absolute and traversal bundle paths", async () => {
    expect(() => jsonSupportBundleFile("../escape.json", {})).toThrow(/Invalid bundle/u);
    expect(() => textSupportBundleFile("/tmp/escape.txt", "nope")).toThrow(/Invalid bundle/u);

    await expect(
      writeSupportBundleZip({
        outputPath: path.join(tempDir, "bundle.zip"),
        files: [{ path: "nested/../escape.txt", mediaType: "text/plain", content: "nope" }],
      }),
    ).rejects.toThrow(/Invalid bundle/u);
  });

  it("writes zip bundles through the same file model", async () => {
    const outputPath = path.join(tempDir, "bundle.zip");
    const bytes = await writeSupportBundleZip({
      outputPath,
      files: [jsonSupportBundleFile("manifest.json", { ok: true })],
    });

    expect(bytes).toBeGreaterThan(0);
    expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    expect(await zip.file("manifest.json")?.async("string")).toBe('{\n  "ok": true\n}\n');
  });
});
