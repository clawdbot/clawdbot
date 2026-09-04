import { spawn } from "node:child_process";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { formatErrorMessage } from "../infra/errors.js";

type NativeStopDisposition = "accepted" | "refused" | "uncertain";

// The shell waits for a separate authorization line. EOF cancels before exec;
// preparing its script cannot issue a native stop. exec preserves the owned PID.
const STOP_EXECUTOR_SCRIPT =
  'printf "%s\\n" "$$"; IFS= read -r action && [ "$action" = stop ] && exec "$@"';

/** A non-exiting executor, optionally placed outside the service's kill cgroup. */
export async function prepareHostedStopExecutor(params: {
  command: string[];
  scopeArgs?: string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  assertCurrent: () => void;
  verifyPlacement?: (pid: number) => Promise<void>;
}) {
  params.assertCurrent();
  params.signal.throwIfAborted();
  // systemd versions differ on argv dollar expansion. Send the quoted command
  // and handshake over stdin so neither old nor new managers can rewrite them.
  const script = `set -- ${params.command.map(quoteCliArg).join(" ")}; ${STOP_EXECUTOR_SCRIPT}\n`;
  const command = params.scopeArgs ? "systemd-run" : "/bin/sh";
  const args = params.scopeArgs ? [...params.scopeArgs, "/bin/sh"] : [];
  // A native group stop must reach the Gateway before it kills this client.
  // Detached creates a separate process group; the private pipe and close join
  // still keep the executor owned, with no unref or unattended continuation.
  const child = spawn(command, args, {
    env: params.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let diagnostic = "";
  let committed = false;
  let disposed = false;
  let ready = false;
  let resolveReady: (pid: number) => void;
  let rejectReady: (error: Error) => void;
  const readiness = new Promise<number>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveResult: (result: { disposition: NativeStopDisposition; detail: string }) => void;
  const result = new Promise<{ disposition: NativeStopDisposition; detail: string }>((resolve) => {
    resolveResult = resolve;
  });
  const closed = result.then(() => {});
  let timeout: ReturnType<typeof setTimeout>;
  const dispose = () => {
    if (disposed) {
      return closed;
    }
    disposed = true;
    clearTimeout(timeout);
    params.signal.removeEventListener("abort", cancel);
    child.stdin.end();
    // Kill only this owned executor, then join close (including its stdio).
    // A cancelled command is uncertain even if it happened to exit successfully.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    return closed;
  };
  const cancel = () => {
    void dispose();
  };
  params.signal.addEventListener("abort", cancel, { once: true });
  child.stdin.on("error", (error) => {
    diagnostic = formatErrorMessage(error);
    cancel();
  });
  child.stderr.on("data", (data: Buffer) => {
    diagnostic = (diagnostic + data.toString()).slice(-1000);
  });
  child.stdout.on("data", (data: Buffer) => {
    if (ready) {
      return;
    }
    output += data.toString();
    if (output.length > 128) {
      rejectReady(new Error("Native stop executor returned invalid readiness"));
      cancel();
      return;
    }
    if (output.endsWith("\n")) {
      if (!/^[1-9]\d*\n$/.test(output) || Number(output.trim()) !== child.pid) {
        rejectReady(new Error("Native stop executor returned invalid readiness"));
        cancel();
        return;
      }
      ready = true;
      clearTimeout(timeout);
      resolveReady(Number(output.trim()));
    }
  });
  child.once("error", (error) => {
    diagnostic = formatErrorMessage(error);
    rejectReady(new Error(`Native stop executor unavailable: ${diagnostic}`));
  });
  child.once("close", (code, signal) => {
    clearTimeout(timeout);
    params.signal.removeEventListener("abort", cancel);
    rejectReady(new Error(`Native stop executor unavailable: ${diagnostic || "closed"}`));
    resolveResult({
      disposition:
        !disposed && committed && code === 0 && !signal
          ? "accepted"
          : !disposed && committed && typeof code === "number" && !signal
            ? "refused"
            : "uncertain",
      detail: diagnostic,
    });
  });
  timeout = setTimeout(() => {
    rejectReady(new Error("Native stop executor preparation timed out"));
    cancel();
  }, 5_000);
  try {
    child.stdin.write(script);
    const pid = await readiness;
    params.signal.throwIfAborted();
    params.assertCurrent();
    await params.verifyPlacement?.(pid);
    params.signal.throwIfAborted();
    params.assertCurrent();
    return {
      dispose,
      execute(assertCurrent: () => void) {
        assertCurrent();
        params.signal.throwIfAborted();
        if (committed) {
          throw new Error("Native stop executor is no longer available");
        }
        if (disposed || child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve({
            disposition: "refused" as const,
            detail: "Native executor closed before stop was requested",
          });
        }
        committed = true;
        child.stdin.write("stop\n");
        timeout = setTimeout(cancel, 5_000);
        return result;
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
