import { describe, expect, it, vi } from "vitest";
import { createClickClackClient } from "./http-client.js";

describe("ClickClack HTTP client timeouts", () => {
  it("aborts a REST request that stalls before response headers", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("expected ClickClack request signal"));
              return;
            }
            signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
          }),
      );
      const client = createClickClackClient({
        baseUrl: "https://clickclack.example",
        token: "fake",
        fetch: fetchMock as unknown as typeof fetch,
      });

      const rejection = expect(client.me()).rejects.toMatchObject({
        name: "TimeoutError",
        message: "request timed out",
      });
      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a REST response body that stops making progress", async () => {
    vi.useFakeTimers();
    try {
      let cancelReason: unknown;
      const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("expected ClickClack request signal");
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"user":'));
          },
          cancel(reason) {
            cancelReason = reason;
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      const client = createClickClackClient({
        baseUrl: "https://clickclack.example",
        token: "fake",
        fetch: fetchMock as unknown as typeof fetch,
      });

      const rejection = expect(client.me()).rejects.toMatchObject({
        name: "TimeoutError",
        message: "request timed out",
      });
      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      expect(cancelReason).toMatchObject({
        name: "TimeoutError",
        message: "request timed out",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a stalled REST error body before building the HTTP error", async () => {
    vi.useFakeTimers();
    try {
      let cancelReason: unknown;
      const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("upstream failure"));
          },
          cancel(reason) {
            cancelReason = reason;
          },
        });
        return new Response(body, { status: 502 });
      });
      const client = createClickClackClient({
        baseUrl: "https://clickclack.example",
        token: "fake",
        fetch: fetchMock as unknown as typeof fetch,
      });

      const rejection = expect(client.me()).rejects.toMatchObject({
        name: "TimeoutError",
        message: "request timed out",
      });
      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
      expect(cancelReason).toMatchObject({
        name: "TimeoutError",
        message: "request timed out",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a REST response to make progress beyond the header deadline", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => controller.enqueue(encoder.encode('{"user":')), 20_000);
            setTimeout(() => controller.enqueue(encoder.encode('{"id":"user-1"}}')), 40_000);
            setTimeout(() => controller.close(), 60_000);
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      const client = createClickClackClient({
        baseUrl: "https://clickclack.example",
        token: "fake",
        fetch: fetchMock as unknown as typeof fetch,
      });

      const result = client.me();
      await vi.advanceTimersByTimeAsync(60_000);

      await expect(result).resolves.toMatchObject({ id: "user-1" });
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not impose a total deadline on channel media uploads", async () => {
    vi.useFakeTimers();
    try {
      let resolveResponse: (response: Response) => void = () => {
        throw new Error("upload response resolver was not initialized");
      };
      let settled = false;
      const fetchMock = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          await new Promise<Response>((resolve) => {
            resolveResponse = resolve;
          }),
      );
      const client = createClickClackClient({
        baseUrl: "https://clickclack.example",
        token: "fake",
        fetch: fetchMock as unknown as typeof fetch,
      });

      const upload = client
        .createUpload({
          workspaceId: "workspace-1",
          buffer: Buffer.from("media"),
          filename: "media.txt",
          contentType: "text/plain",
        })
        .finally(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(settled).toBe(false);
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeUndefined();

      resolveResponse(Response.json({ upload: { id: "upload-1" } }));
      await expect(upload).resolves.toMatchObject({ id: "upload-1" });
    } finally {
      vi.useRealTimers();
    }
  });
});
