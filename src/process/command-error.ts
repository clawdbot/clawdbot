import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import type { SpawnResult } from "./exec-result.js";
import type { runCommandBuffered } from "./exec.js";

function normalizeDiagnostic(output: string | Buffer): string {
  // Progress redraws use CR, not LF. Keep the last frame, including an
  // unfinished redraw, before deciding whether this stream has visible text.
  return stripAnsi(output.toString())
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\r+$/, "").split("\r").at(-1) ?? "")
    .join("\n")
    .trim();
}

export function createCommandError(
  command: string,
  result: SpawnResult | Awaited<ReturnType<typeof runCommandBuffered>>,
  options: { timeoutMs: number },
): Error {
  const output = normalizeDiagnostic(result.stderr) || normalizeDiagnostic(result.stdout);
  const tail = output.split("\n").slice(-12).join("\n");
  const omitted = tail.length < output.length || tail.length > 2000;
  const detail = `${omitted ? "…\n" : ""}${sliceUtf16Safe(tail, -2000)}`;
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
