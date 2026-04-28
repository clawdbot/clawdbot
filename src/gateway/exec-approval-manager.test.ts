import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecApprovalManager } from "./exec-approval-manager.js";

type TimeoutCallback = Parameters<typeof setTimeout>[0];
type MockTimerHandle = ReturnType<typeof setTimeout> & {
  unref: ReturnType<typeof vi.fn>;
};

describe("ExecApprovalManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function installTimerMocks() {
    const timers: Array<{
      delay: number | undefined;
      handle: MockTimerHandle;
    }> = [];

    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimeoutCallback,
      delay?: number,
    ) => {
      void callback;
      const handle = { unref: vi.fn() } as unknown as MockTimerHandle;
      timers.push({ delay, handle });
      return handle;
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(
      (() => undefined) as typeof clearTimeout,
    );

    return timers;
  }

  it("does not keep resolved approval cleanup timers ref'd", async () => {
    const timers = installTimerMocks();
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-resolve");
    const decisionPromise = manager.register(record, 60_000);

    expect(manager.resolve("approval-resolve", "allow-once")).toBe(true);
    await expect(decisionPromise).resolves.toBe("allow-once");

    const cleanupTimer = timers.find((timer) => timer.delay === 15_000);
    expect(cleanupTimer?.handle.unref).toHaveBeenCalledTimes(1);
  });

  it("does not keep expired approval cleanup timers ref'd", async () => {
    const timers = installTimerMocks();
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-expire");
    const decisionPromise = manager.register(record, 60_000);

    expect(manager.expire("approval-expire")).toBe(true);
    await expect(decisionPromise).resolves.toBeNull();

    const cleanupTimer = timers.find((timer) => timer.delay === 15_000);
    expect(cleanupTimer?.handle.unref).toHaveBeenCalledTimes(1);
  });
});
