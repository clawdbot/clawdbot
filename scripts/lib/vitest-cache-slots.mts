import { createHash } from "node:crypto";
import path from "node:path";
import type { VitestCacheAssignment } from "../test-projects.test-support.mts";

type CacheSpec = {
  config: string;
  env: NodeJS.ProcessEnv;
  watchMode: boolean;
  cacheAssignment?: VitestCacheAssignment;
};

/** A slot remains borrowed through retries and the process owner's final join. */
export function createVitestCacheSlots(concurrency: number, platform = process.platform) {
  const available = Array.from({ length: concurrency }, (_, index) => index);
  let nextSlot = concurrency;
  return async <T extends CacheSpec, R extends { groupJoined: boolean }>(
    spec: T,
    run: (assigned: T) => Promise<R>,
  ): Promise<R> => {
    if (
      concurrency <= 1 ||
      platform === "win32" ||
      spec.watchMode ||
      spec.cacheAssignment?.kind !== "scheduler"
    ) {
      return run(spec);
    }
    const slot = available.pop() ?? nextSlot++;
    const configKey = createHash("sha256").update(path.resolve(spec.config)).digest("hex");
    const result = await run({
      ...spec,
      cacheAssignment: { ...spec.cacheAssignment, leased: true },
      env: {
        ...spec.env,
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(
          spec.cacheAssignment.root,
          "slots",
          String(slot),
          configKey,
        ),
      },
    });
    // A rejection or child-only completion leaves this slot retired.
    if (result.groupJoined) {
      available.push(slot);
    }
    return result;
  };
}
