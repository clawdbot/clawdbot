// Slack tests cover monitor.thread resolution plugin behavior.
import {
  WebClient,
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
} from "@slack/web-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../types.js";
import type { SlackIngressTurnLifecycle } from "./ingress.js";
import {
  createSlackThreadTsResolver,
  isTransientSlackThreadLookupError,
} from "./thread-resolution.js";

type SlackThreadClient = Parameters<typeof createSlackThreadTsResolver>[0]["client"];

function createThreadClient(history: ReturnType<typeof vi.fn>): SlackThreadClient {
  return { conversations: { history } } as unknown as SlackThreadClient;
}

function createDurableTurnLifecycle(): SlackIngressTurnLifecycle {
  return {
    admission: "exclusive",
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(),
    onDeferred: vi.fn(),
    onAbandoned: vi.fn(),
  };
}

describe("createSlackThreadTsResolver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function makeThreadReplyMessage(ts: string): SlackMessageEvent {
    return {
      channel: "C1",
      parent_user_id: "U2",
      ts,
    } as SlackMessageEvent;
  }

  it("caches resolved thread_ts lookups", async () => {
    const historyMock = vi.fn().mockResolvedValue({
      messages: [{ ts: "1", thread_ts: "9" }],
    });
    const resolver = createSlackThreadTsResolver({
      client: createThreadClient(historyMock),
      cacheTtlMs: 60_000,
      maxSize: 5,
    });

    const message = makeThreadReplyMessage("1");

    const first = await resolver.resolve({ message, source: "message" });
    const second = await resolver.resolve({ message, source: "message" });

    expect(first.thread_ts).toBe("9");
    expect(second.thread_ts).toBe("9");
    expect(historyMock).toHaveBeenCalledTimes(1);
  });

  it("marks cached unresolved lookups as ambiguous thread replies", async () => {
    const historyMock = vi.fn().mockResolvedValue({
      messages: [{ ts: "1" }],
    });
    const resolver = createSlackThreadTsResolver({
      client: createThreadClient(historyMock),
      cacheTtlMs: 60_000,
      maxSize: 5,
    });

    const message = makeThreadReplyMessage("1");

    const first = await resolver.resolve({ message, source: "message" });
    const second = await resolver.resolve({ message, source: "message" });

    expect(first["_ambiguousThreadReply"]).toBe(true);
    expect(second["_ambiguousThreadReply"]).toBe(true);
    expect(historyMock).toHaveBeenCalledTimes(1);
  });

  it("classifies an exhausted real WebClient 429 as transient", async () => {
    const fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        headers: { "content-type": "application/json", "retry-after": "0" },
        status: 429,
      });
    });
    const client = new WebClient("xoxb-test", {
      fetch,
      retryConfig: { retries: 0 },
      slackApiUrl: "https://slack.test/api/",
    });

    const error: unknown = await client.users
      .info({ user: "U1" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WebAPIRequestError);
    if (!(error instanceof WebAPIRequestError)) {
      throw new Error("expected exhausted Slack 429 to become WebAPIRequestError");
    }
    expect(error.original.message).toMatch(
      /^A rate limit was exceeded \(url: .+, retry-after: 0\)$/,
    );
    expect(isTransientSlackThreadLookupError(error)).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["internal_error", "service_unavailable"])(
    "classifies a real WebClient %s platform response as transient",
    async (code) => {
      const fetch = vi.fn(async () => {
        return new Response(JSON.stringify({ ok: false, error: code }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      });
      const client = new WebClient("xoxb-test", {
        fetch,
        retryConfig: { retries: 0 },
        slackApiUrl: "https://slack.test/api/",
      });

      const error: unknown = await client.users
        .info({ user: "U1" })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(WebAPIPlatformError);
      expect(isTransientSlackThreadLookupError(error)).toBe(true);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      label: "an actual Slack HTTP 408 timeout",
      error: new WebAPIHTTPError(408, "Request Timeout", {}, "timeout"),
    },
    {
      label: "an actual Slack HTTP 429 rejection",
      error: new WebAPIHTTPError(429, "Too Many Requests", {}, "rate limited"),
    },
    {
      label: "an actual Slack HTTP 503 outage",
      error: new WebAPIHTTPError(503, "Service Unavailable", {}, "outage"),
    },
    {
      label: "an actual Slack rate-limit error",
      error: new WebAPIRateLimitedError(1),
    },
    {
      label: "an actual Slack request timeout",
      error: new WebAPIRequestError(
        Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }),
      ),
    },
    {
      label: "the actual Slack SDK AbortSignal.timeout DOMException",
      error: new WebAPIRequestError(new DOMException("request timed out", "TimeoutError")),
    },
    {
      label: "an actual Slack connection reset",
      error: new WebAPIRequestError(
        Object.assign(new Error("socket was reset"), { code: "ECONNRESET" }),
      ),
    },
  ])("hands $label to durable ingress without poisoning the cache", async ({ error }) => {
    const historyMock = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ messages: [{ ts: "1", thread_ts: "9" }] });
    const resolver = createSlackThreadTsResolver({
      client: createThreadClient(historyMock),
      cacheTtlMs: 60_000,
      maxSize: 5,
    });
    const message = makeThreadReplyMessage("1");
    const turnAdoptionLifecycle = createDurableTurnLifecycle();

    await expect(
      resolver.resolve({ message, source: "message", turnAdoptionLifecycle }),
    ).rejects.toBe(error);
    await expect(
      resolver.resolve({ message, source: "app_mention", turnAdoptionLifecycle }),
    ).resolves.toMatchObject({ thread_ts: "9" });

    expect(historyMock).toHaveBeenCalledTimes(2);
  });

  it("keeps direct transient failures ambiguous without poisoning their future lookup", async () => {
    const historyMock = vi
      .fn()
      .mockRejectedValueOnce(new WebAPIHTTPError(503, "Service Unavailable", {}, "outage"))
      .mockResolvedValueOnce({ messages: [{ ts: "1", thread_ts: "9" }] });
    const resolver = createSlackThreadTsResolver({
      client: createThreadClient(historyMock),
      cacheTtlMs: 60_000,
      maxSize: 5,
    });
    const message = makeThreadReplyMessage("1");

    await expect(resolver.resolve({ message, source: "message" })).resolves.toMatchObject({
      _ambiguousThreadReply: true,
    });
    await expect(resolver.resolve({ message, source: "app_mention" })).resolves.toMatchObject({
      thread_ts: "9",
    });

    expect(historyMock).toHaveBeenCalledTimes(2);
  });

  it("releases all coalesced durable twins for their existing queue retry", async () => {
    let rejectHistory!: (error: unknown) => void;
    const historyMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectHistory = reject;
          }),
      )
      .mockResolvedValueOnce({ messages: [{ ts: "1", thread_ts: "9" }] });
    const resolver = createSlackThreadTsResolver({
      client: createThreadClient(historyMock),
      cacheTtlMs: 60_000,
      maxSize: 5,
    });
    const message = makeThreadReplyMessage("1");
    const firstLifecycle = createDurableTurnLifecycle();
    const secondLifecycle = createDurableTurnLifecycle();
    const first = resolver.resolve({
      message,
      source: "message",
      turnAdoptionLifecycle: firstLifecycle,
    });
    const second = resolver.resolve({
      message,
      source: "app_mention",
      turnAdoptionLifecycle: secondLifecycle,
    });
    const outage = new WebAPIHTTPError(503, "Service Unavailable", {}, "outage");

    expect(historyMock).toHaveBeenCalledTimes(1);
    rejectHistory(outage);
    await expect(Promise.allSettled([first, second])).resolves.toEqual([
      { status: "rejected", reason: outage },
      { status: "rejected", reason: outage },
    ]);
    await expect(
      resolver.resolve({ message, source: "message", turnAdoptionLifecycle: firstLifecycle }),
    ).resolves.toMatchObject({ thread_ts: "9" });
    expect(historyMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "HTTP 400 rejection",
      error: new WebAPIHTTPError(400, "Bad Request", {}, "invalid request"),
    },
    {
      label: "HTTP 403 denial",
      error: new WebAPIHTTPError(403, "Forbidden", {}, "missing scope"),
    },
    {
      label: "HTTP 404 missing message",
      error: new WebAPIHTTPError(404, "Not Found", {}, "message not found"),
    },
    {
      label: "Slack platform missing_scope",
      error: new WebAPIPlatformError({ ok: false, error: "missing_scope" }),
    },
    {
      label: "unclassified local failure",
      error: new Error("local lookup unavailable"),
    },
    {
      label: "operator-canceled Slack request",
      error: new WebAPIRequestError(new DOMException("request was canceled", "AbortError")),
    },
    {
      label: "uncoded Slack request failure",
      error: new WebAPIRequestError(new Error("request failed without a transient signal")),
    },
  ])("preserves cached ambiguity for definitive $label", async ({ error }) => {
    const historyMock = vi.fn().mockRejectedValue(error);
    const resolver = createSlackThreadTsResolver({
      client: createThreadClient(historyMock),
      cacheTtlMs: 60_000,
      maxSize: 5,
    });
    const message = makeThreadReplyMessage("1");
    const turnAdoptionLifecycle = createDurableTurnLifecycle();

    await expect(
      resolver.resolve({ message, source: "message", turnAdoptionLifecycle }),
    ).resolves.toMatchObject({ _ambiguousThreadReply: true });
    await expect(
      resolver.resolve({ message, source: "app_mention", turnAdoptionLifecycle }),
    ).resolves.toMatchObject({ _ambiguousThreadReply: true });
    expect(historyMock).toHaveBeenCalledTimes(1);
  });

  it("does not retain a durable transient failure forever with a non-expiring cache", async () => {
    const historyMock = vi
      .fn()
      .mockRejectedValueOnce(new WebAPIHTTPError(503, "Service Unavailable", {}, "outage"))
      .mockResolvedValueOnce({ messages: [{ ts: "1", thread_ts: "9" }] });
    const resolver = createSlackThreadTsResolver({
      client: createThreadClient(historyMock),
      cacheTtlMs: 0,
      maxSize: 5,
    });
    const message = makeThreadReplyMessage("1");
    const turnAdoptionLifecycle = createDurableTurnLifecycle();

    await expect(
      resolver.resolve({ message, source: "message", turnAdoptionLifecycle }),
    ).rejects.toBeInstanceOf(WebAPIHTTPError);
    await expect(
      resolver.resolve({ message, source: "app_mention", turnAdoptionLifecycle }),
    ).resolves.toMatchObject({ thread_ts: "9" });
    await resolver.resolve({ message, source: "message", turnAdoptionLifecycle });

    expect(historyMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the default ttl when cacheTtlMs is non-finite", async () => {
    vi.useFakeTimers();
    const historyMock = vi.fn().mockResolvedValue({
      messages: [{ ts: "1", thread_ts: "9" }],
    });
    const resolver = createSlackThreadTsResolver({
      client: { conversations: { history: historyMock } } as never,
      cacheTtlMs: Number.NaN,
      maxSize: 5,
    });
    const message = makeThreadReplyMessage("1");

    await resolver.resolve({ message, source: "message" });
    vi.advanceTimersByTime(60_001);
    await resolver.resolve({ message, source: "message" });

    expect(historyMock).toHaveBeenCalledTimes(2);
  });

  it("drops cached thread_ts lookups when the current clock is not a valid date timestamp", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const historyMock = vi.fn().mockResolvedValue({
      messages: [{ ts: "1", thread_ts: "9" }],
    });
    const resolver = createSlackThreadTsResolver({
      client: { conversations: { history: historyMock } } as never,
      cacheTtlMs: 60_000,
      maxSize: 5,
    });
    const message = makeThreadReplyMessage("1");

    await resolver.resolve({ message, source: "message" });
    nowSpy.mockReturnValue(Number.NaN);
    await resolver.resolve({ message, source: "message" });

    expect(historyMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache thread_ts lookups when the expiry timestamp would exceed the valid date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    const historyMock = vi.fn().mockResolvedValue({
      messages: [{ ts: "1", thread_ts: "9" }],
    });
    const resolver = createSlackThreadTsResolver({
      client: { conversations: { history: historyMock } } as never,
      cacheTtlMs: 60_000,
      maxSize: 5,
    });
    const message = makeThreadReplyMessage("1");

    await resolver.resolve({ message, source: "message" });
    await resolver.resolve({ message, source: "message" });

    expect(historyMock).toHaveBeenCalledTimes(2);
  });

  it("preserves cacheTtlMs zero as a non-expiring cache entry", async () => {
    const historyMock = vi.fn().mockResolvedValue({
      messages: [{ ts: "1", thread_ts: "9" }],
    });
    const resolver = createSlackThreadTsResolver({
      client: { conversations: { history: historyMock } } as never,
      cacheTtlMs: 0,
      maxSize: 5,
    });
    const message = makeThreadReplyMessage("1");

    await resolver.resolve({ message, source: "message" });
    await resolver.resolve({ message, source: "message" });

    expect(historyMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default max size when maxSize is non-finite", async () => {
    const historyMock = vi.fn(async ({ latest }: { latest: string }) => ({
      messages: [{ ts: latest, thread_ts: `thread-${latest}` }],
    }));
    const resolver = createSlackThreadTsResolver({
      client: { conversations: { history: historyMock } } as never,
      cacheTtlMs: 60_000,
      maxSize: Number.NaN,
    });

    for (let i = 0; i <= 500; i++) {
      await resolver.resolve({ message: makeThreadReplyMessage(String(i)), source: "message" });
    }
    await resolver.resolve({ message: makeThreadReplyMessage("0"), source: "message" });

    expect(historyMock).toHaveBeenCalledTimes(502);
  });
});
