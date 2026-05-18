import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { resolveStableNodePath } from "./stable-node-path.js";

describe("resolveStableNodePath", () => {
  it("returns non-cellar paths unchanged", async () => {
    await expect(resolveStableNodePath("/usr/local/bin/node")).resolves.toBe("/usr/local/bin/node");
  });

  it("prefers the Homebrew opt symlink for default and versioned formulas", async () => {
    await withTempDir({ prefix: "openclaw-stable-node-" }, async (prefix) => {
      const defaultNode = path.join(prefix, "Cellar", "node", "25.7.0", "bin", "node");
      const versionedNode = path.join(prefix, "Cellar", "node@22", "22.19.0", "bin", "node");
      const optDefault = path.join(prefix, "opt", "node", "bin", "node");
      const optVersioned = path.join(prefix, "opt", "node@22", "bin", "node");

      await fs.mkdir(path.dirname(optDefault), { recursive: true });
      await fs.mkdir(path.dirname(optVersioned), { recursive: true });
      await fs.writeFile(optDefault, "", "utf8");
      await fs.writeFile(optVersioned, "", "utf8");

      await expect(resolveStableNodePath(defaultNode)).resolves.toBe(optDefault);
      await expect(resolveStableNodePath(versionedNode)).resolves.toBe(optVersioned);
    });
  });

  it("falls back to the bin symlink for the default formula, otherwise original path", async () => {
    await withTempDir({ prefix: "openclaw-stable-node-" }, async (prefix) => {
      const defaultNode = path.join(prefix, "Cellar", "node", "25.7.0", "bin", "node");
      const versionedNode = path.join(prefix, "Cellar", "node@22", "22.19.0", "bin", "node");
      const binNode = path.join(prefix, "bin", "node");

      await fs.mkdir(path.dirname(binNode), { recursive: true });
      await fs.writeFile(binNode, "", "utf8");

      await expect(resolveStableNodePath(defaultNode)).resolves.toBe(binNode);
      await expect(resolveStableNodePath(versionedNode)).resolves.toBe(versionedNode);
    });
  });
});
