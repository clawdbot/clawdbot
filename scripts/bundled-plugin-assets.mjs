#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

export function parseBundledPluginAssetArgs(argv) {
  const args = [...argv];
  const plugins = [];
  let phase = null;

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
    throw new Error(`Unknown bundled plugin asset argument: ${String(arg)}`);
  }

  if (!VALID_PHASES.has(phase)) {
    throw new Error(`Expected --phase ${[...VALID_PHASES].join("|")}`);
  }

  return { phase, plugins };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await runBundledPluginAssetHooks(parseBundledPluginAssetArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
