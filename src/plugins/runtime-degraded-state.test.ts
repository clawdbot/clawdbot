import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDirSync } from "../test-helpers/temp-dir.js";
import { pluginInstallPathMatchesRoot } from "./runtime-degraded-state.js";

describe("pluginInstallPathMatchesRoot", () => {
  it("matches an existing plugin root through a symlink alias", () => {
    if (process.platform === "win32") {
      return;
    }

    withTempDirSync({ prefix: "openclaw-degraded-plugin-root-" }, (baseDir) => {
      const pluginRoot = path.join(baseDir, "plugin");
      const pluginAlias = path.join(baseDir, "plugin-alias");
      fs.mkdirSync(pluginRoot);
      fs.symlinkSync(pluginRoot, pluginAlias, "dir");

      expect(pluginInstallPathMatchesRoot(pluginAlias, pluginRoot)).toBe(true);
    });
  });

  it("falls back to absolute lexical paths when plugin roots are missing", () => {
    withTempDirSync({ prefix: "openclaw-degraded-plugin-root-" }, (baseDir) => {
      const missingRoot = path.join(baseDir, "missing-plugin");
      const equivalentMissingRoot = path.join(baseDir, "nested", "..", "missing-plugin");

      expect(pluginInstallPathMatchesRoot(equivalentMissingRoot, missingRoot)).toBe(true);
      expect(pluginInstallPathMatchesRoot(path.join(baseDir, "other-missing"), missingRoot)).toBe(
        false,
      );
    });
  });
});
