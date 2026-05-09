import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";

const pathExistsMock = vi.hoisted(() => vi.fn());
const resolveSafeInstallDirMock = vi.hoisted(() => vi.fn());
const assertCanonicalPathWithinBaseMock = vi.hoisted(() => vi.fn());

vi.mock("./fs-safe.js", () => ({
  pathExists: (...args: unknown[]) => pathExistsMock(...args),
}));

vi.mock("./install-safe-path.js", () => ({
  resolveSafeInstallDir: (...args: unknown[]) => resolveSafeInstallDirMock(...args),
  assertCanonicalPathWithinBase: (...args: unknown[]) => assertCanonicalPathWithinBaseMock(...args),
}));

import { ensureInstallTargetAvailable, resolveCanonicalInstallTarget } from "./install-target.js";

beforeEach(() => {
  pathExistsMock.mockReset();
  resolveSafeInstallDirMock.mockReset();
  assertCanonicalPathWithinBaseMock.mockReset();
});

describe("resolveCanonicalInstallTarget", () => {
  it("creates the base dir and returns early for invalid install ids", async () => {
    await withTempDir({ prefix: "openclaw-install-target-" }, async (root) => {
      const baseDir = path.join(root, "plugins");
      resolveSafeInstallDirMock.mockReturnValueOnce({
        ok: false,
        error: "bad id",
      });

      await expect(
        resolveCanonicalInstallTarget({
          baseDir,
          id: "../oops",
          invalidNameMessage: "bad id",
          boundaryLabel: "plugin dir",
        }),
      ).resolves.toEqual({ ok: false, error: "bad id" });

      const baseDirStat = await fs.stat(baseDir);
      expect(baseDirStat.isDirectory()).toBe(true);
      expect(assertCanonicalPathWithinBaseMock).not.toHaveBeenCalled();
    });
  });

  it("returns canonical boundary errors for Error and non-Error throws", async () => {
    await withTempDir({ prefix: "openclaw-install-target-" }, async (baseDir) => {
      const targetDir = path.join(baseDir, "demo");
      resolveSafeInstallDirMock.mockReturnValue({
        ok: true,
        path: targetDir,
      });
      assertCanonicalPathWithinBaseMock.mockRejectedValueOnce(new Error("escaped"));
      assertCanonicalPathWithinBaseMock.mockRejectedValueOnce("boom");

      await expect(
        resolveCanonicalInstallTarget({
          baseDir,
          id: "demo",
          invalidNameMessage: "bad id",
          boundaryLabel: "plugin dir",
        }),
      ).resolves.toEqual({ ok: false, error: "escaped" });

      await expect(
        resolveCanonicalInstallTarget({
          baseDir,
          id: "demo",
          invalidNameMessage: "bad id",
          boundaryLabel: "plugin dir",
        }),
      ).resolves.toEqual({ ok: false, error: "boom" });
    });
  });

  it("returns the resolved target path on success", async () => {
    await withTempDir({ prefix: "openclaw-install-target-" }, async (baseDir) => {
      const targetDir = path.join(baseDir, "demo");
      resolveSafeInstallDirMock.mockReturnValueOnce({
        ok: true,
        path: targetDir,
      });

      await expect(
        resolveCanonicalInstallTarget({
          baseDir,
          id: "demo",
          invalidNameMessage: "bad id",
          boundaryLabel: "plugin dir",
        }),
      ).resolves.toEqual({ ok: true, targetDir });
    });
  });
});

describe("ensureInstallTargetAvailable", () => {
  it("blocks only install mode when the target already exists", async () => {
    pathExistsMock.mockResolvedValueOnce(true);
    pathExistsMock.mockResolvedValueOnce(false);

    await expect(
      ensureInstallTargetAvailable({
        mode: "install",
        targetDir: "/tmp/demo",
        alreadyExistsError: "already there",
      }),
    ).resolves.toEqual({ ok: false, error: "already there" });

    await expect(
      ensureInstallTargetAvailable({
        mode: "update",
        targetDir: "/tmp/demo",
        alreadyExistsError: "already there",
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      ensureInstallTargetAvailable({
        mode: "install",
        targetDir: "/tmp/demo",
        alreadyExistsError: "already there",
      }),
    ).resolves.toEqual({ ok: true });
  });
});
