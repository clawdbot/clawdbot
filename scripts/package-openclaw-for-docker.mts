#!/usr/bin/env node
// Builds the canonical OpenClaw package artifact used by Docker E2E.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireOptionArgument } from "./lib/arg-utils.runtime.mjs";
import { DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV } from "./lib/bundled-plugin-build-entries.mjs";
import { toErrorObject } from "./lib/error-format.mts";
import { terminateManagedChild } from "./lib/managed-child-process.mts";
import { resolveNpmJsonEntries } from "./lib/npm-json-output.mts";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";
import {
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "./lib/package-lifecycle-marker.mjs";
import { isRecord } from "./lib/record-shared.mjs";
import { resolveNpmRunner } from "./npm-runner.mts";
import { preparePackageChangelog, restorePackageChangelog } from "./package-changelog.mjs";
import { validateBundledPackageDependencyAlignment } from "./package-source-dependencies.mjs";
import { resolvePnpmRunner } from "./pnpm-runner.mts";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PACKAGE_BUILD_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_PACKAGE_INVENTORY_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_PACKAGE_PACK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_PACKAGE_TARBALL_CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_KILL_AFTER_MS = 5_000;
const PROCESS_GROUP_EXIT_POLL_MS = 25;
const POST_FORCE_KILL_WAIT_MS = 1_000;
const DEFAULT_CAPTURED_STDOUT_MAX_BYTES = 1024 * 1024;
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;
const AI_RUNTIME_PACKAGE = "@openclaw/ai";
const AI_RUNTIME_BACKUP_DIR = ".openclaw-ai-package-backup";

type KillChild = (signal: NodeJS.Signals) => void;
type RunOptions = {
  captureStdout?: boolean;
  env?: NodeJS.ProcessEnv;
  killAfterMs?: unknown;
  maxCapturedStdoutBytes?: number;
  stdoutFilePath?: string;
  timeoutMs?: unknown;
};
type CommandRunnerOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};
type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  options: CommandRunnerOptions,
) => Promise<unknown>;
type RunImpl = (
  command: string,
  args: string[],
  cwd: string,
  options: RunOptions,
) => Promise<string>;
type DocsMapLifecycle = {
  preparePackageDocsMap: (cwd: string) => Promise<unknown>;
  restorePackageDocsMap: (cwd: string) => Promise<unknown>;
};
type PackageManifestLifecycle = {
  preparePackageManifest: (cwd: string) => Promise<unknown>;
  restorePackageManifest: (cwd: string) => Promise<unknown>;
};
type PackageOptions = RunOptions & {
  bundlePlugins?: string[];
  allowUnreleasedChangelog?: unknown;
  extractAiRuntime?: (tarballPath: string, destination: string) => Promise<unknown>;
  normalizeTarballModes?: (tarballPath: string) => Promise<unknown>;
  outputName?: string;
  packJsonPath?: string;
  pnpmPack?: boolean;
  prepareBundledAiRuntime?: typeof prepareBundledAiRuntimePackage;
  prepareChangelog?: (cwd: string) => Promise<unknown>;
  prepareDocsMap?: (cwd: string) => Promise<unknown>;
  prepareManifest?: (cwd: string) => Promise<unknown>;
  restoreChangelog?: (cwd: string) => Promise<unknown>;
  restoreDocsMap?: (cwd: string) => Promise<unknown>;
  restoreManifest?: (cwd: string) => Promise<unknown>;
  runCaptureImpl?: RunImpl;
  runImpl?: CommandRunner;
};
type MutableJsonRecord = Record<string, unknown>;

function isDocsMapLifecycle(value: unknown): value is DocsMapLifecycle {
  return (
    isRecord(value) &&
    typeof value.preparePackageDocsMap === "function" &&
    typeof value.restorePackageDocsMap === "function"
  );
}

function isPackageManifestLifecycle(value: unknown): value is PackageManifestLifecycle {
  return (
    isRecord(value) &&
    typeof value.preparePackageManifest === "function" &&
    typeof value.restorePackageManifest === "function"
  );
}

function hasErrorCode(error: unknown, code: string) {
  return isRecord(error) && error.code === code;
}

const ACTIVE_CHILD_KILLERS = new Set<KillChild>();
const PACKAGE_BUILD_PLUGIN_SELECTION_ENV_NAMES = [
  "OPENCLAW_EXTENSIONS",
  "OPENCLAW_DOCKER_BUILD_EXTENSIONS",
  DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV,
  // Public package builds must not inherit a smoke lane's private QA entrypoints.
  "OPENCLAW_BUILD_PRIVATE_QA",
];
const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
} satisfies Partial<Record<NodeJS.Signals, number>>;
let forwardedSignalExitCode: number | undefined;

class ForwardedSignalExitError extends Error {
  exitCode: number;

  constructor(exitCode: number) {
    super(`forwarded signal requested exit ${exitCode}`);
    this.exitCode = exitCode;
  }
}

