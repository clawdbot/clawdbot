// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  deferred,
  createConfigCapabilityHarness,
} from "./config-test-harness.ts";

describe("config external mutations", () => {
  it("serializes external mutations after scheduled drafts and refreshes before resolving", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let storedConfig: Record<string, unknown> = { count: 1 };
    let hash = "hash-1";
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        order.push("config.get");
        return {
          config: storedConfig,
          raw: JSON.stringify(storedConfig),
          hash,
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        order.push("config.set");
        storedConfig = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
        hash = "hash-2";
        return { hash };
      }
      if (method === "plugins.setEnabled") {
        order.push("plugins.setEnabled");
        storedConfig = { ...storedConfig, pluginEnabled: true };
        hash = "hash-3";
        return { ok: true };
      }
      return {};
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    order.length = 0;

    runtimeConfig.patchForm(["count"], 2);
    const result = await runtimeConfig.runExternalMutation((client) =>
      client.request("plugins.setEnabled", { pluginId: "memory-core", enabled: true }),
    );

    expect(result).toEqual({
      ok: true,
      value: { ok: true },
      refresh: { ok: true },
    });
    expect(order).toEqual(["config.set", "plugins.setEnabled", "config.get"]);
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-3");
    expect(runtimeConfig.state.configForm).toEqual({ count: 2, pluginEnabled: true });
    runtimeConfig.dispose();
  });

  it("rechecks external mutation access after pending config writes settle", async () => {
    vi.useFakeTimers();
    const firstSet = deferred<unknown>();
    const methods: string[] = [];
    let canDispatch = true;
    const request = vi.fn((method: string) => {
      methods.push(method);
      if (method === "config.get") {
        return Promise.resolve({
          config: { count: 1 },
          raw: '{"count":1}',
          hash: "hash-1",
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set") {
        return firstSet.promise;
      }
      return Promise.resolve({ ok: true });
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    methods.length = 0;

    runtimeConfig.patchForm(["count"], 2);
    const result = runtimeConfig.runExternalMutation(
      (client) => client.request("agents.update", { agentId: "main", name: "Agent Smith" }),
      {
        canDispatch: () => canDispatch,
        dispatchError: "Access changed before the agent identity update started.",
      },
    );
    await vi.waitFor(() => expect(methods).toEqual(["config.set"]));
    canDispatch = false;
    firstSet.resolve({ hash: "hash-2" });

    await expect(result).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      error: "Access changed before the agent identity update started.",
    });
    expect(methods).toEqual(["config.set"]);
    runtimeConfig.dispose();
  });

  it("forces a post-mutation refresh instead of joining a pre-existing config load", async () => {
    const staleLoad = deferred<ConfigSnapshot>();
    let getCalls = 0;
    let storedConfig: Record<string, unknown> = { count: 1 };
    let hash = "hash-1";
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        getCalls += 1;
        if (getCalls === 2) {
          return staleLoad.promise;
        }
        return {
          config: storedConfig,
          raw: JSON.stringify(storedConfig),
          hash,
          valid: true,
          issues: [],
        };
      }
      if (method === "plugins.setEnabled") {
        storedConfig = { count: 1, pluginEnabled: true };
        hash = "hash-2";
        return { ok: true };
      }
      return {};
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    const overlappingRefresh = runtimeConfig.refresh();
    await vi.waitFor(() => expect(getCalls).toBe(2));
    const result = await runtimeConfig.runExternalMutation((client) =>
      client.request("plugins.setEnabled", { pluginId: "memory-core", enabled: true }),
    );

    expect(result.ok).toBe(true);
    expect(getCalls).toBe(3);
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");
    expect(runtimeConfig.state.configForm).toEqual({ count: 1, pluginEnabled: true });

    staleLoad.resolve({
      config: { count: 999 },
      raw: '{"count":999}',
      hash: "stale-hash",
      valid: true,
      issues: [],
    });
    await overlappingRefresh;
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");
    runtimeConfig.dispose();
  });

  it.each([
    { latestCompleted: true, latestFails: false },
    { latestCompleted: false, latestFails: false },
    { latestCompleted: true, latestFails: true },
    { latestCompleted: false, latestFails: true },
  ])(
    "uses the newer refresh after a mutation (completed=$latestCompleted, fails=$latestFails)",
    async ({ latestCompleted, latestFails }) => {
      vi.useFakeTimers();
      const mutationRead = deferred<ConfigSnapshot>();
      const latestRead = deferred<ConfigSnapshot>();
      const mutationReadStarted = deferred<void>();
      const snapshot = (count: number): ConfigSnapshot => ({
        config: { count },
        raw: JSON.stringify({ count }),
        hash: `hash-${count}`,
        valid: true,
        issues: [],
      });
      let getCalls = 0;
      const request = vi.fn((method: string) => {
        if (method === "config.get") {
          getCalls += 1;
          if (getCalls === 2) {
            mutationReadStarted.resolve();
            return mutationRead.promise;
          }
          return getCalls === 3 ? latestRead.promise : Promise.resolve(snapshot(1));
        }
        return Promise.resolve({ ok: true });
      });
      const { runtimeConfig } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      try {
        await runtimeConfig.ensureLoaded();
        let mutationSettled = false;
        const mutation = runtimeConfig
          .runExternalMutation((client) =>
            client.request("plugins.reload", { pluginId: "fixture" }),
          )
          .then((result) => {
            mutationSettled = true;
            return result;
          });
        await mutationReadStarted.promise;
        // config.changed starts an independent read after the mutation's own refresh.
        const refresh = runtimeConfig.refresh();
        const rawDraft = '{\n  "count": 7\n}\n';
        runtimeConfig.setRaw(rawDraft);
        const settleLatest = () =>
          latestFails
            ? latestRead.reject(new Error("latest refresh unavailable"))
            : latestRead.resolve(snapshot(2));
        if (latestCompleted) {
          settleLatest();
          await refresh;
        }
        mutationRead.resolve(snapshot(999));
        let settledBeforeLatest: boolean | undefined;
        if (!latestCompleted) {
          await vi.advanceTimersByTimeAsync(0);
          settledBeforeLatest = mutationSettled;
          settleLatest();
        }
        await refresh;
        await expect(mutation).resolves.toEqual({
          ok: true,
          value: { ok: true },
          refresh: latestFails ? { ok: false, error: "latest refresh unavailable" } : { ok: true },
        });
        if (!latestCompleted) {
          expect(settledBeforeLatest).toBe(false);
        }
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "config.get",
          "plugins.reload",
          "config.get",
          "config.get",
        ]);
        expect(runtimeConfig.state.configSnapshot).toEqual(snapshot(latestFails ? 1 : 2));
        expect(runtimeConfig.state.configRaw).toBe(rawDraft);
        expect(runtimeConfig.state.configFormMode).toBe("raw");
        expect(runtimeConfig.state.configFormDirty).toBe(true);
        expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-1");
      } finally {
        runtimeConfig.dispose();
      }
    },
  );

  it("preserves a committed external mutation when its authoritative refresh fails", async () => {
    let getCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        getCalls += 1;
        if (getCalls === 1) {
          return {
            config: { count: 1 },
            raw: '{"count":1}',
            hash: "hash-1",
            valid: true,
            issues: [],
          };
        }
        throw new Error("refresh unavailable");
      }
      if (method === "plugins.setEnabled") {
        return { ok: true };
      }
      return {};
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    const result = await runtimeConfig.runExternalMutation((client) =>
      client.request("plugins.setEnabled", { pluginId: "memory-core", enabled: true }),
    );

    expect(result).toEqual({
      ok: true,
      value: { ok: true },
      refresh: { ok: false, error: "refresh unavailable" },
    });
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-1");
    runtimeConfig.dispose();
  });

  it("distinguishes definitive external mutation rejections from transient errors", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return {
          config: { count: 1 },
          raw: '{"count":1}',
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      return {};
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    await expect(
      runtimeConfig.runExternalMutation(async () => {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "invalid config",
        });
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "rejected",
      error: "invalid config",
    });
    await expect(
      runtimeConfig.runExternalMutation(async () => {
        throw new Error("socket closed");
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "error",
      error: "socket closed",
    });
    runtimeConfig.dispose();
  });

  it("queues background external mutations until write suspension ends", async () => {
    const methods: string[] = [];
    const request = vi.fn(async (method: string) => {
      methods.push(method);
      if (method === "config.get") {
        return {
          config: { count: 1 },
          raw: '{"count":1}',
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      return { ok: true };
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    methods.length = 0;
    runtimeConfig.setWritesSuspended(true);

    const resultPromise = runtimeConfig.runExternalMutation(
      (client) => client.request("config.patch", { raw: '{"ui":{"prefs":{"locale":"de"}}}' }),
      { waitForWritesResumed: true },
    );
    await Promise.resolve();
    expect(methods).toEqual([]);

    runtimeConfig.setWritesSuspended(false);
    await expect(resultPromise).resolves.toEqual({
      ok: true,
      value: { ok: true },
      refresh: { ok: true },
    });
    expect(methods).toEqual(["config.patch", "config.get"]);
    runtimeConfig.dispose();
  });

  it("preserves queued mutation waiters when suspension is repeated", async () => {
    const methods: string[] = [];
    const request = vi.fn(async (method: string) => {
      methods.push(method);
      if (method === "config.get") {
        return {
          config: { count: 1 },
          raw: '{"count":1}',
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      return { ok: true };
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    methods.length = 0;
    runtimeConfig.setWritesSuspended(true);

    const resultPromise = runtimeConfig.runExternalMutation(
      (client) => client.request("config.patch", { raw: '{"ui":{"prefs":{"locale":"de"}}}' }),
      { waitForWritesResumed: true },
    );
    await Promise.resolve();
    runtimeConfig.setWritesSuspended(true);
    runtimeConfig.setWritesSuspended(false);

    await expect(resultPromise).resolves.toEqual({
      ok: true,
      value: { ok: true },
      refresh: { ok: true },
    });
    expect(methods).toEqual(["config.patch", "config.get"]);
    runtimeConfig.dispose();
  });

  it("retries a background mutation when suspension begins during its write drain", async () => {
    vi.useFakeTimers();
    const firstSet = deferred<unknown>();
    const methods: string[] = [];
    const request = vi.fn((method: string) => {
      methods.push(method);
      if (method === "config.get") {
        return Promise.resolve({
          config: { count: 1 },
          raw: '{"count":1}',
          hash: methods.filter((entry) => entry === "config.set").length ? "hash-2" : "hash-1",
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set") {
        return firstSet.promise;
      }
      return Promise.resolve({ ok: true });
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    methods.length = 0;

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    const resultPromise = runtimeConfig.runExternalMutation(
      (client) => client.request("config.patch", { raw: '{"ui":{"prefs":{"locale":"de"}}}' }),
      { waitForWritesResumed: true },
    );
    runtimeConfig.setWritesSuspended(true);
    firstSet.resolve({ hash: "hash-2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(methods).toEqual(["config.set"]);

    runtimeConfig.setWritesSuspended(false);
    await expect(resultPromise).resolves.toEqual({
      ok: true,
      value: { ok: true },
      refresh: { ok: true },
    });
    expect(methods).toEqual(["config.set", "config.patch", "config.get"]);
    runtimeConfig.dispose();
  });
});
