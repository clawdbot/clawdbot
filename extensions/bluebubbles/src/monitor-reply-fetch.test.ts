import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueBubblesClient, createBlueBubblesClientFromParts } from "./client.js";
import {
  _resetBlueBubblesShortIdState,
  getShortIdForUuid,
  resolveReplyContextFromCache,
} from "./monitor-reply-cache.js";
import {
  _resetBlueBubblesReplyFetchState,
  fetchBlueBubblesReplyContext,
} from "./monitor-reply-fetch.js";

type FactoryParams = Parameters<typeof createBlueBubblesClientFromParts>[0];
type RequestParams = Parameters<BlueBubblesClient["request"]>[0];

const baseParams = {
  accountId: "default",
  baseUrl: "http://localhost:1234",
  password: "s3cret",
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Build a fake client factory that records every constructor + request call
 * and serves a queue of canned responses. Returns the factory plus a `calls`
 * accessor so tests can assert on factory params (SSRF mode inputs) and
 * request params (path, timeout).
 */
function makeFakeClient(
  responses:
    | Array<Response | Error | (() => Promise<Response>)>
    | (() => Response | Promise<Response>),
) {
  const factoryCalls: FactoryParams[] = [];
  const requestCalls: RequestParams[] = [];
  let cursor = 0;
  const factory = vi.fn((factoryParams: FactoryParams): BlueBubblesClient => {
    factoryCalls.push(factoryParams);
    const request = vi.fn(async (requestParams: RequestParams) => {
      requestCalls.push(requestParams);
      if (typeof responses === "function") {
        return await responses();
      }
      const next = responses[cursor++];
      if (next instanceof Error) {
        throw next;
      }
      if (typeof next === "function") {
        return await next();
      }
      return next ?? new Response("", { status: 500 });
    });
    return { request } as unknown as BlueBubblesClient;
  });
  return { factory, factoryCalls, requestCalls };
}

beforeEach(() => {
  _resetBlueBubblesReplyFetchState();
  _resetBlueBubblesShortIdState();
});

afterEach(() => {
  _resetBlueBubblesReplyFetchState();
  _resetBlueBubblesShortIdState();
});

describe("fetchBlueBubblesReplyContext", () => {
  it("returns null when replyToId is empty", async () => {
    const { factory } = makeFakeClient([]);
    const result = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "  ",
      clientFactory: factory,
    });
    expect(result).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it("returns null when baseUrl or password are missing", async () => {
    const { factory } = makeFakeClient([]);
    expect(
      await fetchBlueBubblesReplyContext({
        accountId: "default",
        baseUrl: "",
        password: "x",
        replyToId: "msg-1",
        clientFactory: factory,
      }),
    ).toBeNull();
    expect(
      await fetchBlueBubblesReplyContext({
        accountId: "default",
        baseUrl: "http://localhost:1234",
        password: "",
        replyToId: "msg-1",
        clientFactory: factory,
      }),
    ).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects pathological reply ids before issuing a request", async () => {
    // Each case is rejected for a different reason: empty/whitespace, trailing
    // slash that yields an empty bare segment, characters outside the GUID
    // charset, or length cap. Note: `../etc/passwd` is *not* pathological —
    // sanitizeReplyToId strips to `passwd`, which is a syntactically valid
    // bare GUID. The path goes through encodeURIComponent, so there is no
    // traversal; the server returns 404 and the caller proceeds with null.
    const cases = ["", "   ", "abc/", "abc def", "abc?x=1", "a".repeat(129)];
    for (const replyToId of cases) {
      const { factory } = makeFakeClient([]);
      const result = await fetchBlueBubblesReplyContext({
        ...baseParams,
        replyToId,
        clientFactory: factory,
      });
      expect(result, `replyToId=${JSON.stringify(replyToId)}`).toBeNull();
      expect(factory, `replyToId=${JSON.stringify(replyToId)}`).not.toHaveBeenCalled();
    }
  });

  it("strips part-index prefix (`p:0/<guid>` → `<guid>`) before fetching", async () => {
    const { factory, requestCalls } = makeFakeClient([
      jsonResponse({ data: { text: "hi", handle: { address: "+15551234567" } } }),
    ]);
    const result = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "p:0/msg-bare-guid",
      clientFactory: factory,
    });
    expect(result?.body).toBe("hi");
    expect(requestCalls[0]?.path).toBe("/api/v1/message/msg-bare-guid");
  });

  it("populates the reply cache for the original prefixed reply id", async () => {
    const { factory } = makeFakeClient([
      jsonResponse({ data: { text: "cached prefix", handle: { address: "+15551112222" } } }),
    ]);
    await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "p:0/msg-prefixed-cache",
      chatGuid: "iMessage;-;+15551112222",
      clientFactory: factory,
    });
    const cached = resolveReplyContextFromCache({
      accountId: "default",
      replyToId: "p:0/msg-prefixed-cache",
      chatGuid: "iMessage;-;+15551112222",
    });
    expect(cached?.body).toBe("cached prefix");
    expect(cached?.senderLabel).toBe("+15551112222");
  });

  it("does not cache non-part-index slash prefixes as aliases", async () => {
    const { factory, requestCalls } = makeFakeClient([
      jsonResponse({ data: { text: "cached bare only", handle: { address: "+15551112222" } } }),
    ]);
    await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "../etc/passwd",
      chatGuid: "iMessage;-;+15551112222",
      clientFactory: factory,
    });
    expect(requestCalls[0]?.path).toBe("/api/v1/message/passwd");
    expect(
      resolveReplyContextFromCache({
        accountId: "default",
        replyToId: "passwd",
        chatGuid: "iMessage;-;+15551112222",
      })?.body,
    ).toBe("cached bare only");
    expect(
      resolveReplyContextFromCache({
        accountId: "default",
        replyToId: "../etc/passwd",
        chatGuid: "iMessage;-;+15551112222",
      }),
    ).toBeNull();
    expect(getShortIdForUuid("../etc/passwd")).toBeUndefined();
  });

  it("fetches the BB API and returns body + normalized sender on success", async () => {
    const { factory, requestCalls } = makeFakeClient([
      jsonResponse({
        data: {
          text: "  hello world  ",
          handle: { address: " +15551234567 " },
        },
      }),
    ]);
    const result = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "msg-1",
      clientFactory: factory,
    });
    expect(result).toEqual({ body: "hello world", sender: "+15551234567" });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(requestCalls[0]?.method).toBe("GET");
    expect(requestCalls[0]?.path).toBe("/api/v1/message/msg-1");
  });

  it("lowercases email handles via normalizeBlueBubblesHandle", async () => {
    const { factory } = makeFakeClient([
      jsonResponse({ data: { text: "hi", handle: { address: "Foo@Example.COM" } } }),
    ]);
    const result = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "msg-email",
      clientFactory: factory,
    });
    expect(result?.sender).toBe("foo@example.com");
  });

  it("populates the reply cache so subsequent lookups hit RAM", async () => {
    const { factory } = makeFakeClient([
      jsonResponse({ data: { text: "cached me", handle: { address: "+15551112222" } } }),
    ]);
    await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "msg-cache",
      chatGuid: "iMessage;-;+15551112222",
      clientFactory: factory,
    });
    const cached = resolveReplyContextFromCache({
      accountId: "default",
      replyToId: "msg-cache",
      chatGuid: "iMessage;-;+15551112222",
    });
    expect(cached?.body).toBe("cached me");
    expect(cached?.senderLabel).toBe("+15551112222");
    expect(cached?.shortId).toBeTruthy();
  });

  it("falls back through text → body → subject for the message body", async () => {
    const { factory } = makeFakeClient([
      jsonResponse({ data: { body: "from body field" } }),
      jsonResponse({ data: { subject: "from subject field" } }),
    ]);
    const a = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "msg-a",
      clientFactory: factory,
    });
    expect(a?.body).toBe("from body field");
    const b = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "msg-b",
      clientFactory: factory,
    });
    expect(b?.body).toBe("from subject field");
  });

  it("falls back through handle.address → handle.id → senderId → sender for the sender", async () => {
    const { factory } = makeFakeClient([
      jsonResponse({ data: { text: "x", handle: { id: "+15550000001" } } }),
      jsonResponse({ data: { text: "x", senderId: "+15550000002" } }),
      jsonResponse({ data: { text: "x", sender: "+15550000003" } }),
    ]);
    const a = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "h-a",
      clientFactory: factory,
    });
    expect(a?.sender).toBe("+15550000001");
    const b = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "h-b",
      clientFactory: factory,
    });
    expect(b?.sender).toBe("+15550000002");
    const c = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "h-c",
      clientFactory: factory,
    });
    expect(c?.sender).toBe("+15550000003");
  });

  it("accepts the BB response either wrapped under `data` or at the top level", async () => {
    const { factory } = makeFakeClient([
      jsonResponse({ text: "no envelope", handle: { address: "user@host" } }),
    ]);
    const result = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "msg-flat",
      clientFactory: factory,
    });
    expect(result?.body).toBe("no envelope");
    expect(result?.sender).toBe("user@host");
  });

  it("returns null on non-2xx without throwing", async () => {
    const { factory } = makeFakeClient([new Response("nope", { status: 404 })]);
    const result = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "missing",
      clientFactory: factory,
    });
    expect(result).toBeNull();
  });

  it("returns null when the underlying request throws (network error / timeout)", async () => {
    const { factory } = makeFakeClient([new Error("ECONNRESET")]);
    const result = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "boom",
      clientFactory: factory,
    });
    expect(result).toBeNull();
  });

  it("returns null when JSON parsing fails", async () => {
    const { factory } = makeFakeClient([
      new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    ]);
    const result = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "garbage",
      clientFactory: factory,
    });
    expect(result).toBeNull();
  });

  it("returns null when neither body nor sender can be extracted", async () => {
    const { factory } = makeFakeClient([jsonResponse({ data: { irrelevant: 1 } })]);
    const result = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "blank",
      clientFactory: factory,
    });
    expect(result).toBeNull();
  });

  it("dedupes concurrent fetches for the same accountId + replyToId", async () => {
    let resolveOnce: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveOnce = resolve;
    });
    const { factory } = makeFakeClient(() => pending);
    const a = fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "shared",
      clientFactory: factory,
    });
    const b = fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "shared",
      clientFactory: factory,
    });
    // Only one client construction; in-flight dedupe coalesces both callers.
    expect(factory).toHaveBeenCalledTimes(1);
    resolveOnce(
      jsonResponse({ data: { text: "shared body", handle: { address: "+15558675309" } } }),
    );
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toEqual({ body: "shared body", sender: "+15558675309" });
    expect(resB).toEqual(resA);
  });

  it("does not dedupe across different accountIds", async () => {
    const { factory } = makeFakeClient([
      jsonResponse({ data: { text: "a", handle: { address: "+15551000001" } } }),
      jsonResponse({ data: { text: "b", handle: { address: "+15551000002" } } }),
    ]);
    const [a, b] = await Promise.all([
      fetchBlueBubblesReplyContext({
        ...baseParams,
        accountId: "acct-a",
        replyToId: "same",
        clientFactory: factory,
      }),
      fetchBlueBubblesReplyContext({
        ...baseParams,
        accountId: "acct-b",
        replyToId: "same",
        clientFactory: factory,
      }),
    ]);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(a?.body).toBe("a");
    expect(b?.body).toBe("b");
  });

  it("releases the in-flight slot once a request completes (next call re-fetches)", async () => {
    const { factory } = makeFakeClient([
      jsonResponse({ data: { text: "first", handle: { address: "+15552000001" } } }),
      jsonResponse({ data: { text: "second", handle: { address: "+15552000002" } } }),
    ]);
    const first = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "msg-x",
      clientFactory: factory,
    });
    const second = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "msg-x",
      clientFactory: factory,
    });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(first?.body).toBe("first");
    expect(second?.body).toBe("second");
  });

  it("threads explicit private-network opt-in through to the typed client (mode 1)", async () => {
    const { factory, factoryCalls } = makeFakeClient([
      jsonResponse({ data: { text: "x", handle: { address: "+15553000001" } } }),
    ]);
    await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "ssrf-on",
      accountConfig: { network: { dangerouslyAllowPrivateNetwork: true } },
      clientFactory: factory,
    });
    expect(factoryCalls[0]?.allowPrivateNetwork).toBe(true);
    expect(factoryCalls[0]?.allowPrivateNetworkConfig).toBe(true);
  });

  it("treats local/loopback baseUrls as implicit private-network opt-in (mode 1)", async () => {
    // `http://localhost:1234` is a private hostname; without an explicit
    // opt-out the resolver treats this as the self-hosted case, matching
    // resolveBlueBubblesEffectiveAllowPrivateNetworkFromConfig.
    const { factory, factoryCalls } = makeFakeClient([
      jsonResponse({ data: { text: "x", handle: { address: "+15554000001" } } }),
    ]);
    await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "ssrf-implicit",
      clientFactory: factory,
    });
    expect(factoryCalls[0]?.allowPrivateNetwork).toBe(true);
    expect(factoryCalls[0]?.allowPrivateNetworkConfig).toBeUndefined();
  });

  it("does not mark public BB hosts as private-network when opt-in is absent (mode 2)", async () => {
    const { factory, factoryCalls } = makeFakeClient([
      jsonResponse({ data: { text: "x", handle: { address: "user@example.com" } } }),
    ]);
    await fetchBlueBubblesReplyContext({
      accountId: "default",
      baseUrl: "https://bb.example.com",
      password: "s3cret",
      replyToId: "ssrf-public",
      clientFactory: factory,
    });
    expect(factoryCalls[0]?.allowPrivateNetwork).toBe(false);
  });

  it("propagates explicit opt-out on a private host (mode 3)", async () => {
    const { factory, factoryCalls } = makeFakeClient([
      jsonResponse({ data: { text: "x", handle: { address: "+15555000001" } } }),
    ]);
    await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "ssrf-opt-out",
      accountConfig: { network: { dangerouslyAllowPrivateNetwork: false } },
      clientFactory: factory,
    });
    expect(factoryCalls[0]?.allowPrivateNetwork).toBe(false);
    expect(factoryCalls[0]?.allowPrivateNetworkConfig).toBe(false);
  });

  it("never passes undefined for allowPrivateNetwork to the typed client (regression for #71820 codex review)", async () => {
    // The typed client owns SSRF policy resolution internally and cannot
    // produce an undefined policy. This test guards the invariant at the
    // call boundary: we always pass a concrete boolean for
    // allowPrivateNetwork so the resolver picks a deterministic mode.
    const { factory, factoryCalls } = makeFakeClient([
      jsonResponse({ data: { text: "x", handle: { address: "+15556000001" } } }),
    ]);
    await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "ssrf-defined",
      clientFactory: factory,
    });
    expect(typeof factoryCalls[0]?.allowPrivateNetwork).toBe("boolean");
  });

  it("uses the configured timeout on both the factory and the request call", async () => {
    const { factory, factoryCalls, requestCalls } = makeFakeClient([
      jsonResponse({ data: { text: "x", handle: { address: "+15555000001" } } }),
    ]);
    await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "tm",
      timeoutMs: 1234,
      clientFactory: factory,
    });
    expect(factoryCalls[0]?.timeoutMs).toBe(1234);
    expect(requestCalls[0]?.timeoutMs).toBe(1234);
  });
});
