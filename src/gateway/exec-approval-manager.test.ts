/**
 * Tests exec approval manager state transitions and timeout behavior.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
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
    expect(manager.getSnapshot("approval-resolve")?.resolutionSource).toBe("operator");

    const cleanupTimer = timers.find((timer) => timer.delay === 15_000);
    expect(cleanupTimer?.handle.unref).toHaveBeenCalledTimes(1);
  });

  it("records trusted auto-review as a closed one-shot resolution source", async () => {
    installTimerMocks();
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-auto-review");
    const decisionPromise = manager.register(record, 60_000);

    expect(manager.resolveAutoReview("approval-auto-review", "agent-runtime")).toBe(true);
    await expect(decisionPromise).resolves.toBe("allow-once");
    expect(manager.getSnapshot("approval-auto-review")).toMatchObject({
      decision: "allow-once",
      resolutionSource: "auto-review",
      resolvedBy: "agent-runtime",
    });
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

  it("consumes an expired approval as ask-fallback only once", async () => {
    installTimerMocks();
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-fallback");
    const decisionPromise = manager.register(record, 60_000);

    expect(manager.expire("approval-fallback")).toBe(true);
    await expect(decisionPromise).resolves.toBeNull();

    expect(manager.consumeAskFallback("approval-fallback")).toBe(true);
    expect(manager.consumeAskFallback("approval-fallback")).toBe(false);
    expect(manager.getSnapshot("approval-fallback")?.askFallbackConsumed).toBe(true);
  });

  it("rejects ask-fallback replay of an allow-once approval", async () => {
    installTimerMocks();
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-allow-once");
    const decisionPromise = manager.register(record, 60_000);

    expect(manager.resolve("approval-allow-once", "allow-once")).toBe(true);
    await expect(decisionPromise).resolves.toBe("allow-once");

    expect(manager.consumeAskFallback("approval-allow-once")).toBe(false);
    expect(manager.consumeAllowOnce("approval-allow-once")).toBe(true);
    expect(manager.consumeAskFallback("approval-allow-once")).toBe(false);
  });

  it("clamps oversized approval timers instead of letting Node fire them immediately", () => {
    const timers = installTimerMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const manager = new ExecApprovalManager();
    const record = manager.create(
      { command: "echo ok" },
      MAX_TIMER_TIMEOUT_MS + 1,
      "approval-long",
    );

    void manager.register(record, MAX_TIMER_TIMEOUT_MS + 1);

    expect(record.expiresAtMs).toBe(1_000 + MAX_TIMER_TIMEOUT_MS);
    expect(timers[0]?.delay).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("rejects approval records when expiry would exceed the Date range", () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    const manager = new ExecApprovalManager();

    expect(() => manager.create({ command: "echo ok" }, 1, "approval-overflow")).toThrow(
      "approval expiry is unavailable",
    );
  });
});
