export const IMESSAGE_CLI_STDOUT_MAX_CHARS = 8 * 1024 * 1024;
export const IMESSAGE_CLI_STDERR_TAIL_CHARS = 64 * 1024;

type AppendStdoutResult = { ok: true; value: string } | { ok: false; message: string };

function chunkToString(chunk: string | Buffer): string {
  return typeof chunk === "string" ? chunk : chunk.toString("utf8");
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
  return next.length > maxChars ? next.slice(-maxChars) : next;
}
