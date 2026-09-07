import { expect, it, vi } from "vitest";
import {
  abortable,
  joinWithRunLivenessDeadline,
} from "../agents/embedded-agent-runner/run/abortable.js";
import { runAgentCleanupStep } from "../agents/run-cleanup-timeout.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveProviderRuntimePluginHandle } from "./provider-hook-runtime.js";
import { resolveProviderUsageAuthWithPlugin } from "./provider-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  createPluginRegistryResourceOwner,
  PluginRegistryResourceScope,
  withPluginRegistryResourceScope,
  drainPluginRegistryResourceDisposals,
  registerPluginRegistryResourceDisposer,
} from "./registry-resources.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import type { ProviderPlugin } from "./types.js";

function createProviderResource(hooks: Partial<ProviderPlugin>) {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE value (text TEXT); INSERT INTO value VALUES ('retained')");
  const registry = createEmptyPluginRegistry();
  registry.providers.push({
    pluginId: "resource-fixture",
    source: "synthetic-fixture",
    provider: { id: "resource-fixture", label: "Resource fixture", auth: [], ...hooks },
  });
  const owner = createPluginRegistryResourceOwner(registry, "scoped");
  registerPluginRegistryResourceDisposer(registry, "resource-fixture", {
    id: "sqlite",
    dispose: () => db.close(),
  });
  return { db, registry, owner };
}

it.each([false, true])(
  "keeps an async provider resource through settlement (failure=%s)",
  async (fail) => {
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    const fixture = createProviderResource({
      resolveUsageAuth: async () => {
        entered.resolve();
        await finish.promise;
        const token = String(fixture.db.prepare("SELECT text FROM value").get()?.text);
        if (fail) {
          throw new Error("provider failed after its SQLite read");
        }
        return { token };
      },
    });
    const result = withPluginRuntimeRegistryScope(fixture.registry, () =>
      resolveProviderUsageAuthWithPlugin({
        provider: "resource-fixture",
        context: {
          config: {},
          env: {},
          provider: "resource-fixture",
          resolveApiKeyFromConfigAndStore: () => undefined,
          resolveOAuthToken: async () => null,
        },
      }),
    );
    const outcome = Promise.allSettled([result]);
    try {
      await entered.promise;
      fixture.owner.release();
      let drained = false;
      const drain = drainPluginRegistryResourceDisposals().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(fixture.db.isOpen).toBe(true);
      expect(drained).toBe(false);
      finish.resolve();
      if (fail) {
        await expect(result).rejects.toThrow("provider failed after its SQLite read");
      } else {
        await expect(result).resolves.toEqual({ token: "retained" });
      }
      await drain;
      expect(fixture.db.isOpen).toBe(false);
    } finally {
      fixture.owner.release();
      finish.resolve();
      await outcome;
      await drainPluginRegistryResourceDisposals();
    }
  },
);

it.each(["abort-before", "abort-during", "join-abort", "join-timeout", "cleanup-timeout"] as const)(
  "retains accepted work and late acquisitions across %s without admitting new work",
  async (kind) => {
    if (kind.endsWith("timeout")) {
      vi.useFakeTimers();
    }
    const first = createProviderResource({});
    const late = createProviderResource({
      normalizeModelId: () => String(late.db.prepare("SELECT text FROM value").get()?.text),
    });
    const resources = new PluginRegistryResourceScope();
    resources.retain(first.registry);
    first.owner.release();
    const entered = createDeferredCore();
    const continueWork = createDeferredCore();
    const acquiredLate = createDeferredCore<string>();
    const lateResult = Promise.allSettled([acquiredLate.promise]);
    const finish = createDeferredCore();
    const completed = createDeferredCore<string>();
    const outcome = completed.promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const controller = new AbortController();
    const work = async () => {
      entered.resolve();
      try {
        await continueWork.promise;
        const lateHandle = withPluginRuntimeRegistryScope(late.registry, () =>
          resolveProviderRuntimePluginHandle({ provider: "resource-fixture" }),
        );
        late.owner.release();
        const value =
          String(first.db.prepare("SELECT text FROM value").get()?.text) +
          lateHandle.plugin?.normalizeModelId?.({ provider: "resource-fixture", modelId: "input" });
        acquiredLate.resolve(value);
        await finish.promise;
        completed.resolve(value);
        return value;
      } catch (error) {
        acquiredLate.reject(error);
        completed.reject(error);
        return undefined;
      }
    };
    const visible = withPluginRegistryResourceScope(resources, () => {
      if (kind === "cleanup-timeout") {
        return runAgentCleanupStep({
          runId: "resource-fixture",
          sessionId: "resource-fixture",
          step: "provider-cleanup",
          cleanup: async () => {
            await work();
          },
          timeoutMs: 5,
          log: { warn: () => {} },
        });
      }
      if (kind.startsWith("join-")) {
        return joinWithRunLivenessDeadline({
          joinWork: async () => {
            await work();
          },
          runAbortSignal: controller.signal,
          timeoutMs: 5,
          onTimeout: () => {},
        });
      }
      const pending = work();
      if (kind === "abort-before") {
        controller.abort();
      }
      return abortable(controller.signal, pending);
    });
    const visibleResult = Promise.allSettled([visible]);
    try {
      await entered.promise;
      if (kind.endsWith("timeout")) {
        await vi.advanceTimersByTimeAsync(5);
      } else {
        controller.abort();
      }
      const [result] = await visibleResult;
      expect(result.status).toBe(kind.startsWith("abort-") ? "rejected" : "fulfilled");
      resources.release();
      expect(() => withPluginRegistryResourceScope(resources, () => undefined)).toThrow();
      continueWork.resolve();
      expect(await lateResult).toEqual([{ status: "fulfilled", value: "retainedretained" }]);
      expect(first.db.isOpen && late.db.isOpen).toBe(true);
      let drained = false;
      const drain = drainPluginRegistryResourceDisposals().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      finish.resolve();
      expect(await outcome).toEqual({ value: "retainedretained" });
      await drain;
      expect(first.db.isOpen || late.db.isOpen).toBe(false);
    } finally {
      continueWork.resolve();
      finish.resolve();
      resources.release();
      late.owner.release();
      await outcome;
      await drainPluginRegistryResourceDisposals();
      if (kind.endsWith("timeout")) {
        vi.useRealTimers();
      }
    }
  },
);
