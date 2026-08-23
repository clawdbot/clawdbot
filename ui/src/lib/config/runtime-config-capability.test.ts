// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  deferred,
  createGatewayHarness,
  createConfigServerMock,
  createDeferredSetServerMock,
  createConfigCapabilityHarness,
} from "./config-test-harness.ts";
import { createRuntimeConfigCapability } from "./runtime-config-capability.ts";

describe("runtime config capability", () => {
  it("does not stage a default agent after access downgrades", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return {
          sourceConfig: {
            agents: {
              entries: {
                main: {},
                reviewer: { default: true },
              },
            },
          },
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      return { hash: "hash-2" };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    await runtimeConfig.ensureLoaded();

    publish(true, client, {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["config.get", "config.set"] },
    } as GatewayHelloOk);

    expect(runtimeConfig.stageDefaultAgent("main")).toBe(false);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configForm).toEqual({
      agents: { entries: { main: {}, reviewer: { default: true } } },
    });
    runtimeConfig.dispose();
  });

  it.each([
    {
      label: "read-only same-client reconnect",
      replaceClient: false,
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["config.get", "config.schema"] },
      } as GatewayHelloOk,
    },
    { label: "client replacement", replaceClient: true, hello: undefined },
  ])("refreshes config and schema after a $label", async ({ replaceClient, hello }) => {
    let snapshot = {
      config: { endpoint: "initial" },
      hash: "hash-initial",
      valid: true,
      issues: [],
    };
    let schema = {
      schema: { type: "object" },
      uiHints: {},
      version: "schema-initial",
      generatedAt: "2026-08-15T00:00:00.000Z",
    };
    const requestA = vi.fn(async (method: string) =>
      method === "config.get" ? snapshot : method === "config.schema" ? schema : {},
    );
    const requestB = vi.fn(async (method: string) =>
      method === "config.get" ? snapshot : method === "config.schema" ? schema : {},
    );
    const clientA = { request: requestA } as unknown as GatewayBrowserClient;
    const clientB = { request: requestB } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(clientA);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    if (hello) {
      publish(true, clientA, hello);
    }
    await runtimeConfig.ensureLoaded();
    await runtimeConfig.ensureSchemaLoaded();

    snapshot = {
      config: { endpoint: "current" },
      hash: "hash-current",
      valid: true,
      issues: [],
    };
    schema = { ...schema, version: "schema-current" };
    publish(false, clientA);
    publish(true, replaceClient ? clientB : clientA, hello);

    await vi.waitFor(() => expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-current"));
    expect(runtimeConfig.state.configForm).toEqual({ endpoint: "current" });
    expect(runtimeConfig.state.configSchemaVersion).toBe("schema-current");
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(requestB).not.toHaveBeenCalledWith("config.set", expect.anything());
    if (replaceClient) {
      expect(requestA.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(1);
      expect(requestB).toHaveBeenCalledWith("config.get", {});
      expect(requestB).toHaveBeenCalledWith("config.schema", {});
    } else {
      expect(requestA.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(2);
      expect(requestA).toHaveBeenCalledWith("config.schema", {});
    }
    runtimeConfig.dispose();
  });

  it.each([
    {
      label: "replacement without config.schema",
      replaceClient: true,
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.admin", "operator.read"] },
        features: { methods: ["config.get"] },
      } as GatewayHelloOk,
    },
  ])("refreshes config but skips schema after a $label", async ({ replaceClient, hello }) => {
    let current = false;
    const createRequest = () =>
      vi.fn(async (method: string) => {
        if (method === "config.get") {
          return {
            config: { endpoint: current ? "current" : "initial" },
            hash: current ? "hash-current" : "hash-initial",
            valid: true,
            issues: [],
          };
        }
        return method === "config.schema"
          ? { schema: {}, uiHints: {}, version: "schema-initial", generatedAt: "" }
          : {};
      });
    const requestA = createRequest();
    const requestB = createRequest();
    const clientA = { request: requestA } as unknown as GatewayBrowserClient;
    const clientB = { request: requestB } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(clientA);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    await runtimeConfig.ensureLoaded();
    await runtimeConfig.ensureSchemaLoaded();

    current = true;
    publish(false, clientA);
    publish(true, replaceClient ? clientB : clientA, hello);

    await vi.waitFor(() => expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-current"));
    expect(runtimeConfig.state.configForm).toEqual({ endpoint: "current" });
    expect(runtimeConfig.state.configSchemaVersion).toBe("schema-initial");
    expect(runtimeConfig.state.lastError).toBeNull();
    const activeRequest = replaceClient ? requestB : requestA;
    expect(activeRequest.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(
      replaceClient ? 1 : 2,
    );
    expect(activeRequest.mock.calls.filter(([method]) => method === "config.schema")).toHaveLength(
      replaceClient ? 0 : 1,
    );
    runtimeConfig.dispose();
  });

  it("ignores a save completion from an earlier connection epoch", async () => {
    const save = deferred<unknown>();
    let getCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "config.get") {
        getCount += 1;
        return Promise.resolve({
          config: { value: getCount },
          hash: `hash-${getCount}`,
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set") {
        return save.promise;
      }
      return Promise.resolve({});
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["value"], 2);

    const staleSave = runtimeConfig.save();
    publish(false);
    publish(true);
    save.resolve({});

    await expect(staleSave).resolves.toBe(false);
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configSaving).toBe(false);
    runtimeConfig.dispose();
  });

  it("does not auto-save a dirty draft after reconnecting with read-only access", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const client = { request: server.request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);

    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 2);
    publish(true, client, {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["config.get", "config.set"] },
    } as GatewayHelloOk);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    expect(server.submissions).toHaveLength(0);
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    runtimeConfig.dispose();
  });

  it("rechecks operator access after the original-config parser settles", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const client = { request: server.request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    const originalParse = deferred<void>();

    await runtimeConfig.ensureLoaded();
    runtimeConfig.state.configRawOriginalParsePending = originalParse.promise;
    runtimeConfig.patchForm(["count"], 2);
    const timerAdvance = vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    await Promise.resolve();
    publish(true, client, {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["config.get", "config.set"] },
    } as GatewayHelloOk);
    originalParse.resolve();
    await timerAdvance;

    expect(server.submissions).toHaveLength(0);
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    runtimeConfig.dispose();
  });

  it("refreshes until a hot-reloaded revision becomes active", async () => {
    vi.useFakeTimers();
    let getCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "config.get") {
        return {};
      }
      getCount += 1;
      return {
        config: { count: 2 },
        raw: '{"count":2}',
        hash: "raw-hash-2",
        configRevisionHash: "revision-2",
        appliedConfigHash: getCount >= 2 ? "revision-2" : "revision-1",
        valid: true,
        issues: [],
      };
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    expect(runtimeConfig.state.configNeedsApply).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(runtimeConfig.state.configNeedsApply).toBe(false);
    runtimeConfig.dispose();
  });

  it("continues mismatch polling after a transient config.get failure", async () => {
    vi.useFakeTimers();
    let getCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "config.get") {
        return {};
      }
      getCount += 1;
      if (getCount === 2) {
        throw new Error("gateway restarting");
      }
      return {
        config: { count: 2 },
        raw: '{"count":2}',
        hash: "raw-hash-2",
        configRevisionHash: "revision-2",
        appliedConfigHash: getCount >= 3 ? "revision-2" : "revision-1",
        valid: true,
        issues: [],
      };
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    await vi.advanceTimersByTimeAsync(250);
    expect(runtimeConfig.state.configNeedsApply).toBe(true);
    await vi.advanceTimersByTimeAsync(750);
    expect(runtimeConfig.state.configNeedsApply).toBe(false);
    runtimeConfig.dispose();
  });

  it("discards an applied-hash poll superseded by a config write", async () => {
    vi.useFakeTimers();
    const stalePoll = deferred<ConfigSnapshot>();
    let getCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "config.get") {
        getCount += 1;
        if (getCount === 2) {
          return stalePoll.promise;
        }
        return Promise.resolve({
          config: { count: 1 },
          raw: '{\n  "count": 1\n}\n',
          hash: "hash-1",
          configRevisionHash: "revision-1",
          appliedConfigHash: "revision-0",
          valid: true,
          issues: [],
        });
      }
      return Promise.resolve(method === "config.set" ? { hash: "hash-2" } : {});
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    await vi.advanceTimersByTimeAsync(250);
    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");

    stalePoll.resolve({
      config: { count: 1 },
      raw: '{\n  "count": 1\n}\n',
      hash: "hash-1",
      configRevisionHash: "revision-1",
      appliedConfigHash: "revision-1",
      valid: true,
      issues: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");
    expect(runtimeConfig.state.configNeedsApply).toBe(true);
    runtimeConfig.dispose();
  });

  it("does not re-arm an invalidated applied-hash poll during config.patch", async () => {
    vi.useFakeTimers();
    const stalePoll = deferred<ConfigSnapshot>();
    const patchGate = deferred<unknown>();
    let getCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "config.get") {
        getCount += 1;
        if (getCount === 2) {
          return stalePoll.promise;
        }
        return Promise.resolve({
          config: { count: 1 },
          raw: '{\n  "count": 1\n}\n',
          hash: "hash-1",
          configRevisionHash: "revision-1",
          appliedConfigHash: "revision-0",
          valid: true,
          issues: [],
        });
      }
      if (method === "config.patch") {
        return patchGate.promise;
      }
      return Promise.resolve({});
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    await vi.advanceTimersByTimeAsync(250);
    const patchPromise = runtimeConfig.patch({ raw: { count: 2 }, note: "test patch" });
    await vi.advanceTimersByTimeAsync(0);

    stalePoll.resolve({
      config: { count: 1 },
      raw: '{\n  "count": 1\n}\n',
      hash: "hash-1",
      configRevisionHash: "revision-1",
      appliedConfigHash: "revision-1",
      valid: true,
      issues: [],
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(getCount).toBe(2);
    patchGate.resolve({ hash: "hash-2" });
    await vi.advanceTimersByTimeAsync(0);
    await expect(patchPromise).resolves.toBe(true);
    runtimeConfig.dispose();
  });

  it("keeps a stranded dirty draft unsaved until an explicit save after replacement", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const replacementClient = {
      request: server.request,
    } as unknown as GatewayBrowserClient;
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    publish(false);
    // The disconnect cancelled the debounce; nothing fires while offline.
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 3);
    expect(server.submissions).toHaveLength(0);
    expect(runtimeConfig.state.configFormDirty).toBe(true);

    publish(true, replacementClient);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(server.submissions).toHaveLength(0);
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    // The latch must be operator-visible: without a rendered state the form
    // looks normal while every subsequent edit silently never saves.
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("paused");

    // Further edits do not clear the latch state.
    runtimeConfig.patchForm(["count"], 3);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(server.submissions).toHaveLength(0);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("paused");

    await expect(runtimeConfig.save()).resolves.toBe(true);
    expect(server.submissions).toEqual([
      { method: "config.set", raw: '{\n  "count": 3\n}\n', baseHash: "hash-1" },
    ]);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configNeedsApply).toBe(true);
    // Explicit save rebinds the draft and clears the paused indicator.
    expect(runtimeConfig.state.configAutoSaveStatus).not.toBe("paused");
    runtimeConfig.dispose();
  });

  it("flushes a dirty draft once on dispose instead of dropping it", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    runtimeConfig.dispose();
    // The teardown flush leaves synchronously; no timer needs to fire.
    expect(server.submissions).toEqual([
      { method: "config.set", raw: '{\n  "count": 2\n}\n', baseHash: "hash-1" },
    ]);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 4);
    expect(server.submissions).toHaveLength(1);
  });

  it("does not flush clean or raw drafts on dispose", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.setRaw('{\n  "count": 5\n}\n');
    runtimeConfig.dispose();
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(server.submissions).toHaveLength(0);
  });

  it("chains one final save when disposed mid-flight with a newer edit", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    runtimeConfig.patchForm(["count"], 3);
    runtimeConfig.dispose();
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);

    // The newer draft lands once, based on the flight's ack hash.
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual({ raw: '{\n  "count": 3\n}\n', baseHash: "hash-2" });
  });

  it("does not chain an extra save when disposed mid-flight without newer edits", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    runtimeConfig.dispose();
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    expect(submissions).toHaveLength(1);
  });

  it("classifies an external mutation interrupted by disconnect as retryable", async () => {
    const mutation = deferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "config.get") {
        return Promise.resolve({
          config: { count: 1 },
          raw: '{"count":1}',
          hash: "hash-1",
          valid: true,
          issues: [],
        });
      }
      if (method === "plugins.setEnabled") {
        return mutation.promise;
      }
      return Promise.resolve({});
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    const resultPromise = runtimeConfig.runExternalMutation((client) =>
      client.request("plugins.setEnabled", { pluginId: "memory-core", enabled: true }),
    );
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("plugins.setEnabled", expect.anything()),
    );
    publish(false);
    mutation.reject(new Error("socket closed"));

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      error: "Connection changed before the configuration update completed.",
    });
    runtimeConfig.dispose();
  });

  it("does not retarget a suspended external mutation after the gateway changes", async () => {
    const requestA = vi.fn(async (method: string) => {
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
    const requestB = vi.fn(async (_method: string) => ({ ok: true }));
    const clientA = { request: requestA } as unknown as GatewayBrowserClient;
    const clientB = { request: requestB } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(clientA);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    await runtimeConfig.ensureLoaded();
    requestA.mockClear();
    runtimeConfig.setWritesSuspended(true);

    const resultPromise = runtimeConfig.runExternalMutation(
      (client) => client.request("config.patch", { raw: '{"ui":{"prefs":{"locale":"de"}}}' }),
      { waitForWritesResumed: true },
    );
    await Promise.resolve();
    publish(true, clientB);
    runtimeConfig.setWritesSuspended(false);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      error: "Connection changed before the configuration update started.",
    });
    expect(requestA).not.toHaveBeenCalled();
    expect(requestB.mock.calls.map(([method]) => method)).toEqual(["config.get"]);
    expect(requestB).not.toHaveBeenCalledWith("config.patch", expect.anything());
    runtimeConfig.dispose();
  });

  it("reconciles an uncertain in-flight save without autosaving its trailing draft", async () => {
    vi.useFakeTimers();
    let committedRaw = '{\n  "count": 1\n}\n';
    let hash = "hash-1";
    const sets: Array<{ raw: string; baseHash: string }> = [];
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "config.get") {
        return Promise.resolve({
          config: JSON.parse(committedRaw) as Record<string, unknown>,
          raw: committedRaw,
          hash,
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set") {
        sets.push(params as { raw: string; baseHash: string });
        if (sets.length === 1) {
          // The server commits the first save, but the connection dies
          // before the acknowledgement arrives.
          committedRaw = (params as { raw: string }).raw;
          hash = "hash-2";
          return new Promise(() => {});
        }
        committedRaw = (params as { raw: string }).raw;
        hash = "hash-3";
        return Promise.resolve({ hash });
      }
      return Promise.resolve({});
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(sets).toHaveLength(1);

    // Edit again mid-flight, then drop the connection before the ack lands.
    runtimeConfig.patchForm(["count"], 3);
    publish(false);
    publish(true);
    // Reconnect fetches the authoritative snapshot; the fresh bytes match the
    // interrupted submission, so the surviving draft is rebased onto the
    // committed hash without sending it through the replacement connection.
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    expect(sets).toHaveLength(1);
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-2");

    await expect(runtimeConfig.save()).resolves.toBe(true);
    expect(sets).toHaveLength(2);
    expect(sets[1]).toEqual({ raw: '{\n  "count": 3\n}\n', baseHash: "hash-2" });
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    runtimeConfig.dispose();
  });

  it("lets a reconnected explicit op bypass a dead prior-connection FIFO", async () => {
    const deadSet = deferred<unknown>();
    const methods: string[] = [];
    const request = vi.fn((method: string) => {
      methods.push(method);
      if (method === "config.get") {
        return Promise.resolve({ config: { count: 1 }, hash: "hash-1", valid: true, issues: [] });
      }
      if (method === "config.set") {
        return deadSet.promise;
      }
      return Promise.resolve({});
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    void runtimeConfig.save();
    void runtimeConfig.apply();
    await vi.waitFor(() => expect(methods).toContain("config.set"));
    publish(false);
    publish(true);

    await expect(
      runtimeConfig.patch({ raw: { ui: { prefs: { themeMode: "dark" } } }, note: "test" }),
    ).resolves.toBe(true);
    expect(methods).toContain("config.patch");
    expect(methods).not.toContain("config.apply");
    runtimeConfig.dispose();
  });

  it("does not dispatch an explicit op enqueued before reconnect", async () => {
    const firstPatch = deferred<unknown>();
    let patchCalls = 0;
    let setCalls = 0;
    const request = vi.fn((method: string) => {
      if (method === "config.get") {
        return Promise.resolve({ config: { count: 1 }, hash: "hash-1", valid: true, issues: [] });
      }
      if (method === "config.patch") {
        patchCalls += 1;
        return firstPatch.promise;
      }
      if (method === "config.set") {
        setCalls += 1;
      }
      return Promise.resolve({});
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    const stalePatch = runtimeConfig.patch({ raw: { ui: { prefs: {} } }, note: "test" });
    const staleSet = runtimeConfig.save();
    await vi.waitFor(() => expect(patchCalls).toBe(1));
    publish(false);
    publish(true);
    firstPatch.resolve({});

    await expect(stalePatch).resolves.toBe(false);
    await expect(staleSet).resolves.toBe(false);
    expect(setCalls).toBe(0);
    runtimeConfig.dispose();
  });

  it("rechecks operator access before a queued config write dispatches", async () => {
    const firstPatch = deferred<unknown>();
    let patchCalls = 0;
    let setCalls = 0;
    const request = vi.fn((method: string) => {
      if (method === "config.get") {
        return Promise.resolve({ config: { count: 1 }, hash: "hash-1", valid: true, issues: [] });
      }
      if (method === "config.patch") {
        patchCalls += 1;
        return firstPatch.promise;
      }
      if (method === "config.set") {
        setCalls += 1;
      }
      return Promise.resolve({});
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    const patch = runtimeConfig.patch({ raw: { ui: { prefs: {} } }, note: "test" });
    const save = runtimeConfig.save();
    await vi.waitFor(() => expect(patchCalls).toBe(1));
    publish(true, undefined, {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["config.get", "config.patch", "config.set"] },
    } as GatewayHelloOk);
    firstPatch.resolve({});

    await patch;
    await expect(save).resolves.toBe(false);
    expect(setCalls).toBe(0);
    expect(runtimeConfig.canSet).toBe(false);
    runtimeConfig.dispose();
  });

  it.each(["save", "patch"] as const)(
    "rechecks the caller lifecycle before a queued config %s dispatches",
    async (action) => {
      const firstPatch = deferred<unknown>();
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
        if (method === "config.patch" && methods.filter((entry) => entry === method).length === 1) {
          return firstPatch.promise;
        }
        return Promise.resolve({});
      });
      const { runtimeConfig } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      await runtimeConfig.ensureLoaded();
      methods.length = 0;

      const activePatch = runtimeConfig.patch({ raw: { count: 2 }, note: "active" });
      const queued =
        action === "save"
          ? runtimeConfig.save({ canDispatch: () => canDispatch })
          : runtimeConfig.patch({
              raw: { count: 3 },
              note: "queued",
              canDispatch: () => canDispatch,
            });
      await vi.waitFor(() => expect(methods).toEqual(["config.patch"]));
      canDispatch = false;
      firstPatch.resolve({ config: { count: 2 }, hash: "hash-2" });

      await expect(activePatch).resolves.toBe(true);
      await expect(queued).resolves.toBe(false);
      expect(methods).toEqual(["config.patch"]);
      runtimeConfig.dispose();
    },
  );

  it.each([
    { action: "save" as const, method: "config.set" },
    { action: "apply" as const, method: "config.apply" },
  ])("rechecks operator access after parsing before $method dispatch", async ({ action }) => {
    const server = createConfigServerMock();
    const client = { request: server.request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    const originalParse = deferred<void>();

    await runtimeConfig.ensureLoaded();
    runtimeConfig.state.configRawOriginalParsePending = originalParse.promise;
    const result = runtimeConfig[action]();
    await Promise.resolve();
    publish(true, client, {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["config.get", "config.apply", "config.set"] },
    } as GatewayHelloOk);
    originalParse.resolve();

    await expect(result).resolves.toBe(false);
    expect(server.submissions).toHaveLength(0);
    runtimeConfig.dispose();
  });

  it("frees write drains when a disconnect orphans a hung request", async () => {
    vi.useFakeTimers();
    const request = vi.fn((method: string) => {
      if (method === "config.get") {
        return Promise.resolve({
          config: { count: 1 },
          raw: '{\n  "count": 1\n}\n',
          hash: "hash-1",
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set") {
        // The connection dies before this ever settles.
        return new Promise(() => {});
      }
      return Promise.resolve({});
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    let drained = false;
    const drainPromise = runtimeConfig.waitForPendingWrites().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);

    // Disconnect deregisters the hung flight; a drain already awaiting it
    // (e.g. the app updater barrier) must resume instead of wedging forever.
    publish(false);
    await drainPromise;
    expect(drained).toBe(true);
    runtimeConfig.dispose();
  });

  it("recovers a manual save whose ack was lost to a disconnect", async () => {
    vi.useFakeTimers();
    let committedRaw = '{\n  "count": 1\n}\n';
    let hash = "hash-1";
    const sets: Array<{ raw: string; baseHash: string }> = [];
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "config.get") {
        return Promise.resolve({
          config: JSON.parse(committedRaw) as Record<string, unknown>,
          raw: committedRaw,
          hash,
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set") {
        sets.push(params as { raw: string; baseHash: string });
        if (sets.length === 1) {
          // Commits server-side, but the response never arrives.
          committedRaw = (params as { raw: string }).raw;
          hash = "hash-2";
          return new Promise(() => {});
        }
        hash = "hash-3";
        return Promise.resolve({ hash });
      }
      return Promise.resolve({});
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    void runtimeConfig.save();
    await vi.advanceTimersByTimeAsync(0);
    expect(sets).toHaveLength(1);

    publish(false);
    publish(true);
    await vi.advanceTimersByTimeAsync(0);

    // The reconnect reload recognizes the committed bytes as ours even
    // though the ack (and its manualFlightInfo hash) never arrived: the
    // process-local pending state survives instead of silently disappearing.
    expect(runtimeConfig.state.configNeedsApply).toBe(true);

    // The matching committed bytes leave no draft to retry on the replacement.
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(sets).toHaveLength(1);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    runtimeConfig.dispose();
  });

  it("retries reconciliation on the next reconnect when the reload fails", async () => {
    vi.useFakeTimers();
    let committedRaw = '{\n  "count": 1\n}\n';
    let hash = "hash-1";
    let failNextGet = false;
    const sets: Array<{ raw: string; baseHash: string }> = [];
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "config.get") {
        if (failNextGet) {
          failNextGet = false;
          return Promise.reject(new Error("gateway hiccup"));
        }
        return Promise.resolve({
          config: JSON.parse(committedRaw) as Record<string, unknown>,
          raw: committedRaw,
          hash,
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set") {
        sets.push(params as { raw: string; baseHash: string });
        if (sets.length === 1) {
          committedRaw = (params as { raw: string }).raw;
          hash = "hash-2";
          return new Promise(() => {});
        }
        hash = "hash-3";
        return Promise.resolve({ hash });
      }
      return Promise.resolve({});
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(sets).toHaveLength(1);

    // First reconnect's reconciliation reload fails; the interruption
    // metadata must survive so the NEXT reconnect completes it instead of
    // silently taking the plain path with a stale base.
    failNextGet = true;
    publish(false);
    publish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(runtimeConfig.state.configNeedsApply).toBe(false);

    publish(false);
    publish(true);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    expect(runtimeConfig.state.configNeedsApply).toBe(true);
    expect(sets).toHaveLength(1);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    runtimeConfig.dispose();
  });

  it("restores a revert made while the interrupted write was in flight", async () => {
    vi.useFakeTimers();
    let committedRaw = '{\n  "count": 1\n}\n';
    let hash = "hash-1";
    const sets: Array<{ raw: string; baseHash: string }> = [];
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "config.get") {
        return Promise.resolve({
          config: JSON.parse(committedRaw) as Record<string, unknown>,
          raw: committedRaw,
          hash,
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set") {
        sets.push(params as { raw: string; baseHash: string });
        if (sets.length === 1) {
          // Commits server-side; the ack is lost to the disconnect.
          committedRaw = (params as { raw: string }).raw;
          hash = "hash-2";
          return new Promise(() => {});
        }
        committedRaw = (params as { raw: string }).raw;
        hash = "hash-3";
        return Promise.resolve({ hash });
      }
      return Promise.resolve({});
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(sets).toHaveLength(1);

    // Revert to the original while the save is in flight: the draft reads
    // clean, so a plain reconnect reload would silently replace it with the
    // committed bytes and drop the revert forever.
    runtimeConfig.patchForm(["count"], 1);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    publish(false);
    publish(true);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    expect(sets).toHaveLength(1);
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-2");
    expect(runtimeConfig.state.configForm).toEqual({ count: 1 });

    await expect(runtimeConfig.save()).resolves.toBe(true);
    expect(sets).toHaveLength(2);
    expect(sets[1]).toEqual({ raw: '{\n  "count": 1\n}\n', baseHash: "hash-2" });
    expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    runtimeConfig.dispose();
  });

  it("keeps the conflict status through an offline discard", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return {
          config: { count: 1 },
          raw: '{\n  "count": 1\n}\n',
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        throw new Error("config changed since last load; re-run config.get and retry");
      }
      return {};
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");

    // Offline discard resets the draft locally but must not pretend the
    // stale snapshot was reconciled; only a connected reload clears conflict.
    publish(false);
    await runtimeConfig.discardDraft();
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configRaw).toBe('{\n  "count": 1\n}\n');
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
    runtimeConfig.dispose();
  });
});
