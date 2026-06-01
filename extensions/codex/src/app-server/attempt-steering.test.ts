import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexSteeringQueue } from "./attempt-steering.js";

describe("Codex app-server steering queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves queued steering only after turn/steer is accepted", async () => {
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      answerPendingUserInput: () => false,
      signal: new AbortController().signal,
    });

    const queued = queue.queue("accepted", { debounceMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await queued;

    expect(request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "accepted", text_elements: [] }],
    });
  });

  it("rejects queued steering when turn/steer is rejected", async () => {
    const request = vi.fn(async () => {
      throw new Error("cannot steer a compact turn");
    });
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      answerPendingUserInput: () => false,
      signal: new AbortController().signal,
    });

    const queued = queue.queue("rejected", { debounceMs: 0 });
    const rejected = expect(queued).rejects.toThrow("cannot steer a compact turn");
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    expect(request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "rejected", text_elements: [] }],
    });
  });

  it("rejects queued steering when the run aborts before debounce flush", async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      answerPendingUserInput: () => false,
      signal: controller.signal,
    });

    const queued = queue.queue("aborted", { debounceMs: 1 });
    const rejected = expect(queued).rejects.toThrow("codex app-server steering queue aborted");
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);

    await rejected;
    expect(request).not.toHaveBeenCalled();
  });

  it("answers pending user input without sending turn/steer", async () => {
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const answerPendingUserInput = vi.fn(() => true);
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      answerPendingUserInput,
      signal: new AbortController().signal,
    });

    await queue.queue("answer locally", { debounceMs: 0 });

    expect(answerPendingUserInput).toHaveBeenCalledWith("answer locally");
    expect(request).not.toHaveBeenCalled();
  });
});
