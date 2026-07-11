#!/usr/bin/env node
// Builds the OpenClaw package artifact used by Docker E2E.
// The script owns the build/inventory/pack sequence so local scheduler, shell
// helpers, and GitHub Actions all prepare the exact same npm tarball.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV } from "./lib/bundled-plugin-build-entries.mjs";
import { preparePackageChangelog, restorePackageChangelog } from "./package-changelog.mjs";

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
const ACTIVE_CHILD_KILLERS = new Set();
const PACKAGE_BUILD_PLUGIN_SELECTION_ENV_NAMES = [
  "OPENCLAW_EXTENSIONS",
  "OPENCLAW_DOCKER_BUILD_EXTENSIONS",
  DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV,
];
const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};
let forwardedSignalExitCode;

class ForwardedSignalExitError extends Error {
  constructor(exitCode) {
    super(`forwarded signal requested exit ${exitCode}`);
    this.exitCode = exitCode;
  }
}

for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
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

function resolveTimeoutMs(envName, defaultValue) {
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

function numericTimerValueMs(valueMs) {
  const value = Number(valueMs);
  return Number.isFinite(value) ? Math.floor(value) : undefined;
}

function resolveTimerTimeoutMs(valueMs, fallbackMs = MAX_TIMER_TIMEOUT_MS) {
  const value = numericTimerValueMs(valueMs) ?? numericTimerValueMs(fallbackMs);
  return Math.min(Math.max(value ?? MAX_TIMER_TIMEOUT_MS, 1), MAX_TIMER_TIMEOUT_MS);
}

function resolveOptionalTimerTimeoutMs(valueMs) {
  if (valueMs === undefined) {
    return undefined;
  }
  return resolveTimerTimeoutMs(valueMs, 1);
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function readEqualsOptionValue(value, optionName) {
  if (value === "" || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function validateOutputName(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.t(?:ar\.)?gz$/u.test(value)) {
    throw new Error(`--output-name must be a tarball filename, not a path: ${value}`);
  }
}

function resolvePackedOpenClawFileName(value) {
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

export function parseArgs(argv) {
  const options = {
    allowUnreleasedChangelog: false,
    outputDir: "",
    outputName: "",
    packJson: "",
    pnpmPack: false,
    skipBuild: false,
    sourceDir: ROOT_DIR,
  };
  const seen = new Set();
  const setOnce = (flag, key, value) => {
    if (seen.has(flag)) {
      throw new Error(`${flag} was provided more than once`);
    }
    seen.add(flag);
    options[key] = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-unreleased-changelog") {
      setOnce(arg, "allowUnreleasedChangelog", true);
    } else if (arg === "--output-dir") {
      setOnce("--output-dir", "outputDir", readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg?.startsWith("--output-dir=")) {
      setOnce(
        "--output-dir",
        "outputDir",
        readEqualsOptionValue(arg.slice("--output-dir=".length), "--output-dir"),
      );
    } else if (arg === "--output-name") {
      setOnce("--output-name", "outputName", readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg?.startsWith("--output-name=")) {
      setOnce(
        "--output-name",
        "outputName",
        readEqualsOptionValue(arg.slice("--output-name=".length), "--output-name"),
      );
    } else if (arg === "--pack-json") {
      setOnce("--pack-json", "packJson", readOptionValue(argv, index, arg));
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
      setOnce("--source-dir", "sourceDir", readOptionValue(argv, index, arg));
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

function run(command, args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const resolvedTimeoutMs = resolveOptionalTimerTimeoutMs(options.timeoutMs);
    const resolvedKillAfterMs = resolveTimerTimeoutMs(
      options.killAfterMs,
      DEFAULT_TIMEOUT_KILL_AFTER_MS,
    );
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      detached: useProcessGroup,
    });
    let timedOut = false;
    let outputLimitExceeded = false;
    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;
    let forceKillTimeout;
    const maxCapturedStdoutBytes = Math.max(
      1,
      options.maxCapturedStdoutBytes ?? DEFAULT_CAPTURED_STDOUT_MAX_BYTES,
    );
    const finish = (error, value = "") => {
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
    const killChild = (signal) => {
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The direct child may already have exited; fall back to child.kill.
        }
      }
      child.kill(signal);
    };
    const processGroupAlive = () => {
      if (!useProcessGroup || !child.pid) {
        return false;
      }
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return error?.code === "EPERM";
      }
    };
    const waitForProcessGroupExit = async (timeoutMs) => {
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
    const terminateChild = () => {
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
    const finishAfterTeardown = async (error, value = "") => {
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
    command: "node",
    args: ["scripts/build-all.mjs", "ciArtifacts"],
  },
];

export async function buildPackageArtifacts(sourceDir, options = {}) {
  const runImpl = options.runImpl ?? run;
  const buildEnv = {
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

async function runCapture(command, args, cwd, options = {}) {
  return await run(command, args, cwd, { ...options, captureStdout: true });
}

async function newestOpenClawTarball(outputDir, packOutput) {
  let fromOutput = "";
  try {
    const parsed = JSON.parse(packOutput);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry?.filename !== "string") {
          continue;
        }
        const filename = resolvePackedOpenClawFileName(entry.filename);
        if (filename) {
          fromOutput = filename;
        }
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

async function writePackJson(packOutput, tarball, packJsonPath, sourceDir) {
  if (!packJsonPath) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(packOutput);
  } catch (error) {
    throw new Error("npm pack --json output was not valid JSON", { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("npm pack --json output must be an array");
  }
  const filename = path.basename(tarball);
  for (const entry of parsed) {
    if (entry && typeof entry === "object" && typeof entry.filename === "string") {
      entry.filename = filename;
    }
  }
  const target = path.resolve(sourceDir, packJsonPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(parsed, null, 2)}\n`);
}

async function cleanPackedOpenClawTarballs(outputDir) {
  let entries;
  try {
    entries = await fs.readdir(outputDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
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

function isPackedAiRuntimeTarball(filename) {
  return /^openclaw-ai-[A-Za-z0-9._-]+\.tgz$/u.test(filename);
}

export async function prepareBundledAiRuntimePackage(
  sourceDir,
  outputDir,
  runCaptureImpl = runCapture,
  options = {},
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
    options.extractAiRuntime ??
    ((tarballPath, destination) =>
      Promise.resolve(tar.x({ cwd: destination, file: tarballPath, strip: 1 })));
  const originalPackageJson = await fs.readFile(packageJsonPath, "utf8");
  let packageJson;
  try {
    packageJson = JSON.parse(originalPackageJson);
  } catch (error) {
    throw new Error(`failed to parse ${packageJsonPath}`, { cause: error });
  }
  const aiRuntimeDependency = packageJson.dependencies?.[AI_RUNTIME_PACKAGE];
  let hasAiRuntimeWorkspace = false;
  try {
    await fs.access(aiRuntimePackageJsonPath);
    hasAiRuntimeWorkspace = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
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
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  let packedAiTarballs = [];
  let packageJsonChanged = false;
  let originalAiRuntimeMoved = false;
  let stagedAiRuntimeCreated = false;
  const cleanup = async () => {
    let cleanupError;
    const attempt = async (action) => {
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
      throw cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
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
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await fs.mkdir(aiRuntimePath, { recursive: true });
    stagedAiRuntimeCreated = true;
    await extractAiRuntime(packedAiTarballs[0], aiRuntimePath);

    const stagedPackageJsonPath = path.join(aiRuntimePath, "package.json");
    const stagedPackageJson = JSON.parse(await fs.readFile(stagedPackageJsonPath, "utf8"));
    if (typeof stagedPackageJson.version !== "string" || !stagedPackageJson.version) {
      throw new Error("packed @openclaw/ai package must declare a version");
    }
    for (const [name, version] of Object.entries(stagedPackageJson.dependencies ?? {})) {
      if (packageJson.dependencies[name] !== version) {
        throw new Error(
          `root package.json must declare ${name}@${version} to bundle @openclaw/ai without duplicate dependencies`,
        );
      }
    }
    // Root owns these exact dependencies. Removing them from the staged copy keeps npm from
    // recursively bundling duplicate packages alongside the one private workspace runtime.
    delete stagedPackageJson.dependencies;
    await fs.writeFile(stagedPackageJsonPath, `${JSON.stringify(stagedPackageJson, null, 2)}\n`);

    packageJson.dependencies[AI_RUNTIME_PACKAGE] = stagedPackageJson.version;
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

export async function packOpenClawPackageForDocker(sourceDir, outputDir, options = {}) {
  const runCaptureImpl = options.runCaptureImpl ?? runCapture;
  const prepareChangelog =
    options.prepareChangelog ??
    ((cwd) =>
      preparePackageChangelog(cwd, {
        allowUnreleased: options.allowUnreleasedChangelog,
      }));
  const restoreChangelog = options.restoreChangelog ?? restorePackageChangelog;
  const prepareBundledAiRuntime = options.prepareBundledAiRuntime ?? prepareBundledAiRuntimePackage;
  const packTool = options.pnpmPack ? "pnpm" : "npm";
  if (options.packJsonPath && options.pnpmPack) {
    throw new Error("packJsonPath cannot be combined with pnpmPack");
  }
  console.error("==> Packing OpenClaw package");
  await prepareChangelog(sourceDir);
  let packOutput;
  let cleanupBundledAiRuntime = async () => {};
  try {
    await cleanPackedOpenClawTarballs(outputDir);
    cleanupBundledAiRuntime = await prepareBundledAiRuntime(sourceDir, outputDir, runCaptureImpl);
    const packArgs =
      packTool === "pnpm"
        ? ["pack", "--silent", "--config.ignore-scripts=true", "--pack-destination", outputDir]
        : [
            "pack",
            ...(options.packJsonPath ? ["--json"] : []),
            "--silent",
            "--ignore-scripts",
            "--pack-destination",
            outputDir,
          ];
    packOutput = await runCaptureImpl(packTool, packArgs, sourceDir, {
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
      await restoreChangelog(sourceDir);
    }
  }
  // pnpm reports an absolute destination path. The directory was emptied before packing,
  // so scan that controlled destination instead of accepting a path from command output.
  let tarball = await newestOpenClawTarball(outputDir, options.pnpmPack ? "" : packOutput);
  if (options.outputName) {
    const target = path.join(outputDir, options.outputName);
    if (target !== tarball) {
      await fs.rm(target, { force: true });
      await fs.rename(tarball, target);
      tarball = target;
    }
  }
  await writePackJson(packOutput, tarball, options.packJsonPath, sourceDir);
  return tarball;
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
  await run(
    "node",
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "const { writePackageDistInventory } = await import('./src/infra/package-dist-inventory.ts'); await writePackageDistInventory(process.cwd());",
    ],
    sourceDir,
    {
      timeoutMs: resolveTimeoutMs(
        "OPENCLAW_DOCKER_PACKAGE_INVENTORY_TIMEOUT_MS",
        DEFAULT_PACKAGE_INVENTORY_TIMEOUT_MS,
      ),
    },
  );

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(Number.isInteger(error?.exitCode) ? error.exitCode : 1);
    },
  );
}

function toLintErrorObject(value, fallbackMessage) {
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
