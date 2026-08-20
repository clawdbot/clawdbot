import { runCommandWithTimeout, type SpawnResult } from "openclaw/plugin-sdk/process-runtime";

const CRABBOX_VERSION_TIMEOUT_MS = 2_000;
const CRABBOX_VERSION_MAX_OUTPUT_BYTES = 64 * 1024;

type CrabboxVersionProbe =
  | { status: "supported"; version: string }
  | { status: "outdated"; version: string }
  | { status: "indeterminate"; reason: string };

export async function probeCrabboxVersion(binary: string): Promise<CrabboxVersionProbe> {
  let result: SpawnResult;
  try {
    result = await runCommandWithTimeout([binary, "--version"], {
      killProcessTree: true,
      maxOutputBytes: CRABBOX_VERSION_MAX_OUTPUT_BYTES,
      timeoutMs: CRABBOX_VERSION_TIMEOUT_MS,
    });
  } catch {
    return { status: "indeterminate", reason: "version command could not start" };
  }
  if (result.termination !== "exit" || result.code !== 0 || result.outputLimitExceeded) {
    const reason =
      result.termination === "timeout"
        ? `version command timed out after ${CRABBOX_VERSION_TIMEOUT_MS} ms`
        : result.outputLimitExceeded
          ? "version output exceeded 64 KiB"
          : result.termination !== "exit"
            ? `version command did not exit normally (${result.termination})`
            : `version command exited with code ${result.code ?? "unknown"}`;
    return { status: "indeterminate", reason };
  }
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(
    `${result.stdout}\n${result.stderr}`.trim(),
  );
  if (!match) {
    return { status: "indeterminate", reason: "version output was not recognized" };
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const version = `${major}.${minor}.${patch}`;
  const supported = major > 0 || (major === 0 && (minor > 41 || (minor === 41 && patch >= 1)));
  return supported ? { status: "supported", version } : { status: "outdated", version };
}
