// Update Job Timeout script supports OpenClaw repository automation.
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";

interface TimedUpdateJobOptions {
  abortSettleMs?: number;
  append(this: void, chunk: string): void;
  label: string;
  run(this: void, context: { signal: AbortSignal }): Promise<void> | void;
  timeoutDescription: string;
  timeoutMs: number;
  writeLog(this: void): Promise<void>;
}

export async function runTimedUpdateJob({
  abortSettleMs = 2_500,
  append,
  label,
  run,
  timeoutDescription,
  timeoutMs,
  writeLog,
}: TimedUpdateJobOptions): Promise<number> {
  let timedOut = false;
  const controller = new AbortController();
  const timeoutMessage = `${label} update timed out after ${timeoutDescription}`;
  const resolvedAbortSettleMs = resolveTimerTimeoutMs(abortSettleMs, 0, 0);
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
  let timeout: NodeJS.Timeout | undefined;
  const runOutcome = Promise.resolve()
    .then(() => run({ signal: controller.signal }))
    .then(
      () => ({ status: "pass" as const }),
      (error: unknown) => ({ error, status: "fail" as const }),
    );
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      append(`${timeoutMessage}\n`);
      controller.abort(new Error(timeoutMessage));
      resolve("timeout");
    }, resolvedTimeoutMs);
  });

  try {
    const outcome = await Promise.race([runOutcome, timeoutPromise]);
    if (outcome === "timeout") {
      await waitForAbortSettle(runOutcome, resolvedAbortSettleMs);
      await writeLog();
      return 1;
    }
    if (outcome.status === "fail") {
      append(`${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}\n`);
      await writeLog();
      return 1;
    }
    await writeLog();
    return 0;
  } catch (error) {
    if (!timedOut) {
      append(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    await writeLog();
    return 1;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function waitForAbortSettle<T>(runOutcome: Promise<T>, ms: number): Promise<T | undefined> {
  return await new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    void runOutcome.then((outcome) => {
      clearTimeout(timeout);
      resolve(outcome);
    });
  });
}
