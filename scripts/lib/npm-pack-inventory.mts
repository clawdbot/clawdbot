import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { resolveNpmRunner, type NpmRunnerParams } from "../npm-runner.mts";
import { resolveNpmJsonEntries } from "./npm-json-output.mts";

const NPM_VERSION_TIMEOUT_MS = 10_000;
const ISOLATED_ENV_KEYS =
  "HOME INIT_CWD OLDPWD PWD USERPROFILE XDG_CACHE_HOME XDG_CONFIG_HOME".split(" ");
type NpmSandbox = Record<"cacheDir" | "configDir" | "cwd" | "homeDir", string>;
type NpmPackInventoryOptions = {
  runnerParams?: Omit<NpmRunnerParams, "env" | "npmArgs">;
  sourceEnv?: NodeJS.ProcessEnv;
  timeoutMs: number;
};
export function compareNpmPackInventory(
  tarFiles: Iterable<string>,
  npmFiles: Iterable<string>,
  ignoredPaths: Iterable<string> = [],
): { extra: string[]; missing: string[] } {
  const ignored = new Set(ignoredPaths);
  const tarSet = new Set([...tarFiles].filter((entry) => !ignored.has(entry)));
  const npmSet = new Set([...npmFiles].filter((entry) => !ignored.has(entry)));
  return {
    extra: [...tarSet].filter((entry) => !npmSet.has(entry)).toSorted(),
    missing: [...npmSet].filter((entry) => !tarSet.has(entry)).toSorted(),
  };
}

