import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForLog, stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { SpawnResult } from "./exec-result.js";
import type { runCommandBuffered } from "./exec.js";

export function formatCommandOutput(output: string | Buffer, maxChars = 800): string {
  // CR redraws replace the current frame; trim before making edge tabs visible.
  const text = stripAnsi(output.toString())
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\r+$/, "").split("\r").at(-1) ?? "")
    .join("\n")
    .trim()
    .replace(/[^\n]+/g, sanitizeTerminalText);
  const tail = text.split("\n").slice(-12).join("\n");
  const omitted = tail.length < text.length || tail.length > maxChars;
  return `${omitted ? "…\n" : ""}${sliceUtf16Safe(tail, Math.max(0, tail.length - maxChars))}`;
}

function fitCommandOutput(output: string, maxLength: number): string {
  if (output.length <= maxLength) {
    return output;
  }
  if (maxLength <= 0) {
    return "";
  }
  if (maxLength === 1) {
    return "…";
  }
  const source = output.startsWith("…\n") ? output.slice(2) : output;
  return `…\n${sliceUtf16Safe(source, Math.max(0, source.length - (maxLength - 2)))}`;
}

/** Use an operation label, never argv that may contain credentials. */
export function formatCommandResult(
  command: string,
  result: SpawnResult,
  options: { maxLength?: number } = {},
): string {
  const label = truncateUtf16Safe(sanitizeForLog(command.replace(/[\r\n]+/g, " ")), 256);
  const termination = result.outputLimitExceeded ? "output-limit" : result.termination;
  const signal = result.signal ? `, signal=${result.signal}` : "";
  const killed = result.killed ? ", killed=true" : "";
  const status = result.code === 0 ? "exited" : "failed";
  const header = `${label} ${status} (code=${result.code}, termination=${termination}${signal}${killed})`;
  const streams = (["stderr", "stdout"] as const).flatMap((stream) => {
    const output = formatCommandOutput(result[stream]);
    return output ? [{ stream, output }] : [];
  });
  const maxLength = options.maxLength;
  if (maxLength === undefined) {
    return [header, ...streams.map(({ stream, output }) => `${stream}: ${output}`)].join("\n");
  }
  const boundedLength = Math.max(0, Math.floor(maxLength));
  const fixedLength =
    header.length + streams.reduce((total, { stream }) => total + 1 + `${stream}: `.length, 0);
  if (streams.length === 0 || fixedLength >= boundedLength) {
    return truncateUtf16Safe(header, boundedLength);
  }
  const outputBudget = boundedLength - fixedLength;
  const lengths = streams.map(({ output }) => output.length);
  const allocations =
    streams.length === 2
      ? (() => {
          const first = Math.min(
            lengths[0] ?? 0,
            Math.max(Math.ceil(outputBudget / 2), outputBudget - (lengths[1] ?? 0)),
          );
          return [first, Math.min(lengths[1] ?? 0, outputBudget - first)];
        })()
      : [Math.min(lengths[0] ?? 0, outputBudget)];
  return [
    header,
    ...streams.map(
      ({ stream, output }, index) =>
        `${stream}: ${fitCommandOutput(output, allocations[index] ?? 0)}`,
    ),
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
  return new Error(`${label} failed${reason ? ` (${reason})` : ""}${detail ? `:\n${detail}` : ""}`);
}
