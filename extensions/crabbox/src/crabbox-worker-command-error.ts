import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { sliceUtf16Safe, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const MAX_COMMAND_DETAIL_CHARS = 512;

function crabboxCommandDetail(result: SpawnResult): string {
  const raw = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  if (!raw) {
    return "";
  }
  const compressed = redactSensitiveText(raw).replace(/\s+/gu, " ");
  const omitted = " ... ";
  const remaining = MAX_COMMAND_DETAIL_CHARS - omitted.length;
  const redacted =
    compressed.length <= MAX_COMMAND_DETAIL_CHARS
      ? compressed
      : `${truncateUtf16Safe(compressed, Math.ceil(remaining / 2))}${omitted}${sliceUtf16Safe(
          compressed,
          -Math.floor(remaining / 2),
        )}`;
  return redacted ? `: ${redacted}` : "";
}

export function crabboxCommandError(action: string, result: SpawnResult): Error {
  if (result.termination !== "exit") {
    return new Error(
      `Crabbox ${action} did not exit normally (${result.termination})${crabboxCommandDetail(result)}`,
    );
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
