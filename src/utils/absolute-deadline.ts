import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";

export const ABSOLUTE_DEADLINE_EXPIRED = Symbol("absolute deadline expired");

/** Bounds one operation by an absolute wall-clock deadline. */
export async function awaitWithinDeadline<T>(
  operation: () => Promise<T>,
  deadlineAtMs: number | undefined,
): Promise<T | typeof ABSOLUTE_DEADLINE_EXPIRED> {
  if (deadlineAtMs === undefined) {
    return await operation();
  }
  if (Math.max(0, deadlineAtMs - Date.now()) === 0) {
    return ABSOLUTE_DEADLINE_EXPIRED;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Arm the timer before caller code can synchronously consume the budget;
    // timer callbacks alone cannot establish an absolute deadline.
    const deadline = new Promise<typeof ABSOLUTE_DEADLINE_EXPIRED>((resolve) => {
      // Node overflows long timer delays, so rearm against the real deadline.
      const waitForDeadline = () => {
        const remainingMs = Math.max(0, deadlineAtMs - Date.now());
        if (remainingMs === 0) {
          resolve(ABSOLUTE_DEADLINE_EXPIRED);
          return;
        }
        timer = setTimeout(waitForDeadline, Math.min(remainingMs, MAX_TIMER_TIMEOUT_MS));
      };
      waitForDeadline();
    });
    return await Promise.race([
      deadline,
      operation().then((result) =>
        Date.now() >= deadlineAtMs ? ABSOLUTE_DEADLINE_EXPIRED : result,
      ),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