for (const signal of Object.keys(SIGNAL_EXIT_CODES) as Array<keyof typeof SIGNAL_EXIT_CODES>) {
  process.on(signal, () => {
    forwardedSignalExitCode ??= SIGNAL_EXIT_CODES[signal];
    if (ACTIVE_CHILD_KILLERS.size === 0) {
      process.exit(forwardedSignalExitCode);
    }
    for (const killChild of ACTIVE_CHILD_KILLERS) {
      killChild(signal);
    }
    setTimeout(() => {
      for (const killChild of ACTIVE_CHILD_KILLERS) {
        killChild("SIGKILL");
      }
      process.exit(forwardedSignalExitCode);
    }, DEFAULT_TIMEOUT_KILL_AFTER_MS);
  });
}

function resolveTimeoutMs(envName: string, defaultValue: number) {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  if (!/^[0-9]+$/u.test(raw)) {
    throw new Error(`${envName} must be a positive timeout in milliseconds`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${envName} must be a positive timeout in milliseconds`);
  }
  return parsed;
}

function numericTimerValueMs(valueMs: unknown) {
  const value = Number(valueMs);
  return Number.isFinite(value) ? Math.floor(value) : undefined;
}

function resolvePackageBuildTimeoutMs(
  valueMs: unknown,
  fallbackMs: unknown = MAX_TIMER_TIMEOUT_MS,
) {
  const value = numericTimerValueMs(valueMs) ?? numericTimerValueMs(fallbackMs);
  return Math.min(Math.max(value ?? MAX_TIMER_TIMEOUT_MS, 1), MAX_TIMER_TIMEOUT_MS);
}

function resolveOptionalTimerTimeoutMs(valueMs: unknown) {
  if (valueMs === undefined) {
    return undefined;
  }
  return resolvePackageBuildTimeoutMs(valueMs, 1);
}

function readEqualsOptionValue(value: string, optionName: string) {
  if (value === "" || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function validateOutputName(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.t(?:ar\.)?gz$/u.test(value)) {
    throw new Error(`--output-name must be a tarball filename, not a path: ${value}`);
  }
}

function resolvePackedOpenClawFileName(value: string) {
  const filename = value.trim();
  if (
    !filename.endsWith(".tgz") ||
    (!filename.startsWith("openclaw-") &&
      !filename.includes(":") &&
      !filename.includes("/") &&
      !filename.includes("\\"))
  ) {
    return "";
  }
  if (
    !/^openclaw-[A-Za-z0-9._-]+\.tgz$/u.test(filename) ||
    filename.includes("\0") ||
    filename !== path.basename(filename) ||
    filename !== path.win32.basename(filename)
  ) {
    throw new Error(`npm pack reported unsafe OpenClaw tarball filename: ${filename}`);
  }
  return filename;
}

export function parseArgs(argv: string[]) {
  const args = argv;
  const options = {
    bundlePlugins: [] as string[],
    allowUnreleasedChangelog: false,
    outputDir: "",
    outputName: "",
    packJson: "",
    pnpmPack: false,
    skipBuild: false,
    sourceDir: ROOT_DIR,
  };
  const seen = new Set<string>();
  const setOnce = <Key extends keyof typeof options>(
    flag: string,
    key: Key,
    value: (typeof options)[Key],
  ): void => {
    if (seen.has(flag)) {
      throw new Error(`${flag} was provided more than once`);
    }
    seen.add(flag);
    options[key] = value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--allow-unreleased-changelog") {
      setOnce(arg, "allowUnreleasedChangelog", true);
    } else if (arg === "--bundle-plugin") {
      options.bundlePlugins.push(requireOptionArgument(args, index, arg));
      index += 1;
    } else if (arg?.startsWith("--bundle-plugin=")) {
      options.bundlePlugins.push(
        readEqualsOptionValue(arg.slice("--bundle-plugin=".length), "--bundle-plugin"),
      );
    } else if (arg === "--output-dir") {
      setOnce("--output-dir", "outputDir", requireOptionArgument(args, index, arg));
      index += 1;
    } else if (arg?.startsWith("--output-dir=")) {
      setOnce(
        "--output-dir",
        "outputDir",
        readEqualsOptionValue(arg.slice("--output-dir=".length), "--output-dir"),
      );
    } else if (arg === "--output-name") {
      setOnce("--output-name", "outputName", requireOptionArgument(args, index, arg));
      index += 1;
    } else if (arg?.startsWith("--output-name=")) {
      setOnce(
        "--output-name",
        "outputName",
        readEqualsOptionValue(arg.slice("--output-name=".length), "--output-name"),
      );
    } else if (arg === "--pack-json") {
      setOnce("--pack-json", "packJson", requireOptionArgument(args, index, arg));
      index += 1;
    } else if (arg?.startsWith("--pack-json=")) {
      setOnce(
        "--pack-json",
        "packJson",
        readEqualsOptionValue(arg.slice("--pack-json=".length), "--pack-json"),
      );
    } else if (arg === "--pnpm-pack") {
      setOnce(arg, "pnpmPack", true);
    } else if (arg === "--skip-build") {
      setOnce(arg, "skipBuild", true);
    } else if (arg === "--source-dir") {
      setOnce("--source-dir", "sourceDir", requireOptionArgument(args, index, arg));
      index += 1;
    } else if (arg?.startsWith("--source-dir=")) {
      setOnce(
        "--source-dir",
        "sourceDir",
        readEqualsOptionValue(arg.slice("--source-dir=".length), "--source-dir"),
      );
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.outputName) {
    validateOutputName(options.outputName);
  }
  if (options.packJson && options.pnpmPack) {
    throw new Error("--pack-json cannot be combined with --pnpm-pack");
  }
  return options;
}

function run(command: string, args: string[], cwd: string, options: RunOptions = {}) {
  const setupError =
    options.captureStdout && options.stdoutFilePath
      ? new Error("captureStdout and stdoutFilePath cannot be combined")
      : forwardedSignalExitCode && new ForwardedSignalExitError(forwardedSignalExitCode);
  if (setupError) {
    return Promise.reject(setupError);
  }
  return new Promise<string>((resolve, reject) => {
    const resolvedTimeoutMs = resolveOptionalTimerTimeoutMs(options.timeoutMs);
    const resolvedKillAfterMs = resolvePackageBuildTimeoutMs(
      options.killAfterMs,
      DEFAULT_TIMEOUT_KILL_AFTER_MS,
    );
    const useProcessGroup = process.platform !== "win32";
    const env = options.env ?? process.env;
    // POSIX callers own PATH; retain that selection while supporting Corepack-only builders.
    const npmExecPath = process.platform === "win32" ? env.npm_execpath : "";
    const invocation: {
      args: string[];
      command: string;
      env?: NodeJS.ProcessEnv;
      shell: boolean;
      windowsVerbatimArguments?: boolean;
    } =
      command === "pnpm"
        ? resolvePnpmRunner({ cwd, env, npmExecPath, pnpmArgs: args })
        : process.platform === "win32" && command === "npm"
          ? resolveNpmRunner({ env, npmArgs: args })
          : { args, command, shell: false };
    const stdoutFd = options.stdoutFilePath ? openSync(options.stdoutFilePath, "wx") : undefined;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        stdio: ["ignore", stdoutFd ?? "pipe", "pipe"],
        env: invocation.env ?? env,
        detached: useProcessGroup,
        shell: invocation.shell,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
    } finally {
      if (stdoutFd !== undefined) {
        closeSync(stdoutFd);
      }
    }
    let timedOut = false;
    let outputLimitExceeded = false;
    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    const maxCapturedStdoutBytes = Math.max(
      1,
      options.maxCapturedStdoutBytes ?? DEFAULT_CAPTURED_STDOUT_MAX_BYTES,
    );
    const finish = (error: unknown, value = ""): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      ACTIVE_CHILD_KILLERS.delete(killChild);
      if (forwardedSignalExitCode !== undefined && ACTIVE_CHILD_KILLERS.size === 0) {
        process.exit(forwardedSignalExitCode);
      }
      if (error) {
        reject(toErrorObject(error, "Non-Error rejection"));
        return;
      }
      resolve(value);
    };
    const killChild: KillChild = (signal) => {
      terminateManagedChild(child, signal);
    };
    const processGroupAlive = () => {
      if (!useProcessGroup || !child.pid) {
        return false;
      }
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return error instanceof Error && "code" in error && error.code === "EPERM";
      }
    };
    const waitForProcessGroupExit = async (timeoutMs: number): Promise<boolean> => {
      const deadlineAt = Date.now() + timeoutMs;
      while (Date.now() < deadlineAt) {
        if (!processGroupAlive()) {
          return true;
        }
        await new Promise((resolvePoll) => {
          setTimeout(resolvePoll, PROCESS_GROUP_EXIT_POLL_MS);
        });
      }
      return !processGroupAlive();
    };
    const terminateChild = (): void => {
      killChild("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        forceKillTimeout = undefined;
        if (settled && !processGroupAlive()) {
          return;
        }
        killChild("SIGKILL");
      }, resolvedKillAfterMs);
      forceKillTimeout.unref?.();
    };
    ACTIVE_CHILD_KILLERS.add(killChild);
    const timeout =
      resolvedTimeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminateChild();
          }, resolvedTimeoutMs);
    timeout?.unref?.();
    const finishAfterTeardown = async (error: unknown, value = ""): Promise<void> => {
      if (processGroupAlive()) {
        await waitForProcessGroupExit(resolvedKillAfterMs);
      }
      if (processGroupAlive()) {
        killChild("SIGKILL");
        await waitForProcessGroupExit(POST_FORCE_KILL_WAIT_MS);
      }
      finish(error, value);
    };
    if (options.captureStdout) {
      child.stdout?.on("data", (chunk) => {
        if (outputLimitExceeded) {
          return;
        }
        const chunkText = String(chunk);
        const chunkBytes = Buffer.byteLength(chunkText);
        if (stdoutBytes + chunkBytes > maxCapturedStdoutBytes) {
          outputLimitExceeded = true;
          terminateChild();
          return;
        }
        stdout += chunkText;
        stdoutBytes += chunkBytes;
      });
    } else if (!options.stdoutFilePath) {
      child.stdout?.pipe(process.stderr, { end: false });
    }
    child.stderr?.pipe(process.stderr, { end: false });
    child.on("error", (error) => finish(error));
    child.on("close", (status, signal) => {
      if (timedOut) {
        void finishAfterTeardown(
          new Error(`${command} ${args.join(" ")} timed out after ${resolvedTimeoutMs}ms`),
        );
        return;
      }
      if (outputLimitExceeded) {
        void finishAfterTeardown(
          new Error(
            `${command} ${args.join(" ")} exceeded captured stdout limit (${maxCapturedStdoutBytes} bytes)`,
          ),
        );
        return;
      }
      if (status === 0) {
        finish(undefined, stdout);
        return;
      }
      finish(new Error(`${command} ${args.join(" ")} failed with ${status ?? signal}`));
    });
  });
}

export async function buildPackageArtifacts(
  sourceDir: string,
  packageOptions: PackageOptions = {},
) {
  const runImpl = packageOptions.runImpl ?? run;
  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_BUILD_ALL_NO_PNPM: "1",
    OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
  };
  for (const envName of PACKAGE_BUILD_PLUGIN_SELECTION_ENV_NAMES) {
    delete buildEnv[envName];
  }
  if (packageOptions.bundlePlugins?.length) {
    // Default frozen-ref harnesses must load without source-only composition dependencies.
    const { resolvePackageBundledPlugins } = await import("./lib/package-bundled-plugins.mts");
    const selectedPlugins = resolvePackageBundledPlugins(sourceDir, packageOptions.bundlePlugins);
    buildEnv[DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV] = selectedPlugins.map(({ id }) => id).join(",");
  }
  const timeoutMs = resolveTimeoutMs(
    "OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS",
    DEFAULT_PACKAGE_BUILD_TIMEOUT_MS,
  );
  const distDir = path.join(sourceDir, "dist");
  assertRealOutputRoot(distDir);
  console.error("==> Cleaning OpenClaw package artifacts");
  await fs.rm(distDir, { force: true, recursive: true });

  // Frozen sources own their build entrypoint and may predate clean:dist.
  console.error("==> Building OpenClaw package artifacts");
  await runImpl("pnpm", ["run", "build"], sourceDir, { env: buildEnv, timeoutMs });
}

async function runCapture(command: string, args: string[], cwd: string, options: RunOptions = {}) {
  return await run(command, args, cwd, { ...options, captureStdout: !options.stdoutFilePath });
}

export { run as runCommandForTest, runCapture as runCaptureForTest };

async function newestOpenClawTarball(outputDir: string, packOutput: string) {
  let fromOutput = "";
  for (const line of packOutput.split(/\r?\n/u)) {
    const filename = resolvePackedOpenClawFileName(line);
    if (filename) {
      fromOutput = filename;
    }
  }
  if (fromOutput) {
    return path.join(outputDir, fromOutput);
  }

  const entries = await fs.readdir(outputDir);
  const packed = entries
    .filter((entry) => {
      try {
        return resolvePackedOpenClawFileName(entry) === entry;
      } catch {
        return false;
      }
    })
    .toSorted()
    .at(-1);
  if (!packed) {
    throw new Error(`missing packed OpenClaw tarball in ${outputDir}`);
  }
  return path.join(outputDir, packed);
}

async function writePackJson(
  packOutput: string,
  tarball: string,
  packJsonPath: string,
  sourceDir: string,
) {
  let parsed;
  try {
    parsed = JSON.parse(packOutput);
  } catch (error) {
    throw new Error("npm pack --json output was not valid JSON", { cause: error });
  }
  const entries = resolveNpmJsonEntries(parsed);
  if (
    entries.length === 0 ||
    entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))
  ) {
    throw new Error("npm pack --json output did not contain package results");
  }
  const filename = path.basename(tarball);
  for (const entry of entries) {
    if (
      entry &&
      typeof entry === "object" &&
      "filename" in entry &&
      typeof entry.filename === "string"
    ) {
      (entry as MutableJsonRecord).filename = filename;
    }
  }
  const target = path.resolve(sourceDir, packJsonPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(entries, null, 2)}\n`);
}

async function cleanPackedOpenClawTarballs(outputDir: string) {
  let entries: string[];
  try {
    entries = await fs.readdir(outputDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      entries = [];
    } else {
      throw error;
    }
  }
  await Promise.all(
    entries
      .filter((entry) => {
        try {
          return resolvePackedOpenClawFileName(entry) === entry;
        } catch {
          return false;
        }
      })
      .map((entry) => fs.rm(path.join(outputDir, entry), { force: true })),
  );
}

function isPackedAiRuntimeTarball(filename: string) {
  return /^openclaw-ai-[A-Za-z0-9._-]+\.tgz$/u.test(filename);
}

export async function prepareBundledAiRuntimePackage(
  sourceDir: string,
  outputDir: string,
  runCaptureImpl: RunImpl = runCapture,
  packageOptions: PackageOptions = {},
) {
  const packageJsonPath = path.join(sourceDir, "package.json");
  const aiRuntimePackageJsonPath = path.join(sourceDir, "packages", "ai", "package.json");
  const aiRuntimeSourceDir = path.dirname(aiRuntimePackageJsonPath);
  const aiRuntimePath = path.join(sourceDir, "node_modules", "@openclaw", "ai");
  const aiRuntimeBackupPath = path.join(
    sourceDir,
    "node_modules",
    "@openclaw",
    AI_RUNTIME_BACKUP_DIR,
  );
  const extractAiRuntime =
    packageOptions.extractAiRuntime ??
    ((tarballPath: string, destination: string) =>
      // Source-ref validation runs this trusted harness outside the candidate's dependency tree.
      // Keep extraction on the system tar contract so only the candidate checkout needs install.
      // Use an archive basename so GNU tar cannot treat a Windows drive as a remote host.
      run(
        "tar",
        ["-xzf", path.basename(tarballPath), "-C", destination, "--strip-components=1"],
        path.dirname(tarballPath),
        {
          timeoutMs: resolveTimeoutMs(
            "OPENCLAW_DOCKER_PACKAGE_PACK_TIMEOUT_MS",
            DEFAULT_PACKAGE_PACK_TIMEOUT_MS,
          ),
        },
      ));
  const prepareManifest = packageOptions.prepareManifest ?? (async () => false);
  const restoreManifest = packageOptions.restoreManifest ?? (async () => false);
  const originalPackageJson = await fs.readFile(packageJsonPath, "utf8");
  let packageJson: MutableJsonRecord & {
    bundleDependencies?: unknown;
    dependencies?: Record<string, unknown>;
  };
  try {
    packageJson = JSON.parse(originalPackageJson) as typeof packageJson;
  } catch (error) {
    throw new Error(`failed to parse ${packageJsonPath}`, { cause: error });
  }
  const aiRuntimeDependency = packageJson.dependencies?.[AI_RUNTIME_PACKAGE];
  let hasAiRuntimeWorkspace = false;
  try {
    await fs.access(aiRuntimePackageJsonPath);
    hasAiRuntimeWorkspace = true;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  // Release checks can package refs from before the AI runtime was split into a workspace package.
  if (!hasAiRuntimeWorkspace && aiRuntimeDependency === undefined) {
    return async () => {};
  }
  if (!hasAiRuntimeWorkspace) {
    throw new Error("@openclaw/ai dependency requires the packages/ai workspace");
  }
  if (typeof aiRuntimeDependency !== "string") {
    throw new Error("root package.json must declare @openclaw/ai as a dependency");
  }

  try {
    await fs.access(aiRuntimeBackupPath);
    throw new Error(`refusing to overwrite existing ${aiRuntimeBackupPath}`);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  let packedAiTarballs: string[] = [];
  let packageJsonChanged = false;
  let originalAiRuntimeMoved = false;
  let stagedAiRuntimeCreated = false;
  const cleanup = async (): Promise<void> => {
    let cleanupError: unknown;
    const attempt = async (action: () => Promise<unknown>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        cleanupError ??= error;
      }
    };
    if (packageJsonChanged) {
      await attempt(async () => await fs.writeFile(packageJsonPath, originalPackageJson));
    }
    if (stagedAiRuntimeCreated) {
      await attempt(async () => await fs.rm(aiRuntimePath, { force: true, recursive: true }));
    }
    if (originalAiRuntimeMoved) {
      await attempt(async () => await fs.rename(aiRuntimeBackupPath, aiRuntimePath));
    }
    await attempt(async () => {
      await Promise.all(packedAiTarballs.map((filename) => fs.rm(filename, { force: true })));
    });
    packageJsonChanged = false;
    stagedAiRuntimeCreated = false;
    originalAiRuntimeMoved = false;
    packedAiTarballs = [];
    if (cleanupError) {
      throw toErrorObject(cleanupError, "Package cleanup failed.");
    }
  };

  try {
    let packError: Error | undefined;
    await prepareManifest(aiRuntimeSourceDir);
    try {
      await runCaptureImpl(
        "pnpm",
        [
          "--dir",
          "packages/ai",
          "pack",
          "--loglevel=error",
          "--use-stderr",
          "--pack-destination",
          outputDir,
        ],
        sourceDir,
        {
          timeoutMs: resolveTimeoutMs(
            "OPENCLAW_DOCKER_PACKAGE_PACK_TIMEOUT_MS",
            DEFAULT_PACKAGE_PACK_TIMEOUT_MS,
          ),
        },
      );
    } catch (error) {
      packError = toErrorObject(error, "AI runtime package failed.");
    }
    try {
      await restoreManifest(aiRuntimeSourceDir);
    } catch (restoreError) {
      throw packError ? packagePreparationRestoreError(packError, restoreError) : restoreError;
    }
    if (packError) {
      throw packError;
    }
    packedAiTarballs = (await fs.readdir(outputDir))
      .filter(isPackedAiRuntimeTarball)
      .map((filename) => path.join(outputDir, filename));
    if (packedAiTarballs.length !== 1) {
      throw new Error(
        `expected one packed @openclaw/ai tarball in ${outputDir}, found ${packedAiTarballs.length}`,
      );
    }

    try {
      await fs.lstat(aiRuntimePath);
      await fs.rename(aiRuntimePath, aiRuntimeBackupPath);
      originalAiRuntimeMoved = true;
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
    await fs.mkdir(aiRuntimePath, { recursive: true });
    stagedAiRuntimeCreated = true;
    await extractAiRuntime(packedAiTarballs[0]!, aiRuntimePath);

    const stagedPackageJsonPath = path.join(aiRuntimePath, "package.json");
    const stagedPackageJson = JSON.parse(
      await fs.readFile(stagedPackageJsonPath, "utf8"),
    ) as MutableJsonRecord & {
      dependencies?: Record<string, unknown>;
      version?: unknown;
    };
    if (typeof stagedPackageJson.version !== "string" || !stagedPackageJson.version) {
      throw new Error("packed @openclaw/ai package must declare a version");
    }
    const alignedDependencies = validateBundledPackageDependencyAlignment({
      bundledDependencies: stagedPackageJson.dependencies,
      bundledPackageLabel: "packed @openclaw/ai",
      rootDependencies: packageJson.dependencies,
    });
    for (const [name, version] of alignedDependencies) {
      packageJson.dependencies![name] = version;
    }
    // Root owns these exact dependencies. Removing them from the staged copy keeps npm from
    // recursively bundling duplicate packages alongside the one private workspace runtime.
    delete stagedPackageJson.dependencies;
    await fs.writeFile(stagedPackageJsonPath, `${JSON.stringify(stagedPackageJson, null, 2)}\n`);

    packageJson.dependencies![AI_RUNTIME_PACKAGE] = stagedPackageJson.version;
    const bundleDependencies = packageJson.bundleDependencies ?? [];
    if (!Array.isArray(bundleDependencies)) {
      throw new Error("root package.json bundleDependencies must be an array when present");
    }
    packageJson.bundleDependencies = [...new Set([...bundleDependencies, AI_RUNTIME_PACKAGE])];
    packageJsonChanged = true;
    await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function normalizeOpenClawTarballModes(tarballPath: string) {
  // npm/pnpm pack copy on-disk modes into the tarball (node-tar's portable
  // mode-fix never adds read bits), so a restrictive-umask build host ships
  // owner-only 0600/0700 entries that leave a root-installed CLI unreadable
  // for non-root users under system tar and mode-preserving installers.
  // Rewrite every entry to 0644/0755 the way a umask-022 host would have
  // packed it, keeping executable bits. Stays on the system tar contract like
  // the bundled AI runtime extraction above.
  const timeoutMs = resolveTimeoutMs(
    "OPENCLAW_DOCKER_PACKAGE_PACK_TIMEOUT_MS",
    DEFAULT_PACKAGE_PACK_TIMEOUT_MS,
  );
  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-package-modes-"));
  try {
    await run(
      "tar",
      ["-xzf", path.basename(tarballPath), "-C", stageDir],
      path.dirname(tarballPath),
      { timeoutMs },
    );
    let stagedFileCount = 0;
    const normalizeStagedModes = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await fs.chmod(entryPath, 0o755);
          await normalizeStagedModes(entryPath);
        } else if (entry.isFile()) {
          // Umask masking on extraction only clears group/other bits, so the
          // owner exec bit still says whether the packed entry was executable.
          const executable = ((await fs.stat(entryPath)).mode & 0o100) !== 0;
          await fs.chmod(entryPath, executable ? 0o755 : 0o644);
          stagedFileCount += 1;
        }
      }
    };
    await normalizeStagedModes(stageDir);
    if (stagedFileCount === 0) {
      throw new Error(`packed OpenClaw tarball has no file entries: ${tarballPath}`);
    }
    const stageRootEntries = await fs.readdir(stageDir);
    const normalizedPath = `${tarballPath}.modes-tmp`;
    await fs.rm(normalizedPath, { force: true });
    await run(
      "tar",
      ["--no-xattrs", "-czf", path.basename(normalizedPath), "-C", stageDir, ...stageRootEntries],
      path.dirname(normalizedPath),
      {
        // BSD tar has separate PAX xattr and AppleDouble (._*) metadata paths.
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        timeoutMs,
      },
    );
    await fs.rename(normalizedPath, tarballPath);
  } finally {
    await fs.rm(stageDir, { force: true, recursive: true });
  }
}

async function restorePackageSourceArtifacts(
  sourceDir: string,
  restoreDocsMap: (cwd: string) => Promise<unknown>,
  restoreManifest: (cwd: string) => Promise<unknown>,
  restoreChangelog: (cwd: string) => Promise<unknown>,
) {
  await restoreChangelog(sourceDir);
  await restoreManifest(sourceDir);
  await Promise.all(
    [PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH, LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH].map(
      (relativePath) => fs.rm(path.join(sourceDir, relativePath), { force: true }),
    ),
  );
  // Release the lifecycle receipt only after every other source mutation settles.
  await restoreDocsMap(sourceDir);
}

async function loadSourcePackageLifecycle(
  sourceDir: string,
  moduleName: string,
  validate: (value: unknown) => boolean,
) {
  const modulePath = path.join(sourceDir, "scripts", moduleName);
  try {
    await fs.access(modulePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  const lifecycle: unknown = await import(pathToFileURL(modulePath).href);
  if (!validate(lifecycle)) {
    throw new Error(`source package lifecycle is invalid: ${modulePath}`);
  }
  return lifecycle;
}

function packagePreparationRestoreError(error: unknown, restoreError: unknown) {
  return new AggregateError([error, restoreError], "Package operation and cleanup both failed.", {
    cause: error,
  });
}

export async function packOpenClawPackageForDocker(
  sourcePath: string,
  outputPath: string,
  packageOptions: PackageOptions = {},
) {
  const runCaptureImpl = packageOptions.runCaptureImpl ?? runCapture;
  const prepareChangelog =
    packageOptions.prepareChangelog ??
    ((cwd: string) =>
      preparePackageChangelog(cwd, {
        allowUnreleased: packageOptions.allowUnreleasedChangelog,
      }));
  const restoreChangelog = packageOptions.restoreChangelog ?? restorePackageChangelog;
  // Frozen refs own their package contents. Only refs carrying this lifecycle ship a generated map.
  const sourceDocsMapLifecycle =
    packageOptions.prepareDocsMap && packageOptions.restoreDocsMap
      ? null
      : ((await loadSourcePackageLifecycle(
          sourcePath,
          "package-docs-map.mjs",
          isDocsMapLifecycle,
        )) as DocsMapLifecycle | null);
  const prepareDocsMap =
    packageOptions.prepareDocsMap ??
    sourceDocsMapLifecycle?.preparePackageDocsMap ??
    (async () => false);
  const restoreDocsMap =
    packageOptions.restoreDocsMap ??
    sourceDocsMapLifecycle?.restorePackageDocsMap ??
    (async () => false);
  const sourceManifestLifecycle =
    packageOptions.prepareManifest && packageOptions.restoreManifest
      ? null
      : ((await loadSourcePackageLifecycle(
          sourcePath,
          "package-manifest.mjs",
          isPackageManifestLifecycle,
        )) as PackageManifestLifecycle | null);
  const prepareManifest =
    packageOptions.prepareManifest ??
    sourceManifestLifecycle?.preparePackageManifest ??
    (async () => false);
  const restoreManifest =
    packageOptions.restoreManifest ??
    sourceManifestLifecycle?.restorePackageManifest ??
    (async () => false);
  const prepareBundledAiRuntime =
    packageOptions.prepareBundledAiRuntime ?? prepareBundledAiRuntimePackage;
  const packTool = packageOptions.pnpmPack ? "pnpm" : "npm";
  if (packageOptions.packJsonPath && packageOptions.pnpmPack) {
    throw new Error("packJsonPath cannot be combined with pnpmPack");
  }
  console.error("==> Packing OpenClaw package");
  // This receipt is the package lifecycle lock; acquire it before touching CHANGELOG.md.
  await prepareDocsMap(sourcePath);
  const deferSignalExit: KillChild = () => {};
  ACTIVE_CHILD_KILLERS.add(deferSignalExit);
  const releaseSignalExit = () => {
    ACTIVE_CHILD_KILLERS.delete(deferSignalExit);
    if (forwardedSignalExitCode !== undefined) {
      throw new ForwardedSignalExitError(forwardedSignalExitCode);
    }
  };
  try {
    console.error("==> Writing OpenClaw package inventory");
    await writePackageInventoryForDocker(sourcePath, packageOptions.runImpl ?? run);

    await prepareManifest(sourcePath);
    await prepareChangelog(sourcePath);
  } catch (error) {
    try {
      await restorePackageSourceArtifacts(
        sourcePath,
        restoreDocsMap,
        restoreManifest,
        restoreChangelog,
      );
    } catch (restoreError) {
      releaseSignalExit();
      throw packagePreparationRestoreError(error, restoreError);
    }
    releaseSignalExit();
    throw error;
  }
  let packOutput = "";
  let packageError: unknown;
  let packReceiptDir: string | undefined;
  try {
    let cleanupBundledAiRuntime = async () => {};
    let cleanupBundledPlugins = async () => {};
    try {
      await cleanPackedOpenClawTarballs(outputPath);
      if (packageOptions.bundlePlugins?.length) {
        const { preparePackageBundledPlugins } = await import("./lib/package-bundled-plugins.mts");
        cleanupBundledPlugins = await preparePackageBundledPlugins(
          sourcePath,
          packageOptions.bundlePlugins,
        );
      }
      cleanupBundledAiRuntime = await prepareBundledAiRuntime(
        sourcePath,
        outputPath,
        runCaptureImpl,
        {
          prepareManifest,
          restoreManifest,
        },
      );
      const packArgs =
        packTool === "pnpm"
          ? ["pack", "--silent", "--config.ignore-scripts=true", "--pack-destination", outputPath]
          : [
              "pack",
              "--silent",
              "--ignore-scripts",
              "--pack-destination",
              outputPath,
              "--json=false",
            ];
      packOutput = await runCaptureImpl(packTool, packArgs, sourcePath, {
        timeoutMs: resolveTimeoutMs(
          "OPENCLAW_DOCKER_PACKAGE_PACK_TIMEOUT_MS",
          DEFAULT_PACKAGE_PACK_TIMEOUT_MS,
        ),
      });
    } finally {
      try {
        await cleanupBundledAiRuntime();
      } finally {
        try {
          await cleanupBundledPlugins();
        } finally {
          await restorePackageSourceArtifacts(
            sourcePath,
            restoreDocsMap,
            restoreManifest,
            restoreChangelog,
          );
        }
      }
    }
    // Scan the emptied pnpm destination instead of trusting its absolute-path output.
    let tarball = await newestOpenClawTarball(
      outputPath,
      packageOptions.pnpmPack ? "" : packOutput,
    );
    if (packageOptions.outputName) {
      const target = path.join(outputPath, packageOptions.outputName);
      if (target !== tarball) {
        await fs.rm(target, { force: true });
        await fs.rename(tarball, target);
        tarball = target;
      }
    }
    await (packageOptions.normalizeTarballModes ?? normalizeOpenClawTarballModes)(tarball);
    if (packageOptions.packJsonPath) {
      // npm's original receipt predates normalization. Inspect the finished bytes;
      // dry-run preserves the archive while npm owns hashes, modes, and inventory.
      packReceiptDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-npm-pack-receipt-"));
      const packReceiptPath = path.join(packReceiptDir, "pack.json");
      await runCaptureImpl(
        "npm",
        ["pack", tarball, "--dry-run", "--json", "--ignore-scripts", "--offline", "--silent"],
        sourcePath,
        {
          stdoutFilePath: packReceiptPath,
          timeoutMs: resolveTimeoutMs(
            "OPENCLAW_DOCKER_PACKAGE_PACK_TIMEOUT_MS",
            DEFAULT_PACKAGE_PACK_TIMEOUT_MS,
          ),
        },
      );
      await writePackJson(
        await fs.readFile(packReceiptPath, "utf8"),
        tarball,
        packageOptions.packJsonPath,
        sourcePath,
      );
    }
    return tarball;
  } catch (error) {
    packageError = error;
    throw error;
  } finally {
    try {
      if (packReceiptDir) {
        try {
          await fs.rm(packReceiptDir, { force: true, recursive: true });
        } catch (cleanupError) {
          // oxlint-disable-next-line eslint/no-unsafe-finally -- Preserve primary and cleanup failures.
          throw packageError
            ? packagePreparationRestoreError(packageError, cleanupError)
            : cleanupError;
        }
      }
    } finally {
      releaseSignalExit();
    }
  }
}

export async function writePackageInventoryForDocker(
  sourceDir: string,
  runImpl: CommandRunner = run,
) {
  // Frozen release refs own their inventory shape; run their writer instead of importing current-main helpers.
  // Resolve the loader from that checkout too: the workflow harness may install production deps only.
  const sourceRequire = createRequire(path.join(sourceDir, "package.json"));
  const tsxModuleUrl = pathToFileURL(sourceRequire.resolve("tsx")).href;
  await runImpl(
    "node",
    ["--import", tsxModuleUrl, path.join(sourceDir, "scripts/write-package-dist-inventory.ts")],
    sourceDir,
    {
      timeoutMs: resolveTimeoutMs(
        "OPENCLAW_DOCKER_PACKAGE_INVENTORY_TIMEOUT_MS",
        DEFAULT_PACKAGE_INVENTORY_TIMEOUT_MS,
      ),
    },
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceDir = path.resolve(ROOT_DIR, options.sourceDir || ROOT_DIR);
  const outputDir = path.resolve(
    ROOT_DIR,
    options.outputDir || path.join(".artifacts", "docker-e2e-package"),
  );
  await fs.mkdir(outputDir, { recursive: true });

  if (!options.skipBuild) {
    await buildPackageArtifacts(sourceDir, { bundlePlugins: options.bundlePlugins });
  }

  const tarball = await packOpenClawPackageForDocker(sourceDir, outputDir, {
    bundlePlugins: options.bundlePlugins,
    allowUnreleasedChangelog: options.allowUnreleasedChangelog,
    outputName: options.outputName,
    packJsonPath: options.packJson,
    pnpmPack: options.pnpmPack,
  });

  console.error("==> Checking OpenClaw package tarball");
  const checkStartedAt = Date.now();
  await run(
    "node",
    [
      path.join(ROOT_DIR, "scripts/check-openclaw-package-tarball.mjs"),
      "--require-bundled-workspace-deps",
      tarball,
    ],
    sourceDir,
    {
      timeoutMs: resolveTimeoutMs(
        "OPENCLAW_DOCKER_PACKAGE_TARBALL_CHECK_TIMEOUT_MS",
        DEFAULT_PACKAGE_TARBALL_CHECK_TIMEOUT_MS,
      ),
    },
  );
  console.error(
    `==> OpenClaw package tarball check finished in ${Math.round((Date.now() - checkStartedAt) / 1000)}s`,
  );

  process.stdout.write(`${tarball}\n`);
}

if (
  process.argv[1] &&
  (await fs.realpath(process.argv[1])) === (await fs.realpath(fileURLToPath(import.meta.url)))
) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    const exitCode =
      error && typeof error === "object" && "exitCode" in error ? error.exitCode : undefined;
    process.exit(typeof exitCode === "number" && Number.isInteger(exitCode) ? exitCode : 1);
  });
}
