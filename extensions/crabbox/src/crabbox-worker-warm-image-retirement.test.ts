import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { operationLeaseId } from "./crabbox-worker-profile.js";
import { listCrabboxWarmImages } from "./crabbox-worker-warm-image-store.js";
import {
  captureWarmImage,
  checkpointResult,
  commandResult,
  createWarmProvider,
  openWarmImageStore,
  provisionWarmProfile,
  PROFILE,
  type CommandCall,
} from "./crabbox-worker-warm-image.test-support.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

describe("Crabbox checkpoint retirement", () => {
  it.each(["expiry", "capacity", "missing"])(
    "retains failed retirement through reuse, restart, deferred refresh, and %s cleanup",
    async (cleanup) => {
      let captures = 0;
      let failDeletion = true;
      let missing = false;
      const resources = new Set<string>();
      const command = ({ argv }: CommandCall) => {
        if (argv[2] === "create") {
          const id = `chk_capture_${++captures}`;
          resources.add(id);
          return checkpointResult(id, argv[argv.indexOf("--id") + 1]!, "pending");
        }
        if (argv[2] === "delete") {
          if (failDeletion) {
            return commandResult({ code: 7, stderr: "provider delete unavailable" });
          }
          resources.delete(argv[3]!);
        }
        if (missing && argv[2] === "inspect") {
          return commandResult({
            stdout: JSON.stringify({
              localState: "available",
              providerState: "missing",
              nextAction: "delete",
            }),
          });
        }
        return undefined;
      };
      const initial = createWarmProvider(command);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      await captureWarmImage(initial.provider);
      clock.mockReturnValue(now + DAY_MS);
      await captureWarmImage(initial.provider, PROFILE, "refresh");
      expect(resources).toEqual(new Set(["chk_capture_1", "chk_capture_2"]));
      initial.provider.dispose();
      resetPluginStateStoreForTests();
      const restarted = createWarmProvider(command, initial.stateDir);
      clock.mockReturnValue(now + 2 * DAY_MS);
      await captureWarmImage(restarted.provider, PROFILE, "repeat-refresh");
      expect(captures).toBe(2);
      expect(restarted.calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe("chk_capture_2");
      expect(restarted.calls.at(-1)?.argv[1]).toBe("stop");
      const store = openWarmImageStore();
      const image = store.entries()[0]!;
      if (cleanup === "expiry") {
        clock.mockReturnValue(now + 17 * DAY_MS);
        const lease = { leaseId: operationLeaseId("inspection-only"), profile: PROFILE };
        await restarted.provider.inspect(lease);
        await restarted.provider.destroy(lease);
      } else if (cleanup === "capacity") {
        for (let index = 0; index < 127; index++) {
          store.register(`reserved-${index}`, {
            ...image.value,
            checkpointId: "",
            operation: {
              type: "capture",
              id: `claim-${index}`,
              startedAtMs: now,
              leaseId: `cbx_${index}`,
              provider: "aws",
              phase: "creating",
            },
          });
        }
        await captureWarmImage(restarted.provider, { ...PROFILE, class: "fast" }, "at-capacity");
        expect(store.entries()).toHaveLength(128);
        expect(captures).toBe(2);
      } else {
        // Recheck a pending replacement while its predecessor still needs deletion.
        store.register(image.key, { ...store.lookup(image.key)!, state: "pending" });
        missing = true;
        await captureWarmImage(restarted.provider, PROFILE, "missing-replacement");
        missing = false;
        expect(captures).toBe(2);
      }
      expect(store.lookup(image.key)?.checkpointId).toBe("chk_capture_2");
      expect(
        listCrabboxWarmImages().find((entry) => entry.profileKey === image.key)?.retirement
          ?.checkpointId,
      ).toBe("chk_capture_1");
      expect(resources).toEqual(new Set(["chk_capture_1", "chk_capture_2"]));

      failDeletion = false;
      const recovered = await provisionWarmProfile(
        restarted.provider,
        PROFILE,
        "deletion-recovered",
      );
      expect(resources.has("chk_capture_1")).toBe(false);
      if (cleanup !== "expiry") {
        expect(resources).toEqual(new Set(["chk_capture_2"]));
        expect(restarted.calls.findLast(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(
          "chk_capture_2",
        );
      } else {
        expect(resources).toEqual(new Set());
      }
      await restarted.provider.destroy({
        leaseId: recovered.leaseId,
        profile: { ...PROFILE, warmImage: false },
      });
    },
  );

  it.each([false, true])(
    "does not clear or misreport newer state after an older retirement finishes (fails=%s)",
    async (fails) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      let captures = 0;
      let blockDelete = true;
      const { provider, calls, warn } = createWarmProvider(async ({ argv }) => {
        if (argv[2] === "create") {
          return checkpointResult(
            `chk_generation_${++captures}`,
            argv[argv.indexOf("--id") + 1]!,
            "available",
          );
        }
        if (argv[2] === "delete" && blockDelete) {
          blockDelete = false;
          entered.resolve();
          await release.promise;
          if (fails) {
            return commandResult({ code: 7, stderr: "late delete failure" });
          }
        }
        return undefined;
      });
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      await captureWarmImage(provider);
      const lease = await provisionWarmProfile(provider, PROFILE, "first-refresh");
      clock.mockReturnValue(now + DAY_MS);
      const stopping = provider.destroy({ leaseId: lease.leaseId, profile: PROFILE });
      await entered.promise;
      try {
        clock.mockReturnValue(now + 2 * DAY_MS);
        await captureWarmImage(provider, PROFILE, "newer-refresh");
        expect(captures).toBe(3);
      } finally {
        release.resolve();
      }
      await stopping;
      expect(listCrabboxWarmImages()[0]).toMatchObject({ checkpointId: "chk_generation_3" });
      expect(listCrabboxWarmImages()[0]?.retirement).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      calls.length = 0;
      await provisionWarmProfile(provider, PROFILE, "final-reuse");
      expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe("chk_generation_3");
    },
  );
  it.each(["expiry", "capacity", "missing"])(
    "reports retained current-image deletion failures during %s cleanup",
    async (cleanup) => {
      let cleaning = false;
      const { provider, calls, warn } = createWarmProvider(({ argv }) => {
        if (cleaning && argv[2] === "delete" && argv[3] === "chk_profile_warm") {
          return commandResult({ code: 7, stderr: "provider delete unavailable" });
        }
        if (cleaning && cleanup === "missing" && argv[2] === "inspect") {
          return commandResult({
            stdout: JSON.stringify({
              localState: "available",
              providerState: "missing",
              nextAction: "delete",
            }),
          });
        }
        return undefined;
      });
      await captureWarmImage(provider);
      const store = openWarmImageStore();
      const image = store.entries()[0]!;
      const now = Date.now();
      if (cleanup === "capacity") {
        for (let index = 0; index < 127; index++) {
          store.register(`idle-${index}`, {
            ...image.value,
            checkpointId: `chk_idle_${index}`,
            lastUsedAtMs: now + 1,
          });
        }
      } else if (cleanup === "expiry") {
        vi.spyOn(Date, "now").mockReturnValue(now + 15 * DAY_MS);
      }
      cleaning = true;
      await captureWarmImage(
        provider,
        cleanup === "capacity" ? { ...PROFILE, class: "fast" } : PROFILE,
        "cleanup",
      );
      expect(store.lookup(image.key)).toMatchObject({
        checkpointId: "chk_profile_warm",
        operation: { type: "retire", checkpointId: "chk_profile_warm" },
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /checkpoint retirement.*chk_profile_warm.*retained.*retry.*openclaw crabbox warm-images/iu,
        ),
      );
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("warm image capture failed"));
      expect(calls.at(-1)?.argv[1]).toBe("stop");
    },
  );
});
