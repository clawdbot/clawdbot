// Formats OpenClaw CLI command snippets for chat-facing command responses.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isBunRuntime } from "../../daemon/runtime-binary.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";

const requireFromHere = createRequire(import.meta.url);
const OPENCLAW_CLI_ENTRY_BASENAMES = new Set(["openclaw", "openclaw.mjs"]);
const OPENCLAW_PACKAGE_ENTRY_PATHS = new Set([
  path.join("dist", "entry.js"),
  path.join("dist", "entry.mjs"),
  path.join("dist", "index.js"),
  path.join("dist", "index.mjs"),
  path.join("src", "entry.ts"),
]);
const TEST_RUNNER_ENV_PREFIXES = ["VITEST_", "OPENCLAW_VITEST_"];

function quoteShellArg(value: string): string {
  if (process.platform === "win32") {
    return `'${value.replaceAll("'", "''")}'`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isOpenClawCliLauncherEntry(entry: string): boolean {
  return OPENCLAW_CLI_ENTRY_BASENAMES.has(path.basename(entry));
}

function isOpenClawPackageEntry(entry: string, packageRoot: string): boolean {
  const relativeEntry = path.relative(path.resolve(packageRoot), path.resolve(entry));
  return OPENCLAW_PACKAGE_ENTRY_PATHS.has(relativeEntry);
}

function safeCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

function buildPackageRootCliArgvPrefix(packageRoot: string): string[] {
  const sourceEntry = path.join(packageRoot, "src", "entry.ts");
  if (fs.existsSync(sourceEntry)) {
    const tsxLoader = resolveTrustedTsxLoader(packageRoot);
    return isBunRuntime(process.execPath)
      ? [process.execPath, sourceEntry]
      : tsxLoader
        ? [process.execPath, "--import", tsxLoader, sourceEntry]
        : [process.execPath, path.join(packageRoot, "openclaw.mjs")];
  }
  return [process.execPath, path.join(packageRoot, "openclaw.mjs")];
}

function resolveTrustedTsxLoader(packageRoot: string): string | null {
  try {
    return requireFromHere.resolve("tsx", { paths: [packageRoot] });
  } catch {
    return null;
  }
}

function resolveCurrentOpenClawCliArgvPrefix(): string[] {
  const entry = process.argv[1]?.trim();
  if (entry && entry !== process.execPath && isOpenClawCliLauncherEntry(entry)) {
    return [process.execPath, ...process.execArgv, entry];
  }
  const entryPackageRoot = entry ? resolveOpenClawPackageRootSync({ argv1: entry }) : null;
  if (entry && entryPackageRoot && isOpenClawPackageEntry(entry, entryPackageRoot)) {
    return [process.execPath, ...process.execArgv, entry];
  }
  const packageRoot = resolveOpenClawPackageRootSync({
    argv1: entry,
    cwd: safeCwd(),
    moduleUrl: import.meta.url,
  });
  if (packageRoot) {
    return buildPackageRootCliArgvPrefix(packageRoot);
  }
  return entry && entry !== process.execPath ? [process.execPath, entry] : [process.execPath];
}

/** Reconstructs the current OpenClaw CLI invocation with extra args. */
export function buildCurrentOpenClawCliArgv(args: string[]): string[] {
  return [...resolveCurrentOpenClawCliArgvPrefix(), ...args];
}

/** Clears test-runner env inherited by harness-hosted gateways before spawning the CLI. */
export function buildCurrentOpenClawCliExecEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const overrides: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    if (key === "VITEST" || TEST_RUNNER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      overrides[key] = "";
    }
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/** Builds a shell-quoted command string for rerunning the current OpenClaw CLI. */
export function buildCurrentOpenClawCliCommand(args: string[]): string {
  return buildCurrentOpenClawCliArgv(args).map(quoteShellArg).join(" ");
}
