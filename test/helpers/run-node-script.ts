import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createBoundedChildOutput } from "./bounded-child-output.js";

export async function runNodeScript(
  scriptPathOrArgs: string | string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number | undefined,
  {
    cwd,
    signal,
    maxBuffer,
    requireProcessTreeExit,
    onReady,
  }: {
    cwd?: string;
    signal?: AbortSignal;
    maxBuffer?: number;
    requireProcessTreeExit?: boolean;
    onReady?: Parameters<typeof runManagedCommand>[0]["onReady"];
  } = {},
) {
  const stdout = createBoundedChildOutput(maxBuffer);
  const stderr = createBoundedChildOutput(maxBuffer);
  const overflow = new AbortController();
  const commandSignal = signal ? AbortSignal.any([signal, overflow.signal]) : overflow.signal;
  let status: number | null = null;
  let error: unknown;
  try {
    status = await runManagedCommand({
      bin: process.execPath,
      args: typeof scriptPathOrArgs === "string" ? [scriptPathOrArgs] : scriptPathOrArgs,
      cwd,
      env,
      timeoutMs,
      signal: commandSignal,
      requireProcessTreeExit,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      onReady(child) {
        for (const [name, pipe, output] of [
          ["stdout", child.stdout!, stdout],
          ["stderr", child.stderr!, stderr],
        ] as const) {
          let bytes = 0;
          pipe.on("data", (chunk: Buffer) => {
            output.append(chunk);
            bytes += chunk.byteLength;
            if (maxBuffer !== undefined && bytes > maxBuffer && !overflow.signal.aborted) {
              error = Object.assign(new Error(`${name} maxBuffer length exceeded`), {
                code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
              });
              overflow.abort(error);
            }
          });
        }
        onReady?.(child);
      },
    });
  } catch (cause) {
    // Overflow is a failure, not silent tail capture. Keep cleanup uncertainty
    // alongside it so fixture lifetime cannot mistake failed joining for safety.
    if (!error) {
      error = cause;
    } else if (!(cause instanceof Error && "code" in cause && cause.code === "ABORT_ERR")) {
      error = new AggregateError([error, cause], "Node script failed", { cause });
    }
  }
  return { error, status, stderr: stderr.text(), stdout: stdout.text() };
}
