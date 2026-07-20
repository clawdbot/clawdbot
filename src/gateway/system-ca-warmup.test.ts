import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { warmMacOSSystemCaOffMainThread } from "./system-ca-warmup.js";

class FakeWorker extends EventEmitter {
  unref = vi.fn();
}

describe("warmMacOSSystemCaOffMainThread", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets Node resolve the effective default CA set on macOS", async () => {
    const worker = new FakeWorker();
    const createWorker = vi.fn((_source: string) => worker);
    const warmup = warmMacOSSystemCaOffMainThread({
      platform: "darwin",
      env: {},
      createWorker,
    });

    worker.emit("message", { ok: true, certificateCount: 42 });
    await warmup;

    expect(createWorker).toHaveBeenCalledOnce();
    const workerSource = createWorker.mock.calls[0]?.[0];
    expect(workerSource).toContain('getCACertificates("default")');
    expect(workerSource).not.toContain('getCACertificates("system")');
    expect(worker.unref).toHaveBeenCalledOnce();
  });

  it("skips the warmup outside macOS", async () => {
    const createWorker = vi.fn(() => new FakeWorker());

    await warmMacOSSystemCaOffMainThread({ platform: "linux", env: {}, createWorker });

    expect(createWorker).not.toHaveBeenCalled();
  });

  it("waits for the worker while leaving the main event loop available", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const log = { warn: vi.fn() };
    const warmup = warmMacOSSystemCaOffMainThread({
      platform: "darwin",
      env: {},
      warningMs: 10,
      log,
      createWorker: vi.fn(() => worker),
    });

    let mainTurnRan = false;
    setImmediate(() => {
      mainTurnRan = true;
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(mainTurnRan).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      "macOS CA warmup is still waiting for default trust settings; gateway post-attach startup remains deferred",
    );
    expect(worker.unref).toHaveBeenCalledOnce();

    worker.emit("message", { ok: true, certificateCount: 42 });
    await warmup;
  });

  it("falls back to lazy CA loading when Node denies worker-thread permission", async () => {
    const permissionError = Object.assign(new Error("worker permission denied"), {
      code: "ERR_ACCESS_DENIED",
    });
    const log = { warn: vi.fn() };

    await warmMacOSSystemCaOffMainThread({
      platform: "darwin",
      env: { NODE_USE_SYSTEM_CA: "0" },
      log,
      createWorker: vi.fn(() => {
        throw permissionError;
      }),
    });

    expect(log.warn).toHaveBeenCalledWith(
      "macOS CA warmup skipped because Node denied worker-thread permission; trust settings will load lazily",
    );
  });

  it("fails closed when the worker cannot populate the cache", async () => {
    const worker = new FakeWorker();
    const warmup = warmMacOSSystemCaOffMainThread({
      platform: "darwin",
      env: {},
      createWorker: vi.fn(() => worker),
    });

    worker.emit("message", { ok: false, error: "trust store unavailable" });

    await expect(warmup).rejects.toThrow("trust store unavailable");
  });
});
