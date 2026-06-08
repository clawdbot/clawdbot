// Formats generated TypeScript/JavaScript modules through the repo formatter.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePnpmRunner } from "../pnpm-runner.mjs";

export const GENERATED_MODULE_FORMAT_TIMEOUT_MS = 30_000;
export const GENERATED_MODULE_FORMAT_MAX_BUFFER_BYTES = 1024 * 1024;
const FORMATTER_OUTPUT_TAIL_BYTES = 16 * 1024;

/** Resolve the fastest available oxfmt command for a generated module path. */
export function resolveGeneratedModuleFormatter(params) {
  const platform = params.platform ?? process.platform;
  const existsSync = params.existsSync ?? fs.existsSync;
  const directFormatterPath = path.join(params.repoRoot, "node_modules", ".bin", "oxfmt");
  const useDirectFormatter = platform !== "win32" && existsSync(directFormatterPath);
  if (useDirectFormatter) {
    return {
      command: directFormatterPath,
      args: ["--write", params.outputPath],
      shell: false,
    };
  }

  return resolvePnpmRunner({
    comSpec: params.comSpec,
    npmExecPath: params.npmExecPath,
    nodeExecPath: params.nodeExecPath,
    platform,
    pnpmArgs: ["exec", "oxfmt", "--write", params.outputPath],
  });
}

function outputText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}

function outputTail(value) {
  const text = outputText(value).trim();
  if (!text) {
    return "";
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= FORMATTER_OUTPUT_TAIL_BYTES) {
    return text;
  }
  return bytes.subarray(bytes.byteLength - FORMATTER_OUTPUT_TAIL_BYTES).toString("utf8");
}

function formatterFailureDetails(formatter) {
  const details = [];
  const errorCode = formatter.error?.code;
  if (errorCode === "ETIMEDOUT") {
    details.push(`formatter timed out after ${GENERATED_MODULE_FORMAT_TIMEOUT_MS}ms`);
  } else if (errorCode === "ENOBUFS") {
    details.push(`formatter output exceeded ${GENERATED_MODULE_FORMAT_MAX_BUFFER_BYTES} bytes`);
  } else if (formatter.error?.message) {
    details.push(formatter.error.message);
  }
  if (formatter.status !== null && formatter.status !== undefined && formatter.status !== 0) {
    details.push(`formatter exited with status ${formatter.status}`);
  }
  if (formatter.signal) {
    details.push(`formatter exited with signal ${formatter.signal}`);
  }
  const stderrTail = outputTail(formatter.stderr);
  if (stderrTail) {
    details.push(`stderr tail:\n${stderrTail}`);
  }
  const stdoutTail = outputTail(formatter.stdout);
  if (stdoutTail) {
    details.push(`stdout tail:\n${stdoutTail}`);
  }
  return details.join("\n") || "unknown formatter failure";
}

/** Format generated source in a temporary file and return the formatter output. */
export function formatGeneratedModule(source, { repoRoot, outputPath, errorLabel }, deps = {}) {
  const spawnSyncImpl = deps.spawnSync ?? spawnSync;
  const resolveFormatter = deps.resolveFormatter ?? resolveGeneratedModuleFormatter;
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedOutputPath = path.resolve(
    resolvedRepoRoot,
    path.isAbsolute(outputPath) ? path.relative(resolvedRepoRoot, outputPath) : outputPath,
  );
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-generated-format-"));
  const tempOutputPath = path.join(tempDir, path.basename(resolvedOutputPath));

  try {
    fs.writeFileSync(tempOutputPath, source, "utf8");
    const command = resolveFormatter({
      existsSync: fs.existsSync,
      outputPath: tempOutputPath,
      repoRoot: resolvedRepoRoot,
    });
    const formatter = spawnSyncImpl(command.command, command.args, {
      cwd: resolvedRepoRoot,
      encoding: "utf8",
      env: command.env ?? process.env,
      maxBuffer: GENERATED_MODULE_FORMAT_MAX_BUFFER_BYTES,
      shell: command.shell,
      timeout: GENERATED_MODULE_FORMAT_TIMEOUT_MS,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
    });
    if (formatter.error || formatter.status !== 0) {
      const details = formatterFailureDetails(formatter);
      throw new Error(`failed to format generated ${errorLabel}: ${details}`);
    }
    return fs.readFileSync(tempOutputPath, "utf8");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
