import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "./async-work-scope.js";
import { createDeferredCore } from "./deferred.js";

describe("async work scope", () => {
  it("joins an inherited descendant after its parent returns", async () => {
    const scope = new AsyncWorkScope();
    const gate = createDeferredCore();
    let child: Promise<void> | undefined;
    let drained = false;
    await scope.track(async () => {
      await Promise.resolve();
      child = trackAsyncWork(async () => {
        expect(getAsyncWorkSignal()).toBe(scope.signal);
        await gate.promise;
      });
    });
    const closing = scope.drain().then(() => {
      drained = true;
    });
    try {
      await nextTurn();
      expect(scope.signal.aborted).toBe(true);
      expect(drained).toBe(false);
      expect(getAsyncWorkSignal()).toBeUndefined();
    } finally {
      gate.resolve();
      await child;
      await closing;
    }
    expect(drained).toBe(true);
  });

  it("does not close or drain an independent scope", async () => {
    const first = new AsyncWorkScope();
    const second = new AsyncWorkScope();
    const gates = [createDeferredCore(), createDeferredCore()];
    const completed: number[] = [];
    await Promise.all(
      [first, second].map((scope, index) =>
        scope.track(async () => {
          await Promise.resolve();
          void trackAsyncWork(async () => {
            await gates[index]!.promise;
            completed.push(index);
          });
        }),
      ),
    );
    try {
      gates[0]!.resolve();
      await first.drain();
      expect(completed).toEqual([0]);
      expect(second.signal.aborted).toBe(false);
    } finally {
      for (const gate of gates) {
        gate.resolve();
      }
      await Promise.all([first.drain(), second.drain()]);
    }
  });

  it("captures descendant work ownership without copying another async context", async () => {
    const owner = new AsyncWorkScope();
    const caller = new AsyncWorkScope();
    const authorization = new AsyncLocalStorage<string>();
    const gate = createDeferredCore();
    const track = await authorization.run("requested", () => owner.track(captureAsyncWorkTracker));
    let producer: Promise<void> | undefined;
    let descendant: Promise<void> | undefined;
    let drained = false;
    try {
      await authorization.run("invoker", () =>
        caller.track(() => {
          producer = track(async () => {
            expect(authorization.getStore()).toBe("invoker");
            expect(getAsyncWorkSignal()).toBe(owner.signal);
            await Promise.resolve();
            descendant = trackAsyncWork(() => gate.promise);
          });
        }),
      );
      await producer;
      const closing = owner.drain().then(() => {
        drained = true;
      });
      await caller.drain();
      await nextTurn();
      expect(drained).toBe(false);
      gate.resolve();
      await descendant;
      await closing;
      const staleProducer = vi.fn();
      await expect(track(staleProducer)).rejects.toThrow("Async work scope is closed");
      expect(staleProducer).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await producer;
      await descendant;
      await Promise.all([owner.drain(), caller.drain()]);
      authorization.disable();
    }
  });

  it("keeps an unscoped capture caller-owned when invoked inside a later scope", async () => {
    const track = captureAsyncWorkTracker();
    const caller = new AsyncWorkScope();
    const gate = createDeferredCore();
    let producer: Promise<void> | undefined;
    let descendant: Promise<void> | undefined;
    let descendantSettled = false;
    try {
      await caller.track(() => {
        producer = track(() => {
          expect(getAsyncWorkSignal()).toBeUndefined();
          descendant = trackAsyncWork(async () => {
            await gate.promise;
            descendantSettled = true;
          });
        });
      });
      await producer;
      await caller.drain();
      expect(descendantSettled).toBe(false);
    } finally {
      gate.resolve();
      await producer;
      await descendant;
      await caller.drain();
    }
  });

  it("rejects a late async continuation before invoking its producer", async () => {
    const scope = new AsyncWorkScope();
    const gate = createDeferredCore();
    const producer = vi.fn();
    let continuation: Promise<unknown> | undefined;
    await scope.track(() => {
      continuation = gate.promise.then(() => trackAsyncWork(producer));
    });
    await scope.drain();
    gate.resolve();
    await expect(continuation).rejects.toThrow("Async work scope is closed");
    expect(producer).not.toHaveBeenCalled();
  });
});
