import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const MAX_COMMAND_DETAIL_CHARS = 512;

function crabboxCommandDetail(result: SpawnResult): string {
  const raw = (result.stderr || result.stdout).trim();
  if (!raw) {
    return "";
  }
  const compressed = redactSensitiveText(raw).replace(/\s+/gu, " ");
  if (compressed.length <= MAX_COMMAND_DETAIL_CHARS) {
    return `: ${compressed}`;
  }
  // Provider CLIs print progress first and the actual failure reason last, so the
  // tail is what explains the rejection.
  return `: …${sliceUtf16Safe(compressed, -(MAX_COMMAND_DETAIL_CHARS - 1))}`;
}

export function crabboxCommandError(action: string, result: SpawnResult): Error {
  if (result.termination !== "exit") {
    return new Error(`Crabbox ${action} did not exit normally (${result.termination})`);
  }
  const exitCode = result.code === null ? "unknown" : String(result.code);
  return new Error(
    `Crabbox ${action} failed with exit code ${exitCode}${crabboxCommandDetail(result)}`,
  );
}

export function permanentCrabboxCommandError(
  action: string,
  result: SpawnResult,
): WorkerProviderError {
  return new WorkerProviderError(crabboxCommandError(action, result).message);
}
