#!/usr/bin/env node
// Builds the OpenClaw package artifact used by Docker E2E.
// The script owns the build/inventory/pack sequence so local scheduler, shell
// helpers, and GitHub Actions all prepare the exact same npm tarball.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV } from "./lib/bundled-plugin-build-entries.mjs";
import { terminateManagedChild } from "./lib/managed-child-process.mts";
import { resolveNpmJsonEntries } from "./lib/npm-json-output.mts";
import { isRecord } from "./lib/record-shared.mjs";
import { resolveNpmRunner } from "./npm-runner.mts";
import { preparePackageChangelog, restorePackageChangelog } from "./package-changelog.mjs";
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
  deferForwardedSignalExit?: boolean;
  env?: NodeJS.ProcessEnv;
  killAfterMs?: unknown;
  maxCapturedStdoutBytes?: number;
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
type CaptureRunnerOptions = {
  deferForwardedSignalExit?: boolean;
  timeoutMs?: number;
};
type RunImpl = (
  command: string,
  args: string[],
  cwd: string,
  options: CaptureRunnerOptions,
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
  allowUnreleasedChangelog?: unknown;
  extractAiRuntime?: (tarballPath: string, destination: string) => Promise<unknown>;
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

function resolveTimerTimeoutMs(valueMs: unknown, fallbackMs: unknown = MAX_TIMER_TIMEOUT_MS) {
  const value = numericTimerValueMs(valueMs) ?? numericTimerValueMs(fallbackMs);
  return Math.min(Math.max(value ?? MAX_TIMER_TIMEOUT_MS, 1), MAX_TIMER_TIMEOUT_MS);
}

function resolveOptionalTimerTimeoutMs(valueMs: unknown) {
  if (valueMs === undefined) {
    return undefined;
  }
  return resolveTimerTimeoutMs(valueMs, 1);
}

function readOptionValue(argv: string[], index: number, optionName: string) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
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
    } else if (arg === "--output-dir") {
      setOnce("--output-dir", "outputDir", readOptionValue(args, index, arg));
      index += 1;
    } else if (arg?.startsWith("--output-dir=")) {
      setOnce(
        "--output-dir",
        "outputDir",
        readEqualsOptionValue(arg.slice("--output-dir=".length), "--output-dir"),
      );
    } else if (arg === "--output-name") {
      setOnce("--output-name", "outputName", readOptionValue(args, index, arg));
      index += 1;
    } else if (arg?.startsWith("--output-name=")) {
      setOnce(
        "--output-name",
        "outputName",
        readEqualsOptionValue(arg.slice("--output-name=".length), "--output-name"),
      );
    } else if (arg === "--pack-json") {
      setOnce("--pack-json", "packJson", readOptionValue(args, index, arg));
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
      setOnce("--source-dir", "sourceDir", readOptionValue(args, index, arg));
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
  return new Promise<string>((resolve, reject) => {
    const resolvedTimeoutMs = resolveOptionalTimerTimeoutMs(options.timeoutMs);
    const resolvedKillAfterMs = resolveTimerTimeoutMs(
      options.killAfterMs,
      DEFAULT_TIMEOUT_KILL_AFTER_MS,
    );
    const useProcessGroup = process.platform !== "win32";
    const env = options.env ?? process.env;
    // Keep POSIX command selection stable; only Windows needs explicit npm/pnpm shim handling.
    const invocation: {
      args: string[];
      command: string;
      env?: NodeJS.ProcessEnv;
      shell: boolean;
      windowsVerbatimArguments?: boolean;
    } =
      process.platform === "win32" && command === "pnpm"
        ? resolvePnpmRunner({ cwd, env, npmExecPath: env.npm_execpath, pnpmArgs: args })
        : process.platform === "win32" && command === "npm"
          ? resolveNpmRunner({ env, npmArgs: args })
          : { args, command, shell: false };
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: invocation.env ?? env,
      detached: useProcessGroup,
      shell: invocation.shell,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
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
        if (options.deferForwardedSignalExit) {
          reject(new ForwardedSignalExitError(forwardedSignalExitCode));
          return;
        }
        process.exit(forwardedSignalExitCode);
      }
      if (error) {
        reject(toLintErrorObject(error, "Non-Error rejection"));
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
      child.stdout.on("data", (chunk) => {
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
    } else {
      child.stdout.pipe(process.stderr, { end: false });
    }
    child.stderr.pipe(process.stderr, { end: false });
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

const PACKAGE_ARTIFACT_BUILD_STEPS = [
  {
    label: "Building OpenClaw package artifacts",
    command: "pnpm",
    // Let the frozen source own its build entrypoint while the packaging env
    // keeps canonical declaration emission enabled.
    args: ["run", "build"],
  },
];

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
  for (const step of PACKAGE_ARTIFACT_BUILD_STEPS) {
    console.error(`==> ${step.label}`);
    await runImpl(step.command, step.args, sourceDir, {
      env: {
        ...buildEnv,
      },
      timeoutMs: resolveTimeoutMs(
        "OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS",
        DEFAULT_PACKAGE_BUILD_TIMEOUT_MS,
      ),
    });
  }
}

export const runCommandForTest = run;

async function runCapture(command: string, args: string[], cwd: string, options: RunOptions = {}) {
  return await run(command, args, cwd, { ...options, captureStdout: true });
}

async function newestOpenClawTarball(outputDir: string, packOutput: string) {
  let fromOutput = "";
  try {
    const parsed = JSON.parse(packOutput);
    for (const entry of resolveNpmJsonEntries(parsed)) {
      if (!entry || typeof entry !== "object" || !("filename" in entry)) {
        continue;
      }
      const filenameValue = entry.filename;
      if (typeof filenameValue !== "string") {
        continue;
      }
      const filename = resolvePackedOpenClawFileName(filenameValue);
      if (filename) {
        fromOutput = filename;
      }
    }
  } catch {}
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
  packJsonPath: string | undefined,
  sourceDir: string,
) {
  if (!packJsonPath) {
    return;
  }
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
      run("tar", ["-xzf", tarballPath, "-C", destination, "--strip-components=1"], destination, {
        timeoutMs: resolveTimeoutMs(
          "OPENCLAW_DOCKER_PACKAGE_PACK_TIMEOUT_MS",
          DEFAULT_PACKAGE_PACK_TIMEOUT_MS,
        ),
      }));
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
      throw toLintErrorObject(cleanupError, "Package cleanup failed.");
    }
  };

  try {
    await runCaptureImpl(
      "pnpm",
      ["--dir", "packages/ai", "pack", "--silent", "--pack-destination", outputDir],
      sourceDir,
      {
        deferForwardedSignalExit: true,
        timeoutMs: resolveTimeoutMs(
          "OPENCLAW_DOCKER_PACKAGE_PACK_TIMEOUT_MS",
          DEFAULT_PACKAGE_PACK_TIMEOUT_MS,
        ),
      },
    );
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
    for (const [name, version] of Object.entries(stagedPackageJson.dependencies ?? {})) {
      if (typeof version !== "string") {
        throw new Error(`packed @openclaw/ai dependency ${name} must declare a string version`);
      }
      if (packageJson.dependencies?.[name] !== version) {
        throw new Error(
          `root package.json must declare ${name}@${version} to bundle @openclaw/ai without duplicate dependencies`,
        );
      }
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

async function restorePackageSourceArtifacts(
  sourceDir: string,
  restoreDocsMap: (cwd: string) => Promise<unknown>,
  restoreManifest: (cwd: string) => Promise<unknown>,
  restoreChangelog: (cwd: string) => Promise<unknown>,
) {
  await restoreChangelog(sourceDir);
  await restoreManifest(sourceDir);
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
  return new AggregateError(
    [error, restoreError],
    "Package preparation failed and source artifacts could not be restored.",
    { cause: error },
  );
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
  try {
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
      throw packagePreparationRestoreError(error, restoreError);
    }
    throw error;
  }
  let packOutput = "";
  let cleanupBundledAiRuntime = async () => {};
  try {
    await cleanPackedOpenClawTarballs(outputPath);
    cleanupBundledAiRuntime = await prepareBundledAiRuntime(sourcePath, outputPath, runCaptureImpl);
    const packArgs =
      packTool === "pnpm"
        ? ["pack", "--silent", "--config.ignore-scripts=true", "--pack-destination", outputPath]
        : [
            "pack",
            ...(packageOptions.packJsonPath ? ["--json"] : []),
            "--silent",
            "--ignore-scripts",
            "--pack-destination",
            outputPath,
          ];
    packOutput = await runCaptureImpl(packTool, packArgs, sourcePath, {
      deferForwardedSignalExit: true,
      timeoutMs: resolveTimeoutMs(
        "OPENCLAW_DOCKER_PACKAGE_PACK_TIMEOUT_MS",
        DEFAULT_PACKAGE_PACK_TIMEOUT_MS,
      ),
    });
  } finally {
    try {
      await cleanupBundledAiRuntime();
    } finally {
      await restorePackageSourceArtifacts(
        sourcePath,
        restoreDocsMap,
        restoreManifest,
        restoreChangelog,
      );
    }
  }
  // pnpm reports an absolute destination path. The directory was emptied before packing,
  // so scan that controlled destination instead of accepting a path from command output.
  let tarball = await newestOpenClawTarball(outputPath, packageOptions.pnpmPack ? "" : packOutput);
  if (packageOptions.outputName) {
    const target = path.join(outputPath, packageOptions.outputName);
    if (target !== tarball) {
      await fs.rm(target, { force: true });
      await fs.rename(tarball, target);
      tarball = target;
    }
  }
  await writePackJson(packOutput, tarball, packageOptions.packJsonPath, sourcePath);
  return tarball;
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
    await buildPackageArtifacts(sourceDir);
  }

  console.error("==> Writing OpenClaw package inventory");
  await writePackageInventoryForDocker(sourceDir);

  const tarball = await packOpenClawPackageForDocker(sourceDir, outputDir, {
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

function toLintErrorObject(value: unknown, fallbackMessage: string) {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
