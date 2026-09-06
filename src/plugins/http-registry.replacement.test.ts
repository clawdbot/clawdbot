import { afterEach, describe, expect, it, vi } from "vitest";
import { findRegisteredPluginHttpRoute } from "../gateway/server/plugins-http/route-match.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createMockServerResponse } from "../test-utils/mock-http-response.js";
import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";
import {
  adoptPluginHttpRouteHandoffs,
  createPluginHttpRouteHandoff,
  registerPluginHttpRoute,
  withPluginHttpRouteRegistry,
} from "./http-registry.js";
import { createTrackedRouteLease } from "./http-registry.test-support.js";
import { PluginInstance } from "./plugin-instance.js";
import { projectPluginContributions } from "./registry-contributions.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { disposePluginRegistryInstances, resetPluginRuntimeStateForTest } from "./runtime.js";
import { createPluginRecord } from "./status.test-helpers.js";

const instances = new Set<PluginInstance>();

function createWebhookOwner() {
  const initial = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "webhook", enabled: true, status: "loaded" });
  initial.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry: initial });
  instances.add(instance);
  markPluginRegistryActive(initial);
  let current = initial;
  const prepare = () => {
    const next = createEmptyPluginRegistry();
    next.plugins.push(record);
    projectPluginContributions(current, record, next);
    return next;
  };
  const publish = (next: typeof initial) => {
    adoptPluginHttpRouteHandoffs(current, next);
    markPluginRegistryActive(next);
    markPluginRegistryRetired(current);
    current = next;
  };
  const register = (params: Partial<Parameters<typeof registerPluginHttpRoute>[0]> = {}) =>
    withPluginHttpRouteRegistry(initial, () =>
      instance.run(() =>
        registerPluginHttpRoute({
          path: "/webhook",
          pluginId: record.id,
          source: "webhook-account",
          auth: "plugin",
          handler: vi.fn(),
          throwOnFailure: true,
          ...params,
        }),
      ),
    );
  return { initial, instance, prepare, publish, register };
}

afterEach(async () => {
  await Promise.all([...instances].map((instance) => instance.dispose()));
  instances.clear();
});

