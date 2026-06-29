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
    const fetcher = vi.fn(async () => buildResponse({ status: 404 }));
    const result = await fetchPluralKitMessageInfo({
      messageId: "missing",
      config: { enabled: true },
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result).toBeNull();
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
