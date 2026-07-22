#!/usr/bin/env node

// Discovers and runs bundled plugin package asset hooks.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listGeneratedExtensionAssetSources } from "./lib/static-extension-assets.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALID_PHASES = new Set(["build", "copy"]);

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function pathExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function packagePluginAliases(packageName) {
  if (typeof packageName !== "string") {
    return [];
  }
  const aliases = [packageName];
  const unscopedName = packageName.split("/").at(-1);
  if (unscopedName) {
    aliases.push(unscopedName);
    if (unscopedName.endsWith("-plugin")) {
      aliases.push(unscopedName.slice(0, -"-plugin".length));
    }
  }
  return aliases;
}

async function resolvePluginAliases(pluginDir, packageJson) {
  const aliases = new Set([path.basename(pluginDir), ...packagePluginAliases(packageJson.name)]);
  const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
  if (await pathExists(manifestPath)) {
    const manifest = await readJsonFile(manifestPath);
    if (typeof manifest.id === "string" && manifest.id) {
      aliases.add(manifest.id);
    }
  }
  return aliases;
}

function resolveAssetCommand(packageJson, phase) {
  const assetScripts = packageJson.openclaw?.assetScripts;
  if (!assetScripts || typeof assetScripts !== "object") {
    return null;
  }
  const command = assetScripts[phase];
  return typeof command === "string" && command.trim() ? command.trim() : null;
}

/**
 * Reads bundled plugin asset hook commands for a build or copy phase.
 */
export async function readBundledPluginAssetHooks(options = {}) {
  const repoRoot = options.rootDir ?? rootDir;
  const phase = options.phase;
  if (!VALID_PHASES.has(phase)) {
    throw new Error(`Unsupported bundled plugin asset phase: ${String(phase)}`);
  }

  const pluginFilters = new Set((options.plugins ?? []).filter(Boolean));
  const extensionsDir = path.join(repoRoot, "extensions");
  let entries;
  try {
    entries = await fs.readdir(extensionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const hooks = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pluginDir = path.join(extensionsDir, entry.name);
    const packagePath = path.join(pluginDir, "package.json");
    if (!(await pathExists(packagePath))) {
      continue;
    }

    const packageJson = await readJsonFile(packagePath);
    const aliases = await resolvePluginAliases(pluginDir, packageJson);
    if (pluginFilters.size > 0 && ![...pluginFilters].some((plugin) => aliases.has(plugin))) {
      continue;
    }

    const command = resolveAssetCommand(packageJson, phase);
    if (!command) {
      continue;
    }

    hooks.push({
      aliases: [...aliases].toSorted(),
      command,
      packageName: packageJson.name,
      phase,
      pluginDir,
      pluginId: aliases.has(entry.name) ? entry.name : [...aliases][0],
    });
  }

  return hooks.toSorted((left, right) => left.pluginDir.localeCompare(right.pluginDir));
}

/**
 * Runs bundled plugin asset hook commands for the selected phase/plugins.
 */
export async function runBundledPluginAssetHooks(options = {}) {
  const phase = options.phase;
  const hooks = await readBundledPluginAssetHooks(options);
  if (hooks.length === 0) {
    const scope = options.plugins?.length ? ` for ${options.plugins.join(", ")}` : "";
    console.log(`No bundled plugin asset ${phase} hooks${scope}; skipping.`);
    return;
  }

  for (const hook of hooks) {
    console.log(`[${hook.pluginId}] ${phase}: ${hook.command}`);
    const result = spawnSync(hook.command, {
      cwd: hook.pluginDir,
      env: process.env,
      shell: true,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

/**
 * Lists declared generated source-tree outputs that differ from the committed
 * bytes. Committed buildOutputs must match a fresh hook run; PR node-test
 * selection skips extension suites for packages-only diffs, so this check is
 * the guard that keeps upstream changes from landing stale committed bundles.
 */
export function listStaleGeneratedPluginAssets(options = {}) {
  const repoRoot = options.rootDir ?? rootDir;
  const sources = listGeneratedExtensionAssetSources({ rootDir: repoRoot });
  if (sources.length === 0) {
    return [];
  }
  const result = spawnSync("git", ["status", "--porcelain", "--", ...sources], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `git status failed for generated plugin assets: ${result.stderr?.trim() || result.status}`,
    );
  }
  return result.stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * Parses `--phase`, repeated `--plugin`, and `--check` flags for asset hook scripts.
 */
export function parseBundledPluginAssetArgs(argv) {
  const args = [...argv];
  const plugins = [];
  let phase = null;
  let check = false;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--phase") {
      phase = args.shift() ?? null;
      continue;
    }
    if (arg?.startsWith("--phase=")) {
      phase = arg.slice("--phase=".length);
      continue;
    }
    if (arg === "--plugin") {
      const plugin = args.shift();
      if (plugin) {
        plugins.push(plugin);
      }
      continue;
    }
    if (arg?.startsWith("--plugin=")) {
      plugins.push(arg.slice("--plugin=".length));
      continue;
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    throw new Error(`Unknown bundled plugin asset argument: ${String(arg)}`);
  }

  if (!VALID_PHASES.has(phase)) {
    throw new Error(`Expected --phase ${[...VALID_PHASES].join("|")}`);
  }
  // The stale-asset scan covers every declared buildOutput, so a filtered run
  // would fail on drift it never rebuilt; keep check runs whole-repo.
  if (check && phase !== "build") {
    throw new Error("--check requires --phase build");
  }
  if (check && plugins.length > 0) {
    throw new Error("--check cannot be combined with --plugin filters");
  }

  return { check, phase, plugins };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseBundledPluginAssetArgs(process.argv.slice(2));
    await runBundledPluginAssetHooks(args);
    if (args.check) {
      const stale = listStaleGeneratedPluginAssets();
      if (stale.length > 0) {
        console.error("Generated bundled plugin assets differ from the committed bytes:");
        for (const source of stale) {
          console.error(`  - ${source}`);
        }
        console.error("Rebuild with `pnpm plugins:assets:build` and commit the regenerated files.");
        process.exit(1);
      }
      console.log("Generated bundled plugin assets match the committed bytes.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
