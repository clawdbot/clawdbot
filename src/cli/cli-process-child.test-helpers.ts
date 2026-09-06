// Shared child harness for CLI process suites: real Node+TSX children, one
// deadlock guard each, and failures that always carry the child's own output.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../../test/vitest/vitest.timeouts.js";

const OUTPUT_TAIL_CHARS = 8_000;

/**
 * Deadlock guard for one CLI child, never a startup SLO.
 *
 * A source child cold-loads the whole command graph through TSX: seconds when the
 * transpile cache is warm, tens of seconds on a cold checkout or a contended runner,
 * while these suites assert output and exit codes rather than latency. Sizing the
 * guard one case below the shared Vitest deadline keeps the SIGKILL and its captured
 * output ahead of the framework's opaque timeout. Cases stay at one child each so
 * this single budget applies to all of them.
 */
export const CLI_PROCESS_DEADLOCK_GUARD_MS = DEFAULT_VITEST_TEST_TIMEOUT_MS - 20_000;

export type CliProcessChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function formatOutputTail(stream: string): string {
  const truncatedLength = stream.length - OUTPUT_TAIL_CHARS;
  return truncatedLength > 0
    ? `[... truncated ${truncatedLength} chars ...]\n${stream.slice(-OUTPUT_TAIL_CHARS)}`
    : stream;
}

/** Renders a child failure with both output tails so CI shows the last startup step. */
export function formatCliProcessFailure(params: {
  reason: string;
  stdout: string;
  stderr: string;
}): string {
  return `${params.reason}\n--- child stderr (tail) ---\n${formatOutputTail(
    params.stderr,
  )}\n--- child stdout (tail) ---\n${formatOutputTail(params.stdout)}`;
}

/** Runs one CLI child to completion under {@link CLI_PROCESS_DEADLOCK_GUARD_MS}. */
export async function runCliProcessChild(params: {
  nodeArgs: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  input?: string;
  interact?: (child: ChildProcessWithoutNullStreams) => Promise<void> | void;
  onStdout?: (stdout: string) => void;
  timeoutMs?: number;
}): Promise<CliProcessChildResult> {
  const timeoutMs = params.timeoutMs ?? CLI_PROCESS_DEADLOCK_GUARD_MS;
  const child = spawn(process.execPath, params.nodeArgs, {
    cwd: params.cwd ?? path.resolve("."),
    env: params.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    params.onStdout?.(stdout);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  // Wait for stream EOF alongside exit: a respawning entrypoint hands its pipes
  // to a detached grandchild, and only EOF proves the command's output is complete.
  const closed = Promise.all([
    once(child, "exit"),
    once(child.stdout, "end"),
    once(child.stderr, "end"),
  ]).then(([[code, signal]]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
  }));
  const interaction = (async () => {
    if (params.interact) {
      await params.interact(child);
      return;
    }
    child.stdin.end(params.input);
  })();
  const completed = Promise.all([closed, interaction]).then(([exit]) => exit);
  let guard: NodeJS.Timeout | undefined;
  const exit = await Promise.race([
    completed,
    new Promise<never>((_, reject) => {
      guard = setTimeout(() => {
        child.kill("SIGKILL");
        // SIGKILL reaches the launcher only. A respawning entrypoint hands its stdio to a
        // detached grandchild in its own process group, which survives and keeps these pipes
        // open — enough to keep the Vitest worker alive long after this rejects. Release our
        // ends so the guard cannot leak a wedged worker; the orphan then dies on EPIPE, or is
        // reaped with the runner. Waiting for that tree instead would defeat a deadlock guard.
        child.stdout.destroy();
        child.stderr.destroy();
        reject(
          new Error(
            formatCliProcessFailure({
              reason: `CLI process did not exit before the ${timeoutMs}ms deadlock guard (SIGKILL sent; exitCode=${child.exitCode} signalCode=${child.signalCode})`,
              stderr,
              stdout,
            }),
          ),
        );
      }, timeoutMs);
      guard.unref();
    }),
  ])
    .catch((error: unknown) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      throw error;
    })
    .finally(() => {
      if (guard) {
        clearTimeout(guard);
      }
    });
  return { code: exit.code, signal: exit.signal, stdout, stderr };
}
