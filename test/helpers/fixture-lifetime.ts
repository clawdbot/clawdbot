import fs from "node:fs";
import { makeTempDir } from "./temp-dir.js";

function hasUnjoinedWork(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if ("processTreeState" in value && value.processTreeState !== "terminated") {
    return true;
  }
  if (value instanceof AggregateError && value.errors.some(hasUnjoinedWork)) {
    return true;
  }
  return (
    ("cause" in value && hasUnjoinedWork(value.cause)) ||
    ("error" in value && hasUnjoinedWork(value.error))
  );
}

/** Own whole fixture bodies as well as commands that can outlive a failed assertion. */
export function createFixtureLifetime() {
  const roots = new Set<string>();
  let pendingCleanup: Promise<void> | undefined;
  const work: { completion: Promise<unknown>; cleanup: boolean }[] = [];

  function track<T>(completion: Promise<T>, cleanup = false): Promise<T> {
    work.push({ completion, cleanup });
    void completion.catch(() => {});
    return completion;
  }

  function run<T>(body: () => Promise<T>): Promise<T> {
    // Register before the callback's first await, and observe late rejection even
    // when Vitest has already rejected its separate timeout/cancellation promise.
    return track(Promise.resolve().then(body));
  }

  async function drain() {
    const failures: unknown[] = [];
    // Bodies can register their final command/cleanup while unwinding. Drain
    // those too; a rejected command alone does not certify process-group death.
    while (work.length) {
      const batch = work.splice(0);
      const results = await Promise.allSettled(batch.map((item) => item.completion));
      for (const [index, result] of results.entries()) {
        const value: unknown = result.status === "rejected" ? result.reason : result.value;
        if ((batch[index]!.cleanup && result.status === "rejected") || hasUnjoinedWork(value)) {
          failures.push(value);
        }
      }
    }
    if (failures.length) {
      const ownedRoots = [...roots];
      roots.clear();
      throw new AggregateError(
        failures,
        `Fixture cleanup unverified; retained ${ownedRoots.join(", ")}`,
      );
    }
    // Recursive removal can take seconds on Darwin. Keep sibling command deadlines,
    // output drainage, and reaping live while releasing these already-joined inputs.
    const removals = await Promise.allSettled(
      [...roots].map(async (root) => {
        await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
        roots.delete(root);
      }),
    );
    const errors = removals.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Test temporary directory cleanup failed");
    }
  }

  return {
    run,
    track,
    verifyCleanup: (body: () => Promise<void>) => {
      return track(Promise.resolve().then(body), true);
    },
    createTempDir: (prefix: string, root?: string) => {
      return makeTempDir(roots, prefix, root);
    },
    cleanup() {
      // Timeout teardown can meet an already requested drain. Both callers must
      // join that same work before either is allowed to remove its inputs.
      return (pendingCleanup ??= drain().finally(() => {
        pendingCleanup = undefined;
      }));
    },
  };
}