describe("retained plugin HTTP ownership", () => {
  it.each([
    { pluginId: undefined, published: false },
    { pluginId: undefined, published: true },
    { pluginId: "webhook", published: false },
    { pluginId: "webhook", published: true },
  ])("preserves retry ingress across retained publication: %j", async ({ pluginId, published }) => {
    const owner = createWebhookOwner();
    const lease = createPluginRuntimeCapabilityLease("webhook account");
    const handoff = createPluginHttpRouteHandoff();
    try {
      withPluginHttpRouteRegistry(owner.initial, () => owner.register({ pluginId }), lease);
      const next = owner.prepare();
      if (published) {
        owner.publish(next);
      }
      handoff.park(lease);
      lease.revoke();
      if (!published) {
        owner.publish(next);
      }

      const route = findRegisteredPluginHttpRoute(next, "/webhook");
      expect(route).toBeDefined();
      const response = createMockServerResponse();
      await route!.handler(response.req, response);
      expect(response.statusCode).toBe(503);
      expect(response.getHeader("Retry-After")).toBe("1");
      const following = owner.prepare();
      owner.publish(following);
      expect(findRegisteredPluginHttpRoute(following, "/webhook")).toBe(route);
      const prepared = owner.prepare();
      expect(findRegisteredPluginHttpRoute(prepared, "/webhook")).toBe(route);
      handoff.release();
      expect(findRegisteredPluginHttpRoute(following, "/webhook")).toBeUndefined();
      expect(findRegisteredPluginHttpRoute(prepared, "/webhook")).toBeUndefined();
    } finally {
      lease.revoke();
      handoff.release();
    }
  });

  it("stops and restarts an unchanged webhook after another plugin reloads", () => {
    const owner = createWebhookOwner();
    const stop = owner.register();
    const next = owner.prepare();
    owner.publish(next);

    stop();
    expect(findRegisteredPluginHttpRoute(next, "/webhook")).toBeUndefined();
    owner.register();
    expect(findRegisteredPluginHttpRoute(next, "/webhook")).toBeDefined();
  });

  it("carries a channel stop and restart through an already prepared registry", () => {
    const owner = createWebhookOwner();
    const stop = owner.register();
    const next = owner.prepare();

    stop();
    expect(findRegisteredPluginHttpRoute(next, "/webhook")).toBeUndefined();
    owner.register({ path: "/restarted-webhook" });
    owner.publish(next);
    expect(findRegisteredPluginHttpRoute(next, "/webhook")).toBeUndefined();
    expect(findRegisteredPluginHttpRoute(next, "/restarted-webhook")).toBeDefined();
  });

  it("keeps a shared route until its last account releases every retained projection", () => {
    const owner = createWebhookOwner();
    const first = createPluginRuntimeCapabilityLease("first account");
    const second = createPluginRuntimeCapabilityLease("second account");
    try {
      withPluginHttpRouteRegistry(owner.initial, () => owner.register(), first);
      const published = owner.prepare();
      owner.publish(published);
      const staged = owner.prepare();
      withPluginHttpRouteRegistry(
        published,
        () => owner.register({ reuseExistingSameOwner: true }),
        second,
      );

      first.revoke();
      expect(findRegisteredPluginHttpRoute(published, "/webhook")).toBeDefined();
      expect(findRegisteredPluginHttpRoute(staged, "/webhook")).toBeDefined();
      second.revoke();
      expect(findRegisteredPluginHttpRoute(published, "/webhook")).toBeUndefined();
      expect(findRegisteredPluginHttpRoute(staged, "/webhook")).toBeUndefined();
    } finally {
      first.revoke();
      second.revoke();
    }
  });

  it("routes a retained startup continuation into its published owner", async () => {
    const owner = createWebhookOwner();
    const continuation = createDeferredCore();
    const startup = withPluginHttpRouteRegistry(owner.initial, () =>
      owner.instance.run(async () => {
        await continuation.promise;
        return registerPluginHttpRoute({
          path: "/late-webhook",
          pluginId: "webhook",
          auth: "plugin",
          handler: vi.fn(),
          throwOnFailure: true,
        });
      }),
    );
    const next = owner.prepare();
    owner.publish(next);
    continuation.resolve();
    const stop = await startup;

    expect(findRegisteredPluginHttpRoute(next, "/late-webhook")).toBeDefined();
    expect(findRegisteredPluginHttpRoute(owner.initial, "/late-webhook")).toBeUndefined();
    stop();
    expect(findRegisteredPluginHttpRoute(next, "/late-webhook")).toBeUndefined();
  });

  it("releases route reservations when an unpublished candidate is disposed", async () => {
    const owner = createWebhookOwner();
    const candidate = owner.prepare();
    registerPluginHttpRoute({
      registry: candidate,
      path: "/candidate-route",
      pluginId: "candidate-only",
      auth: "gateway",
      handler: vi.fn(),
    });
    await disposePluginRegistryInstances(candidate, owner.initial);

    expect(() => owner.register({ path: "/candidate-route" })).not.toThrow();
    expect(findRegisteredPluginHttpRoute(owner.initial, "/candidate-route")?.auth).toBe("plugin");
    expect(findRegisteredPluginHttpRoute(candidate, "/candidate-route")?.auth).toBe("gateway");
  });

  it("retains managed anonymous routes and their late startup registrations", async () => {
    const owner = createWebhookOwner();
    const stop = owner.register({ pluginId: undefined });
    const continuation = createDeferredCore();
    const startup = withPluginHttpRouteRegistry(owner.initial, () =>
      owner.instance.run(async () => {
        await continuation.promise;
        return registerPluginHttpRoute({
          path: "/late-anonymous",
          auth: "plugin",
          handler: vi.fn(),
          throwOnFailure: true,
        });
      }),
    );
    const next = owner.prepare();
    owner.publish(next);
    continuation.resolve();
    // Observe the continuation before assertions so a regression does not leak a rejected promise.
    const result = await startup.then(
      (cleanup) => ({ cleanup, error: undefined }),
      (error: unknown) => ({ cleanup: undefined, error }),
    );

    expect(findRegisteredPluginHttpRoute(next, "/webhook")).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(findRegisteredPluginHttpRoute(next, "/late-anonymous")).toBeDefined();
    expect(next.httpRoutes.every((route) => route.pluginId === undefined)).toBe(true);
    stop();
    result.cleanup?.();
    expect(next.httpRoutes).toEqual([]);
  });

  it("releases the former anonymous owner's staged routes on permitted replacement", () => {
    const owner = createWebhookOwner();
    const stopOld = owner.register({ pluginId: undefined });
    const otherRecord = createPluginRecord({ id: "other-owner", enabled: true, status: "loaded" });
    owner.initial.plugins.push(otherRecord);
    const other = new PluginInstance(otherRecord.id, {
      record: otherRecord,
      registry: owner.initial,
    });
    instances.add(other);
    // The candidate retains only the first owner; the replacement belongs to the other instance.
    const candidate = owner.prepare();
    expect(findRegisteredPluginHttpRoute(candidate, "/webhook")).toBeDefined();
    const stopReplacement = withPluginHttpRouteRegistry(owner.initial, () =>
      other.run(() =>
        registerPluginHttpRoute({
          path: "/webhook",
          auth: "plugin",
          source: "another-anonymous-source",
          handler: vi.fn(),
          replaceExisting: true,
          throwOnFailure: true,
        }),
      ),
    );
    const replacement = findRegisteredPluginHttpRoute(owner.initial, "/webhook");

    expect(replacement?.source).toBe("another-anonymous-source");
    expect(replacement?.pluginId).toBeUndefined();
    expect(findRegisteredPluginHttpRoute(candidate, "/webhook")).toBeUndefined();
    stopOld();
    expect(findRegisteredPluginHttpRoute(owner.initial, "/webhook")).toBe(replacement);
    stopReplacement();
    expect(owner.initial.httpRoutes).toEqual([]);
  });

  it("rejects a detached retired instance using the active replacement registry", async () => {
    const previous = createWebhookOwner();
    const current = createWebhookOwner();
    const stopCurrent = current.register({ pluginId: undefined, source: "current-owner" });
    const currentRoute = findRegisteredPluginHttpRoute(current.initial, "/webhook");
    const continuation = createDeferredCore();
    // Return an object so the original invocation ends before this native Promise callback runs.
    const detached = withPluginHttpRouteRegistry(previous.initial, () =>
      previous.instance.run(() => ({
        registration: continuation.promise.then(() =>
          registerPluginHttpRoute({
            registry: current.initial,
            path: "/webhook",
            auth: "plugin",
            source: "retired-owner",
            handler: vi.fn(),
            replaceExisting: true,
            throwOnFailure: true,
          }),
        ),
      })),
    );
    previous.publish(current.initial);
    await previous.instance.dispose();
    continuation.resolve();
    const error = await detached.registration.then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(current.initial.httpRoutes).toEqual([currentRoute]);
    expect(error).toMatchObject({ message: "plugin HTTP route owner is no longer active" });
    stopCurrent();
  });

  it("keeps cleanup exact across replacement and another staged generation", () => {
    const owner = createWebhookOwner();
    const stopOld = owner.register();
    const next = owner.prepare();
    owner.publish(next);
    const stopCurrent = owner.register({ replaceExisting: true });
    const replacement = findRegisteredPluginHttpRoute(next, "/webhook");
    const staged = owner.prepare();

    stopOld();
    expect(findRegisteredPluginHttpRoute(next, "/webhook")).toBe(replacement);
    expect(findRegisteredPluginHttpRoute(staged, "/webhook")).toBe(replacement);
    stopCurrent();
    expect(findRegisteredPluginHttpRoute(next, "/webhook")).toBeUndefined();
    expect(findRegisteredPluginHttpRoute(staged, "/webhook")).toBeUndefined();
  });
});

