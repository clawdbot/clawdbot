// Codex tests cover attempt steering plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexSteeringAcceptedUnconfirmedError,
  createCodexSteeringQueue,
} from "./attempt-steering.js";
import { createClientHarness } from "./test-support.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0V8AAAAASUVORK5CYII=";

describe("Codex app-server steering queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createQueue(request: ReturnType<typeof vi.fn>, options: { signal?: AbortSignal } = {}) {
    return createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      requestTimeoutMs: 60_000,
      signal: options.signal ?? new AbortController().signal,
    });
  }

  const steerRequestOptions = { timeoutMs: 60_000, signal: expect.any(AbortSignal) };

  it("resolves only after the matching Codex user message completes", async () => {
    const request = vi.fn(async (_method: string, _params: unknown) => ({ turnId: "turn-1" }));
    const queue = createQueue(request);
    const onQueueAccepted = vi.fn();

    const queued = queue.queue("accepted", { debounceMs: 0, onQueueAccepted });
    let settled = false;
    void queued.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    const requestParams = request.mock.calls[0]?.[1] as { clientUserMessageId?: string };
    expect(requestParams.clientUserMessageId).toBe("openclaw:turn-1:steer:1");
    expect(onQueueAccepted).toHaveBeenCalledWith(true);
    expect(settled).toBe(false);
    expect(queue.confirmConsumed("unrelated-user-message")).toBe(false);
    expect(queue.confirmConsumed(requestParams.clientUserMessageId ?? "")).toBe(true);
    await queued;
    expect(request).toHaveBeenCalledWith(
      "turn/steer",
      {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "accepted", text_elements: [] }],
        clientUserMessageId: "openclaw:turn-1:steer:1",
      },
      steerRequestOptions,
    );
  });

  it("fails the steer when the app-server never answers turn/steer", async () => {
    // Real client over an in-memory transport: only the app-server process is faked,
    // so this exercises the production request deadline rather than a stub.
    const harness = createClientHarness();
    const queue = createCodexSteeringQueue({
      client: harness.client,
      threadId: "thread-1",
      turnId: "turn-1",
      requestTimeoutMs: 1_000,
      signal: new AbortController().signal,
    });

    const outcomes: unknown[] = [];
    void queue.queue("steer me", { debounceMs: 0 }).then(
      () => outcomes.push("resolved"),
      (error: unknown) => outcomes.push(error),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect((JSON.parse(harness.writes[0] ?? "{}") as { method?: string }).method).toBe(
      "turn/steer",
    );

    // Codex accepted the frame but never responds: the caller must not wait forever.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(outcomes[0]).toBeInstanceOf(CodexSteeringAcceptedUnconfirmedError);
    expect((outcomes[0] as Error & { cause?: unknown }).cause).toMatchObject({
      message: "turn/steer timed out",
    });
    harness.client.close();
  });

  it("aborts the in-flight steer request and removes its client pending entry", async () => {
    const harness = createClientHarness();
    const controller = new AbortController();
    const queue = createCodexSteeringQueue({
      client: harness.client,
      threadId: "thread-1",
      turnId: "turn-1",
      requestTimeoutMs: 60_000,
      signal: controller.signal,
    });
    const pendingRequests = (
      harness.client as unknown as { pending: Map<number | string, unknown> }
    ).pending;

    const queued = queue.queue("steer me", { debounceMs: 0 });
    const rejected = expect(queued).rejects.toBeInstanceOf(CodexSteeringAcceptedUnconfirmedError);
    await vi.advanceTimersByTimeAsync(0);
    expect(pendingRequests.size).toBe(1);

    controller.abort();

    await rejected;
    expect(pendingRequests.size).toBe(0);
    harness.client.close();
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
    const onQueueAccepted = vi.fn();

    const queued = queue.queue("consumed first", { debounceMs: 0, onQueueAccepted });
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(true);
    expect(onQueueAccepted).toHaveBeenCalledWith(true);
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
    expect(request).toHaveBeenCalledWith(
      "turn/steer",
      {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [
          { type: "text", text: "first", text_elements: [] },
          { type: "image", url: `data:image/png;base64,${PNG_1X1}` },
          { type: "text", text: "second", text_elements: [] },
          { type: "image", url: `data:image/png;base64,${PNG_1X1}` },
        ],
        clientUserMessageId: "openclaw:turn-1:steer:1",
      },
      steerRequestOptions,
    );
  });

  it("rejects the batch when Codex rejects turn/steer", async () => {
    const request = vi.fn(async () => {
      throw new Error("cannot steer this turn");
    });
    const queue = createQueue(request);
    const onQueueAccepted = vi.fn();

    const queued = queue.queue("rejected", { debounceMs: 0, onQueueAccepted });
    const rejected = expect(queued).rejects.toThrow("cannot steer this turn");
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    expect(onQueueAccepted).toHaveBeenCalledWith(false);
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
    const rejected = expect(queued).rejects.toBeInstanceOf(CodexSteeringAcceptedUnconfirmedError);
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
    const rejected = expect(queued).rejects.toBeInstanceOf(CodexSteeringAcceptedUnconfirmedError);
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
    const onFirstAccepted = vi.fn();
    const onSecondAccepted = vi.fn();

    const first = queue.queue("on the wire", {
      debounceMs: 0,
      onQueueAccepted: onFirstAccepted,
    });
    const firstRejected = expect(first).rejects.toBeInstanceOf(
      CodexSteeringAcceptedUnconfirmedError,
    );
    await vi.advanceTimersByTimeAsync(0);
    const second = queue.queue("waiting", {
      debounceMs: 0,
      onQueueAccepted: onSecondAccepted,
    });
    const secondRejected = expect(second).rejects.toThrow("steering queue cancelled");
    await vi.advanceTimersByTimeAsync(0);

    queue.cancel();
    acceptFirstSteer?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([firstRejected, secondRejected]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(onFirstAccepted).toHaveBeenCalledWith(true);
    expect(onSecondAccepted).toHaveBeenCalledWith(false);
  });

  it("seals unsent admission while preserving a dispatched consumption confirmation", async () => {
    let acceptFirstSteer: (() => void) | undefined;
    const firstSteerAccepted = new Promise<void>((resolve) => {
      acceptFirstSteer = resolve;
    });
    const request = vi.fn(async () => {
      await firstSteerAccepted;
      return { turnId: "turn-1" };
    });
    const queue = createQueue(request);
    const onDispatchedAccepted = vi.fn();
    const onChainedAccepted = vi.fn();
    const onDebouncedAccepted = vi.fn();
    const onLateAccepted = vi.fn();

    const dispatched = queue.queue("on the wire", {
      debounceMs: 0,
      onQueueAccepted: onDispatchedAccepted,
    });
    await vi.advanceTimersByTimeAsync(0);
    const chained = queue.queue("waiting on send chain", {
      debounceMs: 0,
      onQueueAccepted: onChainedAccepted,
    });
    const chainedRejected = expect(chained).rejects.toThrow("queue admission sealed");
    const debounced = queue.queue("still debounced", {
      debounceMs: 30_000,
      onQueueAccepted: onDebouncedAccepted,
    });
    const debouncedRejected = expect(debounced).rejects.toThrow("queue admission sealed");
    await vi.advanceTimersByTimeAsync(0);

    queue.sealAdmission();

    await Promise.all([chainedRejected, debouncedRejected]);
    await expect(
      queue.queue("too late", { debounceMs: 0, onQueueAccepted: onLateAccepted }),
    ).rejects.toThrow("queue admission sealed");
    expect(request).toHaveBeenCalledOnce();
    expect(onChainedAccepted).toHaveBeenCalledWith(false);
    expect(onDebouncedAccepted).toHaveBeenCalledWith(false);
    expect(onLateAccepted).toHaveBeenCalledWith(false);
    expect(onDispatchedAccepted).not.toHaveBeenCalled();

    expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(true);
    await dispatched;
    expect(onDispatchedAccepted).toHaveBeenCalledWith(true);

    queue.cancel();
    acceptFirstSteer?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();
  });

  it("fully cancels a dispatched batch after admission was sealed", async () => {
    let acceptSteer: (() => void) | undefined;
    const steerAccepted = new Promise<void>((resolve) => {
      acceptSteer = resolve;
    });
    const request = vi.fn(async () => {
      await steerAccepted;
      return { turnId: "turn-1" };
    });
    const queue = createQueue(request);
    const onQueueAccepted = vi.fn();

    const dispatched = queue.queue("on the wire", { debounceMs: 0, onQueueAccepted });
    const rejected = expect(dispatched).rejects.toBeInstanceOf(
      CodexSteeringAcceptedUnconfirmedError,
    );
    await vi.advanceTimersByTimeAsync(0);

    queue.sealAdmission();
    expect(onQueueAccepted).not.toHaveBeenCalled();
    queue.cancel();
    queue.cancel();

    await rejected;
    expect(onQueueAccepted).toHaveBeenCalledWith(true);
    expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(false);
    acceptSteer?.();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("rejects before dispatch when the run is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createQueue(request, { signal: controller.signal });
    const onQueueAccepted = vi.fn();

    await expect(queue.queue("aborted", { debounceMs: 0, onQueueAccepted })).rejects.toThrow(
      "steering queue aborted",
    );
    expect(onQueueAccepted).toHaveBeenCalledWith(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a debounced batch when the run aborts before dispatch", async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createQueue(request, { signal: controller.signal });
    const onQueueAccepted = vi.fn();

    const queued = queue.queue("aborted", { debounceMs: 5, onQueueAccepted });
    const rejected = expect(queued).rejects.toThrow("steering queue aborted");
    controller.abort();
    await vi.advanceTimersByTimeAsync(5);

    await rejected;
    expect(request).not.toHaveBeenCalled();
    expect(onQueueAccepted).toHaveBeenCalledWith(false);
  });
});
