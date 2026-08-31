import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForLog, stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import type { SpawnResult } from "./exec-result.js";
import type { runCommandBuffered } from "./exec.js";

function formatCommandOutputs(outputs: (string | Buffer)[], maxChars: number, shared = false) {
  // CR redraws replace the current progress frame; keep its final visible content.
  const normalized = outputs.map((output) =>
    stripAnsi(output.toString())
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.replace(/\r+$/, "").split("\r").at(-1) ?? "")
      .join("\n")
      .trim(),
  );
  // Extra streams reserve their newline and omission marker inside the existing bound.
  const count = shared ? Math.max(1, normalized.filter(Boolean).length) : 1;
  const limit = shared ? Math.floor((maxChars - 3 * (count - 1)) / count) : maxChars;
  return normalized.map((output) => {
    const tail = output.split("\n").slice(-12).join("\n");
    const omitted = tail.length < output.length || tail.length > limit;
    return `${omitted ? "…\n" : ""}${sliceUtf16Safe(tail, -limit)}`;
  });
}

export function formatCommandOutput(output: string | Buffer, maxChars = 800): string {
  return formatCommandOutputs([output], maxChars).join("");
}

// Pass an operation label, never argv that may contain credentials.
export function formatCommandResult(command: string, result: SpawnResult): string {
  const label = truncateUtf16Safe(sanitizeForLog(command.replace(/[\r\n]+/g, " ")), 256);
  const termination = result.outputLimitExceeded ? "output-limit" : result.termination;
  const signal = result.signal ? `, signal=${result.signal}` : "";
  const killed = result.killed ? ", killed=true" : "";
  const status = result.code === 0 ? "exited" : "failed";
  return [
    `${label} ${status} (code=${result.code}, termination=${termination}${signal}${killed})`,
    ...formatCommandOutputs([result.stderr, result.stdout], 800).flatMap((output, index) =>
      output ? [`${index === 0 ? "stderr" : "stdout"}: ${output}`] : [],
    ),
  ].join("\n");
}

export function createCommandError(
  command: string,
  result: SpawnResult | Awaited<ReturnType<typeof runCommandBuffered>>,
  options: { timeoutMs: number },
): Error {
  const detail = formatCommandOutputs([result.stderr, result.stdout], 2000, true)
    .filter(Boolean)
    .join("\n");
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
