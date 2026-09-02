import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { WarmProfileRecord } from "./crabbox-worker-warm-image-store.js";
import {
  commandResult,
  createWarmProvider,
  openWarmImageStore,
  provisionWarmProfile,
  PROFILE,
} from "./crabbox-worker-warm-image.test-support.js";

const RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const context = () => ({
  profiles: [PROFILE],
  signal: new AbortController().signal,
  assertCurrent() {},
});
const expiredImage = (id: string): WarmProfileRecord => ({
  version: 2,
  allocations: {},
  image: {
    checkpointId: id,
    kind: "aws-ebs-snapshot",
    state: "available",
    createdAtMs: Date.now() - RETENTION_MS,
    lastUsedAtMs: Date.now() - RETENTION_MS,
  },
});

describe("Crabbox idle image maintenance", () => {
  it("preserves demand timestamps, capture ownership, and allocation pins without running setup", async () => {
    const { provider, calls } = createWarmProvider();
    const store = openWarmImageStore();
    const recent = expiredImage("chk_recent");
    recent.image!.lastUsedAtMs = Date.now();
    const pinned = expiredImage("chk_pinned");
    pinned.allocations.cbx_pending = {
      choice: { kind: "checkpoint", checkpointId: "chk_pinned" },
      machineClass: "standard",
      phase: "pending",
    };
    const capturing = expiredImage("chk_capturing");
    capturing.operation = {
      type: "capture",
      id: "capture-owner",
      phase: "uncertain",
      startedAtMs: Date.now(),
    };
    for (const [key, record] of Object.entries({ recent, pinned, capturing })) {
      store.register(key, record);
    }
    store.register("expired", expiredImage("chk_expired"));
    const profile = {
      ...PROFILE,
      setup: "echo configured",
      setupEnv: ["MISSING_MAINTENANCE_SETUP_VALUE"],
      warmImage: false,
    };
    vi.stubEnv("MISSING_MAINTENANCE_SETUP_VALUE", undefined);

    await provider.maintain!({ ...context(), profiles: [profile] });

    expect(calls.map(({ argv }) => argv.slice(1))).toEqual([
      ["checkpoint", "delete", "chk_expired"],
    ]);
    expect(store.lookup("expired")).toBeUndefined();
    for (const [key, record] of Object.entries({ recent, pinned, capturing })) {
      expect(store.lookup(key)).toEqual(record);
    }
  });

  it("retains failed deletion for a later idle sweep", async () => {
    let fails = true;
    const { provider, warn } = createWarmProvider(({ argv }) =>
      argv[2] === "delete" && fails
        ? commandResult({ code: 7, stderr: "fixture deletion unavailable" })
        : undefined,
    );
    const store = openWarmImageStore();
    store.register("expired", expiredImage("chk_expired"));
    await provider.maintain!(context());
    expect(store.lookup("expired")?.operation).toEqual({
      type: "retire",
      checkpointId: "chk_expired",
    });
    expect(warn).toHaveBeenCalledOnce();
    fails = false;
    await provider.maintain!(context());
    expect(store.lookup("expired")).toBeUndefined();
  });

  it.each(["dispose", "authority"] as const)(
    "fences %s during deletion and retains its obligation until an active retry",
    async (boundary) => {
      const started = createDeferred<AbortSignal>();
      const finish = createDeferred<void>();
      const { provider, stateDir } = createWarmProvider(async ({ argv, options }) => {
        if (argv[2] !== "delete") {
          return undefined;
        }
        started.resolve(options.signal!);
        await finish.promise;
        return commandResult();
      });
      const store = openWarmImageStore();
      store.register("expired", expiredImage("chk_expired"));
      let current = true;
      const maintenance = provider.maintain!({
        ...context(),
        assertCurrent() {
          if (!current) {
            throw new Error("maintenance authority closed");
          }
        },
      });
      const rejected = expect(maintenance).rejects.toThrow();
      let stopping: Promise<void> | undefined;
      let stopped = false;
      try {
        const signal = await started.promise;
        // Allocation has its own queue and must not wait on the pending deletion.
        await expect(
          provisionWarmProfile(provider, PROFILE, "during-maintenance"),
        ).resolves.toMatchObject({ node: { deviceId: "device-1" } });
        current = false;
        if (boundary === "dispose") {
          stopping = provider.dispose().then(() => {
            stopped = true;
          });
          expect(signal.aborted).toBe(true);
          await Promise.resolve();
          expect(stopped).toBe(false);
        }
      } finally {
        finish.resolve();
        await rejected;
        await stopping;
      }
      expect(store.lookup("expired")?.operation).toEqual({
        type: "retire",
        checkpointId: "chk_expired",
      });
      const replacement = createWarmProvider(undefined, stateDir);
      await replacement.provider.maintain!(context());
      expect(store.lookup("expired")).toBeUndefined();
      if (boundary === "dispose") {
        expect(stopped).toBe(true);
        expect(() => provider.maintain!(context())).toThrow();
      }
    },
  );

  it("leaves ambiguous executable contexts visible without guessing a checkpoint catalog", async () => {
    const { provider, calls, warn } = createWarmProvider();
    const store = openWarmImageStore();
    const image = expiredImage("chk_expired");
    store.register("expired", image);
    await provider.maintain!({
      ...context(),
      profiles: [PROFILE, { ...PROFILE, binary: "/custom/crabbox" }],
    });
    expect(calls).toEqual([]);
    expect(store.lookup("expired")).toEqual(image);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("one configured CLI executable"));
  });
});
