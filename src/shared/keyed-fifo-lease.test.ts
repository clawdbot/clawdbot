import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { drainGlobalSingletonLifecycleState } from "./global-singleton.js";
import { createKeyedFifoLeaseRegistry } from "./keyed-fifo-lease.js";

const keysToDelete = new Set<symbol>();
const TEST_KEY = Symbol.for("openclaw.test.keyedFifoLease");

function createRegistry() {
  keysToDelete.add(TEST_KEY);
  return createKeyedFifoLeaseRegistry(TEST_KEY);
}

afterEach(async () => {
  await drainGlobalSingletonLifecycleState("close");
  for (const key of keysToDelete) {
    delete (globalThis as Record<PropertyKey, unknown>)[key];
  }
  keysToDelete.clear();
});

describe("keyed FIFO leases", () => {
  it("reserves order before reverse-completing work reaches wait", async () => {
    const registry = createRegistry();
    const older = registry.reserve(["target"])!;
    const newer = registry.reserve(["target"])!;
    let newerReady = false;

    const newerWait = newer.wait().then((ready) => {
      newerReady = ready;
    });
    await Promise.resolve();
    expect(newerReady).toBe(false);

    older.release();
    await newerWait;
    expect(newerReady).toBe(true);
    newer.release();
  });

  it("does not release an aborted waiter's reserved slot", async () => {
    const registry = createRegistry();
    const older = registry.reserve(["target"])!;
    const aborted = registry.reserve(["target"])!;
    const newer = registry.reserve(["target"])!;
    const controller = new AbortController();
    const abortedWait = aborted.wait(controller.signal);
    const newerWait = newer.wait();
    let newerReady = false;
    void newerWait.then(() => {
      newerReady = true;
    });

    controller.abort();
    await expect(abortedWait).resolves.toBe(false);
    older.release();
    await Promise.resolve();
    expect(newerReady).toBe(false);

    aborted.release();
    aborted.release();
    await expect(newerWait).resolves.toBe(true);
    newer.release();
  });

  it("reserves sorted unique multi-key leases without deadlock", async () => {
    const registry = createRegistry();
    const first = registry.reserve(["b", "a", "b"])!;
    const second = registry.reserve(["a", "b"])!;
    let secondReady = false;
    const secondWait = second.wait().then((ready) => {
      secondReady = ready;
    });

    await expect(first.wait()).resolves.toBe(true);
    await Promise.resolve();
    expect(secondReady).toBe(false);
    first.release();
    await secondWait;
    expect(secondReady).toBe(true);
    second.release();
  });

  it("keeps a newer tail when an older tail cleans up", async () => {
    const registry = createRegistry();
    const first = registry.reserve(["target"])!;
    first.release();
    const second = registry.reserve(["target"])!;
    await expect(second.wait()).resolves.toBe(true);
    const third = registry.reserve(["target"])!;
    let thirdReady = false;
    void third.wait().then(() => {
      thirdReady = true;
    });

    await Promise.resolve();
    expect(thirdReady).toBe(false);
    second.release();
    await expect(third.wait()).resolves.toBe(true);
    third.release();
  });

  it("releases an idle key independently when a mixed lease exits before its predecessor", async () => {
    const registry = createRegistry();
    const older = registry.reserve(["busy"])!;
    const mixed = registry.reserve(["idle", "busy"])!;
    const idle = registry.reserve(["idle"])!;
    const busy = registry.reserve(["busy"])!;
    let busyReady = false;
    const busyWait = busy.wait().then((ready) => {
      busyReady = ready;
    });

    mixed.release();
    await expect(idle.wait()).resolves.toBe(true);
    expect(busyReady).toBe(false);
    idle.release();

    older.release();
    await busyWait;
    expect(busyReady).toBe(true);
    busy.release();
  });

  it("shares reservations across duplicate runtime chunks", async () => {
    const key = TEST_KEY;
    keysToDelete.add(key);
    const moduleA = await importFreshModule<typeof import("./keyed-fifo-lease.js")>(
      import.meta.url,
      "./keyed-fifo-lease.js?scope=duplicate-a",
    );
    const moduleB = await importFreshModule<typeof import("./keyed-fifo-lease.js")>(
      import.meta.url,
      "./keyed-fifo-lease.js?scope=duplicate-b",
    );
    const firstRegistry = moduleA.createKeyedFifoLeaseRegistry(key);
    const secondRegistry = moduleB.createKeyedFifoLeaseRegistry(key);
    const first = firstRegistry.reserve(["target"])!;
    const second = secondRegistry.reserve(["target"])!;
    let secondReady = false;
    void second.wait().then(() => {
      secondReady = true;
    });

    await Promise.resolve();
    expect(secondReady).toBe(false);
    first.release();
    await expect(second.wait()).resolves.toBe(true);
    second.release();
  });

  it("releases live gates on full close but not restart", async () => {
    const registry = createRegistry();
    registry.reserve(["target"]);
    registry.reserve(["target"]);
    const last = registry.reserve(["target"])!;
    let ready = false;
    const lastWait = last.wait().then((result) => {
      ready = result;
      return result;
    });

    await drainGlobalSingletonLifecycleState("restart");
    await Promise.resolve();
    expect(ready).toBe(false);

    await drainGlobalSingletonLifecycleState("close");
    await expect(lastWait).resolves.toBe(true);

    const fresh = registry.reserve(["target"])!;
    await expect(fresh.wait()).resolves.toBe(true);
    fresh.release();
  });
});
