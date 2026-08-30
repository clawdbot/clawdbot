import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { operationLeaseId } from "./crabbox-worker-profile.js";
import {
  listCrabboxWarmImages,
  recoverCrabboxWarmImageCapture,
} from "./crabbox-worker-warm-image-store.js";
import {
  captureWarmImage,
  checkpointResult,
  commandResult,
  createWarmProvider,
  openWarmImageStore,
  provisionWarmProfile,
  CHECKPOINT_ID,
  LEASE_ID,
  PROFILE,
  type CommandCall,
} from "./crabbox-worker-warm-image.test-support.js";

describe("Crabbox warm-image lifecycle ownership", () => {
  it.each([
    { ageMs: 24 * 60 * 60 * 1_000 - 1, refreshed: false, deleteFails: false },
    { ageMs: 24 * 60 * 60 * 1_000, refreshed: true, deleteFails: false },
    { ageMs: 24 * 60 * 60 * 1_000, refreshed: true, deleteFails: true },
  ])(
    "refreshes=$refreshed after $ageMs ms, preserves warm reuse, and cleans up after restart when deleteFails=$deleteFails",
    async ({ ageMs, refreshed, deleteFails }) => {
      let refreshing = false;
      let failOldDeletion = deleteFails;
      let checkpointAtDeletion: string | undefined;
      const replacementId = "chk_profile_refreshed";
      const providerCheckpoints = new Set<string>();
      const command = ({ argv }: CommandCall) => {
        if (argv[1] !== "checkpoint") {
          return undefined;
        }
        if (argv[2] === "create") {
          const checkpointId = refreshing ? replacementId : CHECKPOINT_ID;
          providerCheckpoints.add(checkpointId);
          return checkpointResult(checkpointId, argv[argv.indexOf("--id") + 1]!, "pending");
        }
        if (argv[2] === "delete") {
          const checkpointId = argv[3];
          if (!checkpointId) {
            throw new Error("Expected a checkpoint deletion ID");
          }
          if (checkpointId === CHECKPOINT_ID) {
            checkpointAtDeletion = openWarmImageStore().entries()[0]?.value.checkpointId;
            if (failOldDeletion) {
              return commandResult({ code: 7, stderr: "delete failed" });
            }
          }
          providerCheckpoints.delete(checkpointId);
          return commandResult();
        }
        return undefined;
      };
      const { provider, calls, warn, stateDir } = createWarmProvider(command);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      await captureWarmImage(provider);
      const lease = await provisionWarmProfile(provider, PROFILE, `provision:v2:${"1".repeat(64)}`);
      const store = openWarmImageStore();
      const [image] = store.entries();
      if (!image) {
        throw new Error("Expected a captured warm image");
      }
      clock.mockReturnValue(now + ageMs);
      calls.length = 0;
      refreshing = true;

      await provider.destroy({ leaseId: lease.leaseId, profile: PROFILE });

      expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(refreshed ? 1 : 0);
      expect(calls.filter(({ argv }) => argv[2] === "delete").map(({ argv }) => argv[3])).toEqual(
        refreshed ? [CHECKPOINT_ID] : [],
      );
      const retainedId = refreshed ? replacementId : CHECKPOINT_ID;
      expect(store.lookup(image.key)?.checkpointId).toBe(retainedId);
      expect(checkpointAtDeletion).toBe(refreshed ? replacementId : undefined);
      expect(warn).toHaveBeenCalledTimes(deleteFails ? 1 : 0);
      if (deleteFails) {
        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(
            /checkpoint retirement.*chk_profile_warm.*retained.*retry.*openclaw crabbox warm-images/iu,
          ),
        );
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("warm image capture failed"));
      }
      expect(calls.at(-1)?.argv[1]).toBe("stop");

      failOldDeletion = false;
      provider.dispose();
      resetPluginStateStoreForTests();
      const restarted = createWarmProvider(command, stateDir);
      const restartedLease = await provisionWarmProfile(
        restarted.provider,
        PROFILE,
        `provision:v2:${"2".repeat(64)}`,
      );
      expect(restarted.calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(retainedId);
      expect(providerCheckpoints.has(retainedId)).toBe(true);
      expect(providerCheckpoints).toEqual(
        new Set(deleteFails ? [CHECKPOINT_ID, retainedId] : [retainedId]),
      );
      expect(listCrabboxWarmImages()[0]?.retirement?.checkpointId).toBe(
        deleteFails ? CHECKPOINT_ID : undefined,
      );
      expect(restarted.calls.some(({ argv }) => argv[2] === "delete")).toBe(false);
      expect(restarted.calls.some(({ argv }) => argv[1] === "warmup")).toBe(false);
      await restarted.provider.destroy({ leaseId: restartedLease.leaseId, profile: PROFILE });
      expect(providerCheckpoints).toEqual(new Set([retainedId]));
      expect(listCrabboxWarmImages()[0]?.retirement).toBeUndefined();
      expect(
        restarted.calls.filter(({ argv }) => argv[2] === "delete").map(({ argv }) => argv[3]),
      ).toEqual(deleteFails ? [CHECKPOINT_ID] : []);
      expect(restarted.calls.at(-1)?.argv[1]).toBe("stop");

      clock.mockReturnValue(now + ageMs + 14 * 24 * 60 * 60 * 1_000 + 1);
      // This lease was never enrolled, so teardown sweeps without capturing another image.
      const inspectionOnlyLease = {
        leaseId: operationLeaseId(`provision:v2:${"3".repeat(64)}`),
        profile: PROFILE,
      };
      for (let sweep = 0; sweep < 2; sweep++) {
        await restarted.provider.inspect(inspectionOnlyLease);
        await restarted.provider.destroy(inspectionOnlyLease);
        expect(restarted.calls.at(-1)?.argv[1]).toBe("stop");
      }
      expect(restarted.calls.some(({ argv }) => argv[2] === "create")).toBe(false);
      expect(restarted.warn).not.toHaveBeenCalled();
      expect(providerCheckpoints).toEqual(new Set());
    },
  );

  it.each(["run", "create"])("retains the old warm image when refresh %s fails", async (action) => {
    let refreshing = false;
    const { provider, calls, warn } = createWarmProvider(({ argv }) =>
      refreshing && (argv[1] === action || argv[2] === action)
        ? commandResult({ code: 7, stderr: "refresh failed" })
        : undefined,
    );
    await captureWarmImage(provider);
    const lease = await provisionWarmProfile(provider);
    const store = openWarmImageStore();
    const [image] = store.entries();
    if (!image) {
      throw new Error("Expected a captured warm image");
    }
    const existing = { ...image.value, createdAtMs: Date.now() - 24 * 60 * 60 * 1_000 };
    store.register(image.key, existing);
    calls.length = 0;
    refreshing = true;

    await provider.destroy({ leaseId: lease.leaseId, profile: PROFILE });

    expect(warn).toHaveBeenCalledOnce();
    expect(store.lookup(image.key)).toMatchObject(existing);
    expect(listCrabboxWarmImages()[0]?.capture?.phase).toBe(
      action === "create" ? "uncertain" : undefined,
    );
    expect(calls.some(({ argv }) => argv[2] === "delete")).toBe(false);
    refreshing = false;
    calls.length = 0;
    await provisionWarmProfile(provider);
    expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(false);
  });

  it.each([
    { action: "inspect", missing: false },
    { action: "inspect", missing: true },
    { action: "fork", missing: false },
  ])(
    "preserves a refreshed image when an older $action finishes afterward (missing=$missing)",
    async ({ action, missing }) => {
      const commandBlocked = createDeferred<void>();
      const started = createDeferred<void>();
      let blockNext = false;
      let refreshing = false;
      const replacementId = "chk_profile_refreshed";
      const { provider, calls } = createWarmProvider(async ({ argv }) => {
        if (blockNext && argv[2] === action) {
          blockNext = false;
          started.resolve();
          await commandBlocked.promise;
          if (missing) {
            return commandResult({
              stdout: JSON.stringify({
                localState: "available",
                providerState: "missing",
                nextAction: "delete",
              }),
            });
          }
        }
        if (refreshing && argv[2] === "create") {
          return checkpointResult(replacementId, LEASE_ID, "available");
        }
        return undefined;
      });
      await captureWarmImage(provider);
      const lease = await provisionWarmProfile(provider);
      const store = openWarmImageStore();
      const [image] = store.entries();
      if (!image) {
        throw new Error("Expected a captured warm image");
      }
      store.register(image.key, {
        ...image.value,
        state: action === "inspect" ? "pending" : "available",
        createdAtMs: Date.now() - 24 * 60 * 60 * 1_000,
      });
      blockNext = true;
      const provisioning = provisionWarmProfile(
        provider,
        PROFILE,
        `provision:v2:${"1".repeat(64)}`,
      );
      await started.promise;
      refreshing = true;
      try {
        await provider.destroy({ leaseId: lease.leaseId, profile: PROFILE });
      } finally {
        commandBlocked.resolve();
      }
      await provisioning;

      expect(store.lookup(image.key)?.checkpointId).toBe(replacementId);
      calls.length = 0;
      await provisionWarmProfile(provider, PROFILE, `provision:v2:${"2".repeat(64)}`);
      expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(replacementId);
    },
  );

  it("deletes the provider snapshot before forgetting an image unused for fourteen days", async () => {
    const { provider, calls } = createWarmProvider();
    await captureWarmImage(provider);
    const expiredAt = Date.now() + 14 * 24 * 60 * 60 * 1_000;
    vi.spyOn(Date, "now").mockReturnValue(expiredAt);
    calls.length = 0;

    await provisionWarmProfile(provider);

    expect(calls.find(({ argv }) => argv[2] === "delete")?.argv.slice(1)).toEqual([
      "checkpoint",
      "delete",
      CHECKPOINT_ID,
    ]);
    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(true);
    expect(calls.some(({ argv }) => argv[2] === "fork")).toBe(false);
  });

  it("deletes the least-recently-used provider snapshot before admitting a 129th image", async () => {
    const { provider, calls } = createWarmProvider();
    const store = openWarmImageStore();
    const now = Date.now();
    for (let index = 0; index < 128; index += 1) {
      store.register(`image-${index}`, {
        checkpointId: `chk_image_${index}`,
        kind: "aws-ebs-snapshot",
        state: "available",
        createdAtMs: now,
        lastUsedAtMs: now - (index === 42 ? 1_000 : 0),
      });
    }

    await captureWarmImage(provider);

    const deleted = calls.findIndex(({ argv }) => argv[2] === "delete");
    const created = calls.findIndex(({ argv }) => argv[2] === "create");
    expect(calls[deleted]?.argv.slice(1)).toEqual(["checkpoint", "delete", "chk_image_42"]);
    expect(deleted).toBeLessThan(created);
    expect(store.lookup("image-42")).toBeUndefined();
    expect(store.lookup("image-0")?.checkpointId).toBe("chk_image_0");
    expect(store.entries()).toHaveLength(128);
  });

  it("pauses an abandoned empty reservation after restart until exact acknowledged recovery", async () => {
    const initial = createWarmProvider();
    await captureWarmImage(initial.provider);
    const store = openWarmImageStore();
    const [image] = store.entries();
    if (!image) {
      throw new Error("Expected a captured warm image");
    }
    store.register(image.key, {
      ...image.value,
      checkpointId: "",
      // Reservation staleness covers the slowest (machine0) capture budget twice over.
      createdAtMs: Date.now() - 1_200_001,
    });

    const restarted = createWarmProvider(undefined, initial.stateDir);
    await captureWarmImage(restarted.provider);

    expect(restarted.calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(0);
    expect(restarted.calls.some(({ argv }) => argv[2] === "delete")).toBe(false);
    const capture = listCrabboxWarmImages()[0]?.capture;
    expect(capture?.stale).toBe(true);
    expect(capture?.leaseId).toBeUndefined();
    recoverCrabboxWarmImageCapture(capture!.selector, true);
    await captureWarmImage(restarted.provider);
    expect(restarted.calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
    expect(store.lookup(image.key)?.checkpointId).toBe(CHECKPOINT_ID);
  });

  it.each([false, true])(
    "reserves one capture when leases stop concurrently (refresh=%s)",
    async (refresh) => {
      const scrubBlocked = createDeferred<void>();
      let capturing = false;
      const { provider, calls } = createWarmProvider(async ({ argv }) => {
        if (capturing && argv[1] === "run") {
          await scrubBlocked.promise;
        }
        return undefined;
      });
      const first = await provisionWarmProfile(provider);
      const secondOperationId = `provision:v2:${"1".repeat(64)}`;
      const second = await provisionWarmProfile(provider, PROFILE, secondOperationId);
      if (refresh) {
        await captureWarmImage(provider, PROFILE, `provision:v2:${"2".repeat(64)}`);
        const store = openWarmImageStore();
        const [image] = store.entries();
        if (!image) {
          throw new Error("Expected a captured warm image");
        }
        store.register(image.key, {
          ...image.value,
          createdAtMs: Date.now() - 24 * 60 * 60 * 1_000,
        });
      }
      calls.length = 0;
      capturing = true;

      const firstDestroy = provider.destroy({ leaseId: first.leaseId, profile: PROFILE });
      await vi.waitFor(() =>
        expect(
          calls.some(
            ({ argv, options }) =>
              argv[1] === "run" && options.input?.toString().includes("CRABBOX_SCRUB_NODE_SCRIPT"),
          ),
        ).toBe(true),
      );
      const secondDestroy = provider.destroy({ leaseId: second.leaseId, profile: PROFILE });
      await secondDestroy;
      scrubBlocked.resolve();
      await firstDestroy;

      expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
      expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(2);
    },
  );
});
