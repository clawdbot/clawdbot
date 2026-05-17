import { describe, expect, it, vi } from "vitest";
import { createDraftStreamLoop } from "./draft-stream-loop.js";

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const flushMacrotask = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

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
      await flushMicrotasks();
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
      vi.useRealTimers();
    }
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
      await flushMicrotasks();
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
      await flushMicrotasks();
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
});
