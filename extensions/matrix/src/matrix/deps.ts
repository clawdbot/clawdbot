import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";

const REQUIRED_MATRIX_PACKAGES = [
  "matrix-js-sdk",
  "@matrix-org/matrix-sdk-crypto-nodejs",
  "@matrix-org/matrix-sdk-crypto-wasm",
];
const MIN_MATRIX_CRYPTO_NATIVE_BINDING_BYTES = 1_000_000;

type MatrixCryptoRuntimeDeps = {
  requireFn?: (id: string) => unknown;
  runCommand?: (params: {
    argv: string[];
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
  }) => Promise<CommandResult>;
  resolveFn?: (id: string) => string;
  nodeExecutable?: string;
  log?: (message: string) => void;
};

function resolveMissingMatrixPackages(resolveFn?: (id: string) => string): string[] {
  const resolve = resolveFn ?? defaultResolveFn;
  return REQUIRED_MATRIX_PACKAGES.filter((pkg) => {
    try {
      resolve(pkg);
      return false;
    } catch {
      return true;
    }
  });
}

export function isMatrixSdkAvailable(): boolean {
  return resolveMissingMatrixPackages().length === 0;
}

function buildMatrixDepsMissingMessage(missing: string[]): string {
  return [
    `Matrix plugin dependencies are missing: ${missing.join(", ")}.`,
    "Repair this plugin with `openclaw plugins update matrix` or run `openclaw doctor --fix`.",
  ].join(" ");
}

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

let defaultMatrixCryptoRuntimeEnsurePromise: Promise<void> | null = null;

