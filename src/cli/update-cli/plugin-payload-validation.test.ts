// Plugin payload validation tests cover update payload checks for plugin updates.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import {
  runPluginPayloadSmokeCheck,
  runPluginPayloadSmokeCheckForManifestRecords,
} from "./plugin-payload-validation.js";

type BundleFormat = "codex" | "claude" | "cursor";
type FormatMarkedBundleInstallRecord = PluginInstallRecord & {
  format: "bundle";
  bundleFormat?: BundleFormat;
};

describe("runPluginPayloadSmokeCheck", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-payload-smoke-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
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

  async function writeBundle(params: {
    dir: string;
    format: BundleFormat;
    manifest?: unknown;
    markerOnly?: boolean;
  }) {
    await fs.mkdir(params.dir, { recursive: true });
    if (params.markerOnly) {
      await fs.mkdir(path.join(params.dir, "skills"), { recursive: true });
      return;
    }
    const manifestDir =
      params.format === "codex"
        ? ".codex-plugin"
        : params.format === "cursor"
          ? ".cursor-plugin"
          : ".claude-plugin";
    await fs.mkdir(path.join(params.dir, manifestDir), { recursive: true });
    await fs.writeFile(
      path.join(params.dir, manifestDir, "plugin.json"),
      JSON.stringify(params.manifest ?? { name: `${params.format}-bundle` }),
      "utf8",
    );
    await fs.mkdir(path.join(params.dir, "skills"), { recursive: true });
  }

  function formatMarkedBundleRecord(params: {
    installPath: string;
    bundleFormat?: BundleFormat;
  }): PluginInstallRecord {
    const record: FormatMarkedBundleInstallRecord = {
      source: "marketplace",
      format: "bundle",
      ...(params.bundleFormat ? { bundleFormat: params.bundleFormat } : {}),
      installPath: params.installPath,
    };
    return record;
  }

  function resolveTestHostRoot(): string {
    const hostRoot = resolveOpenClawPackageRootSync({
      argv1: process.argv[1],
      moduleUrl: import.meta.url,
      cwd: process.cwd(),
    });
    expect(hostRoot).toBeTruthy();
    return hostRoot!;
  }

  async function linkOpenClawPeerToHost(dir: string): Promise<void> {
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    await fs.symlink(resolveTestHostRoot(), path.join(dir, "node_modules", "openclaw"), "junction");
  }

  async function resolveRealPath(target: string): Promise<string> {
    return await fs.realpath(target).catch(() => target);
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

  it("checks a selected manifest root without an installed-index record", async () => {
    const dir = path.join(tmpRoot, "codex");
    await writePackage(
      dir,
      { name: "@openclaw/codex", openclaw: { extensions: ["./index.js"] } },
      "export default {};",
    );
    const result = await runPluginPayloadSmokeCheckForManifestRecords({
      plugins: [{ id: "codex", rootDir: dir }],
      env: {},
    });

    expect(result).toEqual({ checked: ["codex"], failures: [] });
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

  it.each([
    ["codex", "clawhubFamily"],
    ["claude", "format"],
    ["cursor", "format"],
  ] as const)(
    "accepts a tracked %s bundle record with no package.json via %s metadata",
    async (bundleFormat, metadataKind) => {
      const dir = path.join(tmpRoot, `${bundleFormat}-bundle`);
      await writeBundle({ dir, format: bundleFormat });
      const result = await runPluginPayloadSmokeCheck({
        records: {
          [`${bundleFormat}-bundle`]:
            metadataKind === "clawhubFamily"
              ? {
                  source: "clawhub",
                  clawhubFamily: "bundle-plugin",
                  installPath: dir,
                }
              : formatMarkedBundleRecord({ installPath: dir, bundleFormat }),
        },
        env: {},
      });
      expect(result.checked).toEqual([`${bundleFormat}-bundle`]);
      expect(result.failures).toEqual([]);
    },
  );

  it("accepts a tracked manifestless Claude bundle record with no package.json", async () => {
    const dir = path.join(tmpRoot, "manifestless-claude-bundle");
    await writeBundle({ dir, format: "claude", markerOnly: true });
    const result = await runPluginPayloadSmokeCheck({
      records: {
        "manifestless-claude-bundle": formatMarkedBundleRecord({ installPath: dir }),
      },
      env: {},
    });
    expect(result.checked).toEqual(["manifestless-claude-bundle"]);
    expect(result.failures).toEqual([]);
  });

  it("accepts a persisted marketplace bundle record without transient format metadata", async () => {
    const dir = path.join(tmpRoot, "marketplace-bundle");
    await writeBundle({ dir, format: "cursor" });
    const result = await runPluginPayloadSmokeCheck({
      records: {
        "marketplace-bundle": {
          source: "marketplace",
          installPath: dir,
          marketplaceName: "Local",
          marketplaceSource: "local/repo",
          marketplacePlugin: "marketplace-bundle",
        },
      },
      env: {},
    });
    expect(result.checked).toEqual(["marketplace-bundle"]);
    expect(result.failures).toEqual([]);
  });

  it("reports a bundle manifest failure instead of requiring package.json for bundle records", async () => {
    const dir = path.join(tmpRoot, "broken-bundle");
    await fs.mkdir(path.join(dir, ".codex-plugin"), { recursive: true });
    const result = await runPluginPayloadSmokeCheck({
      records: {
        "broken-bundle": formatMarkedBundleRecord({ installPath: dir, bundleFormat: "codex" }),
      },
      env: {},
    });
    expect(result.failures).toStrictEqual([
      {
        pluginId: "broken-bundle",
        installPath: dir,
        reason: "missing-bundle-manifest",
        detail: `No supported bundle manifest or bundle marker found under ${dir}`,
      },
    ]);
  });

  it("reports invalid bundle manifest when a parseable bundle manifest is not an object", async () => {
    const dir = path.join(tmpRoot, "non-object-bundle");
    await writeBundle({ dir, format: "codex", manifest: [] });
    const result = await runPluginPayloadSmokeCheck({
      records: {
        "non-object-bundle": {
          source: "clawhub",
          clawhubFamily: "bundle-plugin",
          installPath: dir,
        },
      },
      env: {},
    });
    expect(result.failures).toStrictEqual([
      {
        pluginId: "non-object-bundle",
        installPath: dir,
        reason: "invalid-bundle-manifest",
        detail: "Bundle manifest validation failed: plugin manifest must be an object",
      },
    ]);
  });

  it("keeps dual-format bundle records on native package validation", async () => {
    const dir = path.join(tmpRoot, "dual-format-bundle");
    await writeBundle({ dir, format: "codex" });
    await writePackage(dir, {
      name: "dual-format-bundle",
      openclaw: { extensions: ["./missing-extension.js"] },
    });
    const result = await runPluginPayloadSmokeCheck({
      records: {
        "dual-format-bundle": {
          source: "clawhub",
          clawhubFamily: "bundle-plugin",
          installPath: dir,
        },
      },
      env: {},
    });
    expect(result.failures).toStrictEqual([
      {
        pluginId: "dual-format-bundle",
        installPath: dir,
        reason: "missing-extension-entry",
        detail:
          "Plugin extension entry validation failed: extension entry not found: ./missing-extension.js",
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

  it("reports a failure when `openclaw.extensions` contains invalid entries", async () => {
    const dir = path.join(tmpRoot, "brave");
    await writePackage(dir, {
      name: "@openclaw/brave-plugin",
      openclaw: { extensions: ["./index.js", " "] },
      main: "main.js",
    });
    await fs.writeFile(path.join(dir, "index.js"), "export default {};\n", "utf8");
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
          "Plugin extension entry validation failed: package.json openclaw.extensions[1] must be a non-empty string",
      },
    ]);
  });

  it("reports only extension-entry failure for an empty extensions list even if main is missing", async () => {
    const dir = path.join(tmpRoot, "brave-empty");
    await writePackage(dir, {
      name: "@openclaw/brave-plugin",
      openclaw: { extensions: [] },
      main: "dist/index.js",
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
          "Plugin extension entry validation failed: package.json openclaw.extensions is empty",
      },
    ]);
  });

  it("reports missing main entry when extension entries are valid", async () => {
    const dir = path.join(tmpRoot, "brave");
    await writePackage(dir, {
      name: "@openclaw/brave-plugin",
      openclaw: { extensions: ["./index.js"] },
      main: "dist/index.js",
    });
    await fs.writeFile(path.join(dir, "index.js"), "export default {};\n", "utf8");
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

  it("reports a failure when an openclaw peer link is missing", async () => {
    const dir = path.join(tmpRoot, "codex");
    await writePackage(
      dir,
      {
        name: "@openclaw/codex",
        main: "dist/index.js",
        peerDependencies: { openclaw: ">=2026.5.18-beta.1" },
      },
      "export default {};\n",
    );

    const result = await runPluginPayloadSmokeCheck({
      records: { codex: { source: "npm", installPath: dir } },
      env: {},
    });

    expect(result.failures).toStrictEqual([
      {
        pluginId: "codex",
        installPath: dir,
        reason: "missing-openclaw-peer-link",
        detail: `Plugin declares peerDependency "openclaw" but peer link audit failed: missing ${path.join(
          dir,
          "node_modules",
          "openclaw",
        )}.`,
      },
    ]);
  });

  it("reports a failure when an openclaw peer link is a stale real directory", async () => {
    const dir = path.join(tmpRoot, "codex");
    await writePackage(
      dir,
      {
        name: "@openclaw/codex",
        main: "dist/index.js",
        peerDependencies: { openclaw: ">=2026.5.18-beta.1" },
      },
      "export default {};\n",
    );
    const stalePeerDir = path.join(dir, "node_modules", "openclaw");
    await fs.mkdir(stalePeerDir, { recursive: true });

    const result = await runPluginPayloadSmokeCheck({
      records: { codex: { source: "npm", installPath: dir } },
      env: {},
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      pluginId: "codex",
      installPath: dir,
      reason: "missing-openclaw-peer-link",
    });
    expect(result.failures[0]?.detail).toContain(`${stalePeerDir} points to`);
    expect(result.failures[0]?.detail).toContain(
      `instead of ${await resolveRealPath(resolveTestHostRoot())}`,
    );
  });

  it("reports a failure when an openclaw peer link points at the wrong package root", async () => {
    const dir = path.join(tmpRoot, "codex");
    await writePackage(
      dir,
      {
        name: "@openclaw/codex",
        main: "dist/index.js",
        peerDependencies: { openclaw: ">=2026.5.18-beta.1" },
      },
      "export default {};\n",
    );
    const wrongHostRoot = path.join(tmpRoot, "old-openclaw");
    await fs.mkdir(wrongHostRoot, { recursive: true });
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    await fs.symlink(wrongHostRoot, path.join(dir, "node_modules", "openclaw"), "junction");

    const result = await runPluginPayloadSmokeCheck({
      records: { codex: { source: "npm", installPath: dir } },
      env: {},
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      pluginId: "codex",
      installPath: dir,
      reason: "missing-openclaw-peer-link",
    });
    expect(result.failures[0]?.detail).toContain(
      `${path.join(
        dir,
        "node_modules",
        "openclaw",
      )} points to ${await resolveRealPath(wrongHostRoot)} instead of ${await resolveRealPath(
        resolveTestHostRoot(),
      )}`,
    );
  });

  it("accepts an openclaw peer link when it resolves to the host package root", async () => {
    const dir = path.join(tmpRoot, "codex");
    await writePackage(
      dir,
      {
        name: "@openclaw/codex",
        main: "dist/index.js",
        peerDependencies: { openclaw: ">=2026.5.18-beta.1" },
      },
      "export default {};\n",
    );
    await linkOpenClawPeerToHost(dir);

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

  it.each(["EACCES", "EPERM", "EIO"])(
    "classifies a %s package.json read failure as unreadable",
    async (code) => {
      const dir = path.join(tmpRoot, "unreadable");
      const packageJsonPath = path.join(dir, "package.json");
      await writePackage(dir, { name: "unreadable" });
      vi.spyOn(fs, "readFile").mockRejectedValueOnce(
        Object.assign(new Error(`${code}: could not read ${packageJsonPath}`), { code }),
      );

      const result = await runPluginPayloadSmokeCheck({
        records: { unreadable: { source: "npm", installPath: dir } },
        env: {},
      });

      expect(result.failures).toStrictEqual([
        {
          pluginId: "unreadable",
          installPath: dir,
          reason: "unreadable-package-json",
          detail: `Could not read package.json at ${packageJsonPath}: ${code}: could not read ${packageJsonPath}`,
        },
      ]);
    },
  );

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
