#!/usr/bin/env -S node --import tsx
// Openclaw Prepack script supports OpenClaw repository automation.

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "../src/infra/errors.ts";
import { readPositiveEnvInt } from "./lib/numeric-options.mjs";
import { writePackageDistInventoryForPublish } from "./lib/package-dist-inventory.ts";
import { preparePackageChangelog } from "./package-changelog.mjs";
import { createPnpmRunnerSpawnSpec } from "./pnpm-runner.mjs";
const FULL_GIT_COMMIT_RE = /^[0-9a-f]{40}$/iu;
const requiredPreparedPathGroups = [
  ["dist/index.js", "dist/index.mjs"],
  ["dist/control-ui/index.html"],
];
const requiredControlUiAssetPrefix = "dist/control-ui/assets/";
const requiredControlUiCompressionSuffixes = [".br", ".gz"] as const;
const DEFAULT_PREPACK_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const ALLOW_UNRELEASED_CHANGELOG_ENV = "OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG";
const PREPARED_RELEASE_ENV = "OPENCLAW_PREPACK_PREPARED";
const OCM_INTERNAL_NPM_BIN_ENV = "OCM_INTERNAL_NPM_BIN";
const OCM_WORKSPACE_DIRS_ENV = "OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS";
const OCM_ADAPTER_BASENAME = "ocm-npm-workspace-deps.mjs";
const NPM_COMMAND_ENV = "npm_command";
const SELF_CONTAINED_SOURCE_PACK_COMMAND =
  "node scripts/package-openclaw-for-docker.mjs --allow-unreleased-changelog";

type PreparedFileReader = {
  existsSync: typeof existsSync;
  readdirSync: typeof readdirSync;
};

type PackageManifest = {
  dependencies?: Record<string, unknown>;
  name?: unknown;
};

function ocmExternalizesWorkspacePackage(packageName: string, env: NodeJS.ProcessEnv): boolean {
  if (env[NPM_COMMAND_ENV] !== "pack") {
    return false;
  }
  const adapterPath = env[OCM_INTERNAL_NPM_BIN_ENV]?.trim();
  if (!adapterPath || basename(adapterPath) !== OCM_ADAPTER_BASENAME) {
    return false;
  }
  const workspaceDirs = (env[OCM_WORKSPACE_DIRS_ENV] ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  // OCM uses these same manifests to pack and install dependencies beside the root archive.
  // Require the exact package here so unrelated ambient paths cannot bypass the plain-pack guard.
  return workspaceDirs.some((workspaceDir) => {
    try {
      const manifest = JSON.parse(
        readFileSync(join(workspaceDir, "package.json"), "utf8"),
      ) as PackageManifest;
      return manifest.name === packageName;
    } catch {
      return false;
    }
  });
}

function normalizeFiles(files: Iterable<string>): Set<string> {
  return new Set(Array.from(files, (file) => file.replace(/\\/g, "/")));
}

export function collectSourcePackWorkspaceDependencyErrors(
  packageJson: PackageManifest,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (env[PREPARED_RELEASE_ENV]?.trim() === "1") {
    return [];
  }
  const aiDependency = packageJson.dependencies?.["@openclaw/ai"];
  if (typeof aiDependency !== "string" || !aiDependency.trim().startsWith("workspace:")) {
    return [];
  }
  if (ocmExternalizesWorkspacePackage("@openclaw/ai", env)) {
    return [];
  }
  return [
    `plain root packing cannot safely resolve @openclaw/ai from ${aiDependency}: pnpm rewrites the workspace dependency to an exact version without bundling the package`,
    `use \`${SELF_CONTAINED_SOURCE_PACK_COMMAND}\` for a self-contained source package; official npm release automation prepares and publishes @openclaw/ai separately`,
  ];
}

function ensureSupportedSourcePack(env: NodeJS.ProcessEnv = process.env): void {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageManifest;
  const errors = collectSourcePackWorkspaceDependencyErrors(packageJson, env);
  if (errors.length === 0) {
    return;
  }
  for (const error of errors) {
    console.error(`prepack: ${error}`);
  }
  process.exit(1);
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
    for (const suffix of requiredControlUiCompressionSuffixes) {
      if (!Array.from(normalizedAssets).some((assetPath) => assetPath.endsWith(suffix))) {
        errors.push(
          `missing prepared Control UI ${suffix} asset under ${requiredControlUiAssetPrefix}`,
        );
      }
    }
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

export function resolvePrepackCommandTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveEnvInt(
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
  await writePackageDistInventoryForPublish(process.cwd());
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
  ensureSupportedSourcePack();
  const buildEnv = resolvePrepackBuildEnvironment();
  runPnpm(["build"], buildEnv);
  runPnpm(["ui:build"], buildEnv);
  await preparePrepackArtifacts(buildEnv);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
