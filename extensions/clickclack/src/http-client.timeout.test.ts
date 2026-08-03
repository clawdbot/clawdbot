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

  it("does not impose the response-header deadline on channel media uploads", async () => {
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
