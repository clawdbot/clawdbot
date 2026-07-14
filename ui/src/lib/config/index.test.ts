// Control UI tests cover config behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSchemaResponse, ConfigSnapshot } from "../../api/types.ts";
import { createRuntimeConfigCapability, findAgentConfigEntryIndex } from "./index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createGatewayHarness(client: GatewayBrowserClient) {
  let snapshot = { client, connected: true, sessionKey: "main" };
  const listeners = new Set<(next: typeof snapshot) => void>();
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    publish: (connected: boolean) => {
      snapshot = { client, connected, sessionKey: "main" };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRuntimeConfigCapability", () => {
  it("preserves a dirty draft and its original base hash across refreshes", async () => {
    let getCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "config.get") {
        return {};
      }
      getCount += 1;
      return getCount === 1
        ? { config: { count: 1 }, hash: "hash-1", valid: true, issues: [], raw: '{"count":1}' }
        : { config: { count: 3 }, hash: "hash-2", valid: true, issues: [], raw: '{"count":3}' };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);

    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 2);
    await runtimeConfig.refresh();

    expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-1");
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");

    await runtimeConfig.refresh({ discardPendingChanges: true });
    expect(runtimeConfig.state.configForm).toEqual({ count: 3 });
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-2");
    runtimeConfig.dispose();
  });

  it("serializes schema-coerced form values with the draft base hash", async () => {
    const submitted: Array<{ method: string; params: unknown }> = [];
    let configGetCount = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        configGetCount += 1;
        return {
          config: configGetCount === 1 ? { count: 1, enabled: false, tags: [1], label: "ok" } : {},
          hash: configGetCount === 1 ? "hash-1" : "hash-2",
          valid: true,
          issues: [],
        };
      }
      if (method === "config.schema") {
        return {
          schema: {
            type: "object",
            properties: {
              count: { type: "number" },
              enabled: { type: "boolean" },
              tags: { type: "array", items: { type: "integer" } },
              label: { type: "string", minLength: 1 },
            },
          },
          uiHints: {},
        };
      }
      submitted.push({ method, params });
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);

    await Promise.all([runtimeConfig.ensureLoaded(), runtimeConfig.ensureSchemaLoaded()]);
    runtimeConfig.patchForm(["count"], "42.5");
    runtimeConfig.patchForm(["enabled"], "true");
    runtimeConfig.patchForm(["tags"], ["7", ""]);
    runtimeConfig.patchForm(["label"], "");

    await expect(runtimeConfig.save()).resolves.toBe(true);
    const submission = submitted.find((entry) => entry.method === "config.set");
    expect(submission?.params).toMatchObject({ baseHash: "hash-1" });
    const raw = (submission?.params as { raw?: unknown } | undefined)?.raw;
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw as string)).toEqual({ count: 42.5, enabled: true, tags: [7] });
    runtimeConfig.dispose();
  });

  it("stages inherited agent overrides and the default through the public capability", async () => {
    const request = vi.fn(async (method: string) =>
      method === "config.get"
        ? {
            config: { agents: { list: [{ id: "main" }, { id: "reviewer" }] } },
            hash: "hash-1",
            valid: true,
            issues: [],
          }
        : {},
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    await runtimeConfig.ensureLoaded();

    expect(runtimeConfig.ensureAgentEntry("new-agent")).toBe(2);
    expect(runtimeConfig.stageDefaultAgent("reviewer")).toBe(true);
    expect(runtimeConfig.state.configForm).toMatchObject({
      agents: {
        list: [{ id: "main" }, { id: "reviewer", default: true }, { id: "new-agent" }],
      },
    });
    runtimeConfig.dispose();
  });

  it("copies the config path when opening the file fails", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return {
          config: {},
          hash: "hash-1",
          path: "/tmp/openclaw.json",
          valid: true,
          issues: [],
        };
      }
      if (method === "config.openFile") {
        return { ok: false, error: "not supported", path: "/tmp/openclaw.json" };
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    await runtimeConfig.ensureLoaded();

    await runtimeConfig.openFile();
    expect(writeText).toHaveBeenCalledWith("/tmp/openclaw.json");
    expect(runtimeConfig.state.lastError).toContain("File path copied to clipboard");
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

  it("rejects stale config and schema work after reconnecting the same client", async () => {
    const firstConfig = deferred<ConfigSnapshot>();
    const secondConfig = deferred<ConfigSnapshot>();
    const firstSchema = deferred<ConfigSchemaResponse>();
    const secondSchema = deferred<ConfigSchemaResponse>();
    const configRequests = [firstConfig, secondConfig];
    const schemaRequests = [firstSchema, secondSchema];
    const request = vi.fn((method: string) => {
      const pending = method === "config.get" ? configRequests.shift() : schemaRequests.shift();
      if (!pending) {
        throw new Error(`unexpected request: ${method}`);
      }
      return pending.promise;
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);

    const staleConfigLoad = runtimeConfig.ensureLoaded();
    const staleSchemaLoad = runtimeConfig.ensureSchemaLoaded();
    publish(false);
    publish(true);
    const currentConfigLoad = runtimeConfig.ensureLoaded();
    const currentSchemaLoad = runtimeConfig.ensureSchemaLoaded();

    firstConfig.resolve({ config: { source: "stale" }, valid: true, issues: [], raw: "{}" });
    firstSchema.reject(new Error("stale schema failure"));
    await Promise.all([staleConfigLoad, staleSchemaLoad]);

    expect(runtimeConfig.state.configSnapshot).toBeNull();
    expect(runtimeConfig.state.configSchema).toBeNull();
    expect(runtimeConfig.state.lastError).toBeNull();
    expect(runtimeConfig.state.configLoading).toBe(true);
    expect(runtimeConfig.state.configSchemaLoading).toBe(true);

    secondConfig.resolve({ config: { source: "current" }, valid: true, issues: [], raw: "{}" });
    secondSchema.resolve({
      schema: { type: "object" },
      uiHints: {},
      version: "current",
      generatedAt: "2026-07-09T00:00:00.000Z",
    });
    await Promise.all([currentConfigLoad, currentSchemaLoad]);

    expect(runtimeConfig.state.configSnapshot?.config).toEqual({ source: "current" });
    expect(runtimeConfig.state.configSchema).toEqual({ type: "object" });
    expect(runtimeConfig.state.configSchemaVersion).toBe("current");
    expect(runtimeConfig.state.configLoading).toBe(false);
    expect(runtimeConfig.state.configSchemaLoading).toBe(false);
    runtimeConfig.dispose();
  });
});

describe("agent config helpers", () => {
  it("finds explicit agent entries", () => {
    expect(
      findAgentConfigEntryIndex(
        {
          agents: {
            list: [{ id: "main" }, { id: "assistant" }],
          },
        },
        "assistant",
      ),
    ).toBe(1);
  });
});
