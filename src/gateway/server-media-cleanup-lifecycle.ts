import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type MediaCleanupStopResult = "drained" | "timed-out";
export const MEDIA_CLEANUP_STOP_TIMEOUT_MS = 5_000;

const mediaCleanupDrains = resolveGlobalSingleton(
  Symbol.for("openclaw.gateway.mediaCleanupDrains"),
  () => new Set<Promise<void>>(),
);

/** Tracks cleanup work until settlement so later gateway generations retain shared state. */
export function registerMediaCleanupDrain(drain: Promise<void>): void {
  mediaCleanupDrains.add(drain);
  void drain.finally(() => mediaCleanupDrains.delete(drain));
}

/** Defers a replacement cleanup owner until every prior gateway generation settles. */
export async function waitForMediaCleanupDrainsToSettle(): Promise<void> {
  while (mediaCleanupDrains.size > 0) {
    await Promise.allSettled(mediaCleanupDrains);
  }
}

/** Waits for every process-owned cleanup generation, bounded for restart availability. */
export async function waitForMediaCleanupDrains(params: {
  timeoutMs: number;
  onTimeout?: () => void;
}): Promise<MediaCleanupStopResult> {
  const drains = [...mediaCleanupDrains];
  if (drains.length === 0) {
    return "drained";
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timeout = setTimeout(() => resolve(true), params.timeoutMs);
    timeout.unref?.();
  });
  const result = await Promise.race([
    Promise.allSettled(drains).then(() => false as const),
    timedOut,
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  if (result) {
    params.onTimeout?.();
    return "timed-out";
  }
  return "drained";
}
