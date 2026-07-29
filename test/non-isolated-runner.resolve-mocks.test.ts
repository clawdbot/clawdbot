// Guards the resolveMocks serialization pin: passes run sequentially so a
// drained snapshot is never registered (and its mock modules never
// invalidated) twice, while every caller's pass starts at or after its call so
// previously queued ids are registered before the caller's fetch proceeds.
import { describe, expect, it } from "vitest";
import { serializeMockerResolveMocks } from "./non-isolated-runner.js";

// Mirrors BareModuleMocker.resolveMocks: snapshots the static queue's contents
// at pass start, awaits its RPCs, then reassigns the static to [] so ids
// pushed during the await land in the abandoned array.
class FakeMocker {
  static pendingIds: unknown[] = [];
  passes = 0;
  active = 0;
  maxConcurrentPasses = 0;
  processed: unknown[] = [];

  async resolveMocks(): Promise<void> {
    if (FakeMocker.pendingIds.length === 0) {
      return;
    }
    this.active += 1;
    this.maxConcurrentPasses = Math.max(this.maxConcurrentPasses, this.active);
    this.passes += 1;
    const snapshot = [...FakeMocker.pendingIds];
    // Simulate the parallel resolveId RPC round-trips inside one pass.
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
    this.processed.push(...snapshot);
    FakeMocker.pendingIds = [];
    this.active -= 1;
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
});
