import { describe, expect, it, vi } from "vitest";
import { fetchPluralKitMessageInfo } from "./pluralkit.js";

type MockResponse = {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};

const buildResponse = (params: { status: number; body?: unknown }): MockResponse => {
  const body = params.body;
  const textPayload = typeof body === "string" ? body : body == null ? "" : JSON.stringify(body);
  return {
    status: params.status,
    ok: params.status >= 200 && params.status < 300,
    text: async () => textPayload,
    json: async () => body ?? {},
  };
};

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
});
