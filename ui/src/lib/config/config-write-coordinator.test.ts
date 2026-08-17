// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  deferred,
  createConfigServerMock,
  createDeferredSetServerMock,
  createConfigCapabilityHarness,
} from "./config-test-harness.ts";

describe("config write coordinator", () => {
  it("debounces form edits into one config.set and marks needsApply", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
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
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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

  it("flushes the pending debounce before apply and leaves no dangling save", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
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

  it("runs one trailing save when a field is reverted during the flight", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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

  it("drains the whole autosave chain before an explicit apply", async () => {
    vi.useFakeTimers();
    const { request, submissions, applySubmissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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

  it("drains an in-flight manual save before an explicit apply", async () => {
    vi.useFakeTimers();
    const { request, submissions, applySubmissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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

  it("skips the teardown flush when the settled flight acked without a hash", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock({ legacyAck: true });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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

  it("suspends config writes while the app updater runs and resumes after", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
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
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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

  it("flushes a scheduled autosave when a write barrier runs before the debounce", async () => {
    vi.useFakeTimers();
    const setGate = deferred<unknown>();
    const methods: string[] = [];
    const request = vi.fn((method: string, params?: unknown) => {
      methods.push(method);
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
        expect(params).toMatchObject({ baseHash: "hash-1" });
        return setGate.promise;
      }
      return Promise.resolve({});
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    let drained = false;
    const drain = runtimeConfig.waitForPendingWrites().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(methods.filter((method) => method === "config.set")).toHaveLength(1);
    expect(drained).toBe(false);

    setGate.resolve({ hash: "hash-2" });
    await drain;
    expect(drained).toBe(true);
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");
    runtimeConfig.dispose();
  });

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

  it("flushes a pre-ack revert during disposal", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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

  it("does not write when an edit is reverted within the debounce window", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
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
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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

  it("cancels a debounce armed while an explicit save drains another write", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    const save = runtimeConfig.save();
    runtimeConfig.patchForm(["count"], 3);
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    await expect(save).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);

    expect(submissions).toEqual([
      { raw: '{\n  "count": 2\n}\n', baseHash: "hash-1" },
      { raw: '{\n  "count": 3\n}\n', baseHash: "hash-2" },
    ]);
    runtimeConfig.dispose();
  });

  it("defers autosaves behind a manual write and keeps the newer edit", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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

  it("drains in-flight saves before a discarding refresh", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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

  it("chains the teardown flush behind a pending manual save", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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
});
