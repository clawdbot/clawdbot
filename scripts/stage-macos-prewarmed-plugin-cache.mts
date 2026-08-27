#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectPublishablePluginPackages } from "./lib/plugin-npm-release.ts";
import { sha256File, verifyPrewarmedPluginCache } from "./prewarmed-plugin-cache.mjs";

function runChecked(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${String(result.status)}`);
  }
}

function readPluginId(packageDir: string): string {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(packageDir, "openclaw.plugin.json"), "utf8"),
  ) as { id?: unknown };
  if (typeof parsed.id !== "string" || !parsed.id.trim()) {
    throw new Error(`Plugin manifest has no id: ${packageDir}`);
  }
  return parsed.id.trim();
}

function packPlugin(params: { packageDir: string; outputDir: string; repoRoot: string }): string {
  const relativePackageDir = path.relative(params.repoRoot, params.packageDir);
  const generatedDistDir = path.join(params.packageDir, "dist");
  if (fs.existsSync(generatedDistDir)) {
    throw new Error(`Refusing to replace existing plugin build output: ${generatedDistDir}`);
  }
  try {
    runChecked(
      process.execPath,
      [path.join(params.repoRoot, "scripts/lib/plugin-npm-runtime-build.mjs"), relativePackageDir],
      params.repoRoot,
    );
    const before = new Set(fs.readdirSync(params.outputDir));
    runChecked(
      process.execPath,
      [
        path.join(params.repoRoot, "scripts/lib/plugin-npm-package-manifest.mjs"),
        "--run",
        relativePackageDir,
        "--",
        "npm",
        "pack",
        "--ignore-scripts",
        "--pack-destination",
        params.outputDir,
      ],
      params.repoRoot,
    );
    const created = fs
      .readdirSync(params.outputDir)
      .filter((entry) => !before.has(entry) && entry.endsWith(".tgz"));
    if (created.length !== 1) {
      throw new Error(`Packing ${relativePackageDir} created ${created.length} archives`);
    }
    return created[0]!;
  } finally {
    fs.rmSync(generatedDistDir, { recursive: true, force: true });
  }
}

export function stageMacOSPrewarmedPluginCache(params: {
  repoRoot: string;
  outputDir: string;
  gitCommit: string;
}) {
  const repoRoot = path.resolve(params.repoRoot);
  const outputDir = path.resolve(params.outputDir);
  const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  const appVersion = typeof rootPackage.version === "string" ? rootPackage.version.trim() : "";
  if (!appVersion || !/^[a-f0-9]{40}$/u.test(params.gitCommit)) {
    throw new Error("Prewarmed plugin cache build identity is invalid");
  }
  fs.mkdirSync(outputDir, { recursive: true });
  if (fs.readdirSync(outputDir).length > 0) {
    throw new Error(`Prewarmed plugin cache output must be empty: ${outputDir}`);
  }
  const publishable = selectMacOSPrewarmedPluginCacheEntries(repoRoot, appVersion);
  const plugins = publishable.map((plugin, index) => {
    console.error(
      `[prewarm] packing plugin ${index + 1}/${publishable.length}: ${plugin.extensionId}`,
    );
    const archiveFile = packPlugin({
      packageDir: plugin.packageDir,
      outputDir,
      repoRoot,
    });
    return {
      pluginId: plugin.pluginId,
      packageName: plugin.packageName,
      packageVersion: plugin.version,
      npmSpec: `${plugin.packageName}@${plugin.version}`,
      archiveFile,
      archiveSHA256: sha256File(path.join(outputDir, archiveFile)),
    };
  });
  const manifest = { schemaVersion: 1, appVersion, gitCommit: params.gitCommit, plugins };
  fs.writeFileSync(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return verifyPrewarmedPluginCache({
    sourceDir: outputDir,
    expectedVersion: appVersion,
    expectedCommit: params.gitCommit,
  });
}

export function selectMacOSPrewarmedPluginCacheEntries(repoRoot: string, appVersion?: string) {
  const root = path.resolve(repoRoot);
  const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    version?: unknown;
  };
  const expectedVersion =
    appVersion ?? (typeof rootPackage.version === "string" ? rootPackage.version.trim() : "");
  return collectPublishablePluginPackages(root)
    .map((plugin) => {
      if (plugin.version !== expectedVersion) {
        throw new Error(
          `${plugin.extensionId} version ${plugin.version} does not match ${expectedVersion}`,
        );
      }
      const packageDir = path.resolve(root, plugin.packageDir);
      return Object.assign({}, plugin, { packageDir, pluginId: readPluginId(packageDir) });
    })
    .toSorted((a, b) => a.packageName.localeCompare(b.packageName));
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Invalid prewarmed cache arguments");
    }
    values.set(key, value);
  }
  const repoRoot = values.get("--repo-root");
  const outputDir = values.get("--output-dir");
  const gitCommit = values.get("--git-commit");
  if (!repoRoot || !outputDir || !gitCommit || values.size !== 3) {
    throw new Error(
      "usage: stage-macos-prewarmed-plugin-cache --repo-root <dir> --output-dir <dir> --git-commit <sha>",
    );
  }
  return { repoRoot, outputDir, gitCommit };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    stageMacOSPrewarmedPluginCache(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
