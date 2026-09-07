import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { withLegacyPluginSdkResourceScope } from "./legacy-sdk-resource-scope.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  createPluginRegistryResourceOwner,
  registerPluginRegistryResourceDisposer,
} from "./registry-resources.js";

it("joins foreign-realm promises before disposing a legacy SDK host", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE proof (value INTEGER)");
  const finish = createDeferredCore();
  let written = false;
  const work = finish.promise.then(() => {
    db.prepare("INSERT INTO proof VALUES (?)").run(1);
    written = true;
  });
  const thenable: unknown = runInNewContext("Promise.resolve(work)", { work });
  if (!isPromiseLike(thenable)) {
    throw new Error("foreign realm did not return a promise");
  }
  const callback = withLegacyPluginSdkResourceScope((resources, _retain, runInHost) => {
    const registry = createEmptyPluginRegistry();
    resources.adopt({ registry, ...createPluginRegistryResourceOwner(registry, "scoped") });
    registerPluginRegistryResourceDisposer(registry, "fixture", {
      id: "database",
      dispose: () => db.close(),
    });
    return () => runInHost(() => thenable);
  });
  const returned = callback();
  expect(returned).not.toBeInstanceOf(Promise);
  // Observe rejection immediately so a broken early-close implementation cannot
  // leave the deferred SQLite failure as an unhandled rejection during cleanup.
  const outcome = Promise.resolve(returned).then(
    () => undefined,
    (error: unknown) => error,
  );
  let closed = false;
  const close = drainGlobalSingletonLifecycleState("restart").then(() => {
    closed = true;
  });
  try {
    // An untracked thenable lets synchronous disposal finish before this next turn.
    await setImmediate();
    expect(closed).toBe(false);
    expect(db.isOpen).toBe(true);
    expect(() => callback()).toThrow("Legacy plugin SDK host is closed");
  } finally {
    finish.resolve();
    await close;
  }
  expect(await outcome).toBeUndefined();
  expect(written).toBe(true);
  expect(db.isOpen).toBe(false);
  expect(() => callback()).toThrow("Legacy plugin SDK host is closed");
});
