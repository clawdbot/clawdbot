import { setImmediate } from "node:timers/promises";

declare const Bun: { gc(force: boolean): void };

export async function collectGarbageForTest(collectInNode: () => void): Promise<void> {
  // WeakRef targets stay alive for the current job, even without a strong owner.
  await setImmediate();
  if (process.versions.bun) {
    Bun.gc(true);
  } else {
    collectInNode();
  }
}
