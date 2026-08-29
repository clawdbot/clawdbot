import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForLog, stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import type { SpawnResult } from "./exec-result.js";
import type { runCommandBuffered } from "./exec.js";

export function formatCommandOutput(output: string | Buffer, maxChars = 800): string {
  // Progress redraws use CR, not LF. Keep the last frame, including an
  // unfinished redraw, before deciding whether this stream has visible text.
  const normalized = stripAnsi(output.toString())
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\r+$/, "").split("\r").at(-1) ?? "")
    .join("\n")
    .trim();
  const tail = normalized.split("\n").slice(-12).join("\n");
  const omitted = tail.length < normalized.length || tail.length > maxChars;
  return `${omitted ? "…\n" : ""}${sliceUtf16Safe(tail, -maxChars)}`;
}

/** Use an operation label, never argv that may contain credentials. */
export function formatCommandResult(command: string, result: SpawnResult): string {
  const label = truncateUtf16Safe(sanitizeForLog(command.replace(/[\r\n]+/g, " ")), 256);
  const termination = result.outputLimitExceeded ? "output-limit" : result.termination;
  const signal = result.signal ? `, signal=${result.signal}` : "";
  const killed = result.killed ? ", killed=true" : "";
  const status = result.code === 0 ? "exited" : "failed";
  const lines = [
    `${label} ${status} (code=${result.code}, termination=${termination}${signal}${killed})`,
  ];
  for (const stream of ["stderr", "stdout"] as const) {
    const output = formatCommandOutput(result[stream]);
    if (output) {
      lines.push(`${stream}: ${output}`);
    }
  }
  return lines.join("\n");
}

export function createCommandError(
  command: string,
  result: SpawnResult | Awaited<ReturnType<typeof runCommandBuffered>>,
  options: { timeoutMs: number },
): Error {
  const detail =
    formatCommandOutput(result.stderr, 2000) || formatCommandOutput(result.stdout, 2000);
  const reasons: string[] = [];
  if (result.termination === "timeout") {
    reasons.push(`timed out after ${options.timeoutMs / 1000} seconds`);
  } else if (result.termination === "no-output-timeout") {
    reasons.push("timed out waiting for output");
  } else if (
    result.termination === "output-limit" ||
    ("outputLimitExceeded" in result && result.outputLimitExceeded)
  ) {
    reasons.push("output limit exceeded");
  }
  if (result.signal) {
    reasons.push(`signal ${result.signal}`);
  } else if (result.termination === "signal" && reasons.length === 0) {
    reasons.push("terminated");
  }
  if (reasons.length === 0 && result.code !== null) {
    reasons.push(`exit code ${result.code}`);
  }
  const label = truncateUtf16Safe(stripAnsi(command).replace(/[\r\n]+/g, " "), 256);
  const reason = reasons.length > 0 ? ` (${reasons.join("; ")})` : "";
  return new Error(`${label} failed${reason}${detail ? `:\n${detail}` : ""}`);
}
