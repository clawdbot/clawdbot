import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const MAX_COMMAND_DETAIL_CHARS = 512;

function crabboxCommandDetail(result: SpawnResult): string {
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (!raw) {
    return "";
  }
  const compressed = redactSensitiveText(raw).replace(/\s+/gu, " ");
  // Failure diagnoses come last; Crabbox's fixed banner is leading boilerplate.
  // Keep stderr last, matching the per-stream suffix capture in src/process/exec-output.ts.
  const tailMarker = "... ";
  return compressed.length <= MAX_COMMAND_DETAIL_CHARS
    ? `: ${compressed}`
    : `: ${tailMarker}${sliceUtf16Safe(compressed, tailMarker.length - MAX_COMMAND_DETAIL_CHARS)}`;
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
