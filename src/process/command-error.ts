import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForLog, stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { SpawnResult } from "./exec-result.js";
import type { runCommandBuffered } from "./exec.js";

function normalizeCommandOutput(output: string | Buffer): string {
  const visible = stripAnsi(output.toString())
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\r+$/, "").split("\r").at(-1) ?? "")
    .join("\n")
    .trim();
  return visible
    .split("\n")
    .map((line) => sanitizeTerminalText(line))
    .join("\n");
}

function renderCommandOutputTail(output: string, maxChars: number, markerChars = 0): string {
  const tail = output.split("\n").slice(-12).join("\n");
  if (tail.length === output.length && tail.length <= maxChars) {
    return tail;
  }
  const contentLimit = Math.max(0, Math.floor(maxChars)) - markerChars;
  return contentLimit < 0
    ? ""
    : `…\n${contentLimit > 0 ? sliceUtf16Safe(tail, -contentLimit) : ""}`;
}

function formatCommandErrorDetail(stderr: string | Buffer, stdout: string | Buffer): string {
  const streams = [normalizeCommandOutput(stderr), normalizeCommandOutput(stdout)];
  const visible = streams.filter(Boolean);
  if (visible.length < 2) {
    return visible[0] ? renderCommandOutputTail(visible[0], 2_000) : "";
  }

  const bodyBudget = 2_000 - "stderr: \nstdout: ".length;
  const demands = streams.map((output) => {
    const tail = output.split("\n").slice(-12).join("\n");
    return tail.length + (tail.length < output.length ? 2 : 0);
  });
  let allocations = [...demands];
  if (demands[0]! + demands[1]! > bodyBudget) {
    allocations = demands.map((demand) => Math.min(demand, Math.floor(bodyBudget / 2)));
    const remaining = bodyBudget - allocations[0]! - allocations[1]!;
    const stderrUnmet = demands[0]! - allocations[0]!;
    const stdoutUnmet = demands[1]! - allocations[1]!;
    const index = stderrUnmet >= stdoutUnmet ? 0 : 1;
    allocations[index] = allocations[index]! + remaining;
  }
  return `stderr: ${renderCommandOutputTail(
    streams[0]!,
    Math.max(0, Math.floor(allocations[0]!)),
    2,
  )}\nstdout: ${renderCommandOutputTail(streams[1]!, Math.max(0, Math.floor(allocations[1]!)), 2)}`;
}

export function formatCommandOutput(output: string | Buffer, maxChars = 800): string {
  return renderCommandOutputTail(normalizeCommandOutput(output), maxChars);
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
  const detail = formatCommandErrorDetail(result.stderr, result.stdout);
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