async function runFixedCommandWithTimeout(params: {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const [command, ...args] = params.argv;
    if (!command) {
      resolve({
        code: 1,
        stdout: "",
        stderr: "command is required",
      });
      return;
    }

    const proc = spawn(command, args, {
      cwd: params.cwd,
      env: { ...process.env, ...params.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const killChildOnExit = () => {
      if (!settled && proc.exitCode === null) {
        proc.kill("SIGTERM");
      }
    };

    const finalize = (result: CommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      process.off("exit", killChildOnExit);
      resolve(result);
    };
    process.once("exit", killChildOnExit);

    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finalize({
        code: 124,
        stdout,
        stderr: stderr || `command timed out after ${params.timeoutMs}ms`,
      });
    }, params.timeoutMs);

    proc.on("error", (err) => {
      finalize({
        code: 1,
        stdout,
        stderr: err.message,
      });
    });

    proc.on("close", (code) => {
      finalize({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function defaultRequireFn(id: string): unknown {
  return createRequire(import.meta.url)(id);
}

function defaultResolveFn(id: string): string {
  return createRequire(import.meta.url).resolve(id);
}

function isMissingMatrixCryptoRuntimeError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return (
    message.includes("@matrix-org/matrix-sdk-crypto-nodejs-") ||
    message.includes("matrix-sdk-crypto-nodejs") ||
    message.includes("download-lib.js")
  );
}

function isMuslRuntime(): boolean {
  try {
    const report = process.report?.getReport?.() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return true;
  }
}

function resolveMatrixCryptoNativeBindingFilename(): string | null {
  switch (process.platform) {
    case "darwin":
      return process.arch === "arm64"
        ? "matrix-sdk-crypto.darwin-arm64.node"
        : process.arch === "x64"
          ? "matrix-sdk-crypto.darwin-x64.node"
          : null;
    case "linux":
      if (process.arch === "x64") {
        return isMuslRuntime()
          ? "matrix-sdk-crypto.linux-x64-musl.node"
          : "matrix-sdk-crypto.linux-x64-gnu.node";
      }
      if (process.arch === "arm64" && !isMuslRuntime()) {
        return "matrix-sdk-crypto.linux-arm64-gnu.node";
      }
      if (process.arch === "arm") {
        return "matrix-sdk-crypto.linux-arm-gnueabihf.node";
      }
      if (process.arch === "s390x") {
        return "matrix-sdk-crypto.linux-s390x-gnu.node";
      }
      return null;
    case "win32":
      return process.arch === "x64"
        ? "matrix-sdk-crypto.win32-x64-msvc.node"
        : process.arch === "ia32"
          ? "matrix-sdk-crypto.win32-ia32-msvc.node"
          : process.arch === "arm64"
            ? "matrix-sdk-crypto.win32-arm64-msvc.node"
            : null;
    default:
      return null;
  }
}

function resolveMatrixCryptoNativeBindingPath(resolveFn: (id: string) => string): string | null {
  const filename = resolveMatrixCryptoNativeBindingFilename();
  if (!filename) {
    return null;
  }
  try {
    return path.join(
      path.dirname(resolveFn("@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js")),
      filename,
    );
  } catch {
    return null;
  }
}

function removeIncompleteMatrixCryptoNativeBinding(params: {
  bindingPath: string | null;
  log?: (message: string) => void;
}): void {
  const bindingPath = params.bindingPath;
  if (!bindingPath) {
    return;
  }
  try {
    const stat = fs.statSync(bindingPath);
    if (!stat.isFile() || stat.size >= MIN_MATRIX_CRYPTO_NATIVE_BINDING_BYTES) {
      return;
    }
    fs.unlinkSync(bindingPath);
    params.log?.(
      `matrix: removed incomplete native crypto runtime (${stat.size} bytes); it will be downloaded again`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function ensureMatrixCryptoRuntime(
  params: MatrixCryptoRuntimeDeps = {},
): Promise<void> {
  const usesDefaultRuntime =
    !params.requireFn && !params.runCommand && !params.resolveFn && !params.nodeExecutable;
  if (usesDefaultRuntime && defaultMatrixCryptoRuntimeEnsurePromise) {
    await defaultMatrixCryptoRuntimeEnsurePromise;
    return;
  }
  const ensurePromise = ensureMatrixCryptoRuntimeOnce(params);
  if (!usesDefaultRuntime) {
    await ensurePromise;
    return;
  }
  defaultMatrixCryptoRuntimeEnsurePromise = ensurePromise.catch((error: unknown) => {
    defaultMatrixCryptoRuntimeEnsurePromise = null;
    throw error;
  });
  await defaultMatrixCryptoRuntimeEnsurePromise;
}

async function ensureMatrixCryptoRuntimeOnce(params: MatrixCryptoRuntimeDeps): Promise<void> {
  const resolveFn = params.resolveFn ?? defaultResolveFn;
  const nativeBindingPath = resolveMatrixCryptoNativeBindingPath(resolveFn);
  removeIncompleteMatrixCryptoNativeBinding({ bindingPath: nativeBindingPath, log: params.log });
  const requireFn = params.requireFn ?? defaultRequireFn;
  try {
    requireFn("@matrix-org/matrix-sdk-crypto-nodejs");
    return;
  } catch (err) {
    if (!isMissingMatrixCryptoRuntimeError(err)) {
      throw err;
    }
  }

  const scriptPath = resolveFn("@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js");
  params.log?.("matrix: bootstrapping native crypto runtime");
  const runCommand = params.runCommand ?? runFixedCommandWithTimeout;
  const nodeExecutable = params.nodeExecutable ?? process.execPath;
  const result = await runCommand({
    argv: [nodeExecutable, scriptPath],
    cwd: path.dirname(scriptPath),
    timeoutMs: 300_000,
    env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
  });
  if (result.code !== 0) {
    removeIncompleteMatrixCryptoNativeBinding({ bindingPath: nativeBindingPath, log: params.log });
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "Matrix crypto runtime bootstrap failed.",
    );
  }

  removeIncompleteMatrixCryptoNativeBinding({ bindingPath: nativeBindingPath, log: params.log });
  requireFn("@matrix-org/matrix-sdk-crypto-nodejs");
}

export async function ensureMatrixSdkInstalled(params?: {
  runtime?: RuntimeEnv;
  confirm?: (message: string) => Promise<boolean>;
  resolveFn?: (id: string) => string;
}): Promise<void> {
  const missing = resolveMissingMatrixPackages(params?.resolveFn);
  if (missing.length === 0) {
    return;
  }
  throw new Error(buildMatrixDepsMissingMessage(missing));
}
