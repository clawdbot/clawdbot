import { describe, expect, it, vi } from "vitest";
import { steerActiveSessionWithOptionalDeliveryWait } from "./attempt.queue-message.js";

type SteerTarget = Parameters<typeof steerActiveSessionWithOptionalDeliveryWait>[0];

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => {});
  return { promise, reject, resolve };
}

function createReceipt(cancelResult: boolean) {
  const accepted = deferred();
  const committed = deferred();
  const cancel = vi.fn(() => cancelResult);
  return {
    accepted,
    committed,
    receipt: { accepted: accepted.promise, committed: committed.promise, cancel },
  };
}

function waitForCommit(
  target: SteerTarget,
  options: NonNullable<Parameters<typeof steerActiveSessionWithOptionalDeliveryWait>[2]> = {},
) {
  return steerActiveSessionWithOptionalDeliveryWait(target, "delegated work", {
    deliveryTimeoutMs: 1_000,
    waitForTranscriptCommit: true,
    ...options,
  });
}

describe("embedded steering receipts", () => {
  it("forwards provenance and reports acceptance only after enqueue", async () => {
    const receipt = createReceipt(true);
    const onQueueAccepted = vi.fn();
    const origin = {
      kind: "inter_session" as const,
      sourceSessionKey: "agent:sender:main",
      sourceTool: "sessions_send",
    };
    const steerWithReceipt = vi.fn(() => receipt.receipt);
    const target: SteerTarget = { steer: vi.fn(), steerWithReceipt };

    const queued = waitForCommit(target, { inputProvenance: origin, onQueueAccepted });
    expect(steerWithReceipt).toHaveBeenCalledWith(
      "delegated work",
      undefined,
      undefined,
      undefined,
      undefined,
      origin,
    );
    expect(onQueueAccepted).not.toHaveBeenCalled();

    receipt.accepted.resolve();
    await vi.waitFor(() => expect(onQueueAccepted).toHaveBeenCalledWith(true));
    receipt.committed.resolve();

    await expect(queued).resolves.toEqual({
      kind: "steered",
      transcriptCommit: "confirmed",
    });
  });

  it("cancels the exact receipt before acceptance on timeout", async () => {
    vi.useFakeTimers();
    try {
      const receipt = createReceipt(true);
      const onQueueAccepted = vi.fn();
      const target: SteerTarget = {
        steer: vi.fn(),
        steerWithReceipt: vi.fn(() => receipt.receipt),
      };

      const queued = waitForCommit(target, { deliveryTimeoutMs: 10, onQueueAccepted });
      const rejected = expect(queued).rejects.toThrow("not accepted before timeout");
      await vi.advanceTimersByTimeAsync(10);

      await rejected;
      expect(receipt.receipt.cancel).toHaveBeenCalledOnce();
      expect(onQueueAccepted).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports accepted-unconfirmed when exact cancellation loses the race", async () => {
    vi.useFakeTimers();
    try {
      const receipt = createReceipt(false);
      const onQueueAccepted = vi.fn();
      const target: SteerTarget = {
        steer: vi.fn(),
        steerWithReceipt: vi.fn(() => receipt.receipt),
      };

      const queued = waitForCommit(target, { deliveryTimeoutMs: 10, onQueueAccepted });
      await vi.advanceTimersByTimeAsync(10);

      await expect(queued).resolves.toEqual({
        kind: "accepted-unconfirmed",
        errorMessage: "queued steering message was not accepted before timeout",
      });
      expect(receipt.receipt.cancel).toHaveBeenCalledOnce();
      expect(onQueueAccepted).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the same exact receipt when the source aborts after acceptance", async () => {
    const receipt = createReceipt(true);
    const controller = new AbortController();
    const onQueueAccepted = vi.fn();
    const target: SteerTarget = {
      steer: vi.fn(),
      steerWithReceipt: vi.fn(() => receipt.receipt),
    };

    const queued = waitForCommit(target, {
      abortSignal: controller.signal,
      onQueueAccepted,
    });
    receipt.accepted.resolve();
    await vi.waitFor(() => expect(onQueueAccepted).toHaveBeenCalledWith(true));
    controller.abort();

    await expect(queued).rejects.toThrow("queued steering message was cancelled");
    expect(receipt.receipt.cancel).toHaveBeenCalledOnce();
  });

  it("preserves non-wait admission and pre-abort callbacks", async () => {
    const steer = vi.fn(async () => undefined);
    const accepted = vi.fn();
    const target: SteerTarget = { steer };

    await expect(
      steerActiveSessionWithOptionalDeliveryWait(target, "plain steer", {
        onQueueAccepted: accepted,
      }),
    ).resolves.toEqual({ kind: "steered", transcriptCommit: "not-requested" });
    expect(accepted).toHaveBeenCalledWith(true);

    const controller = new AbortController();
    controller.abort();
    const rejected = vi.fn();
    await expect(
      steerActiveSessionWithOptionalDeliveryWait(target, "cancelled steer", {
        abortSignal: controller.signal,
        onQueueAccepted: rejected,
      }),
    ).rejects.toThrow("cancelled before acceptance");
    expect(rejected).toHaveBeenCalledWith(false);
    expect(steer).toHaveBeenCalledOnce();
  });
});
