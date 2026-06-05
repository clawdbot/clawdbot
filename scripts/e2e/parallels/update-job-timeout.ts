// Update Job Timeout script supports OpenClaw repository automation.
interface TimedUpdateJobOptions {
  append(this: void, chunk: string): void;
  label: string;
  run(this: void, context: { signal: AbortSignal }): Promise<void> | void;
  timeoutDescription: string;
  timeoutMs: number;
  writeLog(this: void): Promise<void>;
}

export async function runTimedUpdateJob({
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
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      append(`${timeoutMessage}\n`);
      controller.abort(new Error(timeoutMessage));
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    await Promise.race([Promise.resolve(run({ signal: controller.signal })), timeoutPromise]);
    await writeLog();
    return timedOut ? 1 : 0;
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
