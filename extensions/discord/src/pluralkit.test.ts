// Discord tests cover pluralkit plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { fetchPluralKitMessageInfo } from "./pluralkit.js";

type MockResponse = {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  body: null;
  arrayBuffer: () => Promise<Buffer>;
};

const buildResponse = (params: { status: number; body?: unknown }): MockResponse => {
  const body = params.body;
  const textPayload = typeof body === "string" ? body : body == null ? "" : JSON.stringify(body);
  return {
    status: params.status,
    ok: params.status >= 200 && params.status < 300,
    text: async () => textPayload,
    json: async () => body ?? {},
    body: null,
    arrayBuffer: async () => Buffer.from(textPayload),
  };
};

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

describe("fetchPluralKitMessageInfo", () => {
  it("returns null when disabled", async () => {
    const fetcher = vi.fn();
    const result = await fetchPluralKitMessageInfo({
      messageId: "123",
      config: { enabled: false },
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns null on 404", async () => {
    const tracked = cancelTrackedResponse("missing", { status: 404 });
    const fetcher = vi.fn(async () => tracked.response);
    const result = await fetchPluralKitMessageInfo({
      messageId: "missing",
      config: { enabled: true },
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result).toBeNull();
    expect(tracked.wasCanceled()).toBe(true);
  });

  it("returns payload and sends token when configured", async () => {
    let receivedHeaders: Record<string, string> | undefined;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      receivedHeaders = init?.headers as Record<string, string> | undefined;
      return buildResponse({
        status: 200,
        body: {
          id: "123",
          member: { id: "mem_1", name: "Alex" },
          system: { id: "sys_1", name: "System" },
        },
      });
    });

    const result = await fetchPluralKitMessageInfo({
      messageId: "123",
      config: { enabled: true, token: "pk_test" },
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(result?.member?.id).toBe("mem_1");
    expect(receivedHeaders?.Authorization).toBe("pk_test");
  });

  it("aborts PluralKit response body reads that exceed the lookup timeout", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        observedSignal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            observedSignal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("PluralKit lookup timed out", "AbortError")),
              { once: true },
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const lookupPromise = fetchPluralKitMessageInfo({
        messageId: "slow-body",
        config: { enabled: true },
        fetcher,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(observedSignal?.aborted).toBe(false);
      const lookupRejection = expect(lookupPromise).rejects.toThrow(/timed out|abort/i);

      await vi.advanceTimersByTimeAsync(10_000);
      await lookupRejection;
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("relays parent cancellation to the PluralKit request", async () => {
    const parent = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      observedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener(
          "abort",
          () => {
            const reason = observedSignal?.reason;
            reject(reason instanceof Error ? reason : new Error("PluralKit request aborted"));
          },
          { once: true },
        );
      });
    });

    const lookupPromise = fetchPluralKitMessageInfo({
      messageId: "cancelled",
      config: { enabled: true },
      fetcher,
      signal: parent.signal,
    });
    parent.abort(new Error("preflight stopped"));

    await expect(lookupPromise).rejects.toThrow("preflight stopped");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("bounds PluralKit API error bodies without using response.text()", async () => {
    const tracked = cancelTrackedResponse(`${"plural failure ".repeat(1024)}tail`, {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    const fetcher = vi.fn(async () => tracked.response);

    let caught: Error | undefined;
    try {
      await fetchPluralKitMessageInfo({
        messageId: "boom",
        config: { enabled: true },
        fetcher: fetcher as unknown as typeof fetch,
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toContain("PluralKit API failed (500): plural failure");
    expect(caught?.message).not.toContain("tail");
    expect(caught?.message.length).toBeLessThan(8_400);
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });
});
