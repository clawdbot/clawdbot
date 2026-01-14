import type { CronServiceState } from "./state.js";

export async function locked<T>(
  state: CronServiceState,
  fn: () => Promise<T>,
): Promise<T> {
  const next = state.op.then(fn, fn);
  // Keep the chain alive even when the operation fails.
  state.op = next.then(
    () => undefined,
    () => undefined,
  );
  return (await next) as T;
}
