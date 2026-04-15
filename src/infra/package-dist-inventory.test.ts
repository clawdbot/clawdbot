import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  collectPackageDistInventoryErrors,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
  collectPackageDistInventory,
  writePackageDistInventory,
} from "./package-dist-inventory.js";

describe("package dist inventory", () => {
  it("tracks missing and stale dist files", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-" }, async (packageRoot) => {
      const currentFile = path.join(packageRoot, "dist", "current-BR6xv1a1.js");
      await fs.mkdir(path.dirname(currentFile), { recursive: true });
      await fs.writeFile(currentFile, "export {};\n", "utf8");

      await expect(writePackageDistInventory(packageRoot)).resolves.toEqual([
        "dist/current-BR6xv1a1.js",
      ]);
      await expect(collectPackageDistInventoryErrors(packageRoot)).resolves.toEqual([]);

      await fs.rm(currentFile);
      await fs.writeFile(
        path.join(packageRoot, "dist", "stale-CJUAgRQR.js"),
        "export {};\n",
        "utf8",
      );

      await expect(collectPackageDistInventoryErrors(packageRoot)).resolves.toEqual([
        "missing packaged dist file dist/current-BR6xv1a1.js",
        "unexpected packaged dist file dist/stale-CJUAgRQR.js",
      ]);
    });
  });

  it("keeps npm-omitted dist artifacts out of the inventory", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-pack-" }, async (packageRoot) => {
      const packagedQaRuntime = path.join(
        packageRoot,
        "dist",
        "extensions",
        "qa-channel",
        "runtime-api.js",
      );
      const omittedQaChunk = path.join(packageRoot, "dist", "extensions", "qa-channel", "cli.js");
      const omittedQaMatrixChunk = path.join(
        packageRoot,
        "dist",
        "extensions",
        "qa-matrix",
        "index.js",
      );
      const omittedMap = path.join(packageRoot, "dist", "feature.runtime.js.map");
      await fs.mkdir(path.dirname(packagedQaRuntime), { recursive: true });
      await fs.mkdir(path.dirname(omittedQaMatrixChunk), { recursive: true });
      await fs.writeFile(packagedQaRuntime, "export {};\n", "utf8");
      await fs.writeFile(omittedQaChunk, "export {};\n", "utf8");
      await fs.writeFile(omittedQaMatrixChunk, "export {};\n", "utf8");
      await fs.writeFile(omittedMap, "{}", "utf8");

      await expect(writePackageDistInventory(packageRoot)).resolves.toEqual([
        "dist/extensions/qa-channel/runtime-api.js",
      ]);
    });
  });
  it("fails closed when the inventory is missing", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-missing-" }, async (packageRoot) => {
      await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await expect(collectPackageDistInventoryErrors(packageRoot)).resolves.toEqual([
        `missing package dist inventory ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`,
      ]);
    });
  });

  it("rejects symlinked dist entries", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-symlink-" }, async (packageRoot) => {
      const distDir = path.join(packageRoot, "dist");
      await fs.mkdir(distDir, { recursive: true });
      await fs.writeFile(path.join(packageRoot, "escape.js"), "export {};\n", "utf8");
      await fs.symlink(path.join(packageRoot, "escape.js"), path.join(distDir, "entry.js"));

      await expect(collectPackageDistInventory(packageRoot)).rejects.toThrow(
        "Unsafe package dist path: dist/entry.js",
      );
    });
  });
});
