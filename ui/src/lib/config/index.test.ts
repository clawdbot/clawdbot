// @vitest-environment node
// Control UI tests cover config behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSchemaResponse, ConfigSnapshot } from "../../api/types.ts";
import { createRuntimeConfigCapability, findAgentConfigEntryIndex } from "./index.ts";

const CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS = 800;

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
  vi.useRealTimers();
});

/** Simple hash-tracking config.get/config.set/config.apply mock gateway. */
function createConfigServerMock() {
  let hashCounter = 1;
  let appliedHash = "hash-1";
  let storedRaw = '{\n  "count": 1\n}\n';
  const submissions: Array<{ method: string; raw: string; baseHash: string }> = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      return {
        config: JSON.parse(storedRaw) as Record<string, unknown>,
        raw: storedRaw,
        hash: `hash-${hashCounter}`,
        configRevisionHash: `hash-${hashCounter}`,
        appliedConfigHash: appliedHash,
        valid: true,
        issues: [],
      };
    }
    if (method === "config.set" || method === "config.apply") {
      const { raw, baseHash } = params as { raw: string; baseHash: string };
      submissions.push({ method, raw, baseHash });
      storedRaw = raw;
      hashCounter += 1;
      if (method === "config.apply") {
        appliedHash = `hash-${hashCounter}`;
      }
      // Like the real gateway: ack with the persisted snapshot hash.
      return { hash: `hash-${hashCounter}` };
    }
    return {};
  });
  return { request, submissions, currentHash: () => `hash-${hashCounter}` };
}

/**
 * createConfigServerMock variant whose FIRST config.set stays pending until
 * `firstSet` resolves — for exercising mid-flight edits/reverts/teardown.
 */
function createDeferredSetServerMock(options: { legacyAck?: boolean } = {}) {
  const firstSet = deferred<unknown>();
  let hashCounter = 1;
  let storedRaw = '{\n  "count": 1\n}\n';
  const submissions: Array<{ raw: string; baseHash: string }> = [];
  const applySubmissions: Array<{ raw: string; baseHash: string }> = [];
  const request = vi.fn((method: string, params?: unknown) => {
    if (method === "config.get") {
      return Promise.resolve({
        config: JSON.parse(storedRaw) as Record<string, unknown>,
        raw: storedRaw,
        hash: `hash-${hashCounter}`,
        valid: true,
        issues: [],
      });
    }
    if (method === "config.set") {
      const { raw, baseHash } = params as { raw: string; baseHash: string };
      submissions.push({ raw, baseHash });
      storedRaw = raw;
      hashCounter += 1;
      const ack = options.legacyAck ? {} : { hash: `hash-${hashCounter}` };
      return submissions.length === 1 ? firstSet.promise.then(() => ack) : Promise.resolve(ack);
    }
    if (method === "config.apply") {
      const { raw, baseHash } = params as { raw: string; baseHash: string };
      applySubmissions.push({ raw, baseHash });
      storedRaw = raw;
      hashCounter += 1;
      return Promise.resolve({ hash: `hash-${hashCounter}` });
    }
    return Promise.resolve({});
  });
  return { request, submissions, applySubmissions, firstSet };
}

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

