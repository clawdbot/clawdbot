import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";

/** Promise-based sleep that clamps timer inputs through the shared timeout resolver. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, resolveTimerTimeoutMs(ms, 0, 0));
  });
}
