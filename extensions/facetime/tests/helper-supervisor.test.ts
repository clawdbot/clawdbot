import { afterEach, describe, expect, it, vi } from "vitest";
import { FaceTimeHelperSupervisor } from "../src/helper-supervisor.js";

describe("FaceTime helper supervisor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("injects missing FaceTime and Phone helpers after the startup grace period", async () => {
    vi.useFakeTimers();
    const connectedBundles: string[] = [];
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    const supervisor = new FaceTimeHelperSupervisor({
      pluginRoot: "/tmp/facetime",
      logger: console,
      runCommandWithTimeout: runCommandWithTimeout as any,
      connectedBundles: () => connectedBundles,
      targetAvailable: () => true,
      initialGraceMs: 100,
      retryDelaysMs: [1_000],
      connectionGraceMs: 0,
    });

    supervisor.start();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);

    expect(runCommandWithTimeout).toHaveBeenCalledTimes(2);
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["/bin/bash", "/tmp/facetime/scripts/inject-helper.sh", "--app", "FaceTime"],
      expect.objectContaining({
        timeoutMs: 120_000,
        killProcessTree: true,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["/bin/bash", "/tmp/facetime/scripts/inject-helper.sh", "--app", "Phone"],
      expect.objectContaining({
        timeoutMs: 120_000,
        killProcessTree: true,
        signal: expect.any(AbortSignal),
      }),
    );
    await supervisor.stop();
  });

  it("reports the second serialized injection as queued", async () => {
    vi.useFakeTimers();
    let finishFirst:
      | ((result: { code: number; stdout: string; stderr: string }) => void)
      | undefined;
    const firstInjection = new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        finishFirst = resolve;
      },
    );
    const runCommandWithTimeout = vi
      .fn()
      .mockReturnValueOnce(firstInjection)
      .mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const supervisor = new FaceTimeHelperSupervisor({
      pluginRoot: "/tmp/facetime",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runCommandWithTimeout: runCommandWithTimeout as any,
      connectedBundles: () => [],
      targetAvailable: () => true,
      initialGraceMs: 0,
      retryDelaysMs: [1_000],
      connectionGraceMs: 0,
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(supervisor.status()).toEqual([
      expect.objectContaining({ target: "FaceTime", injecting: true, queued: false }),
      expect.objectContaining({ target: "Phone", injecting: false, queued: true }),
    ]);

    finishFirst?.({ code: 0, stdout: "", stderr: "" });
    await firstInjection;
    await vi.advanceTimersByTimeAsync(0);
    await supervisor.stop();
  });

  it("cancels reinjection after an authenticated helper reconnects", async () => {
    vi.useFakeTimers();
    const connectedBundles: string[] = [];
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    const supervisor = new FaceTimeHelperSupervisor({
      pluginRoot: "/tmp/facetime",
      logger: console,
      runCommandWithTimeout: runCommandWithTimeout as any,
      connectedBundles: () => connectedBundles,
      targetAvailable: () => true,
      initialGraceMs: 100,
      retryDelaysMs: [1_000],
      connectionGraceMs: 0,
    });

    supervisor.start();
    connectedBundles.push("com.apple.FaceTime", "com.apple.mobilephone");
    supervisor.connected("com.apple.FaceTime");
    supervisor.connected("com.apple.mobilephone");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    expect(supervisor.status()).toEqual([
      expect.objectContaining({ target: "FaceTime", connected: true, attempts: 0 }),
      expect.objectContaining({ target: "Phone", connected: true, attempts: 0 }),
    ]);
    await supervisor.stop();
  });

  it("backs off and reports the last injection failure", async () => {
    vi.useFakeTimers();
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "Developer Tools mode is disabled",
    });
    const supervisor = new FaceTimeHelperSupervisor({
      pluginRoot: "/tmp/facetime",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runCommandWithTimeout: runCommandWithTimeout as any,
      connectedBundles: () => ["com.apple.mobilephone"],
      targetAvailable: () => true,
      initialGraceMs: 0,
      retryDelaysMs: [1_000, 5_000],
      connectionGraceMs: 0,
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
    expect(supervisor.status()).toContainEqual(
      expect.objectContaining({
        target: "FaceTime",
        attempts: 1,
        connected: false,
        injecting: false,
        lastError: "Developer Tools mode is disabled",
      }),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(2);
    await supervisor.stop();
  });

  it("reports an injection that never authenticates instead of waiting forever", async () => {
    vi.useFakeTimers();
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    const supervisor = new FaceTimeHelperSupervisor({
      pluginRoot: "/tmp/facetime",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runCommandWithTimeout: runCommandWithTimeout as any,
      connectedBundles: () => [],
      targetAvailable: (target) => target === "FaceTime",
      initialGraceMs: 0,
      retryDelaysMs: [1_000],
      connectionGraceMs: 0,
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(supervisor.status()).toContainEqual(
      expect.objectContaining({
        target: "FaceTime",
        connected: false,
        injecting: false,
        retryScheduled: true,
        lastError: "FaceTime helper injection completed but no authenticated connection arrived",
      }),
    );
    await supervisor.stop();
  });

  it("does not supervise Phone when the app is unavailable", async () => {
    vi.useFakeTimers();
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    const supervisor = new FaceTimeHelperSupervisor({
      pluginRoot: "/tmp/facetime",
      logger: console,
      runCommandWithTimeout: runCommandWithTimeout as any,
      connectedBundles: () => [],
      targetAvailable: (target) => target === "FaceTime",
      initialGraceMs: 0,
      retryDelaysMs: [1_000],
      connectionGraceMs: 0,
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["/bin/bash", "/tmp/facetime/scripts/inject-helper.sh", "--app", "FaceTime"],
      expect.objectContaining({
        timeoutMs: 120_000,
        killProcessTree: true,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(supervisor.status().map((entry) => entry.target)).toEqual(["FaceTime"]);
    await supervisor.stop();
  });

  it("waits for a stale helper process to exit before reinjecting", async () => {
    vi.useFakeTimers();
    let processAlive = true;
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    const supervisor = new FaceTimeHelperSupervisor({
      pluginRoot: "/tmp/facetime",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runCommandWithTimeout: runCommandWithTimeout as any,
      connectedBundles: () => [],
      targetAvailable: () => true,
      processAlive: () => processAlive,
      initialGraceMs: 10_000,
      retryDelaysMs: [1_000],
      connectionGraceMs: 0,
    });

    supervisor.start();
    supervisor.stale("com.apple.FaceTime", 1234);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    expect(supervisor.status()).toContainEqual(
      expect.objectContaining({
        target: "FaceTime",
        stale: true,
        staleProcessId: 1234,
      }),
    );

    processAlive = false;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["/bin/bash", "/tmp/facetime/scripts/inject-helper.sh", "--app", "FaceTime"],
      expect.objectContaining({ timeoutMs: 120_000, killProcessTree: true }),
    );
    await supervisor.stop();
  });

  it("warns once while stale helper processes keep reconnecting", async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const supervisor = new FaceTimeHelperSupervisor({
      pluginRoot: "/tmp/facetime",
      logger,
      runCommandWithTimeout: vi.fn() as any,
      connectedBundles: () => [],
      targetAvailable: (target) => target === "FaceTime",
      processAlive: () => true,
      initialGraceMs: 10_000,
      retryDelaysMs: [1_000],
      connectionGraceMs: 0,
    });

    supervisor.start();
    supervisor.stale("com.apple.FaceTime", 1234);
    supervisor.stale("com.apple.FaceTime", 1234);
    supervisor.stale("com.apple.FaceTime.FTConversationService", 1234);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenLastCalledWith(
      "[facetime] Restart FaceTime to load the updated OpenClaw helper",
    );
    expect(supervisor.status()).toContainEqual(
      expect.objectContaining({
        target: "FaceTime",
        stale: true,
        staleProcessId: 1234,
        retryScheduled: true,
      }),
    );

    supervisor.stale("com.apple.FaceTime", 5678);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(supervisor.status()).toContainEqual(
      expect.objectContaining({
        target: "FaceTime",
        staleProcessId: 5678,
      }),
    );

    supervisor.connected("com.apple.FaceTime");
    supervisor.stale("com.apple.FaceTime", 9012);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    await supervisor.stop();
  });

  it("preserves the stale-process monitor when injection finishes concurrently", async () => {
    vi.useFakeTimers();
    let finishInjection:
      | ((result: { code: number; stdout: string; stderr: string }) => void)
      | undefined;
    const firstInjection = new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        finishInjection = resolve;
      },
    );
    const runCommandWithTimeout = vi
      .fn()
      .mockReturnValueOnce(firstInjection)
      .mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const supervisor = new FaceTimeHelperSupervisor({
      pluginRoot: "/tmp/facetime",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runCommandWithTimeout: runCommandWithTimeout as any,
      connectedBundles: () => [],
      targetAvailable: (target) => target === "FaceTime",
      processAlive: () => false,
      initialGraceMs: 0,
      retryDelaysMs: [1_000],
      connectionGraceMs: 0,
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);

    supervisor.stale("com.apple.FaceTime", 1234);
    finishInjection?.({ code: 0, stdout: "", stderr: "" });
    await firstInjection;
    await vi.advanceTimersByTimeAsync(2_001);

    expect(runCommandWithTimeout).toHaveBeenCalledTimes(2);
    await supervisor.stop();
  });

  it("aborts and joins in-flight LLDB injection before stop completes", async () => {
    vi.useFakeTimers();
    let injectionSignal: AbortSignal | undefined;
    const runCommandWithTimeout = vi.fn(
      async (_argv: string[], options: { signal: AbortSignal; killProcessTree: boolean }) => {
        injectionSignal = options.signal;
        return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
          options.signal.addEventListener(
            "abort",
            () => resolve({ code: 1, stdout: "", stderr: "aborted" }),
            { once: true },
          );
        });
      },
    );
    const supervisor = new FaceTimeHelperSupervisor({
      pluginRoot: "/tmp/facetime",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runCommandWithTimeout: runCommandWithTimeout as never,
      connectedBundles: () => [],
      targetAvailable: () => true,
      initialGraceMs: 0,
      retryDelaysMs: [1_000],
      connectionGraceMs: 0,
    });
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runCommandWithTimeout).toHaveBeenCalledOnce();

    await supervisor.stop();

    expect(injectionSignal?.aborted).toBe(true);
    expect(runCommandWithTimeout).toHaveBeenCalledOnce();
    expect(runCommandWithTimeout.mock.calls[0]?.[1]).toMatchObject({
      killProcessTree: true,
    });
  });
});
