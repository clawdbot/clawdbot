// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  deferred,
  createGatewayHarness,
  createConfigServerMock,
  createConfigCapabilityHarness,
} from "./config-test-harness.ts";
import { createRuntimeConfigCapability } from "./runtime-config-capability.ts";

describe("config gateway operations", () => {
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
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    const reloadGate = deferred<unknown>();
    deferReload = reloadGate;
    runtimeConfig.patchForm(["count"], 2);
    const save = runtimeConfig.save();
    await vi.advanceTimersByTimeAsync(0);
    // config.set acked; the post-save reload is held open while a new edit lands.
    runtimeConfig.patchForm(["count"], 3);
    reloadGate.resolve({});
    await expect(save).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");

    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
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
    const first = createConfigCapabilityHarness(request as GatewayBrowserClient["request"]);
    await first.runtimeConfig.ensureLoaded();

    failReloads = true;
    first.runtimeConfig.patchForm(["count"], 2);
    await expect(first.runtimeConfig.save()).resolves.toBe(true);
    expect(first.runtimeConfig.state.lastError).toContain("gateway went away");

    expect(first.runtimeConfig.state.configNeedsApply).toBe(true);
    first.runtimeConfig.dispose();

    failReloads = false;
    const second = createConfigCapabilityHarness(request as GatewayBrowserClient["request"]);
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
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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

  it("saves a revert made after acknowledgement on the new base", async () => {
    vi.useFakeTimers();
    let hashCounter = 1;
    let storedRaw = '{\n  "count": 1\n}\n';
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
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    // The ack already rebased the originals onto the submitted bytes, so a
    // revert to the previous value compares dirty and reschedules.
    runtimeConfig.patchForm(["count"], 1);
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual({ raw: '{\n  "count": 1\n}\n', baseHash: "hash-2" });
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
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
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    await expect(runtimeConfig.apply()).resolves.toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
    runtimeConfig.dispose();
  });

  it("adopts config.patch acknowledgements for consecutive queued patches", async () => {
    const patchBaseHashes: string[] = [];
    let storedConfig: Record<string, unknown> = { count: 1 };
    let hashCounter = 1;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        return {
          config: storedConfig,
          raw: JSON.stringify(storedConfig),
          hash: `hash-${hashCounter}`,
          valid: true,
          issues: [],
        };
      }
      if (method === "config.patch") {
        const patch = params as { baseHash: string; raw: string };
        patchBaseHashes.push(patch.baseHash);
        storedConfig = { ...storedConfig, ...(JSON.parse(patch.raw) as Record<string, unknown>) };
        hashCounter += 1;
        return { config: storedConfig, hash: `hash-${hashCounter}` };
      }
      return {};
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    const first = runtimeConfig.patch({ raw: { first: true }, note: "first test patch" });
    const second = runtimeConfig.patch({ raw: { second: true }, note: "second test patch" });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(patchBaseHashes).toEqual(["hash-1", "hash-2"]);
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-3");
    expect(runtimeConfig.state.configForm).toEqual({ count: 1, first: true, second: true });
    runtimeConfig.dispose();
  });

  it("keeps a concurrent dirty draft on its pre-patch CAS base", async () => {
    vi.useFakeTimers();
    const patchGate = deferred<unknown>();
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
      if (method === "config.patch") {
        return patchGate.promise;
      }
      return Promise.resolve({});
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    const patch = runtimeConfig.patch({ raw: { patched: true }, note: "concurrent test patch" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("config.patch", expect.anything()));
    runtimeConfig.patchForm(["count"], 2);
    patchGate.resolve({ config: { count: 1, patched: true }, hash: "hash-2" });
    await expect(patch).resolves.toBe(true);

    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-1");
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
    runtimeConfig.resetDraft();
    runtimeConfig.dispose();
  });

  it.each(["autosave", "patch"] as const)(
    "orders a %s acknowledgement after an older in-flight config load",
    async (operation) => {
      vi.useFakeTimers();
      const staleLoad = deferred<ConfigSnapshot>();
      let getCalls = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "config.get") {
          getCalls += 1;
          if (getCalls === 2) {
            return staleLoad.promise;
          }
          return {
            config: { count: 1 },
            raw: '{"count":1}',
            hash: "hash-1",
            valid: true,
            issues: [],
          };
        }
        if (method === "config.patch" || method === "config.set") {
          return { config: { count: 1, patched: true }, hash: "hash-2" };
        }
        return {};
      });
      const { runtimeConfig } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      await runtimeConfig.ensureLoaded();

      const staleRefresh = runtimeConfig.refresh();
      expect(getCalls).toBe(2);
      if (operation === "autosave") {
        runtimeConfig.patchForm(["patched"], true);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      } else {
        await expect(
          runtimeConfig.patch({ raw: { patched: true }, note: "ordered patch test" }),
        ).resolves.toBe(true);
      }
      expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");

      staleLoad.resolve({
        config: { count: 1 },
        raw: '{"count":1}',
        hash: "hash-1",
        valid: true,
        issues: [],
      });
      await staleRefresh;
      expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");
      expect(runtimeConfig.state.configForm).toEqual({ count: 1, patched: true });
      // A refresh requested after the ack still owns its new snapshot.
      await runtimeConfig.refresh();
      expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-1");
      expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
      runtimeConfig.dispose();
    },
  );

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
      return method === "config.patch" ? { config: { count: 2 }, hash: "hash-2" } : {};
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
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

  it("adopts the acked autosave without a follow-up reload", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
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
});
