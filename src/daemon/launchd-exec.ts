/** Shared launchctl execution and result classification for macOS service owners. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { getWindowsCmdExePath } from "../infra/windows-install-roots.js";
import { execFileUtf8, type ExecResult } from "./exec-file.js";

export type LaunchctlResult = ExecResult;

export async function execLaunchctl(args: string[], timeoutMs?: number): Promise<LaunchctlResult> {
  const isWindows = process.platform === "win32";
  const file = isWindows ? getWindowsCmdExePath() : "launchctl";
  const fileArgs = isWindows ? ["/d", "/s", "/c", "launchctl", ...args] : args;
  return await execFileUtf8(file, fileArgs, {
    ...(isWindows ? { windowsHide: true } : {}),
    ...(timeoutMs && timeoutMs > 0 ? { timeout: timeoutMs, killSignal: "SIGKILL" as const } : {}),
  });
}

export function isLaunchctlNotLoaded(result: LaunchctlResult): boolean {
  const detail = normalizeLowercaseStringOrEmpty(result.stderr || result.stdout);
  return (
    result.termination === "exit" &&
    (detail.includes("no such process") ||
      detail.includes("could not find service") ||
      detail.includes("not found"))
  );
}

export function formatLaunchctlResultDetail(
  result: Pick<LaunchctlResult, "stdout" | "stderr">,
): string {
  const sanitized = sanitizeForLog((result.stderr || result.stdout).replace(/[\r\n\t]+/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return truncateUtf16Safe(sanitized, 1000);
}
