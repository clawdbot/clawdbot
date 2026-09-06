import path from "node:path";
import { vi } from "vitest";
import * as fileLock from "../../src/infra/file-lock.js";
import { createDeferred } from "./promise.js";

/** Observe the real writer awaiting its held lock before changing external state. */
export async function withContendedConfigMutation<T>(
  configPath: string,
  mutate: () => Promise<T>,
  beforeRelease: () => Promise<void> | void,
): Promise<T> {
  const held = await fileLock.acquireFileLock(configPath, {
    retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
    stale: 30_000,
  });
  const requested = createDeferred();
  const original = fileLock.withFileLock;
  const observer = vi.spyOn(fileLock, "withFileLock").mockImplementation((target, options, run) => {
    if (path.resolve(target) === path.resolve(configPath)) {
      requested.resolve();
    }
    return original(target, options, run);
  });
  let released = false;
  let pending: Promise<T> | undefined;
  try {
    pending = mutate();
    await Promise.race([
      requested.promise,
      pending.then(() => {
        throw new Error("Mutation completed without waiting for its held config lock");
      }),
    ]);
    await beforeRelease();
    await held.release();
    released = true;
    return await pending;
  } finally {
    observer.mockRestore();
    if (!released) {
      await held.release();
    }
    await pending?.catch(() => undefined);
  }
}
