// Feishu tests for token-invalid retry behavior in streaming card sessions (#97287).
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuStreamingSession } from "./streaming-card.js";
import { clearStreamingTokenCache } from "./streaming-token-cache.js";

type FeishuStreamingFetch = typeof fetch;

const hermeticPublicLookup: LookupFn = (async (_hostname: string, _options?: unknown) => ({
  address: "93.184.216.34",
  family: 4,
})) as LookupFn;

function createMemoryFetch(handler: (url: URL, body: string) => Response | Promise<Response>): {
  fetchImpl: FeishuStreamingFetch;
  lookupFn: LookupFn;
} {
  return {
    fetchImpl: withFetchPreconnect(
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const body = typeof init?.body === "string" ? init.body : "";
        return await handler(url, body);
      }),
    ) as FeishuStreamingFetch,
    lookupFn: hermeticPublicLookup,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("feishu streaming token-invalid retry (#97287)", () => {
  beforeEach(() => {
    clearStreamingTokenCache();
  });

  afterEach(() => {
    clearStreamingTokenCache();
  });

  it("refreshes the client via getClient closure on token-invalid retry", async () => {
    let clientCallCount = 0;
    const clients = [
      {
        im: {
          message: {
            create: vi.fn(async () => ({
              code: 99991663,
              msg: "Invalid access token",
              data: {},
            })),
          },
        },
      },
      {
        im: {
          message: {
            create: vi.fn(async () => ({
              code: 0,
              msg: "ok",
              data: { message_id: "om_refreshed" },
            })),
          },
        },
      },
    ];

    const deps = createMemoryFetch((url) => {
      if (url.pathname.includes("/auth/")) {
        return jsonResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: "token-1",
          expire: 7200,
        });
      }
      return jsonResponse({
        code: 0,
        msg: "ok",
        data: { card_id: "card_retry" },
      });
    });

    const getClient = () => {
      const client = clients[Math.min(clientCallCount, clients.length - 1)];
      clientCallCount += 1;
      return client as never;
    };

    const session = new FeishuStreamingSession(
      getClient,
      { appId: "app_retry", appSecret: "secret" },
      undefined,
      deps,
      "account_retry",
    );

    await session.start("chat_id", "chat_id");

    // The first client returned a token-invalid body; requestFeishuApi should
    // have cleared caches and retried, causing getClient() to be called again
    // for a fresh client.
    expect(clientCallCount).toBeGreaterThanOrEqual(2);
    expect(clients[0]!.im.message.create).toHaveBeenCalledTimes(1);
    expect(clients[1]!.im.message.create).toHaveBeenCalledTimes(1);

    await session.discard();
  });

  it("does not retry token-invalid more than once for streaming card send", async () => {
    const createMock = vi.fn(async () => ({
      code: 99991663,
      msg: "Invalid access token",
      data: {},
    }));

    const deps = createMemoryFetch((url) => {
      if (url.pathname.includes("/auth/")) {
        return jsonResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: "token-1",
          expire: 7200,
        });
      }
      return jsonResponse({
        code: 0,
        msg: "ok",
        data: { card_id: "card_no_retry" },
      });
    });

    const session = new FeishuStreamingSession(
      () => ({ im: { message: { create: createMock } } }) as never,
      { appId: "app_no_retry", appSecret: "secret" },
      undefined,
      deps,
      "account_no_retry",
    );

    // The send should fail after one token-invalid retry because the second
    // attempt also returns token-invalid.
    await expect(session.start("chat_id", "chat_id")).rejects.toThrow();

    // createMock called twice: initial + one retry.
    expect(createMock).toHaveBeenCalledTimes(2);
  });
});
