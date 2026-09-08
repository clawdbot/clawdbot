// Guards the resolveMocks serialization pin: passes run sequentially so a
// drained snapshot is never registered (and its mock modules never
// invalidated) twice, while every caller's pass starts at or after its call so
// previously queued ids are registered before the caller's fetch proceeds.
import { describe, expect, it } from "vitest";
import { createDeferred } from "./helpers/promise.js";
import { drainMockerResolveMocks, serializeMockerResolveMocks } from "./non-isolated-runner.js";

// Mirrors BareModuleMocker.resolveMocks: snapshots the static queue's contents
// at pass start, awaits its RPCs, then reassigns the static to [] so ids
// pushed during the await land in the abandoned array.
class FakeMocker {
  static pendingIds: unknown[] = [];
  beforeFirstPass?: () => Promise<void>;
  nextPassError?: Error;
  passes = 0;
  active = 0;
  maxConcurrentPasses = 0;
  processed: unknown[] = [];
  resetObservations: Array<{ active: number; pendingIds: unknown[]; processed: unknown[] }> = [];

  async resolveMocks(): Promise<void> {
    if (FakeMocker.pendingIds.length === 0) {
      return;
    }
    this.active += 1;
    this.maxConcurrentPasses = Math.max(this.maxConcurrentPasses, this.active);
    this.passes += 1;
    const snapshot = [...FakeMocker.pendingIds];
    // Every pass must suspend like the awaited RPCs, even without a gate.
    await (this.passes === 1 ? this.beforeFirstPass?.() : undefined);
    const passError = this.nextPassError;
    this.nextPassError = undefined;
    if (passError) {
      FakeMocker.pendingIds = [];
      this.active -= 1;
      throw passError;
    }
    this.processed.push(...snapshot);
    FakeMocker.pendingIds = [];
    this.active -= 1;
  }

  reset(): void {
    this.resetObservations.push({
      active: this.active,
      pendingIds: [...FakeMocker.pendingIds],
      processed: [...this.processed],
    });
  }
}

function pauseFirstPass(mocker: FakeMocker): { started: Promise<void>; release: () => void } {
  const started = createDeferred();
  const gate = createDeferred();
  mocker.beforeFirstPass = () => {
    started.resolve();
    return gate.promise;
  };
  return { started: started.promise, release: gate.resolve };
}

describe("serializeMockerResolveMocks", () => {
  it("serializes concurrent callers and never re-registers a drained snapshot", async () => {
    FakeMocker.pendingIds = ["mock-a", "mock-b"];
    const mocker = new FakeMocker();
    serializeMockerResolveMocks(mocker);

    await Promise.all([mocker.resolveMocks(), mocker.resolveMocks(), mocker.resolveMocks()]);

    expect(mocker.maxConcurrentPasses).toBe(1);
    // Later chained passes see the cleared queue and no-op instead of
    // re-registering (and re-invalidating) the same snapshot.
    expect(mocker.passes).toBe(1);
    expect(mocker.processed).toEqual(["mock-a", "mock-b"]);
    expect(FakeMocker.pendingIds).toEqual([]);
  });

  it("registers ids queued while a pass is in flight before the later caller resolves", async () => {
    FakeMocker.pendingIds = ["mock-a"];
    const mocker = new FakeMocker();
    const { started, release } = pauseFirstPass(mocker);
    serializeMockerResolveMocks(mocker);

    const first = mocker.resolveMocks();
    await started;
    // Upstream would abandon this push when it reassigns pendingIds to [];
    // the wrapper must requeue it and the second caller's own chained pass
    // must register it before that caller proceeds with its fetch.
    FakeMocker.pendingIds.push("mock-late");
    const second = mocker.resolveMocks();
    release();
    await second;

    expect(mocker.processed).toEqual(["mock-a", "mock-late"]);
    expect(mocker.passes).toBe(2);
    expect(mocker.maxConcurrentPasses).toBe(1);
    await first;
    expect(FakeMocker.pendingIds).toEqual([]);
  });

  it("drains ids queued during the final pass without requiring another caller", async () => {
    FakeMocker.pendingIds = ["mock-a"];
    const mocker = new FakeMocker();
    const { started, release } = pauseFirstPass(mocker);
    serializeMockerResolveMocks(mocker);

    const first = mocker.resolveMocks();
    await started;
    FakeMocker.pendingIds.push("mock-late");
    release();
    await first;

    expect(mocker.processed).toEqual(["mock-a", "mock-late"]);
    expect(mocker.passes).toBe(2);
    expect(FakeMocker.pendingIds).toEqual([]);
  });

  it("does not double-wrap when installed repeatedly", async () => {
    FakeMocker.pendingIds = ["mock-a"];
    const mocker = new FakeMocker();
    serializeMockerResolveMocks(mocker);
    // Identity check: a second install must keep the first wrapper in place.
    const wrapped: unknown = Reflect.get(mocker, "resolveMocks");
    serializeMockerResolveMocks(mocker);

    expect(Reflect.get(mocker, "resolveMocks")).toBe(wrapped);
    await mocker.resolveMocks();
    expect(mocker.passes).toBe(1);
  });

  it("allows a fresh pass after the previous one settles", async () => {
    FakeMocker.pendingIds = ["mock-a"];
    const mocker = new FakeMocker();
    serializeMockerResolveMocks(mocker);
    await mocker.resolveMocks();

    FakeMocker.pendingIds = ["mock-b"];
    await mocker.resolveMocks();

    expect(mocker.passes).toBe(2);
    expect(mocker.processed).toEqual(["mock-a", "mock-b"]);
    expect(FakeMocker.pendingIds).toEqual([]);
  });

  it("drains every queued pass before cleanup resets the mocker", async () => {
    FakeMocker.pendingIds = ["mock-a"];
    const mocker = new FakeMocker();
    const { started, release } = pauseFirstPass(mocker);
    serializeMockerResolveMocks(mocker);

    const first = mocker.resolveMocks();
    await started;
    const drain = drainMockerResolveMocks(mocker);
    try {
      const drainState = Promise.race([drain.then(() => "settled"), Promise.resolve("pending")]);
      expect(await drainState).toBe("pending");
      FakeMocker.pendingIds.push("mock-late");
      const second = mocker.resolveMocks();
      release();
      await drain;
      mocker.reset();

      expect(mocker.resetObservations).toEqual([
        { active: 0, pendingIds: [], processed: ["mock-a", "mock-late"] },
      ]);
      await Promise.all([first, second]);
    } finally {
      release();
      await drainMockerResolveMocks(mocker);
    }
  });

  it("keeps the internal drain usable after a caller-visible rejection", async () => {
    FakeMocker.pendingIds = ["mock-a"];
    const mocker = new FakeMocker();
    mocker.nextPassError = new Error("synthetic resolution failure");
    serializeMockerResolveMocks(mocker);

    await expect(mocker.resolveMocks()).rejects.toThrow("synthetic resolution failure");
    FakeMocker.pendingIds = ["mock-b"];
    const recovered = mocker.resolveMocks();

    await expect(drainMockerResolveMocks(mocker)).resolves.toBeUndefined();
    await expect(recovered).resolves.toBeUndefined();
    expect(mocker.passes).toBe(2);
  });
});
