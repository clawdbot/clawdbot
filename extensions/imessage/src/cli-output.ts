// Bounded one-shot iMessage CLI execution shared by action and send surfaces.
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";

const IMESSAGE_CLI_STDOUT_MAX_BYTES = 8 * 1024 * 1024;
const IMESSAGE_CLI_STDERR_TAIL_BYTES = 64 * 1024;

function parseLastJsonObject(stdout: string): Record<string, unknown> | null {
  const last = stdout
    .split(/\r?\n/u)
    .findLast((line) => line.trim().length > 0)
    ?.trim();
  if (!last) {
    return null;
  }
  try {
    const value = JSON.parse(last) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function runIMessageCliJsonCommand(params: {
  cliPath: string;
  dbPath?: string;
  args: readonly string[];
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const dbPath = params.dbPath?.trim();
  const argv = [params.cliPath, ...params.args, ...(dbPath ? ["--db", dbPath] : []), "--json"];
  const result = await runCommandWithTimeout(argv, {
    killProcessTree: true,
    maxOutputBytes: {
      stdout: IMESSAGE_CLI_STDOUT_MAX_BYTES,
      stderr: IMESSAGE_CLI_STDERR_TAIL_BYTES,
    },
    outputCapture: { stdout: "head", stderr: "tail" },
    terminateOnOutputLimit: { stdout: true },
    timeoutMs: params.timeoutMs,
  });
  if (result.termination === "timeout") {
    throw new Error(`iMessage action timed out after ${params.timeoutMs}ms`);
  }
  if (result.outputLimitExceeded || result.stdoutTruncatedBytes) {
    throw new Error(`imsg stdout exceeded ${IMESSAGE_CLI_STDOUT_MAX_BYTES} bytes`);
  }

  const parsed = parseLastJsonObject(result.stdout);
  if (result.code !== 0) {
    const detail =
      (typeof parsed?.error === "string" && parsed.error.trim()) ||
      result.stderr.trim() ||
      result.stdout.trim() ||
      `imsg exited with code ${result.code}`;
    throw new Error(detail);
  }
  if (!parsed) {
    throw new Error(
      `imsg returned non-JSON output: ${result.stdout.trim() || result.stderr.trim()}`,
    );
  }
  if (parsed.success === false) {
    const detail =
      typeof parsed.error === "string" && parsed.error.trim()
        ? parsed.error.trim()
        : "iMessage action failed";
    throw new Error(detail);
  }
  return parsed;
}
