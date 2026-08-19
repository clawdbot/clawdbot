import type { Model, StreamOptions } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import {
  notifyProviderHttpMetadata,
  notifyProviderHttpResponse,
  notifyProviderStreamOpened,
} from "./transport-stream-shared.js";

const model = { id: "acceptance-test", provider: "test" } as Model;

describe("notifyProviderHttpResponse", () => {
  it.each(["onProviderAccepted", "onResponse"] as const)(
    "cancels an unread response when %s fails",
    async (hookName) => {
      const hookError = new Error(`${hookName} failed`);
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          cancel,
        }),
        { status: 200 },
      );
      const options: StreamOptions = {
        [hookName]: vi.fn(() => Promise.reject(hookError)),
      };

      await expect(notifyProviderHttpResponse({ options, response, model })).rejects.toBe(
        hookError,
      );

      expect(cancel).toHaveBeenCalledWith(hookError);
    },
  );

  it("does not wait for unread response cancellation after a callback fails", async () => {
    const hookError = new Error("acceptance failed");
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => {
      markCancelStarted = resolve;
    });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          markCancelStarted();
          return new Promise<void>(() => {});
        },
      }),
      { status: 200 },
    );
    const notification = notifyProviderHttpResponse({
      options: { onProviderAccepted: () => Promise.reject(hookError) },
      response,
      model,
    });

    await cancelStarted;
    await expect(notification).rejects.toBe(hookError);
  });

  it("reports a rejected HTTP response without marking it accepted", async () => {
    const onProviderAccepted = vi.fn();
    const onResponse = vi.fn();
    const options: StreamOptions = { onProviderAccepted, onResponse };
    const response = new Response("rejected", { status: 429 });

    await notifyProviderHttpResponse({ options, response, model });

    expect(onProviderAccepted).not.toHaveBeenCalled();
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ status: 429 }), model);
  });

  it("does not resume response handling when a callback aborts its signal", async () => {
    const controller = new AbortController();
    const abortReason = Object.assign(new Error("operator canceled"), {
      code: "OPERATOR_CANCELLED",
    });
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 });

    await expect(
      notifyProviderHttpResponse({
        options: {
          signal: controller.signal,
          onProviderAccepted: () => controller.abort(abortReason),
        },
        response,
        model,
      }),
    ).rejects.toBe(abortReason);
    expect(cancel).toHaveBeenCalledWith(abortReason);
  });

  it("uses the option signal to abort a pending HTTP acceptance callback", async () => {
    const controller = new AbortController();
    const abortReason = Object.assign(new Error("operator canceled"), {
      code: "OPERATOR_CANCELLED",
    });
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 });
    let markHookStarted!: () => void;
    const hookStarted = new Promise<void>((resolve) => {
      markHookStarted = resolve;
    });
    const options: StreamOptions = {
      signal: controller.signal,
      onProviderAccepted: () => {
        markHookStarted();
        return new Promise<void>(() => {});
      },
    };

    const notification = notifyProviderHttpResponse({ options, response, model });
    await hookStarted;
    controller.abort(abortReason);

    await expect(notification).rejects.toBe(abortReason);
    expect(cancel).toHaveBeenCalledWith(abortReason);
  });
});

describe("opaque provider stream acceptance", () => {
  it("cancels an SDK stream without waiting when acceptance fails", async () => {
    const hookError = new Error("acceptance callback failed");
    const cancelStream = vi.fn(() => new Promise<void>(() => {}));

    await expect(
      notifyProviderStreamOpened({
        options: { onProviderAccepted: () => Promise.reject(hookError) },
        model,
        cancelStream,
      }),
    ).rejects.toBe(hookError);

    expect(cancelStream).toHaveBeenCalledOnce();
    expect(cancelStream).toHaveBeenCalledWith(hookError);
  });

  it("cancels an SDK stream when the acceptance callback is aborted", async () => {
    const controller = new AbortController();
    const abortReason = Object.assign(new Error("operator canceled"), {
      code: "OPERATOR_CANCELLED",
    });
    const cancelStream = vi.fn();
    let markHookStarted!: () => void;
    const hookStarted = new Promise<void>((resolve) => {
      markHookStarted = resolve;
    });
    const options: StreamOptions = {
      signal: controller.signal,
      onProviderAccepted: () => {
        markHookStarted();
        return new Promise<void>(() => {});
      },
    };

    const notification = notifyProviderStreamOpened({ options, model, cancelStream });
    await hookStarted;
    controller.abort(abortReason);

    await expect(notification).rejects.toBe(abortReason);
    expect(cancelStream).toHaveBeenCalledOnce();
    expect(cancelStream).toHaveBeenCalledWith(abortReason);
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("synchronous cleanup failure");
      },
    ],
    ["rejects", () => Promise.reject(new Error("asynchronous cleanup failure"))],
  ])("preserves the lifecycle failure when SDK cleanup %s", async (_label, cancelStream) => {
    const hookError = new Error("acceptance callback failed");

    await expect(
      notifyProviderStreamOpened({
        options: { onProviderAccepted: () => Promise.reject(hookError) },
        model,
        cancelStream,
      }),
    ).rejects.toBe(hookError);
  });

  it("does not cancel an accepted SDK stream", async () => {
    const cancelStream = vi.fn();

    await notifyProviderStreamOpened({
      options: { onProviderAccepted: vi.fn() },
      model,
      cancelStream,
    });

    expect(cancelStream).not.toHaveBeenCalled();
  });

  it("cancels a metadata-only SDK stream when its compatibility callback fails", async () => {
    const hookError = new Error("response callback failed");
    const cancelStream = vi.fn();

    await expect(
      notifyProviderHttpMetadata({
        options: { onResponse: () => Promise.reject(hookError) },
        response: { status: 200, headers: {} },
        model,
        cancelStream,
      }),
    ).rejects.toBe(hookError);

    expect(cancelStream).toHaveBeenCalledOnce();
    expect(cancelStream).toHaveBeenCalledWith(hookError);
  });
});
