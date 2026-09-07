/** Retention child: proves a disposed attempt lifecycle no longer holds its per-attempt AsyncLocalStorage in Node's global storageList. */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import {
  createEmbeddedAttemptTranscriptLifecycle,
  type LifecycleOwner,
} from "./attempt-transcript-lifecycle.js";

const gc = globalThis.gc as () => void;
assert.ok(globalThis.gc, "The retention child requires --expose-gc");

function runLifecycle(disposeAfter: boolean) {
  // Hold every store so the WeakRef below keeps observing each instance after the
  // lifecycle's own closure would otherwise have dropped it.
  const lifecycleStore = new AsyncLocalStorage<LifecycleOwner>();
  const lifecycle = createEmbeddedAttemptTranscriptLifecycle(
    { runId: "retention", sessionId: "retention" },
    { createLifecycleStore: () => lifecycleStore },
  );
  return Promise.resolve().then(async () => {
    await lifecycle.withTranscriptWrite(async () => {
      // Burn the store into the current async context exactly once so the
      // AsyncLocalStorage instance is entered into Node's global storageList.
      await Promise.resolve();
    });
    if (disposeAfter) {
      await lifecycle.dispose();
    }
    // Drop the lifecycle object itself; only the store reference remains in this child.
    return new WeakRef(lifecycleStore);
  });
}

async function countCollected(instances: WeakRef<AsyncLocalStorage<LifecycleOwner>>[]) {
  for (let pass = 0; pass < 8; pass += 1) {
    await setImmediate();
    gc();
  }
  return instances.filter((reference) => reference.deref() === undefined).length;
}

// A disposed lifecycle must let its per-attempt store be collected.
const disposed = await Promise.all(Array.from({ length: 40 }, () => runLifecycle(true)));
// A never-disposed lifecycle leaks its store into storageList for the process lifetime.
const leaked = await Promise.all(Array.from({ length: 40 }, () => runLifecycle(false)));

const collectedDisposed = await countCollected(disposed);
const collectedLeaked = await countCollected(leaked);

// Sanity: with --expose-gc the control path actually collects.
assert.ok(
  collectedDisposed >= 30,
  `disposed stores must be collectable, collected=${collectedDisposed}/40`,
);
assert.ok(
  collectedLeaked <= 5,
  `leaked stores should remain retained, collected=${collectedLeaked}/40`,
);

console.log(
  `retention ok: disposed collected=${collectedDisposed}/40 leaked collected=${collectedLeaked}/40`,
);
