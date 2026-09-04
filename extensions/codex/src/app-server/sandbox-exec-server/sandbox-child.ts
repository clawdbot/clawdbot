/** Owns one sandbox subprocess tree through close, reaping, and backend finalization. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { killProcessTree } from "openclaw/plugin-sdk/process-runtime";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";

const SANDBOX_CHILD_TERM_GRACE_MS = 1_000;
// Covers the post-TERM tree kill plus Windows taskkill completion before failure is reported.
const SANDBOX_CHILD_REAP_TIMEOUT_MS = 4_500;

type SandboxChildOutcome = { exitCode: number; signal: NodeJS.Signals | null };

export type SandboxChildOwner = {
  process: ChildProcessWithoutNullStreams;
  settled: Promise<SandboxChildOutcome>;
  terminate: () => Promise<SandboxChildOutcome>;
};

export async function spawnSandboxChild(params: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  finalizeExec?: NonNullable<SandboxContext["backend"]>["finalizeExec"];
  finalizeToken?: unknown;
  finalizeStatus: (outcome: SandboxChildOutcome) => "completed" | "failed";
  onFinalizeError: (error: unknown) => void;
  owners: Set<SandboxChildOwner>;
  terminateRemote?: () => Promise<void>;
}): Promise<SandboxChildOwner> {
  const [command, ...args] = params.argv;
  const finalize = async (status: "completed" | "failed", exitCode: number | null) =>
    await params.finalizeExec?.({
      status,
      exitCode,
      timedOut: false,
      token: params.finalizeToken,
    });
  if (!command) {
    await finalize("failed", null).catch(params.onFinalizeError);
    throw new Error("OpenClaw sandbox exec spec did not provide a command.");
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, args, {
      detached: process.platform !== "win32",
      env: params.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    await finalize("failed", null).catch(params.onFinalizeError);
    throw error;
  }

  let outcome: SandboxChildOutcome | undefined;
  const closed = new Promise<SandboxChildOutcome>((resolve) => {
    child.once("close", (code, signal) => resolve((outcome = { exitCode: code ?? 1, signal })));
  });
  let finalizePromise: Promise<void> | undefined;
  let terminationCleanup: Promise<void> | undefined;
  let terminationError: Error | undefined;
  const settled = closed.then(async (result) => {
    await terminationCleanup;
    child.stdin.destroy();
    await (finalizePromise ??= finalize(params.finalizeStatus(result), result.exitCode));
    return result;
  });
  void settled.catch(params.onFinalizeError);

  let terminationPromise: Promise<SandboxChildOutcome> | undefined;
  const owner: SandboxChildOwner = {
    process: child,
    settled,
    terminate: () =>
      (terminationPromise ??= (async () => {
        child.stdin.destroy();
        terminationCleanup = params.terminateRemote?.().catch((error: unknown) => {
          terminationError = error instanceof Error ? error : new Error(String(error));
        });
        await terminationCleanup;
        if (!outcome) {
          if (child.pid) {
            killProcessTree(child.pid, {
              detached: process.platform !== "win32",
              graceMs: SANDBOX_CHILD_TERM_GRACE_MS,
            });
          } else {
            child.kill("SIGTERM");
          }
          const reaped = await Promise.race([
            closed.then(() => true),
            delay(SANDBOX_CHILD_REAP_TIMEOUT_MS).then(() => false),
          ]);
          if (!reaped) {
            throw new Error(
              `Sandbox child process tree ${child.pid ?? "unknown"} survived SIGKILL; tear down the sandbox environment and inspect the surviving process tree before retrying.`,
            );
          }
        }
        const result = await settled;
        if (terminationError) {
          throw terminationError;
        }
        return result;
      })()),
  };
  params.owners.add(owner);
  void settled.then(
    () => params.owners.delete(owner),
    () => params.owners.delete(owner),
  );
  return owner;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
