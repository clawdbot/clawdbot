// Codex tests cover attempt steering plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexSteeringQueue } from "./attempt-steering.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0V8AAAAASUVORK5CYII=";

describe("Codex app-server steering queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createQueue(
    request: ReturnType<typeof vi.fn>,
    options: {
      signal?: AbortSignal;
      claimPendingUserInput?: () =>
        | { answer: (text: string) => boolean; cancel: () => boolean }
        | undefined;
    } = {},
  ) {
    return createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      claimPendingUserInput: options.claimPendingUserInput ?? (() => undefined),
      signal: options.signal ?? new AbortController().signal,
    });
  }

  it("resolves only after the matching Codex user message completes", async () => {
    const request = vi.fn(async (_method: string, _params: unknown) => ({ turnId: "turn-1" }));
    const queue = createQueue(request);

    const queued = queue.queue("accepted", { debounceMs: 0 });
    let settled = false;
    void queued.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    const requestParams = request.mock.calls[0]?.[1] as { clientUserMessageId?: string };
    expect(requestParams.clientUserMessageId).toBe("openclaw:turn-1:steer:1");
    expect(settled).toBe(false);
    expect(queue.confirmConsumed("unrelated-user-message")).toBe(false);
    expect(queue.confirmConsumed(requestParams.clientUserMessageId ?? "")).toBe(true);
    await queued;
    expect(request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "accepted", text_elements: [] }],
      clientUserMessageId: "openclaw:turn-1:steer:1",
    });
  });

  it("handles user-message completion before the steer response", async () => {
    let acceptSteer: (() => void) | undefined;
    const steerAccepted = new Promise<void>((resolve) => {
      acceptSteer = resolve;
    });
    const request = vi.fn(async () => {
      await steerAccepted;
      return { turnId: "turn-1" };
    });
    const queue = createQueue(request);

    const queued = queue.queue("consumed first", { debounceMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(true);
    await queued;

    acceptSteer?.();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("batches ordered text and images under one correlated user-message id", async () => {
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createQueue(request);

    const first = queue.queue("first", {
      debounceMs: 5,
      images: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
    });
    const second = queue.queue("second", {
      debounceMs: 5,
      images: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
    });
    await vi.advanceTimersByTimeAsync(5);

    expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(true);
    await Promise.all([first, second]);
    expect(request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [
        { type: "text", text: "first", text_elements: [] },
        { type: "image", url: `data:image/png;base64,${PNG_1X1}` },
        { type: "text", text: "second", text_elements: [] },
        { type: "image", url: `data:image/png;base64,${PNG_1X1}` },
      ],
      clientUserMessageId: "openclaw:turn-1:steer:1",
    });
  });

  it("rejects the batch when Codex rejects turn/steer", async () => {
    const request = vi.fn(async () => {
      throw new Error("cannot steer this turn");
    });
    const queue = createQueue(request);

    const queued = queue.queue("rejected", { debounceMs: 0 });
    const rejected = expect(queued).rejects.toThrow("cannot steer this turn");
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
  });

  it("rejects later steering behind a failed batch", async () => {
    let rejectFirstSteer: ((error: Error) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise<{ turnId: string }>((_resolve, reject) => {
          rejectFirstSteer = reject;
        }),
    );
    const queue = createQueue(request);

    const settled: string[] = [];
    const first = queue.queue("first", { debounceMs: 0 }).catch(() => {
      settled.push("first");
    });
    await vi.advanceTimersByTimeAsync(0);
    const second = queue.queue("second", { debounceMs: 0 }).catch(() => {
      settled.push("second");
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledOnce();
    rejectFirstSteer?.(new Error("cannot steer this turn"));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([first, second]);

    expect(request).toHaveBeenCalledOnce();
    expect(settled).toEqual(["first", "second"]);
  });

  it("rejects accepted but unconsumed steering when cancelled", async () => {
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createQueue(request);

    const queued = queue.queue("completion wake", { debounceMs: 0 });
    const rejected = expect(queued).rejects.toThrow("steering queue cancelled");
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);

    queue.cancel();
    await rejected;
    expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(false);
    await expect(queue.queue("too late", { debounceMs: 0 })).rejects.toThrow(
      "steering queue cancelled",
    );
  });

  it("rejects accepted but unconsumed steering when the run aborts", async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createQueue(request, { signal: controller.signal });

    const queued = queue.queue("completion wake", { debounceMs: 0 });
    const rejected = expect(queued).rejects.toThrow("steering queue aborted");
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);

    controller.abort();
    await rejected;
    expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(false);
    await expect(queue.queue("too late", { debounceMs: 0 })).rejects.toThrow(
      "steering queue aborted",
    );
  });

  it("does not dispatch a chained batch after cancellation", async () => {
    let acceptFirstSteer: (() => void) | undefined;
    const firstSteerAccepted = new Promise<void>((resolve) => {
      acceptFirstSteer = resolve;
    });
    const request = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstSteerAccepted;
        return { turnId: "turn-1" };
      })
      .mockResolvedValue({ turnId: "turn-1" });
    const queue = createQueue(request);

    const first = queue.queue("on the wire", { debounceMs: 0 });
    const firstRejected = expect(first).rejects.toThrow("steering queue cancelled");
    await vi.advanceTimersByTimeAsync(0);
    const second = queue.queue("waiting", { debounceMs: 0 });
    const secondRejected = expect(second).rejects.toThrow("steering queue cancelled");
    await vi.advanceTimersByTimeAsync(0);

    queue.cancel();
    acceptFirstSteer?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([firstRejected, secondRejected]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("answers pending user input without steering", async () => {
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const answerPendingUserInput = vi.fn(() => true);
    const queue = createQueue(request, {
      claimPendingUserInput: () => ({
        answer: answerPendingUserInput,
        cancel: vi.fn(() => true),
      }),
    });

    await queue.queue("answer locally", { debounceMs: 0 });
    expect(answerPendingUserInput).toHaveBeenCalledWith("answer locally");
    expect(request).not.toHaveBeenCalled();
  });

  it("steers a complete image reply before releasing pending input", async () => {
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const answerPendingUserInput = vi.fn(() => true);
    const cancelPendingUserInput = vi.fn(() => true);
    const queue = createQueue(request, {
      claimPendingUserInput: () => ({
        answer: answerPendingUserInput,
        cancel: cancelPendingUserInput,
      }),
    });

    const queued = queue.queue("compare these", {
      images: [
        { type: "image", data: PNG_1X1, mimeType: "image/png" },
        { type: "image", data: PNG_1X1, mimeType: "image/png" },
      ],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(answerPendingUserInput).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [
        { type: "text", text: "compare these", text_elements: [] },
        { type: "image", url: `data:image/png;base64,${PNG_1X1}` },
        { type: "image", url: `data:image/png;base64,${PNG_1X1}` },
      ],
      clientUserMessageId: "openclaw:turn-1:steer:1",
    });
    expect(cancelPendingUserInput).toHaveBeenCalledOnce();
    expect(request.mock.invocationCallOrder[0]!).toBeLessThan(
      cancelPendingUserInput.mock.invocationCallOrder[0]!,
    );
    expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(true);
    await queued;
  });

  it("claims pending input before a later queued message can answer it", async () => {
    let resolveImageSteer: (() => void) | undefined;
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ turnId: string }>((resolve) => {
            resolveImageSteer = () => resolve({ turnId: "turn-1" });
          }),
      )
      .mockResolvedValue({ turnId: "turn-1" });
    const cancelPendingUserInput = vi.fn(() => true);
    let pendingClaimed = false;
    const queue = createQueue(request, {
      claimPendingUserInput: () => {
        if (pendingClaimed) {
          return undefined;
        }
        pendingClaimed = true;
        return { answer: vi.fn(() => true), cancel: cancelPendingUserInput };
      },
    });

    const imageQueued = queue.queue("image reply", {
      images: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
    });
    await vi.advanceTimersByTimeAsync(0);
    const laterQueued = queue.queue("later reply", { debounceMs: 0 });
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(1);
    resolveImageSteer?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
    expect(cancelPendingUserInput).toHaveBeenCalledOnce();
    expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(true);
    expect(queue.confirmConsumed("openclaw:turn-1:steer:2")).toBe(true);
    await Promise.all([imageQueued, laterQueued]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      input: [
        { type: "text", text: "image reply" },
        { type: "image", url: `data:image/png;base64,${PNG_1X1}` },
      ],
    });
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      input: [{ type: "text", text: "later reply" }],
    });
  });

  it("releases pending input when an atomic image steer is rejected", async () => {
    const request = vi.fn(async () => {
      throw new Error("cannot steer this turn");
    });
    const answerPendingUserInput = vi.fn(() => true);
    const cancelPendingUserInput = vi.fn(() => true);
    const queue = createQueue(request, {
      claimPendingUserInput: () => ({
        answer: answerPendingUserInput,
        cancel: cancelPendingUserInput,
      }),
    });

    const queued = queue.queue("compare this", {
      images: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
    });
    const rejected = expect(queued).rejects.toThrow("cannot steer this turn");
    await vi.advanceTimersByTimeAsync(0);
    await rejected;

    expect(answerPendingUserInput).not.toHaveBeenCalled();
    expect(cancelPendingUserInput).toHaveBeenCalledOnce();
  });

  it("rejects before dispatch when the run is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createQueue(request, { signal: controller.signal });

    await expect(queue.queue("aborted", { debounceMs: 0 })).rejects.toThrow(
      "steering queue aborted",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a debounced batch when the run aborts before dispatch", async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createQueue(request, { signal: controller.signal });

    const queued = queue.queue("aborted", { debounceMs: 5 });
    const rejected = expect(queued).rejects.toThrow("steering queue aborted");
    controller.abort();
    await vi.advanceTimersByTimeAsync(5);

    await rejected;
    expect(request).not.toHaveBeenCalled();
  });
});
