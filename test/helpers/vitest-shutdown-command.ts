import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createBoundedChildOutput } from "./bounded-child-output.ts";

/** Capture fixture diagnostics without losing the managed cancellation outcome. */
export async function runVitestShutdownCommand({
  maxBytes = 2 * 1024 * 1024,
  signal,
  ...options
}: Pick<
  Parameters<typeof runManagedCommand>[0],
  "args" | "cwd" | "env" | "timeoutMs" | "onReady" | "signal"
> & { maxBytes?: number }) {
  const stdout = createBoundedChildOutput(maxBytes);
  const stderr = createBoundedChildOutput(maxBytes);
  const controller = new AbortController();
  let overflow: Error | undefined;
  try {
    const code = await runManagedCommand({
      ...options,
      bin: process.execPath,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      requireProcessTreeExit: process.platform !== "win32",
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      onReady(child) {
        for (const [pipe, output] of [
          [child.stdout, stdout],
          [child.stderr, stderr],
        ] as const) {
          let bytes = 0;
          pipe!.on("data", (chunk: Buffer) => {
            output.append(chunk);
            bytes += chunk.byteLength;
            if (bytes > maxBytes && !overflow) {
              overflow = Object.assign(
                new Error(`Shutdown fixture output exceeded ${maxBytes} bytes`),
                { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
              );
              controller.abort();
            }
          });
        }
        options.onReady?.(child);
      },
    });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  } catch (cause) {
    // Cleanup failures remain primary; overflowing output must not conceal live writers.
    const aborted = cause instanceof Error && "code" in cause && cause.code === "ABORT_ERR";
    const error = aborted && overflow ? overflow : cause;
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      stdout: stdout.text(),
      stderr: stderr.text(),
    });
  }
}
