import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";

// Failed disposal must permanently close its host; keep that host out of other suites.
const singletons = vi.hoisted(() => ({
  values: new Map<symbol, unknown>(),
  resets: new Map<symbol, () => void | Promise<void>>(),
}));
vi.mock("../shared/global-singleton.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/global-singleton.js")>()),
  resolveGlobalSingleton<T>(
    key: symbol,
    create: () => T,
    reset?: (value: T) => void | Promise<void>,
  ): T {
    if (!singletons.values.has(key)) {
      singletons.values.set(key, create());
    }
    const value = singletons.values.get(key) as T;
    if (reset) {
      singletons.resets.set(key, () => reset(value));
    }
    return value;
  },
}));

import { withLegacyPluginSdkResourceScope } from "./legacy-sdk-resource-scope.js";

it("keeps admission closed after asynchronous release fails, including repeated resets", async () => {
  const pendingRelease = createDeferredCore();
  const release = vi.fn(() => pendingRelease.promise);
  withLegacyPluginSdkResourceScope((_resources, retain) => retain({ release }));
  const reset = singletons.resets.get(Symbol.for("openclaw.legacyPluginSdkRegistryResourceHost"));
  if (!reset) {
    throw new Error("Legacy host did not register lifecycle cleanup");
  }
  const closing = Promise.resolve(reset());
  const overlappingClose = Promise.resolve(reset());
  const failure = expect(closing).rejects.toThrow("resource release failed");
  const overlappingFailure = expect(overlappingClose).rejects.toThrow("resource release failed");
  try {
    expect(() => withLegacyPluginSdkResourceScope(() => "new callback")).toThrow("host is closed");
    pendingRelease.reject(new Error("synthetic disposal failure"));
    await Promise.all([failure, overlappingFailure]);
    expect(release).toHaveBeenCalledOnce();
    expect(() => withLegacyPluginSdkResourceScope(() => "new callback")).toThrow("host is closed");
    await expect(Promise.resolve(reset())).rejects.toThrow("resource release failed");
    expect(release).toHaveBeenCalledOnce();
    expect(() => withLegacyPluginSdkResourceScope(() => "new callback")).toThrow("host is closed");
  } finally {
    pendingRelease.resolve();
    await Promise.allSettled([closing, overlappingClose]);
  }
});
