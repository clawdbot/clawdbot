// Imessage plugin module implements cli output behavior.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const IMESSAGE_CLI_STDOUT_MAX_CHARS = 8 * 1024 * 1024;
const IMESSAGE_CLI_STDERR_TAIL_CHARS = 64 * 1024;

type AppendStdoutResult = { ok: true; value: string } | { ok: false; message: string };

function chunkToString(chunk: string | Buffer): string {
  return typeof chunk === "string" ? chunk : chunk.toString("utf8");
}

export function listenForIMessageCliStreamErrors(params: {
  child: Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr" | "kill">;
  isSettled: () => boolean;
  fail: (error: Error) => void;
}): void {
  for (const stream of ["stdout", "stderr"] as const) {
    // Keep the listener after settlement: late stream errors still need to be
    // consumed even though they can no longer change the command result.
    params.child[stream].on("error", (error) => {
      if (params.isSettled()) {
        return;
      }
      params.fail(new Error(`iMessage CLI ${stream} stream error: ${error.message}`));
      try {
        params.child.kill("SIGKILL");
      } catch {
        // The helper may already be gone.
      }
    });
  }
}

export function appendIMessageCliStdout(
  current: string,
  chunk: string | Buffer,
  maxChars = IMESSAGE_CLI_STDOUT_MAX_CHARS,
): AppendStdoutResult {
  const next = current + chunkToString(chunk);
  if (next.length > maxChars) {
    return { ok: false, message: `imsg stdout exceeded ${maxChars} characters` };
  }
  return { ok: true, value: next };
}

export function appendIMessageCliStderrTail(
  current: string,
  chunk: string | Buffer,
  maxChars = IMESSAGE_CLI_STDERR_TAIL_CHARS,
): string {
  const next = current + chunkToString(chunk);
  return next.length > maxChars ? sliceUtf16Safe(next, -maxChars) : next;
}
