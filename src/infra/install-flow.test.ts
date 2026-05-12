import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import * as archive from "./archive.js";
import { resolveExistingInstallPath, withExtractedArchiveRoot } from "./install-flow.js";
import * as installSource from "./install-source-utils.js";

async function runExtractedArchiveFailureCase(configureArchive: () => void) {
  vi.spyOn(installSource, "withTempDir").mockImplementation(
    async (_prefix, fn) => await fn("/tmp/openclaw-install-flow"),
  );
  configureArchive();
  return await withExtractedArchiveRoot({
    archivePath: "/tmp/plugin.tgz",
    tempDirPrefix: "openclaw-plugin-",
    timeoutMs: 1000,
    onExtracted: async () => ({ ok: true as const }),
  });
}

describe("resolveExistingInstallPath", () => {
  it("returns resolved path and stat for existing files", async () => {
    await withTempDir({ prefix: "openclaw-install-flow-" }, async (fixtureRoot) => {
      const filePath = path.join(fixtureRoot, "plugin.tgz");
      await fs.writeFile(filePath, "archive");

      const result = await resolveExistingInstallPath(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.resolvedPath).toBe(filePath);
      expect(result.stat.isFile()).toBe(true);
    });
  });

  it("returns a path-not-found error for missing paths", async () => {
    await withTempDir({ prefix: "openclaw-install-flow-" }, async (fixtureRoot) => {
      const missing = path.join(fixtureRoot, "missing.tgz");

      const result = await resolveExistingInstallPath(missing);

      expect(result).toEqual({
        ok: false,
        error: `path not found: ${missing}`,
      });
    });
  });
});

describe("withExtractedArchiveRoot", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts archive and passes root directory to callback", async () => {
    const tmpRoot = path.join(path.sep, "tmp", "openclaw-install-flow");
    const archivePath = path.join(path.sep, "tmp", "plugin.tgz");
    const extractDir = path.join(tmpRoot, "extract");
    const packageRoot = path.join(extractDir, "package");
    const withTempDirSpy = vi
      .spyOn(installSource, "withTempDir")
      .mockImplementation(async (_prefix, fn) => await fn(tmpRoot));
    const extractSpy = vi.spyOn(archive, "extractArchive").mockResolvedValue(undefined);
    const resolveRootSpy = vi.spyOn(archive, "resolvePackedRootDir").mockResolvedValue(packageRoot);

    const onExtracted = vi.fn(async (rootDir: string) => ({ ok: true as const, rootDir }));
    const result = await withExtractedArchiveRoot({
      archivePath,
      tempDirPrefix: "openclaw-plugin-",
      timeoutMs: 1000,
      rootMarkers: ["package.json"],
      onExtracted,
    });

    expect(withTempDirSpy).toHaveBeenCalledTimes(1);
    const withTempDirCall = withTempDirSpy.mock.calls[0];
    expect(withTempDirCall?.[0]).toBe("openclaw-plugin-");
    expect(typeof withTempDirCall?.[1]).toBe("function");
    expect(extractSpy).toHaveBeenCalledOnce();
    expect(extractSpy.mock.calls[0]?.[0]?.archivePath).toBe(archivePath);
    expect(resolveRootSpy).toHaveBeenCalledWith(extractDir, {
      rootMarkers: ["package.json"],
    });
    expect(onExtracted).toHaveBeenCalledWith(packageRoot);
    expect(result).toEqual({
      ok: true,
      rootDir: packageRoot,
    });
  });

  it("returns extract failure when extraction throws", async () => {
    const result = await runExtractedArchiveFailureCase(() => {
      vi.spyOn(archive, "extractArchive").mockRejectedValue(new Error("boom"));
    });

    expect(result).toEqual({
      ok: false,
      error: "failed to extract archive: Error: boom",
    });
  });

  it("returns root-resolution failure when archive layout is invalid", async () => {
    const result = await runExtractedArchiveFailureCase(() => {
      vi.spyOn(archive, "extractArchive").mockResolvedValue(undefined);
      vi.spyOn(archive, "resolvePackedRootDir").mockRejectedValue(new Error("invalid layout"));
    });

    expect(result).toEqual({
      ok: false,
      error: "Error: invalid layout",
    });
  });
});
