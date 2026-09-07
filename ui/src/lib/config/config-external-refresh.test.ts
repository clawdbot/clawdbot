// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import { loadConfig } from "./config-gateway-operations.ts";
import { nextRequestVersion } from "./config-state-model.ts";
import { createConfigCapabilityHarness, deferred } from "./config-test-harness.ts";

function snapshot(count: number): ConfigSnapshot {
  return {
    config: { count },
    raw: JSON.stringify({ count }),
    hash: `hash-${count}`,
    valid: true,
    issues: [],
  };
}

describe("external mutation config refresh", () => {
  it.each([
    { order: "mutation read first", failure: false },
    { order: "successor read first", failure: false },
    { order: "mutation read first", failure: true },
    { order: "successor read first", failure: true },
  ])(
    "uses the actual successor result with $order (failure: $failure)",
    async ({ order, failure }) => {
      const mutationRead = deferred<ConfigSnapshot>();
      const successorRead = deferred<ConfigSnapshot>();
      const mutationReadStarted = deferred<void>();
      let reads = 0;
      const request = vi.fn((method: string) => {
        if (method !== "config.get") {
          return Promise.resolve({ ok: true });
        }
        reads += 1;
        if (reads === 1) {
          return Promise.resolve(snapshot(1));
        }
        if (reads === 2) {
          mutationReadStarted.resolve();
          return mutationRead.promise;
        }
        if (reads === 3) {
          return successorRead.promise;
        }
        throw new Error(`Unexpected configuration read ${reads}`);
      });
      const { runtimeConfig } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      try {
        await runtimeConfig.ensureLoaded();
        const mutation = runtimeConfig.runExternalMutation((client) =>
          client.request("plugins.setEnabled", { pluginId: "test-plugin", enabled: true }),
        );
        await mutationReadStarted.promise;
        runtimeConfig.setRaw('{"count":9}');
        // The generation-triggered page refresh starts after the RPC and its own fresh read.
        const refresh = runtimeConfig.refresh();
        expect(reads).toBe(3);
        const finishSuccessor = () =>
          failure
            ? successorRead.reject(new Error("current refresh unavailable"))
            : successorRead.resolve(snapshot(3));
        if (order === "mutation read first") {
          mutationRead.resolve(snapshot(2));
          await mutationRead.promise;
          finishSuccessor();
        } else {
          finishSuccessor();
          await refresh;
          mutationRead.resolve(snapshot(2));
        }
        await refresh;
        await expect(mutation).resolves.toEqual({
          ok: true,
          value: { ok: true },
          refresh: failure ? { ok: false, error: "current refresh unavailable" } : { ok: true },
        });
        expect(runtimeConfig.state.configSnapshot?.hash).toBe(failure ? "hash-1" : "hash-3");
        expect(runtimeConfig.state.lastError).toBe(failure ? "current refresh unavailable" : null);
        expect(runtimeConfig.state.configRaw).toBe('{"count":9}');
        expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-1");
        expect(runtimeConfig.state.configFormDirty).toBe(true);
      } finally {
        runtimeConfig.dispose();
      }
    },
  );
  it.each(["write acknowledgement", "disconnect", "same-client reconnect", "dispose"] as const)(
    "ends a pending mutation refresh on %s without waiting for its transport reply",
    async (retirement) => {
      const pendingRead = deferred<ConfigSnapshot>();
      const readStarted = deferred<void>();
      let reads = 0;
      const request = vi.fn((method: string) => {
        if (method !== "config.get") {
          return Promise.resolve({ ok: true });
        }
        if (++reads === 1) {
          return Promise.resolve(snapshot(1));
        }
        if (reads === 3) {
          return Promise.resolve(snapshot(3));
        }
        readStarted.resolve();
        return pendingRead.promise;
      });
      const { runtimeConfig, publish } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      try {
        await runtimeConfig.ensureLoaded();
        const mutation = runtimeConfig.runExternalMutation((client) =>
          client.request("plugins.setEnabled", { pluginId: "test-plugin", enabled: true }),
        );
        await readStarted.promise;
        if (retirement === "write acknowledgement") {
          // Config write acknowledgements invalidate older reads without issuing a replacement.
          nextRequestVersion(runtimeConfig.state, "config");
        } else if (retirement === "disconnect" || retirement === "same-client reconnect") {
          publish(false);
          if (retirement === "same-client reconnect") {
            publish(true);
          }
        } else {
          runtimeConfig.dispose();
        }
        await expect(mutation).resolves.toEqual({
          ok: true,
          value: { ok: true },
          refresh: {
            ok: false,
            error:
              retirement === "write acknowledgement"
                ? "The configuration refresh was superseded by a configuration write."
                : "Connection changed before the configuration update was refreshed.",
          },
        });
        expect(reads).toBe(retirement === "same-client reconnect" ? 3 : 2);
        pendingRead.resolve(snapshot(99));
        await pendingRead.promise;
        expect(runtimeConfig.state.configSnapshot?.hash).toBe(
          retirement === "same-client reconnect" ? "hash-3" : "hash-1",
        );
      } finally {
        pendingRead.resolve(snapshot(99));
        runtimeConfig.dispose();
      }
    },
  );

  it("does not borrow a successor's apply outcome for reconnect draft recovery", async () => {
    const stale = deferred<ConfigSnapshot>();
    const request = vi.fn((method: string) => {
      if (method !== "config.get") {
        throw new Error(`Unexpected request ${method}`);
      }
      return request.mock.calls.length === 1 ? stale.promise : Promise.resolve(snapshot(2));
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    const captureDraft = vi.fn();
    try {
      const original = loadConfig(runtimeConfig.state, { beforeApplySnapshot: captureDraft });
      await expect(loadConfig(runtimeConfig.state)).resolves.toBe(true);
      stale.resolve(snapshot(1));
      await expect(original).resolves.toBe(false);
      expect(captureDraft).not.toHaveBeenCalled();
      expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");
    } finally {
      runtimeConfig.dispose();
    }
  });

  it("rechecks connection ownership after the pre-adoption recovery callback", async () => {
    const request = vi.fn(async () => snapshot(1));
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    try {
      await expect(
        loadConfig(runtimeConfig.state, { beforeApplySnapshot: () => publish(false) }),
      ).resolves.toBe(false);
      expect(runtimeConfig.state.configSnapshot).toBeNull();
    } finally {
      runtimeConfig.dispose();
    }
  });
  it("records a successor started synchronously by a loading-state subscriber", async () => {
    const staleRead = deferred<ConfigSnapshot>();
    let reads = 0;
    const request = vi.fn((method: string) => {
      if (method !== "config.get") {
        return Promise.resolve({ ok: true });
      }
      reads += 1;
      return reads === 2 ? staleRead.promise : Promise.resolve(snapshot(reads));
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    let successor: Promise<void> | undefined;
    let observe = false;
    const stop = runtimeConfig.subscribe((state) => {
      if (observe && state.configLoading) {
        observe = false;
        successor = runtimeConfig.refresh();
      }
    });
    try {
      await runtimeConfig.ensureLoaded();
      observe = true;
      const mutation = runtimeConfig.runExternalMutation((client) =>
        client.request("plugins.setEnabled", { pluginId: "test-plugin", enabled: true }),
      );
      await expect(mutation).resolves.toEqual({
        ok: true,
        value: { ok: true },
        refresh: { ok: true },
      });
      await successor;
      expect(reads).toBe(3);
      expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-3");
      staleRead.resolve(snapshot(2));
      await staleRead.promise;
      expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-3");
    } finally {
      staleRead.resolve(snapshot(2));
      stop();
      runtimeConfig.dispose();
    }
  });
});
