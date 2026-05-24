import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  resolveLocalHeavyCheckEnv,
  shouldAcquireLocalHeavyCheckLockForOxlint,
} from "./lib/local-heavy-check-runtime.mjs";

const DEFAULT_WINDOWS_EXTENSION_CHUNK_SIZE = 8;
const EXTENSION_TS_CONFIG = "config/tsconfig/oxlint.extensions.json";
const EXTENSIONS_DIR = "extensions";
const OXLINT_SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;

const CORE_SHARD = {
  name: "core",
  args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "src", "ui", "packages"],
};
const EXTENSIONS_SHARD = {
  name: "extensions",
  args: ["--tsconfig", EXTENSION_TS_CONFIG, EXTENSIONS_DIR],
};
const SCRIPTS_SHARD = {
  name: "scripts",
  args: ["--tsconfig", "config/tsconfig/oxlint.scripts.json", "scripts"],
};

export function createOxlintShards({
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  readDir = fs.readdirSync,
} = {}) {
  const extensionShards =
    platform === "win32"
      ? createWindowsExtensionShards({ cwd, env, readDir })
      : [EXTENSIONS_SHARD];

  return [CORE_SHARD, ...extensionShards, SCRIPTS_SHARD];
}

export function createWindowsExtensionShards({
  cwd = process.cwd(),
  env = process.env,
  readDir = fs.readdirSync,
} = {}) {
  const entries = listExtensionEntries({ cwd, readDir });
  if (entries.dirs.length === 0 && entries.rootFiles.length === 0) {
    return [EXTENSIONS_SHARD];
  }

  const chunkSize = resolveWindowsExtensionChunkSize(env);
  const shards = [];

  if (entries.rootFiles.length > 0) {
    shards.push({
      name: "extensions:root",
      args: ["--tsconfig", EXTENSION_TS_CONFIG, ...entries.rootFiles],
    });
  }

  for (let index = 0; index < entries.dirs.length; index += chunkSize) {
    const chunk = entries.dirs.slice(index, index + chunkSize);
    const chunkNumber = String(index / chunkSize + 1).padStart(2, "0");
    shards.push({
      name: `extensions:${chunkNumber}`,
      args: ["--tsconfig", EXTENSION_TS_CONFIG, ...chunk],
    });
  }
  return shards;
}

export function resolveWindowsExtensionChunkSize(env = process.env) {
  const rawValue = env.OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE;
  if (rawValue === undefined) {
    return DEFAULT_WINDOWS_EXTENSION_CHUNK_SIZE;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : DEFAULT_WINDOWS_EXTENSION_CHUNK_SIZE;
}

function listExtensionEntries({ cwd, readDir }) {
  let entries;
  try {
    entries = readDir(path.join(cwd, EXTENSIONS_DIR), { withFileTypes: true });
  } catch {
    return {
      dirs: [],
      rootFiles: [],
    };
  }

  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${EXTENSIONS_DIR}/${entry.name}`)
    .toSorted((left, right) => left.localeCompare(right));
  const rootFiles = entries
    .filter((entry) => entry.isFile() && OXLINT_SOURCE_FILE_PATTERN.test(entry.name))
    .map((entry) => `${EXTENSIONS_DIR}/${entry.name}`)
    .toSorted((left, right) => left.localeCompare(right));

  return {
    dirs,
    rootFiles,
  };
}

export async function main(extraArgs = process.argv.slice(2), runtimeEnv = process.env) {
  const runner = path.resolve("scripts", "run-oxlint.mjs");
  const env = resolveLocalHeavyCheckEnv(runtimeEnv);
  const hasMetadataOnlyFlag = extraArgs.some((arg) =>
    ["--help", "-h", "--version", "-V", "--rules", "--print-config", "--init"].includes(arg),
  );
  const shouldAcquireParentLock =
    !hasMetadataOnlyFlag ||
    shouldAcquireLocalHeavyCheckLockForOxlint(extraArgs, {
      cwd: process.cwd(),
      env,
    });
  const releaseLock =
    env.OPENCLAW_OXLINT_SKIP_LOCK === "1"
      ? () => {}
      : shouldAcquireParentLock
        ? acquireLocalHeavyCheckLockSync({
            cwd: process.cwd(),
            env,
            toolName: "oxlint shards",
          })
        : () => {};

  const shards = createOxlintShards({
    cwd: process.cwd(),
    env,
    platform: process.platform,
  });

  try {
    const prepareResult = spawnSync(
      process.execPath,
      [path.resolve("scripts", "prepare-extension-package-boundary-artifacts.mjs")],
      {
        stdio: "inherit",
        env,
      },
    );

    if (prepareResult.error) {
      throw prepareResult.error;
    }
    if ((prepareResult.status ?? 1) !== 0) {
      process.exitCode = prepareResult.status ?? 1;
    } else {
      const runSerial = env.OPENCLAW_OXLINT_SHARDS_SERIAL === "1" || process.platform === "win32";
      const results = runSerial
        ? await runShardsSerial({ entries: shards, env, extraArgs, runner })
        : await Promise.all(shards.map((shard) => runShard({ env, extraArgs, runner, shard })));
      process.exitCode = results.find((status) => status !== 0) ?? 0;
    }
  } finally {
    releaseLock();
  }
}

if (import.meta.main) {
  await main();
}

async function runShardsSerial({ entries, env, extraArgs, runner }) {
  const results = [];
  for (const shard of entries) {
    results.push(await runShard({ env, extraArgs, runner, shard }));
  }
  return results;
}

async function runShard({ env, extraArgs, runner, shard }) {
  console.error(`[oxlint:${shard.name}] starting`);
  const child = spawn(process.execPath, [runner, ...shard.args, ...extraArgs], {
    stdio: "inherit",
    env: {
      ...env,
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_OXLINT_SKIP_PREPARE: "1",
    },
  });

  return await new Promise((resolve) => {
    child.once("error", (error) => {
      console.error(error);
      resolve(1);
    });
    child.once("close", (status) => {
      console.error(`[oxlint:${shard.name}] finished`);
      resolve(status ?? 1);
    });
  });
}
