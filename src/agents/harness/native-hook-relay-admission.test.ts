import { describe, expect, it, vi } from "vitest";
import {
  NativeHookRelayAdmissionCancelledError,
  NativeHookRelayAdmissionClosedError,
  NativeHookRelayAdmissionController,
  NativeHookRelayAdmissionOverloadedError,
} from "./native-hook-relay-admission.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("NativeHookRelayAdmissionController", () => {
  it("runs four active operations, queues 32 in FIFO order, and rejects the next request", async () => {
    const controller = new NativeHookRelayAdmissionController();
    const releases = Array.from({ length: 36 }, deferred);
    const started: number[] = [];
    const operations = releases.map((release, index) =>
      controller.run(async () => {
        started.push(index);
        await release.promise;
        return index;
      }),
    );

    await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(controller.snapshot()).toMatchObject({
      active: 4,
      queued: 32,
      accepted: 36,
      rejected: 0,
      peakActive: 4,
      peakQueued: 32,
    });
    await expect(controller.run(async () => 36)).rejects.toBeInstanceOf(
      NativeHookRelayAdmissionOverloadedError,
    );

    for (let index = 0; index < releases.length; index += 1) {
      releases[index]?.resolve();
      await operations[index];
    }
    expect(started).toEqual(Array.from({ length: 36 }, (_, index) => index));
    expect(controller.snapshot()).toEqual({
      active: 0,
      queued: 0,
      accepted: 36,
      completed: 36,
      rejected: 1,
      cancelled: 0,
      coalesced: 0,
      peakActive: 4,
      peakQueued: 32,
    });
  });

  it("removes an aborted queued operation without consuming an execution slot", async () => {
    const controller = new NativeHookRelayAdmissionController({
      maxActive: 1,
      maxQueued: 1,
    });
    const active = deferred();
    const first = controller.run(() => active.promise);
    const abortController = new AbortController();
    const queued = controller.run(async () => undefined, {
      signal: abortController.signal,
    });

    abortController.abort();
    await expect(queued).rejects.toBeInstanceOf(NativeHookRelayAdmissionCancelledError);
    expect(controller.snapshot()).toMatchObject({
      active: 1,
      queued: 0,
      cancelled: 1,
    });
    active.resolve();
    await first;
  });

  it("rejects queued and future operations after close", async () => {
    const controller = new NativeHookRelayAdmissionController({
      maxActive: 1,
      maxQueued: 1,
    });
    const active = deferred();
    const first = controller.run(() => active.promise);
    const queued = controller.run(async () => undefined);

    controller.close();
    await expect(queued).rejects.toBeInstanceOf(NativeHookRelayAdmissionClosedError);
    await expect(controller.run(async () => undefined)).rejects.toBeInstanceOf(
      NativeHookRelayAdmissionClosedError,
    );
    active.resolve();
    await first;
  });

  it("rejects a zero active limit rather than creating an undrainable queue", () => {
    expect(() => new NativeHookRelayAdmissionController({ maxActive: 0, maxQueued: 1 })).toThrow(
      "maxActive must be a safe integer greater than or equal to 1",
    );
  });

  it("coalesces an exact in-flight key without consuming active or queued capacity", async () => {
    const controller = new NativeHookRelayAdmissionController({
      maxActive: 1,
      maxQueued: 0,
    });
    const release = deferred();
    const operation = vi.fn(() => release.promise);
    const first = controller.run(operation, { key: "permission:call-1" });
    const duplicate = controller.run(operation, { key: "permission:call-1" });

    await Promise.resolve();
    expect(controller.snapshot()).toMatchObject({
      active: 1,
      queued: 0,
      accepted: 1,
      coalesced: 1,
    });
    expect(operation).toHaveBeenCalledOnce();
    release.resolve();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([undefined, undefined]);
  });
});
