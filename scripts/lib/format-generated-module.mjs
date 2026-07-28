// Formats generated TypeScript/JavaScript modules through the repo formatter.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GENERATED_MODULE_FORMAT_TIMEOUT_MS = 30_000;
export const GENERATED_MODULE_FORMAT_MAX_BUFFER_BYTES = 1024 * 1024;
const FORMATTER_OUTPUT_TAIL_BYTES = 16 * 1024;

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
  const resolvedRepoRoot = path.resolve(repoRoot);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-generated-format-"));
  const tempOutputPath = path.join(tempDir, path.basename(outputPath));

  try {
    fs.writeFileSync(tempOutputPath, source, "utf8");
    const formatter = spawnSyncImpl(
      process.execPath,
      [
        path.join(resolvedRepoRoot, "node_modules", "oxfmt", "bin", "oxfmt"),
        "--write",
        tempOutputPath,
      ],
      {
        cwd: resolvedRepoRoot,
        encoding: "utf8",
        maxBuffer: GENERATED_MODULE_FORMAT_MAX_BUFFER_BYTES,
        shell: false,
        timeout: GENERATED_MODULE_FORMAT_TIMEOUT_MS,
      },
    );
    if (formatter.error || formatter.status !== 0) {
      const details = formatterFailureDetails(formatter);
      throw new Error(`failed to format generated ${errorLabel}: ${details}`);
    }
    return fs.readFileSync(tempOutputPath, "utf8");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
