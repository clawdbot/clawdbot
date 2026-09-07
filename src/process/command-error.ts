import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForLog, stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { SpawnResult } from "./exec-result.js";
import type { runCommandBuffered } from "./exec.js";

const COMMAND_ERROR_NAME = "CommandExecutionError";
// Older serialized failures have no marker; recognize their explicit termination header.
const COMMAND_ERROR_HEADER_RE =
  /^(?:Error:\s*)?.+ failed \((?:timed out after [\d.]+ seconds|timed out waiting for output|output limit exceeded|exit code -?\d+|terminated|signal SIG[A-Z0-9]+)(?:; signal SIG[A-Z0-9]+)?\):?$/u;

export function formatCommandErrorForUser(text: string): string | undefined {
  const lines = text.trim().split(/\r?\n/u);
  const header = lines[0] ?? "";
  if (!header.startsWith(`${COMMAND_ERROR_NAME}: `) && !COMMAND_ERROR_HEADER_RE.test(header)) {
    return undefined;
  }
  const tail = lines.length > 1 ? lines.at(-1)?.trim() : undefined;
  const summary = [header, tail].filter(Boolean).join(" ").replace(/\s+/gu, " ").trim();
  return summary.length > 500 ? `${truncateUtf16Safe(summary, 497)}...` : summary;
}

export function formatCommandOutput(output: string | Buffer, maxChars = 800): string {
  // CR redraws replace the current frame; trim before making edge tabs visible.
  // Anchor each CR run/frame so unmatched runs do not repeatedly scan their suffixes.
  const lines = stripAnsi(output.toString())
    .replace(/(^|[^\r])\r+(?=\n|$)/g, "$1")
    .replace(/(^|\n)[^\n]*\r/g, "$1")
    .trim()
    .split("\n");
  const tail = lines.slice(-12).map(sanitizeTerminalText).join("\n");
  const omitted = lines.length > 12 || tail.length > maxChars;
  return `${omitted ? "…\n" : ""}${sliceUtf16Safe(tail, Math.max(0, tail.length - maxChars))}`;
}

/** Use an operation label, never argv that may contain credentials. */
export function formatCommandResult(command: string, result: SpawnResult): string {
  const label = truncateUtf16Safe(sanitizeForLog(command.replace(/[\r\n]+/g, " ")), 256);
  const termination = result.outputLimitExceeded ? "output-limit" : result.termination;
  const signal = result.signal ? `, signal=${result.signal}` : "";
  const killed = result.killed ? ", killed=true" : "";
  const status = result.code === 0 ? "exited" : "failed";
  return [
    `${label} ${status} (code=${result.code}, termination=${termination}${signal}${killed})`,
    ...(["stderr", "stdout"] as const).flatMap((stream) => {
      const output = formatCommandOutput(result[stream]);
      return output ? [`${stream}: ${output}`] : [];
    }),
  ].join("\n");
}

export function createCommandError(
  command: string,
  result: SpawnResult | Awaited<ReturnType<typeof runCommandBuffered>>,
  options: { timeoutMs: number },
): Error {
  const stderr = formatCommandOutput(result.stderr, 2_000);
  const stdout = formatCommandOutput(result.stdout, 2_000);
  let detail = stderr || stdout;
  if (stderr && stdout) {
    const budget = 2_000 - "stderr: \nstdout: ".length;
    const first = Math.min(stderr.length, Math.max(Math.ceil(budget / 2), budget - stdout.length));
    // Pure suffix fitting replaces any earlier marker; normalization runs only once.
    const tail = (output: string, limit: number) =>
      output.length <= limit ? output : `…\n${sliceUtf16Safe(output, 2 - limit)}`;
    detail = `stderr: ${tail(stderr, first)}\nstdout: ${tail(stdout, budget - first)}`;
  }
  const signal = result.signal ? `signal ${result.signal}` : "";
  const limited =
    "outputLimitExceeded" in result && result.outputLimitExceeded ? "output limit exceeded" : "";
  const exitReason = limited || (!signal && result.code !== null ? `exit code ${result.code}` : "");
  const primary = {
    timeout: `timed out after ${options.timeoutMs / 1000} seconds`,
    "no-output-timeout": "timed out waiting for output",
    "output-limit": "output limit exceeded",
    exit: exitReason,
    error: exitReason,
    signal: limited || (!signal ? "terminated" : ""),
  }[result.termination];
  const reason = [primary, signal].filter(Boolean).join("; ");
  const label = truncateUtf16Safe(stripAnsi(command).replace(/[\r\n]+/g, " "), 256);
  const error = new Error(
    `${label} failed${reason ? ` (${reason})` : ""}${detail ? `:\n${detail}` : ""}`,
  );
  error.name = COMMAND_ERROR_NAME;
  return error;
}
