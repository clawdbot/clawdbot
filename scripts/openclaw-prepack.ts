#!/usr/bin/env -S node --import tsx
// Openclaw Prepack script supports OpenClaw repository automation.

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "../src/infra/errors.ts";
import { writePackageDistInventory } from "../src/infra/package-dist-inventory.ts";
import { preparePackageChangelog } from "./package-changelog.mjs";
import { createPnpmRunnerSpawnSpec } from "./pnpm-runner.mjs";
const FULL_GIT_COMMIT_RE = /^[0-9a-f]{40}$/iu;
const requiredPreparedPathGroups = [
  ["dist/index.js", "dist/index.mjs"],
  ["dist/control-ui/index.html"],
];
const requiredControlUiAssetPrefix = "dist/control-ui/assets/";
const DEFAULT_PREPACK_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const ALLOW_UNRELEASED_CHANGELOG_ENV = "OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG";

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

export function resolvePrepackAllowUnreleasedChangelog(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[ALLOW_UNRELEASED_CHANGELOG_ENV]?.trim();
  if (raw === undefined || raw === "" || raw === "0" || raw === "false") {
    return false;
  }
  if (raw === "1" || raw === "true") {
    return true;
  }
  throw new Error(`invalid ${ALLOW_UNRELEASED_CHANGELOG_ENV}: ${raw}`);
}

export function resolvePrepackCommandStdio(
  options: SpawnSyncOptions,
  env: NodeJS.ProcessEnv = process.env,
): SpawnSyncOptions["stdio"] {
  const requestedStdio = options.stdio ?? "inherit";
  const npmJsonOutput = env.npm_config_json === "true" || env.npm_config_json === "1";
  if (npmJsonOutput && requestedStdio === "inherit") {
    return ["inherit", 2, "inherit"];
  }
  return requestedStdio;
}

export function runPrepackCommand(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
): ReturnType<typeof spawnSync> {
  const env = options.env ?? process.env;
  return spawnSync(command, args, {
    ...options,
    env,
    killSignal: options.killSignal ?? "SIGKILL",
    stdio: resolvePrepackCommandStdio(options, env),
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

export function resolvePrepackBuildEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
  readGitCommit: () => string | null = () => {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 ? result.stdout.trim() : null;
  },
): NodeJS.ProcessEnv {
  const explicitTimestamp = env.OPENCLAW_BUILD_TIMESTAMP?.trim();
  const explicitCommit = env.GIT_COMMIT?.trim() || env.GIT_SHA?.trim();
  const checkedOutCommit = explicitCommit ? null : readGitCommit()?.trim();
  // GITHUB_SHA names the workflow invocation and can differ from a checked-out tag.
  const commit = explicitCommit || checkedOutCommit || env.GITHUB_SHA?.trim();
  if (commit && !FULL_GIT_COMMIT_RE.test(commit)) {
    throw new Error("build commit must be a full 40-character hexadecimal SHA");
  }
  const buildEnv: NodeJS.ProcessEnv = {
    ...env,
    OPENCLAW_BUILD_TIMESTAMP: explicitTimestamp || now().toISOString(),
  };
  if (commit) {
    buildEnv.GIT_COMMIT = commit.toLowerCase();
  }
  return buildEnv;
}

function runPnpm(args: string[], env: NodeJS.ProcessEnv): void {
  const command = createPnpmRunnerSpawnSpec({
    env,
    pnpmArgs: args,
    stdio: "inherit",
  });
  run(command.command, command.args, { ...command.options, env });
}

function runBuildSmoke(): void {
  run(process.execPath, ["scripts/test-built-bundled-channel-entry-smoke.mjs"]);
}

async function writeDistInventory(): Promise<void> {
  await writePackageDistInventory(process.cwd());
}

export async function preparePrepackArtifacts(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  ensurePreparedArtifacts();
  await writeDistInventory();
  runBuildSmoke();
  await preparePackageChangelog(process.cwd(), {
    allowUnreleased: resolvePrepackAllowUnreleasedChangelog(env),
  });
}

async function main(): Promise<void> {
  const buildEnv = resolvePrepackBuildEnvironment();
  runPnpm(["build"], buildEnv);
  runPnpm(["ui:build"], buildEnv);
  await preparePrepackArtifacts(buildEnv);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
