#!/usr/bin/env -S node --import tsx

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "../src/infra/errors.ts";
import { writePackageDistInventory } from "../src/infra/package-dist-inventory.ts";

const skipPrepackPreparedEnv = "OPENCLAW_PREPACK_PREPARED";
const requiredPreparedPathGroups = [
  ["dist/index.js", "dist/index.mjs"],
  ["dist/control-ui/index.html"],
];
const requiredControlUiAssetPrefix = "dist/control-ui/assets/";

type PreparedFileReader = {
  existsSync: typeof existsSync;
  readdirSync: typeof readdirSync;
};

function normalizeFiles(files: Iterable<string>): Set<string> {
  return new Set(Array.from(files, (file) => file.replace(/\\/g, "/")));
}

export function shouldSkipPrepack(env = process.env): boolean {
  const raw = env[skipPrepackPreparedEnv];
  if (!raw) {
    return false;
  }
  return !/^(0|false)$/i.test(raw);
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
      console.error(
        `prepack: using prepared artifacts from ${skipPrepackPreparedEnv}; skipping rebuild.`,
      );
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
    `prepack: ${skipPrepackPreparedEnv}=1 requires an existing build and Control UI bundle. Run \`pnpm build && pnpm ui:build\` first or unset ${skipPrepackPreparedEnv}.`,
  );
  process.exit(1);
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status === 0) {
    return;
  }
  process.exit(result.status ?? 1);
}

function runBuildSmoke(): void {
  run(process.execPath, ["scripts/test-built-bundled-channel-entry-smoke.mjs"]);
}

async function writeDistInventory(): Promise<void> {
  await writePackageDistInventory(process.cwd());
}

async function main(): Promise<void> {
  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  if (shouldSkipPrepack()) {
    ensurePreparedArtifacts();
    await writeDistInventory();
    runBuildSmoke();
    return;
  }
  run(pnpmCommand, ["build"]);
  run(pnpmCommand, ["ui:build"]);
  await writeDistInventory();
  runBuildSmoke();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
