// Supervisor adapter test support builds mock process handles for adapter tests.
import { expect, vi } from "vitest";

/**
 * Shared supervisor adapter assertions for the SIGTERM -> SIGKILL fallback
 * contract. Kept outside individual adapter tests so child and pty backends
 * prove the same timer semantics.
 */
type WaitResult = {
  code: number | null;
  signal: number | NodeJS.Signals | null;
};

/** Assert fallback SIGKILL resolves only after the grace timer expires. */
export async function expectWaitStaysPendingUntilSigkillFallback(
  waitPromise: Promise<WaitResult>,
  triggerKill: () => void,
): Promise<void> {
  const settled = vi.fn();
  void waitPromise.then(() => settled());

  triggerKill();

  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(3999);
  expect(settled).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  await expect(waitPromise).resolves.toEqual({ code: null, signal: "SIGKILL" });
}

/** Assert a real process exit beats the fallback timer and stays idempotent. */
export async function expectRealExitWinsOverSigkillFallback(params: {
  waitPromise: Promise<WaitResult>;
  triggerKill: () => void;
  emitExit: () => void;
  expected: WaitResult;
}): Promise<void> {
  params.triggerKill();
  params.emitExit();

  await expect(params.waitPromise).resolves.toEqual(params.expected);

  await vi.advanceTimersByTimeAsync(4_001);
  await expect(params.waitPromise).resolves.toEqual(params.expected);
}
