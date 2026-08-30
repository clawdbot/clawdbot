// Guards the resolveMocks serialization pin: passes run sequentially so a
// drained snapshot is never registered (and its mock modules never
// invalidated) twice, while every caller's pass starts at or after its call so
// previously queued ids are registered before the caller's fetch proceeds.
import { describe, expect, it } from "vitest";
import { drainMockerResolveMocks, serializeMockerResolveMocks } from "./non-isolated-runner.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

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
    if (this.passes === 1 && this.beforeFirstPass) {
      await this.beforeFirstPass();
    } else {
      // Simulate the parallel resolveId RPC round-trips inside one pass.
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }
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
    serializeMockerResolveMocks(mocker);

    const first = mocker.resolveMocks();
    // Upstream would abandon this push when it reassigns pendingIds to [];
    // the wrapper must requeue it and the second caller's own chained pass
    // must register it before that caller proceeds with its fetch.
    FakeMocker.pendingIds.push("mock-late");
    const second = mocker.resolveMocks();
    await second;

    expect(mocker.processed).toEqual(["mock-a", "mock-late"]);
    expect(mocker.maxConcurrentPasses).toBe(1);
    await first;
    expect(FakeMocker.pendingIds).toEqual([]);
  });

  it("drains ids queued during the final pass without requiring another caller", async () => {
    FakeMocker.pendingIds = ["mock-a"];
    const firstPassStarted = deferred();
    const releaseFirstPass = deferred();
    const mocker = new FakeMocker();
    mocker.beforeFirstPass = async () => {
      firstPassStarted.resolve();
      await releaseFirstPass.promise;
    };
    serializeMockerResolveMocks(mocker);

    const first = mocker.resolveMocks();
    await firstPassStarted.promise;
    FakeMocker.pendingIds.push("mock-late");
    releaseFirstPass.resolve();
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
    const firstPassStarted = deferred();
    const releaseFirstPass = deferred();
    const mocker = new FakeMocker();
    mocker.beforeFirstPass = async () => {
      firstPassStarted.resolve();
      await releaseFirstPass.promise;
    };
    serializeMockerResolveMocks(mocker);

    const first = mocker.resolveMocks();
    await firstPassStarted.promise;
    const drain = drainMockerResolveMocks(mocker);
    const drainState = Promise.race([drain.then(() => "settled"), Promise.resolve("pending")]);

    expect(await drainState).toBe("pending");
    FakeMocker.pendingIds.push("mock-late");
    const second = mocker.resolveMocks();
    releaseFirstPass.resolve();
    await drain;
    mocker.reset();

    expect(mocker.resetObservations).toEqual([
      { active: 0, pendingIds: [], processed: ["mock-a", "mock-late"] },
    ]);
    await Promise.all([first, second]);
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