describe("config form auto-save", () => {
  function createHarness(request: GatewayBrowserClient["request"]) {
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    return { runtimeConfig: createRuntimeConfigCapability(gateway), publish };
  }

  it("debounces form edits into one config.set and marks needsApply", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    runtimeConfig.patchForm(["count"], 3);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS - 1);
    expect(server.submissions).toHaveLength(0);
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");

    await vi.advanceTimersByTimeAsync(1);
    expect(server.submissions).toEqual([
      { method: "config.set", raw: '{\n  "count": 3\n}\n', baseHash: "hash-1" },
    ]);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    expect(runtimeConfig.state.configNeedsApply).toBe(true);
    // The post-save reload rebased the clean draft onto the new hash.
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");
    runtimeConfig.dispose();
  });

  it("keeps mid-flight edits dirty and queues exactly one trailing save", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saving");

    // Edits during the in-flight save stay dirty and fold into one trailing save.
    runtimeConfig.patchForm(["count"], 3);
    runtimeConfig.patchForm(["count"], 4);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);
    expect(runtimeConfig.state.configFormDirty).toBe(true);

    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual({ raw: '{\n  "count": 4\n}\n', baseHash: "hash-2" });
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    runtimeConfig.dispose();
  });

  it("surfaces auto-save failures without retry-looping", async () => {
    vi.useFakeTimers();
    let setCalls = 0;
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
        setCalls += 1;
        throw new Error("disk full");
      }
      return {};
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(setCalls).toBe(1);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configNeedsApply).toBe(false);
    expect(runtimeConfig.state.lastError).toContain("disk full");

    // No retry loop; only the next edit reschedules a save.
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 10);
    expect(setCalls).toBe(1);
    runtimeConfig.patchForm(["count"], 3);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(setCalls).toBe(2);
    runtimeConfig.dispose();
  });

  it("clears needsApply only on apply; a discarding refresh keeps the banner", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configNeedsApply).toBe(true);

    // Discarding local edits does not undo the already-saved file: the
    // restart banner must survive until apply.
    runtimeConfig.patchForm(["count"], 9);
    await runtimeConfig.refresh({ discardPendingChanges: true });
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configNeedsApply).toBe(true);

    await expect(runtimeConfig.apply()).resolves.toBe(true);
    expect(runtimeConfig.state.configNeedsApply).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
    expect(server.submissions.at(-1)?.method).toBe("config.apply");
    runtimeConfig.dispose();
  });

  it("derives needsApply across capability recreation from Gateway revision truth", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const first = createHarness(server.request as GatewayBrowserClient["request"]);
    await first.runtimeConfig.ensureLoaded();

    first.runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(first.runtimeConfig.state.configNeedsApply).toBe(true);
    first.runtimeConfig.dispose();

    // A fresh capability compares the persisted and applied revisions.
    const second = createHarness(server.request as GatewayBrowserClient["request"]);
    await second.runtimeConfig.ensureLoaded();
    expect(second.runtimeConfig.state.configNeedsApply).toBe(true);

    await expect(second.runtimeConfig.apply()).resolves.toBe(true);
    expect(second.runtimeConfig.state.configNeedsApply).toBe(false);
    second.runtimeConfig.dispose();

    // After apply advances runtime truth, a third load shows no banner.
    const third = createHarness(server.request as GatewayBrowserClient["request"]);
    await third.runtimeConfig.ensureLoaded();
    expect(third.runtimeConfig.state.configNeedsApply).toBe(false);
    third.runtimeConfig.dispose();
  });

  it("does not invent needsApply when an older Gateway omits the applied hash", async () => {
    const request = vi.fn(async (method: string) =>
      method === "config.get" ? { config: {}, hash: "hash-1", valid: true, issues: [] } : {},
    );
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    expect(runtimeConfig.state.configNeedsApply).toBe(false);
    runtimeConfig.dispose();
  });

  it("preserves process-local needsApply after saving through an older Gateway", async () => {
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
      return method === "config.set" ? { hash: "hash-2" } : {};
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    expect(runtimeConfig.state.configNeedsApply).toBe(true);
    runtimeConfig.dispose();
  });

  it("treats a missing current config as drift from an applied revision", async () => {
    const request = vi.fn(async (method: string) =>
      method === "config.get"
        ? {
            config: {},
            hash: null,
            configRevisionHash: null,
            appliedConfigHash: "applied-hash",
            valid: true,
            issues: [],
          }
        : {},
    );
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    expect(runtimeConfig.state.configNeedsApply).toBe(true);
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
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
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
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
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
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
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
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
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

  it("flushes the pending debounce before apply and leaves no dangling save", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 7);
    // Apply serializes the current form itself; the scheduled autosave is
    // cancelled and never fires afterwards.
    await expect(runtimeConfig.apply()).resolves.toBe(true);
    expect(server.submissions).toEqual([
      { method: "config.apply", raw: '{\n  "count": 7\n}\n', baseHash: "hash-1" },
    ]);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(server.submissions).toHaveLength(1);
    runtimeConfig.dispose();
  });

  it("reschedules a stranded dirty draft after reconnect", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig, publish } = createHarness(
      server.request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    publish(false);
    // The disconnect cancelled the debounce; nothing fires while offline.
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 3);
    expect(server.submissions).toHaveLength(0);
    expect(runtimeConfig.state.configFormDirty).toBe(true);

    publish(true);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(server.submissions).toEqual([
      { method: "config.set", raw: '{\n  "count": 2\n}\n', baseHash: "hash-1" },
    ]);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configNeedsApply).toBe(true);
    runtimeConfig.dispose();
  });

  it("reports a base-hash conflict distinctly and recovers via discarding reload", async () => {
    vi.useFakeTimers();
    let rejectSet = true;
    const server = createConfigServerMock();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.set" && rejectSet) {
        // Exact gateway contract message from requireConfigBaseHash
        // (src/gateway/server-methods/config.ts).
        throw new Error("config changed since last load; re-run config.get and retry");
      }
      return server.request(method, params);
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    // No auto-rebase-and-retry: the whole-form draft would clobber the other writer.
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 5);
    expect(server.submissions).toHaveLength(0);

    // The Reload affordance discards the local draft and re-syncs from disk.
    rejectSet = false;
    await runtimeConfig.refresh({ discardPendingChanges: true });
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
    expect(runtimeConfig.state.configFormDirty).toBe(false);

    runtimeConfig.patchForm(["count"], 3);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(server.submissions).toEqual([
      { method: "config.set", raw: '{\n  "count": 3\n}\n', baseHash: "hash-1" },
    ]);
    runtimeConfig.dispose();
  });

  it("resets a stale Saved/error status as soon as a new edit lands", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");

    runtimeConfig.patchForm(["count"], 3);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");

    // Raw edits reset the indicator too.
    runtimeConfig.setRaw('{\n  "count": 9\n}\n');
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
    runtimeConfig.dispose();
  });

  it("flushes a dirty draft once on dispose instead of dropping it", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
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
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.setRaw('{\n  "count": 5\n}\n');
    runtimeConfig.dispose();
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(server.submissions).toHaveLength(0);
  });

  it("applies a clean snapshot's raw bytes verbatim instead of reserializing", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    // Hand-formatted (but JSON-parseable) raw that serializeConfigForm would
    // rewrite into pretty-printed two-space form.
    const rawDraft = '{"count":9,"keepFormatting":true}\n';
    runtimeConfig.setRaw(rawDraft);
    const savePromise = runtimeConfig.save();
    await vi.advanceTimersByTimeAsync(0);
    await expect(savePromise).resolves.toBe(true);
    expect(server.submissions[0]?.raw).toBe(rawDraft);

    // The banner's apply must not destroy the formatting that was just saved.
    await expect(runtimeConfig.apply()).resolves.toBe(true);
    expect(server.submissions[1]).toMatchObject({ method: "config.apply", raw: rawDraft });
    runtimeConfig.dispose();
  });

  it("does not report Saved while edits made during the reload are still dirty", async () => {
    vi.useFakeTimers();
    let hashCounter = 1;
    let storedRaw = '{\n  "count": 1\n}\n';
    let deferReload: ReturnType<typeof deferred<unknown>> | null = null;
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "config.get") {
        const response = {
          config: JSON.parse(storedRaw) as Record<string, unknown>,
          raw: storedRaw,
          hash: `hash-${hashCounter}`,
          valid: true,
          issues: [],
        };
        if (deferReload) {
          const pending = deferReload;
          deferReload = null;
          return pending.promise.then(() => response);
        }
        return Promise.resolve(response);
      }
      if (method === "config.set") {
        storedRaw = (params as { raw: string }).raw;
        hashCounter += 1;
        return Promise.resolve({ hash: `hash-${hashCounter}` });
      }
      return Promise.resolve({});
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    const reloadGate = deferred<unknown>();
    deferReload = reloadGate;
    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    // config.set acked; the post-save reload is held open while a new edit lands.
    runtimeConfig.patchForm(["count"], 3);
    reloadGate.resolve({});
    await vi.advanceTimersByTimeAsync(0);

    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");

    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    runtimeConfig.dispose();
  });

  it("merges a form patch on top of a parseable dirty raw draft", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.setRaw('{\n  "count": 1,\n  "rawOnly": true\n}\n');
    expect(runtimeConfig.state.configFormMode).toBe("raw");

    // A Quick Settings patch lands on the shared capability: it must build on
    // the parsed raw draft instead of the stale form.
    runtimeConfig.patchForm(["count"], 7);
    expect(runtimeConfig.state.configFormMode).toBe("form");

    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(server.submissions).toHaveLength(1);
    expect(JSON.parse(server.submissions[0]?.raw ?? "{}")).toEqual({ count: 7, rawOnly: true });
    runtimeConfig.dispose();
  });

  it("refuses form patches while an unparseable raw draft is pending", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    const brokenRaw = '{\n  "count": broken';
    runtimeConfig.setRaw(brokenRaw);
    runtimeConfig.patchForm(["count"], 7);

    // The raw draft stays authoritative; the form edit is rejected loudly.
    expect(runtimeConfig.state.configRaw).toBe(brokenRaw);
    expect(runtimeConfig.state.configFormMode).toBe("raw");
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
    expect(runtimeConfig.state.lastError).toContain("Raw editor");
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(server.submissions).toHaveLength(0);
    runtimeConfig.dispose();
  });

  it("keeps process-local needsApply when the post-save reload fails", async () => {
    vi.useFakeTimers();
    let failReloads = false;
    let hashCounter = 1;
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        if (failReloads) {
          throw new Error("gateway went away");
        }
        return {
          config: { count: 1 },
          raw: '{\n  "count": 1\n}\n',
          hash: `hash-${hashCounter}`,
          configRevisionHash: `hash-${hashCounter}`,
          appliedConfigHash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        hashCounter += 1;
        return { hash: `hash-${hashCounter}` };
      }
      return {};
    });
    const first = createHarness(request as GatewayBrowserClient["request"]);
    await first.runtimeConfig.ensureLoaded();

    failReloads = true;
    first.runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    expect(first.runtimeConfig.state.configNeedsApply).toBe(true);
    first.runtimeConfig.dispose();

    failReloads = false;
    const second = createHarness(request as GatewayBrowserClient["request"]);
    await second.runtimeConfig.ensureLoaded();
    expect(second.runtimeConfig.state.configNeedsApply).toBe(true);
    second.runtimeConfig.dispose();
  });

  it("keeps saving against the ack hash while reloads fail", async () => {
    vi.useFakeTimers();
    let failReloads = false;
    let hashCounter = 1;
    const submissions: Array<{ raw: string; baseHash: string }> = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        if (failReloads) {
          throw new Error("gateway offline");
        }
        return {
          config: { count: 1 },
          raw: '{\n  "count": 1\n}\n',
          hash: `hash-${hashCounter}`,
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        const { raw, baseHash } = params as { raw: string; baseHash: string };
        submissions.push({ raw, baseHash });
        hashCounter += 1;
        return { hash: `hash-${hashCounter}` };
      }
      return {};
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    failReloads = true;
    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    runtimeConfig.patchForm(["count"], 3);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    // Each save chains onto the previous ack hash; the failed best-effort
    // reloads never block or self-conflict the flow.
    expect(submissions.map((entry) => entry.baseHash)).toEqual(["hash-1", "hash-2"]);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    runtimeConfig.dispose();
  });

  it("runs one trailing save when a field is reverted during the flight", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    // Revert to the pre-save value while the save is in flight: against the
    // old original this looks clean, but the submitted bytes are now the
    // authoritative original, so the revert must still be written back.
    runtimeConfig.patchForm(["count"], 1);
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);

    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual({ raw: '{\n  "count": 1\n}\n', baseHash: "hash-2" });
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    runtimeConfig.dispose();
  });

  it("chains one final save when disposed mid-flight with a newer edit", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
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
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    runtimeConfig.dispose();
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    expect(submissions).toHaveLength(1);
  });

  it("applies the acked bytes when the post-save reload failed", async () => {
    vi.useFakeTimers();
    let failReloads = false;
    let hashCounter = 1;
    const applySubmissions: Array<{ raw: string; baseHash: string }> = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        if (failReloads) {
          throw new Error("gateway offline");
        }
        return {
          config: { count: 1 },
          raw: '{\n  "count": 1\n}\n',
          hash: `hash-${hashCounter}`,
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        hashCounter += 1;
        return { hash: `hash-${hashCounter}` };
      }
      if (method === "config.apply") {
        const { raw, baseHash } = params as { raw: string; baseHash: string };
        applySubmissions.push({ raw, baseHash });
        hashCounter += 1;
        return { hash: `hash-${hashCounter}` };
      }
      return {};
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    failReloads = true;
    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configNeedsApply).toBe(true);

    // The ack made the submitted bytes the local snapshot; apply must submit
    // them, not the pre-save file the failed reload left behind.
    await expect(runtimeConfig.apply()).resolves.toBe(true);
    expect(applySubmissions).toEqual([{ raw: '{\n  "count": 2\n}\n', baseHash: "hash-2" }]);
    expect(runtimeConfig.state.configNeedsApply).toBe(false);
    runtimeConfig.dispose();
  });

  it("keeps a revert made during the cosmetic reload dirty and saves it", async () => {
    vi.useFakeTimers();
    let hashCounter = 1;
    let storedRaw = '{\n  "count": 1\n}\n';
    let deferReload: ReturnType<typeof deferred<unknown>> | null = null;
    const submissions: Array<{ raw: string; baseHash: string }> = [];
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "config.get") {
        const response = {
          config: JSON.parse(storedRaw) as Record<string, unknown>,
          raw: storedRaw,
          hash: `hash-${hashCounter}`,
          valid: true,
          issues: [],
        };
        if (deferReload) {
          const pending = deferReload;
          deferReload = null;
          return pending.promise.then(() => response);
        }
        return Promise.resolve(response);
      }
      if (method === "config.set") {
        const { raw, baseHash } = params as { raw: string; baseHash: string };
        submissions.push({ raw, baseHash });
        storedRaw = raw;
        hashCounter += 1;
        return Promise.resolve({ hash: `hash-${hashCounter}` });
      }
      return Promise.resolve({});
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    const reloadGate = deferred<unknown>();
    deferReload = reloadGate;
    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    // The ack already rebased the originals onto the submitted bytes, so a
    // revert during the still-pending reload compares dirty and reschedules.
    runtimeConfig.patchForm(["count"], 1);
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    reloadGate.resolve({});
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual({ raw: '{\n  "count": 1\n}\n', baseHash: "hash-2" });
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    runtimeConfig.dispose();
  });

  it("drains the whole autosave chain before an explicit apply", async () => {
    vi.useFakeTimers();
    const { request, submissions, applySubmissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    // Edit while the save is in flight, then apply: the trailing save must
    // land first and the apply must chain onto ITS ack hash (no CAS failure).
    runtimeConfig.patchForm(["count"], 3);
    const applyPromise = runtimeConfig.apply();
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    await expect(applyPromise).resolves.toBe(true);

    expect(submissions).toEqual([
      { raw: '{\n  "count": 2\n}\n', baseHash: "hash-1" },
      { raw: '{\n  "count": 3\n}\n', baseHash: "hash-2" },
    ]);
    expect(applySubmissions).toEqual([{ raw: '{\n  "count": 3\n}\n', baseHash: "hash-3" }]);
    runtimeConfig.dispose();
  });

  it("clears a failure status and error when a mutation reverts the draft clean", async () => {
    vi.useFakeTimers();
    let setCalls = 0;
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
        setCalls += 1;
        throw new Error("disk full");
      }
      return {};
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");

    // Reverting to the original makes the failure moot.
    runtimeConfig.patchForm(["count"], 1);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
    expect(runtimeConfig.state.lastError).toBeNull();
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(setCalls).toBe(1);
    runtimeConfig.dispose();
  });

  it("keeps the conflict status until reload even when the draft reverts clean", async () => {
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
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");

    // The snapshot is known stale; local cleanliness cannot clear that.
    runtimeConfig.patchForm(["count"], 1);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");

    await runtimeConfig.refresh({ discardPendingChanges: true });
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
    runtimeConfig.dispose();
  });

  it("drains an in-flight manual save before an explicit apply", async () => {
    vi.useFakeTimers();
    const { request, submissions, applySubmissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    const rawDraft = '{\n  "count": 5\n}\n';
    runtimeConfig.setRaw(rawDraft);
    const savePromise = runtimeConfig.save();
    await vi.advanceTimersByTimeAsync(0);
    expect(submissions).toEqual([{ raw: rawDraft, baseHash: "hash-1" }]);

    // Apply while the manual save is still in flight: it must wait for the
    // save's ack and chain onto its hash instead of racing the same base.
    const applyPromise = runtimeConfig.apply();
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    await expect(savePromise).resolves.toBe(true);
    await expect(applyPromise).resolves.toBe(true);

    expect(applySubmissions).toEqual([{ raw: rawDraft, baseHash: "hash-2" }]);
    runtimeConfig.dispose();
  });

  it("discards offline drafts locally instead of no-op refreshing", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig, publish } = createHarness(
      server.request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    const originalRaw = runtimeConfig.state.configRawOriginal;

    publish(false);
    runtimeConfig.setRaw('{\n  "count": 9\n}\n');
    expect(runtimeConfig.state.configFormDirty).toBe(true);

    await runtimeConfig.discardDraft();
    expect(runtimeConfig.state.configRaw).toBe(originalRaw);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
    expect(runtimeConfig.state.lastError).toBeNull();

    // Connected discards still reload from disk.
    publish(true);
    runtimeConfig.patchForm(["count"], 4);
    const getCallsBefore = server.request.mock.calls.filter(
      ([method]) => method === "config.get",
    ).length;
    await runtimeConfig.discardDraft();
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(server.request.mock.calls.filter(([method]) => method === "config.get").length).toBe(
      getCallsBefore + 1,
    );
    runtimeConfig.dispose();
  });

  it("reports a conflict status when apply hits the base-hash guard", async () => {
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
      if (method === "config.apply") {
        throw new Error("config changed since last load; re-run config.get and retry");
      }
      return {};
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    await expect(runtimeConfig.apply()).resolves.toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
    runtimeConfig.dispose();
  });

  it("skips the teardown flush when the settled flight acked without a hash", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock({ legacyAck: true });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    // Without the flight's own ack hash there is no trusted CAS base for the
    // final flush; failing closed beats clobbering a foreign write.
    runtimeConfig.patchForm(["count"], 3);
    runtimeConfig.dispose();
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);
  });

  it("drains in-flight saves before a discard without trailing the discarded bytes", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    // A mid-flight edit would normally spawn a trailing save; a discard must
    // wait for the flight and then throw the draft away instead.
    runtimeConfig.patchForm(["count"], 3);
    const discardPromise = runtimeConfig.discardDraft();
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    await discardPromise;

    expect(submissions).toHaveLength(1);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    // The draft ends clean against the acked/reloaded state, not the old bytes.
    expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
    runtimeConfig.dispose();
  });

  it("refuses apply while a raw draft is dirty", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.setRaw('{\n  "count": 9\n}\n');
    await expect(runtimeConfig.apply()).resolves.toBe(false);

    // Raw stays explicit-save-only: nothing was written, the user is told to
    // resolve the raw draft first.
    expect(server.submissions).toHaveLength(0);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
    expect(runtimeConfig.state.lastError).toContain("Raw editor");
    runtimeConfig.dispose();
  });

  it("suspends config writes while the app updater runs and resumes after", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.setWritesSuspended(true);
    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 3);
    expect(server.submissions).toHaveLength(0);
    expect(runtimeConfig.state.configFormDirty).toBe(true);

    // Manual writes refuse too: config writes mid-update can corrupt the install.
    await expect(runtimeConfig.save()).resolves.toBe(false);
    await expect(runtimeConfig.apply()).resolves.toBe(false);
    expect(server.submissions).toHaveLength(0);

    // Edits made during the update save once it ends.
    runtimeConfig.setWritesSuspended(false);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(server.submissions).toEqual([
      { method: "config.set", raw: '{\n  "count": 2\n}\n', baseHash: "hash-1" },
    ]);
    runtimeConfig.dispose();
  });

  it("treats config.patch as a suspendable, drainable write", async () => {
    vi.useFakeTimers();
    const patchGate = deferred<unknown>();
    const patches: unknown[] = [];
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "config.get") {
        return Promise.resolve({
          config: { count: 1 },
          raw: '{\n  "count": 1\n}\n',
          hash: "hash-1",
          valid: true,
          issues: [],
        });
      }
      if (method === "config.patch") {
        patches.push(params);
        return patchGate.promise;
      }
      return Promise.resolve({});
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    // Suspended (app updater running): patches refuse like save/apply — a
    // patch is a config write too and could overlap the install.
    runtimeConfig.setWritesSuspended(true);
    await expect(
      runtimeConfig.patch({ raw: { count: 5 }, note: "test suspended patch" }),
    ).resolves.toBe(false);
    expect(patches).toHaveLength(0);
    runtimeConfig.setWritesSuspended(false);

    // Once in flight, the updater barrier must wait for it.
    const patchPromise = runtimeConfig.patch({ raw: { count: 5 }, note: "test in-flight patch" });
    await vi.advanceTimersByTimeAsync(0);
    expect(patches).toHaveLength(1);
    let drained = false;
    const drainPromise = runtimeConfig.waitForPendingWrites().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    patchGate.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    await drainPromise;
    await expect(patchPromise).resolves.toBe(true);
    runtimeConfig.dispose();
  });

  it("refreshes applied revision truth after config.patch", async () => {
    vi.useFakeTimers();
    let getCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        getCount += 1;
        const revision = getCount === 1 ? "revision-1" : "revision-2";
        return {
          config: { count: getCount },
          raw: `{\n  "count": ${getCount}\n}\n`,
          hash: `hash-${getCount}`,
          configRevisionHash: revision,
          appliedConfigHash: revision,
          valid: true,
          issues: [],
        };
      }
      return method === "config.patch" ? { hash: "hash-2" } : {};
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    await expect(runtimeConfig.patch({ raw: { count: 2 }, note: "test patch" })).resolves.toBe(
      true,
    );
    expect(runtimeConfig.state.configNeedsApply).toBe(true);

    await vi.advanceTimersByTimeAsync(250);
    expect(runtimeConfig.state.configNeedsApply).toBe(false);
    expect(runtimeConfig.state.configSnapshot?.configRevisionHash).toBe("revision-2");
    runtimeConfig.dispose();
  });

  it("flushes a pre-ack revert during disposal", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    // Revert to the original value while the save is in flight: dirty reads
    // false (originals not yet rebased onto the submission), but the bytes
    // differ from the submitted ones — dropping this flush would persist the
    // unreverted value.
    runtimeConfig.patchForm(["count"], 1);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    runtimeConfig.dispose();
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);

    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual({ raw: '{\n  "count": 1\n}\n', baseHash: "hash-2" });
  });

  it("reconciles an uncertain in-flight save after reconnect before autosave resumes", async () => {
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
        hash = "hash-3";
        return Promise.resolve({ hash });
      }
      return Promise.resolve({});
    });
    const { runtimeConfig, publish } = createHarness(request as GatewayBrowserClient["request"]);
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
    // committed hash instead of false-conflicting against our own write.
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    expect(sets).toHaveLength(2);
    expect(sets[1]).toEqual({ raw: '{\n  "count": 3\n}\n', baseHash: "hash-2" });
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    runtimeConfig.dispose();
  });

  it("does not write when an edit is reverted within the debounce window", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    // Dirtiness is canonical-vs-canonical on the form objects, so a revert to
    // the original value reads clean and never rewrites the file (which would
    // destroy JSON5 comments/formatting for a semantic no-op).
    runtimeConfig.patchForm(["count"], 2);
    runtimeConfig.patchForm(["count"], 1);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);

    expect(server.submissions).toHaveLength(0);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    runtimeConfig.dispose();
  });

  it("serializes explicit ops queued behind the same in-flight write", async () => {
    vi.useFakeTimers();
    const { request, submissions, applySubmissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    // Both ops queue behind the hung autosave; they must dispatch one after
    // another, each against the base its predecessor produced — not both
    // against the drained flight's base.
    const savePromise = runtimeConfig.save();
    const applyPromise = runtimeConfig.apply();
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    await expect(savePromise).resolves.toBe(true);
    await expect(applyPromise).resolves.toBe(true);

    expect(submissions).toHaveLength(2);
    expect(submissions[1]?.baseHash).toBe("hash-2");
    expect(applySubmissions).toHaveLength(1);
    expect(applySubmissions[0]?.baseHash).toBe("hash-3");
    runtimeConfig.dispose();
  });

  it("defers autosaves behind a manual write and keeps the newer edit", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    const savePromise = runtimeConfig.save();
    await vi.advanceTimersByTimeAsync(0);
    expect(submissions).toHaveLength(1);

    // Edit while the manual save is pending: no concurrent config.set may
    // start (it would race the same base hash), and the manual completion
    // must not snap the draft back to its older submitted bytes.
    runtimeConfig.patchForm(["count"], 3);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(submissions).toHaveLength(1);

    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    await savePromise;
    await vi.advanceTimersByTimeAsync(0);

    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual({ raw: '{\n  "count": 3\n}\n', baseHash: "hash-2" });
    expect(runtimeConfig.state.configForm).toEqual({ count: 3 });
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
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
    const { runtimeConfig, publish } = createHarness(request as GatewayBrowserClient["request"]);
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

  it("rebases trailing edits after a hashless ack so the trailing save does not self-conflict", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock({ legacyAck: true });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    // Edit while the hashless save is in flight: the follow-up reload must
    // rebase the surviving draft onto the fetched post-write hash, or the
    // trailing save conflicts with the write that just succeeded.
    runtimeConfig.patchForm(["count"], 3);
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual({ raw: '{\n  "count": 3\n}\n', baseHash: "hash-2" });
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
    const { runtimeConfig, publish } = createHarness(request as GatewayBrowserClient["request"]);
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

    // …and the still-dirty draft retries against the committed hash.
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(sets).toHaveLength(2);
    expect(sets[1]).toEqual({ raw: '{\n  "count": 2\n}\n', baseHash: "hash-2" });
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
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
    const { runtimeConfig, publish } = createHarness(request as GatewayBrowserClient["request"]);
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
    expect(sets).toHaveLength(2);
    expect(sets[1]).toEqual({ raw: '{\n  "count": 2\n}\n', baseHash: "hash-2" });
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
    const { runtimeConfig, publish } = createHarness(request as GatewayBrowserClient["request"]);
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

    expect(sets).toHaveLength(2);
    expect(sets[1]).toEqual({ raw: '{\n  "count": 1\n}\n', baseHash: "hash-2" });
    expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    runtimeConfig.dispose();
  });

  it("keeps process-local needsApply after a legacy hashless ack reload", async () => {
    vi.useFakeTimers();
    const { request, firstSet, submissions } = createDeferredSetServerMock({ legacyAck: true });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    expect(submissions).toHaveLength(1);
    expect(runtimeConfig.state.configNeedsApply).toBe(true);
    runtimeConfig.dispose();
  });

  it("drains in-flight saves before a discarding refresh", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    // Same barrier as discardDraft: the settling flight must not trail the
    // just-discarded edit back to disk after the refresh.
    runtimeConfig.patchForm(["count"], 3);
    const refreshPromise = runtimeConfig.refresh({ discardPendingChanges: true });
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    await refreshPromise;

    expect(submissions).toHaveLength(1);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
    runtimeConfig.dispose();
  });

  it("flushes a scheduled form autosave before config.patch and re-arms after", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let hashCounter = 1;
    const request = vi.fn((method: string) => {
      if (method === "config.get") {
        return Promise.resolve({
          config: { count: 1 },
          raw: '{\n  "count": 1\n}\n',
          hash: `hash-${hashCounter}`,
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set" || method === "config.patch") {
        order.push(method);
        hashCounter += 1;
        return Promise.resolve({ hash: `hash-${hashCounter}` });
      }
      return Promise.resolve({});
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    // Patch during the debounce window: the draft must be flushed as a real
    // save before the patch, not silently dropped with its timer.
    runtimeConfig.patchForm(["count"], 2);
    let patchBaseCount: unknown;
    await expect(
      runtimeConfig.patchFromSnapshot((config) => {
        patchBaseCount = config.count;
        return {
          options: { raw: { other: true }, note: "test patch after autosave" },
        };
      }),
    ).resolves.toBe(true);

    expect(order).toEqual(["config.set", "config.patch"]);
    expect(patchBaseCount).toBe(2);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    runtimeConfig.dispose();
  });

  it("adopts the acked autosave without a follow-up reload", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();
    const configGetCalls = () =>
      server.request.mock.calls.filter(([method]) => method === "config.get").length;
    const getsBefore = configGetCalls();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(server.submissions).toHaveLength(1);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    // The acked bytes + hash ARE the snapshot; a config.get here would flash
    // configLoading and lock the editors between keystrokes.
    expect(configGetCalls()).toBe(getsBefore);
    expect(runtimeConfig.state.configSnapshot?.hash).toBe(server.currentHash());
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
    const { runtimeConfig, publish } = createHarness(request as GatewayBrowserClient["request"]);
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

  it("chains the teardown flush behind a pending manual save", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    const savePromise = runtimeConfig.save();
    await vi.advanceTimersByTimeAsync(0);
    expect(submissions).toHaveLength(1);

    runtimeConfig.patchForm(["count"], 3);
    runtimeConfig.dispose();
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    await savePromise;

    // Exactly one chained flush, based on the manual save's own ack hash —
    // never a parallel write against the same base.
    expect(submissions).toEqual([
      { raw: '{\n  "count": 2\n}\n', baseHash: "hash-1" },
      { raw: '{\n  "count": 3\n}\n', baseHash: "hash-2" },
    ]);
  });

  it("skips the teardown flush behind a pending apply", async () => {
    vi.useFakeTimers();
    const firstApply = deferred<unknown>();
    let setCalls = 0;
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
        setCalls += 1;
        return Promise.resolve({ hash: "hash-9" });
      }
      if (method === "config.apply") {
        return firstApply.promise.then(() => ({ hash: "hash-2" }));
      }
      return Promise.resolve({});
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    const applyPromise = runtimeConfig.apply();
    await vi.advanceTimersByTimeAsync(0);

    // The gateway is about to restart; a post-apply write is meaningless.
    runtimeConfig.patchForm(["count"], 3);
    runtimeConfig.dispose();
    firstApply.resolve({});
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    await applyPromise;
    expect(setCalls).toBe(0);
  });

  it("never auto-saves raw-text drafts and submits them on manual save", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    const rawDraft = '{\n  "count": 9,\n  "handEdited": true\n}\n';
    runtimeConfig.setRaw(rawDraft);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(server.submissions).toHaveLength(0);
    expect(runtimeConfig.state.configFormDirty).toBe(true);

    // Manual save must submit the raw bytes, not the stale form serialization.
    const savePromise = runtimeConfig.save();
    await vi.advanceTimersByTimeAsync(0);
    await expect(savePromise).resolves.toBe(true);
    expect(server.submissions[0]?.raw).toBe(rawDraft);
    expect(runtimeConfig.state.configNeedsApply).toBe(true);
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

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