function normalizePackagePath(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("npm pack returned a file entry without a string path");
  }
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/u, "");
  if (
    !normalized ||
    normalized.endsWith("/") ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(value) ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`npm pack returned an invalid package path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function parseNpmVersion(stdout: string): string {
  const version = stdout.trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(
      `npm --version returned invalid output: ${JSON.stringify(version.slice(0, 80))}`,
    );
  }
  return version;
}

function parseNpmPackFiles(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("npm pack returned invalid JSON");
  }
  const entries = resolveNpmJsonEntries(parsed);
  if (entries.length !== 1 || !isRecord(entries[0])) {
    throw new Error("npm pack JSON must contain exactly one package result");
  }
  const files = entries[0].files;
  if (!Array.isArray(files)) {
    throw new Error("npm pack JSON result is missing its files array");
  }
  const normalizedFiles: string[] = [];
  const seen = new Set<string>();
  for (const entry of files) {
    if (!isRecord(entry)) {
      throw new Error("npm pack returned an invalid file entry");
    }
    const file = normalizePackagePath(entry.path);
    if (seen.has(file)) {
      throw new Error(`npm pack returned duplicate package path ${file}`);
    }
    seen.add(file);
    normalizedFiles.push(file);
  }
  return normalizedFiles.toSorted();
}

function controlledNpmEnvironment(
  sourceEnv: NodeJS.ProcessEnv,
  sandbox: NpmSandbox,
): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(sourceEnv).filter(
      ([key]) => !/^npm_/iu.test(key) && !ISOLATED_ENV_KEYS.includes(key.toUpperCase()),
    ),
  );
  return {
    ...env,
    HOME: sandbox.homeDir,
    INIT_CWD: sandbox.cwd,
    NPM_CONFIG_CACHE: sandbox.cacheDir,
    NPM_CONFIG_GLOBALCONFIG: path.join(sandbox.configDir, "global.npmrc"),
    NPM_CONFIG_USERCONFIG: path.join(sandbox.configDir, "user.npmrc"),
    PWD: sandbox.cwd,
    USERPROFILE: sandbox.homeDir,
    XDG_CACHE_HOME: sandbox.cacheDir,
    XDG_CONFIG_HOME: sandbox.configDir,
  };
}

function describeSpawnFailure(
  label: string,
  result: ReturnType<typeof spawnSync>,
  timeoutMs: number,
): string {
  const error = result.error as NodeJS.ErrnoException | undefined;
  const knownFailure = error?.code
    ? (
        {
          ENOBUFS: "exceeded its output limit",
          ENOENT: "executable was not found",
          ETIMEDOUT: `timed out after ${timeoutMs}ms`,
        } as Record<string, string>
      )[error.code]
    : undefined;
  if (knownFailure) {
    return `${label} ${knownFailure}`;
  }
  const stderr = typeof result.stderr === "string" ? result.stderr.trim().slice(0, 2_000) : "";
  return `${label} failed${stderr ? `: ${stderr}` : ` with status ${String(result.status)}`}`;
}

function withoutPackageScripts<T>(packageRoot: string, run: () => T): T {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const originalBytes = fs.readFileSync(packageJsonPath);
  const originalMode = fs.statSync(packageJsonPath).mode;
  const packageJson = JSON.parse(originalBytes.toString("utf8")) as unknown;
  if (!isRecord(packageJson)) {
    throw new Error("package.json must contain an object");
  }
  delete packageJson.scripts;

  // Callers provide unique disposable extracted trees, so this synchronous mutation is isolated.
  try {
    if ((originalMode & 0o200) === 0) {
      fs.chmodSync(packageJsonPath, originalMode | 0o200);
    }
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson));
    return run();
  } finally {
    try {
      fs.writeFileSync(packageJsonPath, originalBytes);
    } finally {
      fs.chmodSync(packageJsonPath, originalMode);
    }
  }
}

export function collectNpmPackInventory(packageRoot: string, options: NpmPackInventoryOptions) {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm-pack-inventory-"));
  const sandbox = {
    cacheDir: path.join(sandboxRoot, "cache"),
    configDir: path.join(sandboxRoot, "config"),
    cwd: path.join(sandboxRoot, "cwd"),
    homeDir: path.join(sandboxRoot, "home"),
  };
  for (const directory of Object.values(sandbox)) {
    fs.mkdirSync(directory);
  }
  fs.writeFileSync(path.join(sandbox.configDir, "global.npmrc"), "", { mode: 0o600 });
  fs.writeFileSync(path.join(sandbox.configDir, "user.npmrc"), "", { mode: 0o600 });

  const npmEnv = controlledNpmEnvironment(options.sourceEnv ?? process.env, sandbox);
  const spawnOptions = { cwd: sandbox.cwd, encoding: "utf8" as const, windowsHide: true };
  const runNpm = (label: string, args: string[], timeout: number, maxBuffer: number): string => {
    const npm = resolveNpmRunner({
      env: npmEnv,
      npmArgs: [`--prefix=${sandbox.cwd}`, ...args],
      ...options.runnerParams,
    });
    const result = spawnSync(npm.command, npm.args, {
      ...spawnOptions,
      env: npm.env ?? npmEnv,
      maxBuffer,
      shell: npm.shell,
      timeout,
      windowsVerbatimArguments: npm.windowsVerbatimArguments,
    });
    if (result.status !== 0 || result.error) {
      throw new Error(describeSpawnFailure(label, result, timeout));
    }
    return result.stdout;
  };
  const startedAt = Date.now();
  try {
    const npmVersion = parseNpmVersion(
      runNpm("npm --version", ["--version"], NPM_VERSION_TIMEOUT_MS, 64 * 1024),
    );
    const packOutput = withoutPackageScripts(packageRoot, () =>
      runNpm(
        "npm pack inventory",
        [
          "pack",
          packageRoot,
          "--dry-run",
          "--json",
          "--ignore-scripts",
          "--offline",
          "--workspaces=false",
          "--include-workspace-root=false",
          "--audit=false",
          "--fund=false",
          "--update-notifier=false",
          "--color=false",
          "--loglevel=error",
        ],
        options.timeoutMs,
        64 * 1024 * 1024,
      ),
    );
    if (fs.readdirSync(sandbox.cwd).length !== 0) {
      throw new Error("npm pack inventory wrote files outside the extracted package root");
    }
    return {
      durationMs: Date.now() - startedAt,
      files: parseNpmPackFiles(packOutput),
      npmVersion,
    };
  } finally {
    fs.rmSync(sandboxRoot, { force: true, recursive: true });
  }
}
