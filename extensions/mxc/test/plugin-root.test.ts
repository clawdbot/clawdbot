import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveMxcLauncherPath } from "../src/plugin-root.js";

describe("resolveMxcLauncherPath", () => {
  it("throws when called from outside any plugin tree", () => {
    const outside = pathToFileURL(path.resolve("README.md")).href;
    expect(() => resolveMxcLauncherPath(outside)).toThrow(/cannot locate plugin root/);
  });

  it("returns the src .mjs in dev layout", () => {
    const launcher = resolveMxcLauncherPath();
    expect(launcher).toMatch(/mxc-spawn-launcher\.mjs$/);
    expect(fs.existsSync(launcher)).toBe(true);
  });

  it("returns the package dist launcher in packed plugin layout", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mxc-packed-plugin-"));
    try {
      writeFileSync(path.join(root, "package.json"), "{}");
      writeFileSync(path.join(root, "openclaw.plugin.json"), "{}");
      const distDir = path.join(root, "dist");
      fs.mkdirSync(distDir, { recursive: true });
      const launcher = path.join(distDir, "mxc-spawn-launcher.mjs");
      writeFileSync(launcher, "export {};\n");
      const moduleUrl = pathToFileURL(path.join(distDir, "index.js")).href;

      expect(resolveMxcLauncherPath(moduleUrl)).toBe(launcher);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