describe("plugin HTTP route handoffs", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("transfers retry ingress while retired holders release their leases", () => {
    const previous = createEmptyPluginRegistry();
    const next = createEmptyPluginRegistry();
    const retired = createTrackedRouteLease();
    const current = createTrackedRouteLease();
    const route = {
      path: "/plugins/handoff",
      auth: "plugin" as const,
      pluginId: "demo",
      source: "account",
    };
    const unregisterOld = withPluginHttpRouteRegistry(
      previous,
      () => registerPluginHttpRoute({ ...route, handler: vi.fn(), throwOnFailure: true }),
      retired.lease,
    );
    const handoff = createPluginHttpRouteHandoff();
    handoff.park(retired.lease);
    retired.revoke();
    expect(retired.cleanups.size).toBe(0);
    adoptPluginHttpRouteHandoffs(previous, next);
    expect(previous.httpRoutes).toHaveLength(0);
    expect(next.httpRoutes).toHaveLength(1);
    const handler = vi.fn();
    withPluginHttpRouteRegistry(
      next,
      () => registerPluginHttpRoute({ ...route, handler, throwOnFailure: true }),
      current.lease,
    );
    unregisterOld();
    handoff.release();
    expect(next.httpRoutes.map((entry) => entry.handler)).toEqual([handler]);
    current.revoke();
    expect(next.httpRoutes).toHaveLength(0);
    expect(current.cleanups.size).toBe(0);
  });

  it.each([{ pluginId: "other" }, { source: "other-account" }, { auth: "gateway" as const }])(
    "preserves retry ingress when a successor changes ownership: %j",
    (changed) => {
      const registry = createEmptyPluginRegistry();
      const retired = createTrackedRouteLease();
      const route = {
        path: "/plugins/handoff",
        auth: "plugin" as const,
        pluginId: "demo",
        source: "account",
      };
      withPluginHttpRouteRegistry(
        registry,
        () => registerPluginHttpRoute({ ...route, handler: vi.fn(), throwOnFailure: true }),
        retired.lease,
      );
      const handoff = createPluginHttpRouteHandoff();
      handoff.park(retired.lease);
      retired.revoke();
      const placeholder = registry.httpRoutes[0];
      expect(() =>
        registerPluginHttpRoute({
          ...route,
          ...changed,
          registry,
          handler: vi.fn(),
          throwOnFailure: true,
        }),
      ).toThrow();
      expect(registry.httpRoutes).toEqual([placeholder]);
      const next = createEmptyPluginRegistry();
      registerPluginHttpRoute({
        ...route,
        ...changed,
        registry: next,
        handler: vi.fn(),
        throwOnFailure: true,
      });
      expect(() => adoptPluginHttpRouteHandoffs(registry, next)).toThrow();
      expect(registry.httpRoutes).toEqual([placeholder]);
      handoff.release();
      expect(registry.httpRoutes).toHaveLength(0);
    },
  );

  it.each([false, true])(
    "keeps sibling handoffs across successor claims (registry swap: %s)",
    (swapRegistry) => {
      const registry = createEmptyPluginRegistry();
      const first = createTrackedRouteLease();
      const second = createTrackedRouteLease();
      const firstHandoff = createPluginHttpRouteHandoff();
      const secondHandoff = createPluginHttpRouteHandoff();
      const route = {
        path: "/plugins/shared",
        auth: "plugin" as const,
        pluginId: "demo",
        source: "shared",
      };
      for (const owner of [first, second]) {
        withPluginHttpRouteRegistry(
          registry,
          () =>
            registerPluginHttpRoute({
              ...route,
              handler: vi.fn(),
              reuseExistingSameOwner: true,
              throwOnFailure: true,
            }),
          owner.lease,
        );
      }
      firstHandoff.park(first.lease);
      first.revoke();
      secondHandoff.park(second.lease);
      second.revoke();
      expect(registry.httpRoutes.map((entry) => entry.handoff)).toEqual([true]);
      const next = swapRegistry ? createEmptyPluginRegistry() : registry;
      const handler = vi.fn();
      const unregister = registerPluginHttpRoute({
        ...route,
        registry: next,
        handler,
        throwOnFailure: true,
      });
      if (swapRegistry) {
        adoptPluginHttpRouteHandoffs(registry, next);
      }
      firstHandoff.release();
      expect(next.httpRoutes.map((entry) => entry.handler)).toEqual([handler]);
      unregister();
      expect(next.httpRoutes.map((entry) => entry.handoff)).toEqual([true]);
      const secondHandler = vi.fn();
      const unregisterSecond = registerPluginHttpRoute({
        ...route,
        registry: next,
        handler: secondHandler,
        throwOnFailure: true,
      });
      secondHandoff.release();
      expect(next.httpRoutes.map((entry) => entry.handler)).toEqual([secondHandler]);
      unregisterSecond();
      expect(next.httpRoutes).toHaveLength(0);
    },
  );
});
