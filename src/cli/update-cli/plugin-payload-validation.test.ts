import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPluginPayloadSmokeCheck } from "./plugin-payload-validation.js";

describe("runPluginPayloadSmokeCheck", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-payload-smoke-"));
  });
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function writePackage(
    dir: string,
    manifest: Record<string, unknown>,
    mainContent?: string,
  ) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(manifest), "utf8");
    const main = typeof manifest.main === "string" ? manifest.main : "index.js";
    if (mainContent !== undefined) {
      const target = path.join(dir, main);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, mainContent, "utf8");
    }
  }

  it("reports ok for a record whose package.json + main file exist", async () => {
    const dir = path.join(tmpRoot, "discord");
    await writePackage(
      dir,
      { name: "@openclaw/discord", main: "dist/index.js" },
      "module.exports = {};",
    );
    const result = await runPluginPayloadSmokeCheck({
      records: { discord: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toEqual([]);
    expect(result.checked).toEqual(["discord"]);
  });

  it("reports a failure when the package directory is missing", async () => {
    const dir = path.join(tmpRoot, "brave");
    const result = await runPluginPayloadSmokeCheck({
      records: { brave: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toStrictEqual([
      {
        pluginId: "brave",
        installPath: dir,
        reason: "missing-package-dir",
        detail: `Install dir is missing: ${dir}`,
      },
    ]);
  });

  it("reports a failure when the package.json is missing", async () => {
    const dir = path.join(tmpRoot, "brave");
    await fs.mkdir(dir, { recursive: true });
    const result = await runPluginPayloadSmokeCheck({
      records: { brave: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toStrictEqual([
      {
        pluginId: "brave",
        installPath: dir,
        reason: "missing-package-json",
        detail: `package.json is missing under ${dir}`,
      },
    ]);
  });

  it("reports a failure when the main entry file is missing on disk", async () => {
    const dir = path.join(tmpRoot, "brave");
    await writePackage(dir, { name: "@openclaw/brave", main: "dist/index.js" });
    const result = await runPluginPayloadSmokeCheck({
      records: { brave: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toStrictEqual([
      {
        pluginId: "brave",
        installPath: dir,
        reason: "missing-main-entry",
        detail: `Plugin main entry "dist/index.js" not found at ${path.join(dir, "dist/index.js")}`,
      },
    ]);
  });

  it("accepts a manifest with no main field (OpenClaw plugins commonly use `exports` or `openclaw.extensions`)", async () => {
    const dir = path.join(tmpRoot, "matrix");
    await writePackage(dir, { name: "@openclaw/plugin-matrix" });
    const result = await runPluginPayloadSmokeCheck({
      records: { matrix: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toEqual([]);
  });

  it("accepts a manifest that declares only `exports` and no `main`", async () => {
    const dir = path.join(tmpRoot, "qa");
    await writePackage(dir, {
      name: "@openclaw/qa-channel",
      exports: { ".": "./index.js", "./api.js": "./api.js" },
    });
    const result = await runPluginPayloadSmokeCheck({
      records: { qa: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toEqual([]);
  });

  it("accepts a manifest that declares an existing `openclaw.extensions` entry and no `main`", async () => {
    const dir = path.join(tmpRoot, "brave");
    await writePackage(dir, {
      name: "@openclaw/brave-plugin",
      openclaw: { extensions: ["./index.js"] },
    });
    await fs.writeFile(path.join(dir, "index.js"), "export default {};\n", "utf8");
    const result = await runPluginPayloadSmokeCheck({
      records: { brave: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toEqual([]);
  });

  it("accepts a packaged TypeScript extension entry when compiled runtime output exists", async () => {
    const dir = path.join(tmpRoot, "codex");
    await writePackage(dir, {
      name: "@openclaw/codex",
      openclaw: { extensions: ["./index.ts"] },
    });
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(path.join(dir, "dist", "index.js"), "export default {};\n", "utf8");
    const result = await runPluginPayloadSmokeCheck({
      records: { codex: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toEqual([]);
  });

  it("reports a failure when an `openclaw.extensions` entry file is missing", async () => {
    const dir = path.join(tmpRoot, "brave");
    await writePackage(dir, {
      name: "@openclaw/brave-plugin",
      openclaw: { extensions: ["./dist/index.js"] },
    });
    const result = await runPluginPayloadSmokeCheck({
      records: { brave: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toStrictEqual([
      {
        pluginId: "brave",
        installPath: dir,
        reason: "missing-extension-entry",
        detail:
          "Plugin extension entry validation failed: extension entry not found: ./dist/index.js",
      },
    ]);
  });

  it("reports a failure when `main` resolves to a directory rather than a file", async () => {
    const dir = path.join(tmpRoot, "dir-main");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "dir-main", main: "lib" }),
      "utf8",
    );
    await fs.mkdir(path.join(dir, "lib"), { recursive: true });
    const result = await runPluginPayloadSmokeCheck({
      records: { x: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toStrictEqual([
      {
        pluginId: "x",
        installPath: dir,
        reason: "missing-main-entry",
        detail: `Plugin main entry "lib" not found at ${path.join(dir, "lib")}`,
      },
    ]);
  });

  it("reports a failure when `main` is a symlink whose target is missing", async () => {
    const dir = path.join(tmpRoot, "broken-symlink");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "broken-symlink", main: "dist/entry.js" }),
      "utf8",
    );
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.symlink(
      path.join(dir, "dist", "missing-target.js"),
      path.join(dir, "dist", "entry.js"),
    );
    const result = await runPluginPayloadSmokeCheck({
      records: { x: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toStrictEqual([
      {
        pluginId: "x",
        installPath: dir,
        reason: "missing-main-entry",
        detail: `Plugin main entry "dist/entry.js" not found at ${path.join(dir, "dist", "entry.js")}`,
      },
    ]);
  });

  it("reports a failure when package.json cannot be parsed", async () => {
    const dir = path.join(tmpRoot, "broken");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "package.json"), "not-json", "utf8");
    const result = await runPluginPayloadSmokeCheck({
      records: { broken: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toStrictEqual([
      {
        pluginId: "broken",
        installPath: dir,
        reason: "invalid-package-json",
        detail:
          "Could not parse package.json: Unexpected token 'o', \"not-json\" is not valid JSON",
      },
    ]);
  });

  it("reports a failure when an install record is missing installPath", async () => {
    const result = await runPluginPayloadSmokeCheck({
      records: {
        discord: { source: "npm" } as unknown as { source: "npm"; installPath?: string },
      },
      env: {},
    });
    expect(result.checked).toEqual(["discord"]);
    expect(result.failures).toEqual([
      {
        pluginId: "discord",
        reason: "missing-install-path",
        detail: "Install path is missing from the plugin install record.",
      },
    ]);
  });

  it("only checks records whose source is package-tracked (npm/clawhub/git/marketplace)", async () => {
    const dir = path.join(tmpRoot, "tracked");
    await writePackage(dir, { name: "tracked" }, "module.exports = {};");
    const records = {
      bundled: { source: "bundled", installPath: dir } as never,
      npm: { source: "npm" as const, installPath: dir },
    };
    const result = await runPluginPayloadSmokeCheck({
      records,
      env: {},
    });
    expect(result.checked).toEqual(["npm"]);
  });
});
