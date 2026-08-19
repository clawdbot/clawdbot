// Draft stream loop tests cover incremental draft updates while channel replies stream.
import { setImmediate as nextMacrotask } from "node:timers/promises";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftStreamLoop } from "./draft-stream-loop.js";

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const flushMacrotask = async () => {
  await nextMacrotask();
};

async function waitForBackgroundFlushError(
  onBackgroundFlushError: ReturnType<typeof vi.fn<(err: unknown) => void>>,
) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await flushMicrotasks();
    if (onBackgroundFlushError.mock.calls.length > 0) {
      return;
    }
  }
}

async function captureUnhandledRejections(
  run: (rejections: unknown[]) => Promise<void>,
  settle: () => Promise<void> = flushMacrotask,
) {
  const rejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await run(rejections);
    await settle();
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
}

describe("createDraftStreamLoop", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    if (vi.isFakeTimers()) {
      vi.clearAllTimers();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("contains immediate background flush rejections and preserves pending text", async () => {
    await captureUnhandledRejections(async (rejections) => {
      const error = new Error("send failed");
      const onBackgroundFlushError = vi.fn<(err: unknown) => void>();
      const sendOrEditStreamMessage = vi
        .fn<(text: string) => Promise<boolean>>()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(true);

      const loop = createDraftStreamLoop({
        throttleMs: 0,
        isStopped: () => false,
        sendOrEditStreamMessage,
        onBackgroundFlushError,
      });

      loop.update("hello");
      await waitForBackgroundFlushError(onBackgroundFlushError);
      await flushMacrotask();
      await loop.flush();

      expect(rejections).toStrictEqual([]);
      expect(onBackgroundFlushError).toHaveBeenCalledWith(error);
      expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(1, "hello");
      expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(2, "hello");
    });
  });

  it("contains scheduled background flush rejections and preserves pending text", async () => {
    vi.useFakeTimers();
    try {
      await captureUnhandledRejections(
        async (rejections) => {
          const error = new Error("send failed");
          const onBackgroundFlushError = vi.fn<(err: unknown) => void>();
          const sendOrEditStreamMessage = vi
            .fn<(text: string) => Promise<boolean>>()
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce(true);

          const loop = createDraftStreamLoop({
            throttleMs: 100,
            isStopped: () => false,
            sendOrEditStreamMessage,
            onBackgroundFlushError,
          });

          loop.update("scheduled");
          await vi.advanceTimersByTimeAsync(100);
          await flushMicrotasks();
          await loop.flush();

          expect(rejections).toStrictEqual([]);
          expect(onBackgroundFlushError).toHaveBeenCalledWith(error);
          expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(1, "scheduled");
          expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(2, "scheduled");
        },
        async () => {
          await vi.advanceTimersByTimeAsync(0);
        },
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("clamps oversized throttle timers", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const sendOrEditStreamMessage = vi.fn(async () => true);
      const loop = createDraftStreamLoop({
        throttleMs: Number.MAX_SAFE_INTEGER,
        isStopped: () => false,
        sendOrEditStreamMessage,
      });

      loop.update("hello");

      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(MAX_TIMER_TIMEOUT_MS - 1);
      expect(sendOrEditStreamMessage).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(sendOrEditStreamMessage).toHaveBeenCalledExactlyOnceWith("hello");
      loop.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("takes the latest queued text without interrupting the in-flight send", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let releaseSend: (() => void) | undefined;
    const sendPending = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendOrEditStreamMessage = vi.fn(async () => {
      await sendPending;
      return true;
    });
    const loop = createDraftStreamLoop({
      throttleMs: 0,
      isStopped: () => false,
      sendOrEditStreamMessage,
    });

    loop.update("in flight");
    await flushMicrotasks();
    loop.update("queued first");
    loop.update("queued latest");

    expect(vi.getTimerCount()).toBe(1);
    expect(loop.takePending()).toBe("queued latest");
    expect(vi.getTimerCount()).toBe(0);

    releaseSend?.();
    await loop.waitForInFlight();
    await flushMicrotasks();

    expect(sendOrEditStreamMessage).toHaveBeenCalledExactlyOnceWith("in flight");
  });

  it("contains synchronous sender failures from background flushes", async () => {
    await captureUnhandledRejections(async (rejections) => {
      const error = new Error("send failed");
      const onBackgroundFlushError = vi.fn<(err: unknown) => void>();
      const sendOrEditStreamMessage = vi
        .fn<(text: string) => Promise<boolean>>()
        .mockImplementationOnce(() => {
          throw error;
        })
        .mockResolvedValueOnce(true);

      const loop = createDraftStreamLoop({
        throttleMs: 0,
        isStopped: () => false,
        sendOrEditStreamMessage,
        onBackgroundFlushError,
      });

      loop.update("hello");
      await waitForBackgroundFlushError(onBackgroundFlushError);
      await flushMacrotask();
      await loop.flush();

      expect(rejections).toStrictEqual([]);
      expect(onBackgroundFlushError).toHaveBeenCalledWith(error);
      expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(1, "hello");
      expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(2, "hello");
    });
  });

  it("contains background flush error reporter failures", async () => {
    await captureUnhandledRejections(async (rejections) => {
      const error = new Error("send failed");
      const onBackgroundFlushError = vi.fn<(err: unknown) => void>(() => {
        throw new Error("report failed");
      });
      const sendOrEditStreamMessage = vi
        .fn<(text: string) => Promise<boolean>>()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(true);

      const loop = createDraftStreamLoop({
        throttleMs: 0,
        isStopped: () => false,
        sendOrEditStreamMessage,
        onBackgroundFlushError,
      });

      loop.update("hello");
      await waitForBackgroundFlushError(onBackgroundFlushError);
      await flushMacrotask();
      await loop.flush();

      expect(rejections).toStrictEqual([]);
      expect(onBackgroundFlushError).toHaveBeenCalledWith(error);
      expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(2, "hello");
    });
  });

  it("keeps explicit flush rejections visible and preserves pending text", async () => {
    const error = new Error("send failed");
    const sendOrEditStreamMessage = vi
      .fn<(text: string) => Promise<boolean>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(true);

    const loop = createDraftStreamLoop({
      throttleMs: 100,
      isStopped: () => false,
      sendOrEditStreamMessage,
    });

    loop.update("hello");
    await expect(loop.flush()).rejects.toThrow(error);
    await loop.flush();

    expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(1, "hello");
    expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(2, "hello");
  });

  it("preserves concurrent update text when sendOrEditStreamMessage returns false", async () => {
    let deliver!: (() => void) | undefined;
    const deliverPromise = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    const capturedArgs: string[] = [];

    const sendOrEditStreamMessage = vi
      .fn<(text: string) => Promise<boolean>>()
      .mockImplementationOnce(async (text: string) => {
        capturedArgs.push(text);
        await deliverPromise;
        return false;
      })
      .mockImplementationOnce(async (text: string) => {
        capturedArgs.push(text);
        return true;
      });

    const loop = createDraftStreamLoop({
      throttleMs: 0,
      isStopped: () => false,
      sendOrEditStreamMessage,
    });

    loop.update("initial");
    await flushMicrotasks();

    loop.update("concurrent");
    deliver!();
    await loop.flush();

    expect(capturedArgs[1]).toBe("concurrent");
  });

  it("preserves generic pending updates when consecutive sends return false", async () => {
    type Update = { text: string; blocks: string[] };
    const initial = { text: "initial", blocks: ["initial-blocks"] };
    const latest = { text: "latest", blocks: ["latest-blocks"] };
    let releaseFirst: (() => void) | undefined;
    const firstSend = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sendOrEditStreamMessage = vi
      .fn<(update: Update) => Promise<boolean>>()
      .mockImplementationOnce(async () => {
        await firstSend;
        return false;
      })
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const loop = createDraftStreamLoop<Update>({
      throttleMs: 0,
      isStopped: () => false,
      emptyValue: { text: "", blocks: [] },
      isEmpty: (update) => !update.text,
      sendOrEditStreamMessage,
    });

    loop.update(initial);
    await flushMicrotasks();
    loop.update(latest);
    releaseFirst?.();
    await loop.flush();
    await loop.flush();

    expect(sendOrEditStreamMessage.mock.calls).toEqual([[initial], [latest], [latest]]);
  });

  it("keeps generic payload fields atomic while newer updates queue", async () => {
    type Update = { text: string; blocks: string[] };
    let releaseFirst: (() => void) | undefined;
    const firstSend = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sendOrEditStreamMessage = vi.fn(async (update: Update) => {
      if (update.text === "first") {
        await firstSend;
      }
      return true;
    });
    const loop = createDraftStreamLoop<Update>({
      throttleMs: 0,
      isStopped: () => false,
      emptyValue: { text: "", blocks: [] },
      isEmpty: (update) => !update.text,
      sendOrEditStreamMessage,
    });

    loop.update({ text: "first", blocks: ["first-blocks"] });
    await flushMicrotasks();
    loop.update({ text: "latest", blocks: ["latest-blocks"] });
    releaseFirst?.();
    await loop.flush();

    expect(sendOrEditStreamMessage.mock.calls).toEqual([
      [{ text: "first", blocks: ["first-blocks"] }],
      [{ text: "latest", blocks: ["latest-blocks"] }],
    ]);
  });

  it("materializes only the newest lazy payload in a throttle window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let materializeCount = 0;
    const lazyPayload = (text: string) => {
      let cached: string | undefined;
      let materialized = false;
      return Object.defineProperty({} as { text?: string }, "text", {
        enumerable: true,
        get: () => {
          if (!materialized) {
            materializeCount += 1;
            cached = text;
            materialized = true;
          }
          return cached;
        },
      });
    };
    const sendOrEditStreamMessage = vi.fn(async (payload: { text?: string }) => {
      void payload.text;
    });
    const emptyValue = {};
    const loop = createDraftStreamLoop<{ text?: string }>({
      throttleMs: 100,
      isStopped: () => false,
      emptyValue,
      isEmpty: (payload) => payload === emptyValue || !payload.text?.trim(),
      sendOrEditStreamMessage,
    });

    const payloads = Array.from({ length: 24 }, (_, index) => lazyPayload(`partial ${index + 1}`));
    for (const payload of payloads) {
      loop.update(payload);
    }

    expect(materializeCount).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(materializeCount).toBe(1);
    expect(sendOrEditStreamMessage).toHaveBeenCalledTimes(1);
    expect(sendOrEditStreamMessage.mock.calls[0]?.[0].text).toBe("partial 24");

    for (const payload of payloads) {
      void payload.text;
    }
    expect(materializeCount).toBe(payloads.length);
  });

  it("drops a lazy empty flush without sending or losing the next visible value", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sendOrEditStreamMessage = vi.fn(async (_payload: { text?: string }) => {});
    const emptyValue = {};
    const loop = createDraftStreamLoop<{ text?: string }>({
      throttleMs: 100,
      isStopped: () => false,
      emptyValue,
      isEmpty: (payload) => payload === emptyValue || !payload.text?.trim(),
      sendOrEditStreamMessage,
    });

    loop.update({ text: "first" });
    await flushMicrotasks();
    expect(sendOrEditStreamMessage).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_100);
    loop.update({
      get text(): undefined {
        return undefined;
      },
    });
    await loop.flush();
    expect(sendOrEditStreamMessage).toHaveBeenCalledTimes(1);

    loop.update({ text: "next" });
    await vi.advanceTimersByTimeAsync(100);
    expect(sendOrEditStreamMessage).toHaveBeenCalledTimes(2);
    expect(sendOrEditStreamMessage.mock.calls[1]?.[0].text).toBe("next");
  });
});
