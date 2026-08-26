import { formatErrorMessage } from "./errors.js";

export type RequiredCleanupOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export async function captureRequiredCleanupOutcome<T>(
  operation: () => Promise<T>,
): Promise<RequiredCleanupOutcome<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function finishRequiredCleanup<T>(params: {
  outcome: RequiredCleanupOutcome<T>;
  cleanup: () => Promise<void>;
  afterCleanup?: () => Promise<void>;
  cleanupFailureMessage?: string;
  combinedFailureMessage: string;
}): Promise<T> {
  const cleanupOutcome = await captureRequiredCleanupOutcome(params.cleanup);
  if (!cleanupOutcome.ok) {
    const cleanupError = cleanupOutcome.error;
    const cleanupDetail = `Cleanup error: ${formatErrorMessage(cleanupError)}`;
    if (!params.outcome.ok) {
      throw new AggregateError(
        [params.outcome.error, cleanupError],
        `${params.combinedFailureMessage} ${cleanupDetail}`,
        { cause: params.outcome.error },
      );
    }
    throw new Error(
      `${params.cleanupFailureMessage ?? "Required cleanup failed."} ${cleanupDetail}`,
      {
        cause: cleanupError,
      },
    );
  }
  await params.afterCleanup?.();
  if (!params.outcome.ok) {
    throw params.outcome.error;
  }
  return params.outcome.value;
}
