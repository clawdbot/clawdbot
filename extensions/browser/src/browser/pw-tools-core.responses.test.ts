import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { responseBodyViaPlaywright } from "./pw-tools-core.responses.js";

const mocks = vi.hoisted(() => ({
  getPageForTargetId: vi.fn(),
  ensurePageState: vi.fn(),
}));
vi.mock("./pw-session.js", () => mocks);

describe("response body operation lifecycle", () => {
  let page: EventEmitter;

  beforeEach(() => {
    vi.useFakeTimers();
    page = new EventEmitter();
    mocks.getPageForTargetId.mockResolvedValue(page);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const options = { cdpUrl: "http://127.0.0.1:18792", url: "**/api", timeoutMs: 500 };

  function response(body: () => Promise<Buffer>) {
    return {
      url: () => "https://example.com/api",
      status: () => 200,
      headers: () => ({ "content-type": "text/plain" }),
      body,
    };
  }

  it.each([0, 400])("keeps the total deadline when headers take %i ms", async (headerDelay) => {
    let finishBody!: (body: Buffer) => void;
    const pendingBody = new Promise<Buffer>((resolve) => {
      finishBody = resolve;
    });
    const body = vi.fn(() => pendingBody);
    const result = responseBodyViaPlaywright(options).then(
      () => "success",
      (error: unknown) => error,
    );
    let outcome: unknown = "pending";
    void result.then((value) => (outcome = value));
    await vi.advanceTimersByTimeAsync(headerDelay);
    page.emit("response", response(body));
    await vi.advanceTimersByTimeAsync(500 - headerDelay);
    try {
      expect(outcome).toBeInstanceOf(Error);
      expect(String(outcome)).toMatch(/timed out|timeout/i);
      expect(page.listenerCount("response")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finishBody(Buffer.from("late response"));
      await result;
    }
  });

  it.each(["headers", "body"])("honors caller cancellation while waiting for %s", async (phase) => {
    const controller = new AbortController();
    const reason = new Error("response request cancelled");
    const body = vi.fn(async (): Promise<Buffer> => Buffer.from("late response"));
    let finishBody!: (body: Buffer) => void;
    if (phase === "body") {
      body.mockImplementation(
        () =>
          new Promise<Buffer>((resolve) => {
            finishBody = resolve;
          }),
      );
    }
    const opts = { ...options, signal: controller.signal };
    const result = responseBodyViaPlaywright(opts).then(
      () => "success",
      (error: unknown) => error,
    );
    let outcome: unknown = "pending";
    void result.then((value) => (outcome = value));
    await vi.advanceTimersByTimeAsync(0);
    if (phase === "body") {
      page.emit("response", response(body));
      await vi.advanceTimersByTimeAsync(0);
    }
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(outcome).toBe(reason);
      expect(page.listenerCount("response")).toBe(0);
    } finally {
      if (phase === "body") {
        finishBody(Buffer.from("late response"));
      } else {
        page.emit("response", response(body));
      }
      await result;
    }
    if (phase === "headers") {
      expect(body).not.toHaveBeenCalled();
    }
  });

  it("preserves the missing-response recovery hint and removes its listeners", async () => {
    const result = responseBodyViaPlaywright(options).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    expect(String(await result)).toContain("openclaw browser requests");
    expect(page.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resolve a page for an already cancelled caller", async () => {
    const reason = new Error("already cancelled");
    const opts = { ...options, signal: AbortSignal.abort(reason) };
    await expect(responseBodyViaPlaywright(opts)).rejects.toBe(reason);
    expect(mocks.getPageForTargetId).not.toHaveBeenCalled();
  });

  it("selects only the first matching response and clears its deadline", async () => {
    const result = responseBodyViaPlaywright(options);
    const ignoredBody = vi.fn(async () => Buffer.from("ignored"));
    const firstBody = Buffer.from("first response");
    await vi.advanceTimersByTimeAsync(0);
    page.emit("response", { ...response(ignoredBody), url: () => "https://example.com/other" });
    page.emit(
      "response",
      response(async () => firstBody),
    );
    page.emit("response", response(ignoredBody));
    await expect(result).resolves.toMatchObject({ body: "first response", status: 200 });
    expect(ignoredBody).not.toHaveBeenCalled();
    expect(page.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles page closure and absorbs a late body failure", async () => {
    let rejectBody!: (reason: Error) => void;
    const result = responseBodyViaPlaywright(options).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    page.emit(
      "response",
      response(
        () =>
          new Promise<Buffer>((_resolve, reject) => {
            rejectBody = reject;
          }),
      ),
    );
    page.emit("close");
    await expect(result).resolves.toMatchObject({
      message: "Page closed before response body was available.",
    });
    rejectBody(new Error("late transport failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(page.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
