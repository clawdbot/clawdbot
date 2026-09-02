import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
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
  PROFILE,
} from "./crabbox-worker-warm-image.test-support.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

describe("Crabbox capture recovery", () => {
  it.each([
    { phase: "scrub", fails: false },
    { phase: "scrub", fails: true },
    { phase: "create", fails: false },
    { phase: "create", fails: true },
  ])(
    "keeps an old $phase claim owned during warm reuse and a second teardown (fails=$fails)",
    async ({ phase, fails }) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      let block = false;
      let phaseEntered = false;
      const initial = createWarmProvider(async ({ argv }) => {
        const isPhase = phase === "create" ? argv[2] === "create" : argv[1] === "run";
        if (block && isPhase && !phaseEntered) {
          phaseEntered = true;
          entered.resolve();
          await release.promise;
          if (fails) {
            return commandResult({ code: 7, stderr: "capture phase failed" });
          }
        }
        if (block && argv[2] === "create") {
          return checkpointResult("chk_after_delay", argv[argv.indexOf("--id") + 1]!, "available");
        }
        return undefined;
      });
      await captureWarmImage(initial.provider);
      const first = await provisionWarmProfile(initial.provider, PROFILE, "first");
      const second = await provisionWarmProfile(initial.provider, PROFILE, "second");
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const store = openWarmImageStore();
      const image = store.entries()[0]!;
      store.register(image.key, {
        ...image.value,
        image: { ...image.value.image!, createdAtMs: now - DAY_MS },
      });
      block = true;
      const stopping = initial.provider.destroy({ leaseId: first.leaseId, profile: PROFILE });
      await entered.promise;
      const selector = listCrabboxWarmImages()[0]?.capture?.selector;
      try {
        // Neither the former stale threshold nor image retention transfers capture ownership.
        clock.mockReturnValue(now + 15 * DAY_MS);
        await initial.provider.destroy({ leaseId: second.leaseId, profile: PROFILE });
        expect(listCrabboxWarmImages()[0]?.capture).toMatchObject({ selector, stale: true });
        expect(store.lookup(image.key)?.image?.checkpointId).toBe(CHECKPOINT_ID);
        const reused = await provisionWarmProfile(initial.provider, PROFILE, "while-capturing");
        expect(initial.calls.findLast(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(
          CHECKPOINT_ID,
        );
        await initial.provider.destroy({ leaseId: reused.leaseId, profile: PROFILE });
        expect(initial.calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(
          phase === "create" ? 2 : 1,
        );
      } finally {
        release.resolve();
      }
      await stopping;
      expect(initial.calls.some(({ argv }) => argv[1] === "stop")).toBe(true);
      if (!fails) {
        expect(initial.calls.at(-1)?.argv[2]).toBe("delete");
      }
      expect(store.lookup(image.key)?.image?.checkpointId).toBe(
        fails ? CHECKPOINT_ID : "chk_after_delay",
      );
      expect(listCrabboxWarmImages()[0]?.capture?.selector).toBe(
        fails && phase === "create" ? selector : undefined,
      );
    },
  );

  it("reopens an uncertain create without admitting another capture, then recovers the exact claim", async () => {
    let failCreate = false;
    const initial = createWarmProvider(({ argv }) =>
      failCreate && argv[2] === "create"
        ? commandResult({ termination: "timeout", code: null, killed: true })
        : undefined,
    );
    await captureWarmImage(initial.provider);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + DAY_MS);
    failCreate = true;
    await captureWarmImage(initial.provider, PROFILE, "uncertain");
    const selector = listCrabboxWarmImages()[0]!.capture!.selector;
    await initial.provider.dispose();
    resetPluginStateStoreForTests();
    clock.mockReturnValue(now + 2 * DAY_MS);
    const restarted = createWarmProvider(undefined, initial.stateDir);
    await captureWarmImage(restarted.provider, PROFILE, "after-restart");
    expect(restarted.calls.some(({ argv }) => argv[2] === "create")).toBe(false);
    expect(restarted.calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
    expect(listCrabboxWarmImages()[0]?.capture?.selector).toBe(selector);
    recoverCrabboxWarmImageCapture(selector, true);
    expect(listCrabboxWarmImages()[0]?.checkpointId).toBe(CHECKPOINT_ID);
    await captureWarmImage(restarted.provider, PROFILE, "after-recovery");
    expect(restarted.calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
  });

  it.each([false, true])(
    "fences a scrub completion after exact recovery closes its claim (fails=%s)",
    async (fails) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      let block = false;
      const { provider, calls } = createWarmProvider(async ({ argv }) => {
        if (block && argv[1] === "run") {
          block = false;
          entered.resolve();
          await release.promise;
          return fails ? commandResult({ code: 7 }) : undefined;
        }
        return undefined;
      });
      await captureWarmImage(provider);
      const store = openWarmImageStore();
      const image = store.entries()[0]!;
      store.register(image.key, {
        ...image.value,
        image: { ...image.value.image!, createdAtMs: Date.now() - DAY_MS },
      });
      const lease = await provisionWarmProfile(provider, PROFILE, "closed-scrub");
      block = true;
      const stopping = provider.destroy({ leaseId: lease.leaseId, profile: PROFILE });
      await entered.promise;
      try {
        // Simulates the ownership handoff; a closed scrub must never issue create.
        recoverCrabboxWarmImageCapture(listCrabboxWarmImages()[0]!.capture!.selector, true);
        store.update?.(
          image.key,
          (current) =>
            current && {
              ...current,
              operation: {
                type: "capture",
                id: "replacement-generation",
                leaseId: "cbx_replacement",
                provider: "aws",
                startedAtMs: Date.now(),
                phase: "scrubbing",
              },
            },
        );
      } finally {
        release.resolve();
      }
      await stopping;
      expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
      expect(listCrabboxWarmImages()[0]?.capture?.selector).toBe("replacement-generation");
      expect(listCrabboxWarmImages()[0]?.checkpointId).toBe(CHECKPOINT_ID);
    },
  );
  it("reclaims an idle image rather than a capture-owned last-good image at capacity", async () => {
    const { provider, calls } = createWarmProvider();
    await captureWarmImage(provider);
    const store = openWarmImageStore();
    const image = store.entries()[0]!;
    const now = Date.now();
    const retained = {
      ...image.value,
      image: { ...image.value.image!, lastUsedAtMs: now - DAY_MS },
      operation: {
        type: "capture" as const,
        id: "capacity-capture",
        startedAtMs: now,
        leaseId: "cbx_capturing",
        provider: "aws",
        phase: "creating" as const,
      },
    };
    store.register(image.key, retained);
    for (let index = 0; index < 127; index++) {
      store.register(`idle-${index}`, {
        ...image.value,
        image: { ...image.value.image!, checkpointId: `chk_idle_${index}`, lastUsedAtMs: now },
      });
    }
    calls.length = 0;
    await captureWarmImage(provider, { ...PROFILE, class: "fast" }, "different-profile");
    expect(calls.filter(({ argv }) => argv[2] === "delete").map(({ argv }) => argv[3])).toEqual([
      "chk_idle_0",
    ]);
    expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
    expect(store.lookup(image.key)).toEqual(retained);
    expect(store.entries()).toHaveLength(128);
  });
});
