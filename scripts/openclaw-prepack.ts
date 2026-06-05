#!/usr/bin/env -S node --import tsx
// Openclaw Prepack script supports OpenClaw repository automation.

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "../src/infra/errors.ts";
import { writePackageDistInventory } from "../src/infra/package-dist-inventory.ts";
import { preparePackageChangelog } from "./package-changelog.mjs";
import { createPnpmRunnerSpawnSpec } from "./pnpm-runner.mjs";
const requiredPreparedPathGroups = [
  ["dist/index.js", "dist/index.mjs"],
  ["dist/control-ui/index.html"],
];
const requiredControlUiAssetPrefix = "dist/control-ui/assets/";
const DEFAULT_PREPACK_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

type PreparedFileReader = {
  existsSync: typeof existsSync;
  readdirSync: typeof readdirSync;
};

function normalizeFiles(files: Iterable<string>): Set<string> {
  return new Set(Array.from(files, (file) => file.replace(/\\/g, "/")));
}

export function collectPreparedPrepackErrors(
  files: Iterable<string>,
  assetPaths: Iterable<string>,
): string[] {
  const normalizedFiles = normalizeFiles(files);
  const normalizedAssets = normalizeFiles(assetPaths);
  const errors: string[] = [];

  for (const group of requiredPreparedPathGroups) {
    if (group.some((path) => normalizedFiles.has(path))) {
      continue;
    }
    errors.push(`missing required prepared artifact: ${group.join(" or ")}`);
  }

  if (!normalizedAssets.values().next().done) {
    return errors;
  }

  errors.push(`missing prepared Control UI asset payload under ${requiredControlUiAssetPrefix}`);
  return errors;
}

function collectPreparedFilePaths(reader: PreparedFileReader = { existsSync, readdirSync }): {
  files: Set<string>;
  assets: string[];
} {
  const assets = reader
    .readdirSync("dist/control-ui/assets", { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? [] : [`${requiredControlUiAssetPrefix}${entry.name}`],
    );

  const files = new Set<string>();
  for (const group of requiredPreparedPathGroups) {
    for (const path of group) {
      if (reader.existsSync(path)) {
        files.add(path);
      }
    }
  }

  return {
    files,
    assets,
  };
}

function ensurePreparedArtifacts(): void {
  try {
    const preparedFiles = collectPreparedFilePaths();
    const errors = collectPreparedPrepackErrors(preparedFiles.files, preparedFiles.assets);
    if (errors.length === 0) {
      console.error("prepack: using existing prepared artifacts.");
      return;
    }
    for (const error of errors) {
      console.error(`prepack: ${error}`);
    }
  } catch (error) {
    const message = formatErrorMessage(error);
    console.error(`prepack: failed to verify prepared artifacts: ${message}`);
  }

  console.error(
    "prepack: requires an existing build and Control UI bundle. Run `pnpm build && pnpm ui:build` before packing or publishing.",
  );
  process.exit(1);
}

function positiveEnvInt(name: string, env: NodeJS.ProcessEnv, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return value;
}

export function resolvePrepackCommandTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveEnvInt(
    "OPENCLAW_PREPACK_COMMAND_TIMEOUT_MS",
    env,
    DEFAULT_PREPACK_COMMAND_TIMEOUT_MS,
  );
}

export function runPrepackCommand(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
): ReturnType<typeof spawnSync> {
  const env = options.env ?? process.env;
  return spawnSync(command, args, {
    stdio: "inherit",
    ...options,
    env,
    killSignal: options.killSignal ?? "SIGKILL",
    timeout: options.timeout ?? resolvePrepackCommandTimeoutMs(env),
  });
}

function run(command: string, args: string[], options: SpawnSyncOptions = {}): void {
  const result = runPrepackCommand(command, args, options);
  if (result.status === 0) {
    return;
  }
  if (result.error) {
    console.error(`prepack: ${command} failed: ${formatErrorMessage(result.error)}`);
  }
  process.exit(result.status ?? 1);
}

function runPnpm(args: string[]): void {
  const command = createPnpmRunnerSpawnSpec({
    env: process.env,
    pnpmArgs: args,
    stdio: "inherit",
  });
  run(command.command, command.args, command.options);
}

function runBuildSmoke(): void {
  run(process.execPath, ["scripts/test-built-bundled-channel-entry-smoke.mjs"]);
}

async function writeDistInventory(): Promise<void> {
  await writePackageDistInventory(process.cwd());
}

async function main(): Promise<void> {
  runPnpm(["build"]);
  runPnpm(["ui:build"]);
  ensurePreparedArtifacts();
  await writeDistInventory();
  runBuildSmoke();
  await preparePackageChangelog();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
