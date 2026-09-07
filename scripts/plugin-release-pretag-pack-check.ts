#!/usr/bin/env -S node --import tsx

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import { collectClawHubPublishablePluginPackages } from "./lib/plugin-clawhub-release.ts";
import { collectPublishablePluginPackages } from "./lib/plugin-npm-release.ts";

const DEFAULT_CLAWHUB_CLI_PACKAGE = "clawhub@0.23.3";
// Match the existing npm release-check and shrinkwrap command 10-minute ceilings: complete
// plugin builds and packs retain their normal budget while lifecycle or registry stalls stop.
const PLUGIN_RELEASE_PRETAG_COMMAND_TIMEOUT_MS = 10 * 60_000;

type PluginReleasePretagPackTarget = {
  packageDir: string;
  packageName: string;
  packClawHub: boolean;
  packNpm: boolean;
};

/** Preserve conventional managed-command exit statuses at the executable boundary. */
export function pluginReleasePretagExitCode(error: unknown): number {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "number" &&
    Number.isInteger(error.code) &&
    error.code >= 0 &&
    error.code <= 255
  ) {
    return error.code;
  }
  return 1;
}

export function collectPluginReleasePretagPackTargets(
  rootDir = resolve("."),
): PluginReleasePretagPackTarget[] {
  const targets = new Map<string, PluginReleasePretagPackTarget>();

  for (const plugin of collectPublishablePluginPackages(rootDir)) {
    targets.set(plugin.packageDir, {
      packageDir: plugin.packageDir,
      packageName: plugin.packageName,
      packClawHub: false,
      packNpm: true,
    });
  }
  for (const plugin of collectClawHubPublishablePluginPackages(rootDir)) {
    const existing = targets.get(plugin.packageDir);
    targets.set(plugin.packageDir, {
      packageDir: plugin.packageDir,
      packageName: plugin.packageName,
      packClawHub: true,
      packNpm: existing?.packNpm ?? false,
    });
  }

  return [...targets.values()].toSorted((left, right) =>
    left.packageName.localeCompare(right.packageName),
  );
}

async function runCommand(
  command: string,
  args: string[],
  params: {
    commandLabel: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    quietStdout?: boolean;
    stage: string;
    timeoutMs: number;
  },
): Promise<void> {
  let status: number;
  try {
    status = await runManagedCommand({
      args,
      bin: command,
      cwd: params.cwd,
      env: params.env,
      shell: false,
      stdio: params.quietStdout ? ["inherit", "ignore", "inherit"] : "inherit",
      timeoutMs: params.timeoutMs,
    });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ETIMEDOUT")) {
      throw error;
    }
    throw Object.assign(
      new Error(`${params.stage} timed out after ${params.timeoutMs}ms: ${params.commandLabel}`),
      { code: "ETIMEDOUT" as const },
    );
  }
  if (status !== 0) {
    throw Object.assign(
      new Error(`${params.stage} failed with exit code ${status}: ${params.commandLabel}`),
      { code: status },
    );
  }
}

export async function runPluginReleasePretagPackCheck(
  rootDir = resolve("."),
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? PLUGIN_RELEASE_PRETAG_COMMAND_TIMEOUT_MS;
  const targets = collectPluginReleasePretagPackTargets(rootDir);
  const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-plugin-pretag-pack-"));
  const wrapperDir = join(tempRoot, "bin");
  mkdirSync(wrapperDir);
  const clawHubWrapper = join(wrapperDir, "clawhub");
  writeFileSync(
    clawHubWrapper,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'exec npm exec --yes --package "${CLAWHUB_CLI_PACKAGE}" -- clawhub "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(clawHubWrapper, 0o755);

  try {
    const packEnv = {
      ...process.env,
      CLAWHUB_CLI_PACKAGE: process.env.CLAWHUB_CLI_PACKAGE?.trim() || DEFAULT_CLAWHUB_CLI_PACKAGE,
      PATH: `${wrapperDir}:${process.env.PATH ?? ""}`,
    };
    const prebuiltPackEnv = {
      ...packEnv,
      OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0",
    };
    for (const [index, target] of targets.entries()) {
      console.log(`plugin runtime build: ${target.packageName}`);
      await runCommand(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/check-plugin-npm-runtime-builds.mts",
          "--package",
          target.packageDir,
        ],
        {
          commandLabel: `node --import tsx scripts/check-plugin-npm-runtime-builds.mts --package ${target.packageDir}`,
          cwd: rootDir,
          stage: `plugin runtime build for ${target.packageName}`,
          timeoutMs,
        },
      );
      if (target.packNpm) {
        console.log(`npm pack: ${target.packageName}`);
        await runCommand(
          "bash",
          ["scripts/plugin-npm-publish.sh", "--pack-dry-run", target.packageDir],
          {
            commandLabel: `bash scripts/plugin-npm-publish.sh --pack-dry-run ${target.packageDir}`,
            cwd: rootDir,
            env: prebuiltPackEnv,
            quietStdout: true,
            stage: `npm pack for ${target.packageName}`,
            timeoutMs,
          },
        );
      }
      if (target.packClawHub) {
        const outputDir = join(tempRoot, `clawhub-${index}`);
        console.log(`ClawHub pack: ${target.packageName}`);
        await runCommand(
          "bash",
          ["scripts/plugin-clawhub-publish.sh", "--pack", target.packageDir],
          {
            commandLabel: `bash scripts/plugin-clawhub-publish.sh --pack ${target.packageDir}`,
            cwd: rootDir,
            env: {
              ...prebuiltPackEnv,
              OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR: outputDir,
            },
            quietStdout: true,
            stage: `ClawHub pack for ${target.packageName}`,
            timeoutMs,
          },
        );
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(`plugin-release-pretag-pack-check: packed ${targets.length} publishable plugins.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await runPluginReleasePretagPackCheck();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = pluginReleasePretagExitCode(error);
  }
}
