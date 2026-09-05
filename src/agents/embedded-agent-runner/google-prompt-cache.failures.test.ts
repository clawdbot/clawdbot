import crypto from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import { attachModelProviderRequestTransport } from "../provider-request-config.js";
import { buildGuardedModelFetch } from "../provider-transport-fetch.js";
import {
  createCacheFetchMock,
  createCapturingStreamFn,
  createOversizedJsonResponse,
  fetchUrl,
  makeGoogleModel,
  makeSessionManager,
  preparePromptCacheStream,
  type SessionCustomEntry,
  streamContext,
} from "./google-prompt-cache.test-support.js";

const NOW = 1_000_000;
const TOOLS = [
  {
    name: "lookup",
    description: "Look up a value",
    parameters: { type: "object" },
  },
];

function promptContext() {
  return {
    systemPrompt: "Follow policy.",
    messages: [],
    tools: TOOLS,
  } as never;
}

function invoke(
  wrapped: Awaited<ReturnType<typeof preparePromptCacheStream>>,
  model = makeGoogleModel(),
  context = promptContext(),
) {
  return Promise.resolve(wrapped?.(model, context, {} as never));
}

const plainPromptContext = { systemPrompt: "Follow policy.", messages: [] } as never;

function readyEntry(params: {
  cachedContent?: string;
  expireTime?: unknown;
  now?: number;
}): SessionCustomEntry {
  const now = params.now ?? NOW;
  return {
    id: "entry-ready",
    parentId: null,
    timestamp: new Date(now - 5_000).toISOString(),
    type: "custom",
    customType: "openclaw.google-prompt-cache",
    data: {
      status: "ready",
      timestamp: now - 5_000,
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
      modelApi: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      systemPromptDigest: crypto.createHash("sha256").update("Follow policy.").digest("hex"),
      cacheRetention: "long",
      cachedContent: params.cachedContent ?? "cachedContents/existing",
      ...(params.expireTime === undefined ? {} : { expireTime: params.expireTime }),
    },
  };
}

function failedEntry(retryAfter: number): SessionCustomEntry {
  return {
    id: "entry-failed",
    parentId: null,
    timestamp: new Date(NOW - 5_000).toISOString(),
    type: "custom",
    customType: "openclaw.google-prompt-cache",
    data: {
      status: "failed",
      timestamp: NOW - 5_000,
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
      modelApi: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      systemPromptDigest: crypto.createHash("sha256").update("Follow policy.").digest("hex"),
      cacheRetention: "long",
      retryAfter,
    },
  };
}

describe("google prompt cache failure handling", () => {
  it.each([
    ["malformed JSON", () => new Response("not-json{{{", { status: 200 })],
    [
      "invalid UTF-8",
      () =>
        new Response(new Uint8Array([0x7b, 0x22, 0x6b, 0x22, 0x3a, 0xff, 0x7d]), {
          status: 200,
        }),
    ],
    ["JSON null", () => new Response("null", { status: 200 })],
    ["JSON primitive", () => new Response("42", { status: 200 })],
    ["JSON array", () => new Response("[]", { status: 200 })],
    ["oversized JSON", () => createOversizedJsonResponse().response],
    [
      "body read failure",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              throw new Error("broken cache response body");
            },
          }),
          { status: 200 },
        ),
    ],
  ])("continues uncached after %s", async (_name, responseFactory) => {
    const entries: SessionCustomEntry[] = [];
    const fetchMock = vi.fn(async () => responseFactory());
    const innerStreamFn = vi.fn(() => "visible-output" as never);
    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now: NOW,
      sessionManager: makeSessionManager(entries),
      streamFn: innerStreamFn,
    });

    await expect(invoke(wrapped)).resolves.toBe("visible-output");
    expect(streamContext(innerStreamFn)).toMatchObject({
      systemPrompt: "Follow policy.",
      tools: TOOLS,
    });
    expect(entries.at(-1)?.data).toMatchObject({ status: "failed" });
  });

  it.each([
    ["missing name", { expireTime: new Date(NOW + 60_000).toISOString() }],
    ["blank name", { name: " ", expireTime: new Date(NOW + 60_000).toISOString() }],
    [
      "wrong name prefix",
      { name: "files/cache-id", expireTime: new Date(NOW + 60_000).toISOString() },
    ],
    [
      "multi-segment name",
      { name: "cachedContents/cache/id", expireTime: new Date(NOW + 60_000).toISOString() },
    ],
    [
      "C0 null name",
      { name: "cachedContents/cache\u0000id", expireTime: new Date(NOW + 60_000).toISOString() },
    ],
    [
      "C0 unit-separator name",
      { name: "cachedContents/cache\u001fid", expireTime: new Date(NOW + 60_000).toISOString() },
    ],
    [
      "DEL name",
      { name: "cachedContents/cache\u007fid", expireTime: new Date(NOW + 60_000).toISOString() },
    ],
    [
      "C1 next-line name",
      { name: "cachedContents/cache\u0085id", expireTime: new Date(NOW + 60_000).toISOString() },
    ],
    [
      "lone high-surrogate name",
      { name: "cachedContents/cache\ud800id", expireTime: new Date(NOW + 60_000).toISOString() },
    ],
    [
      "lone low-surrogate name",
      { name: "cachedContents/cache\udc00id", expireTime: new Date(NOW + 60_000).toISOString() },
    ],
    [
      "NFC Unicode name",
      { name: "cachedContents/caf\u00e9", expireTime: new Date(NOW + 60_000).toISOString() },
    ],
    [
      "NFD Unicode name",
      { name: "cachedContents/cafe\u0301", expireTime: new Date(NOW + 60_000).toISOString() },
    ],
    [
      "embedded-whitespace name",
      { name: "cachedContents/cache id", expireTime: new Date(NOW + 60_000).toISOString() },
    ],
    [
      "query-delimited name",
      { name: "cachedContents/cache-id?bad", expireTime: new Date(NOW + 60_000).toISOString() },
    ],
    [
      "fragment-delimited name",
      { name: "cachedContents/cache-id#bad", expireTime: new Date(NOW + 60_000).toISOString() },
    ],
    [
      "backslash-delimited name",
      { name: "cachedContents/cache\\id", expireTime: new Date(NOW + 60_000).toISOString() },
    ],
    [
      "percent-encoded separator name",
      { name: "cachedContents/cache%2Fid", expireTime: new Date(NOW + 60_000).toISOString() },
    ],
    [
      "current-directory name",
      { name: "cachedContents/.", expireTime: new Date(NOW + 60_000).toISOString() },
    ],
    [
      "parent-directory name",
      { name: "cachedContents/..", expireTime: new Date(NOW + 60_000).toISOString() },
    ],
    ["missing expiry", { name: "cachedContents/cache-id" }],
    ["non-string expiry", { name: "cachedContents/cache-id", expireTime: 123 }],
    ["unparseable expiry", { name: "cachedContents/cache-id", expireTime: "not-a-date" }],
    [
      "nonfuture expiry",
      { name: "cachedContents/cache-id", expireTime: new Date(NOW).toISOString() },
    ],
  ])("rejects automatic cache creation with %s", async (_name, payload) => {
    const entries: SessionCustomEntry[] = [];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const { streamFn, getCapturedPayload } = createCapturingStreamFn("visible-output");
    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now: NOW,
      sessionManager: makeSessionManager(entries),
      streamFn,
    });

    await expect(invoke(wrapped)).resolves.toBe("visible-output");
    expect(streamFn).toHaveBeenCalledOnce();
    expect(streamContext(streamFn)).toMatchObject({
      systemPrompt: "Follow policy.",
      tools: TOOLS,
    });
    expect(getCapturedPayload()).not.toHaveProperty("cachedContent");
    expect(entries.at(-1)?.data).toMatchObject({
      status: "failed",
      retryAfter: NOW + 10 * 60_000,
    });
  });

  it.each([
    ["HTTP failure", async () => new Response("denied", { status: 403 })],
    [
      "network failure",
      async () => {
        throw new Error("network unavailable");
      },
    ],
    [
      "transport timeout",
      async () => {
        throw new Error("model request timed out");
      },
    ],
    [
      "provider abort",
      async () => {
        throw new DOMException("provider stopped", "AbortError");
      },
    ],
  ])("continues uncached after %s", async (_name, fetchImpl) => {
    const entries: SessionCustomEntry[] = [];
    const innerStreamFn = vi.fn(() => "visible-output" as never);
    const wrapped = await preparePromptCacheStream({
      fetchMock: vi.fn(fetchImpl),
      now: NOW,
      sessionManager: makeSessionManager(entries),
      streamFn: innerStreamFn,
    });

    await expect(invoke(wrapped)).resolves.toBe("visible-output");
    expect(streamContext(innerStreamFn)).toMatchObject({
      systemPrompt: "Follow policy.",
      tools: TOOLS,
    });
    expect(entries.at(-1)?.data).toMatchObject({ status: "failed" });
  });

  it("propagates the caller abort reason without persisting failure or streaming", async () => {
    const reason = new Error("caller cancelled");
    const controller = new AbortController();
    controller.abort(reason);
    const entries: SessionCustomEntry[] = [];
    const innerStreamFn = vi.fn();
    const wrapped = await preparePromptCacheStream({
      fetchMock: vi.fn(async () => {
        throw new DOMException("fetch aborted", "AbortError");
      }),
      now: NOW,
      sessionManager: makeSessionManager(entries),
      signal: controller.signal,
      streamFn: innerStreamFn,
    });

    await expect(invoke(wrapped)).rejects.toBe(reason);
    expect(entries).toHaveLength(0);
    expect(innerStreamFn).not.toHaveBeenCalled();
  });

  it("keeps unregistered auth sentinel failures outside optional cache handling", async () => {
    const innerStreamFn = vi.fn();
    const fetchMock = vi.fn();
    const wrapped = await preparePromptCacheStream({
      apiKey: "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end",
      fetchMock,
      now: NOW,
      sessionManager: makeSessionManager(),
      streamFn: innerStreamFn,
    });

    await expect(invoke(wrapped)).rejects.toThrow("is not registered in this process");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(innerStreamFn).not.toHaveBeenCalled();
  });

  it("keeps request-header construction failures outside optional cache handling", async () => {
    const constructionFailure = new Error("request headers unavailable");
    const model = makeGoogleModel();
    Object.defineProperty(model, "headers", {
      get() {
        throw constructionFailure;
      },
    });
    const entries: SessionCustomEntry[] = [];
    const fetchMock = vi.fn();
    const innerStreamFn = vi.fn();
    const wrapped = await preparePromptCacheStream({
      fetchMock,
      model,
      now: NOW,
      sessionManager: makeSessionManager(entries),
      streamFn: innerStreamFn,
    });

    await expect(invoke(wrapped, model)).rejects.toBe(constructionFailure);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(entries).toHaveLength(0);
    expect(innerStreamFn).not.toHaveBeenCalled();
  });

  it("propagates writer-claim rebound while recording cache failure", async () => {
    const rebound = new SessionTranscriptWriterClaimReboundError();
    const innerStreamFn = vi.fn();
    const wrapped = await preparePromptCacheStream({
      fetchMock: vi.fn(async () => new Response("denied", { status: 403 })),
      now: NOW,
      sessionManager: {
        appendCustomEntry: vi.fn(async () => {
          throw rebound;
        }),
        getEntries: () => [],
      },
      streamFn: innerStreamFn,
    });

    await expect(invoke(wrapped)).rejects.toBe(rebound);
    expect(innerStreamFn).not.toHaveBeenCalled();
  });

  it("continues when failure metadata persistence fails generically", async () => {
    const innerStreamFn = vi.fn(() => "visible-output" as never);
    const wrapped = await preparePromptCacheStream({
      fetchMock: vi.fn(async () => new Response("denied", { status: 403 })),
      now: NOW,
      sessionManager: {
        appendCustomEntry: vi.fn(async () => {
          throw new Error("metadata unavailable");
        }),
        getEntries: () => [],
      },
      streamFn: innerStreamFn,
    });

    await expect(invoke(wrapped)).resolves.toBe("visible-output");
  });

  it.each([
    ["missing expiry", { expireTime: undefined }],
    ["malformed expiry", { expireTime: "not-a-date" }],
    ["nonfuture expiry", { expireTime: new Date(NOW).toISOString() }],
    [
      "invalid cache name",
      {
        cachedContent: "files/cache-id",
        expireTime: new Date(NOW + 3_600_000).toISOString(),
      },
    ],
    [
      "query-delimited cache name",
      {
        cachedContent: "cachedContents/cache-id?bad",
        expireTime: new Date(NOW + 3_600_000).toISOString(),
      },
    ],
    [
      "fragment-delimited cache name",
      {
        cachedContent: "cachedContents/cache-id#bad",
        expireTime: new Date(NOW + 3_600_000).toISOString(),
      },
    ],
    [
      "backslash-delimited cache name",
      {
        cachedContent: "cachedContents/cache\\id",
        expireTime: new Date(NOW + 3_600_000).toISOString(),
      },
    ],
    [
      "percent-encoded separator cache name",
      {
        cachedContent: "cachedContents/cache%2Fid",
        expireTime: new Date(NOW + 3_600_000).toISOString(),
      },
    ],
    [
      "current-directory cache name",
      {
        cachedContent: "cachedContents/.",
        expireTime: new Date(NOW + 3_600_000).toISOString(),
      },
    ],
    [
      "parent-directory cache name",
      {
        cachedContent: "cachedContents/..",
        expireTime: new Date(NOW + 3_600_000).toISOString(),
      },
    ],
    [
      "C0 cache name",
      {
        cachedContent: "cachedContents/cache\u0000id",
        expireTime: new Date(NOW + 3_600_000).toISOString(),
      },
    ],
    [
      "lone-surrogate cache name",
      {
        cachedContent: "cachedContents/cache\ud800id",
        expireTime: new Date(NOW + 3_600_000).toISOString(),
      },
    ],
    [
      "Unicode cache name",
      {
        cachedContent: "cachedContents/caf\u00e9",
        expireTime: new Date(NOW + 3_600_000).toISOString(),
      },
    ],
  ])("rebuilds persisted ready state with %s", async (_name, entry) => {
    const entries = [readyEntry(entry)];
    const fetchMock = createCacheFetchMock({
      name: "cachedContents/rebuilt",
      expireTime: new Date(NOW + 3_600_000).toISOString(),
    });
    const { streamFn, getCapturedPayload } = createCapturingStreamFn();
    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now: NOW,
      sessionManager: makeSessionManager(entries),
      streamFn,
    });

    await invoke(wrapped, makeGoogleModel(), plainPromptContext);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchUrl(fetchMock)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/cachedContents",
    );
    expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/rebuilt");
  });

  it("continues uncached when an invalid persisted name cannot be rebuilt", async () => {
    const entries = [
      readyEntry({
        cachedContent: "cachedContents/cache\u0000id",
        expireTime: new Date(NOW + 3_600_000).toISOString(),
      }),
    ];
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            name: "cachedContents/cache\u0000id",
            expireTime: new Date(NOW + 3_600_000).toISOString(),
          }),
          { status: 200 },
        ),
    );
    const { streamFn, getCapturedPayload } = createCapturingStreamFn("visible-output");
    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now: NOW,
      sessionManager: makeSessionManager(entries),
      streamFn,
    });

    await expect(invoke(wrapped)).resolves.toBe("visible-output");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchUrl(fetchMock)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/cachedContents",
    );
    expect(streamContext(streamFn)).toMatchObject({
      systemPrompt: "Follow policy.",
      tools: TOOLS,
    });
    expect(getCapturedPayload()).not.toHaveProperty("cachedContent");
    expect(entries.at(-1)?.data).toMatchObject({
      status: "failed",
      retryAfter: NOW + 10 * 60_000,
    });
  });

  it("refreshes a transport-stable punctuation name at the exact URL", async () => {
    const cachedContent = "cachedContents/cache-_.!~*'()";
    const entries = [
      readyEntry({
        cachedContent,
        expireTime: new Date(NOW + 60_000).toISOString(),
      }),
    ];
    const fetchMock = createCacheFetchMock({
      name: cachedContent,
      expireTime: new Date(NOW + 3_600_000).toISOString(),
    });
    const { streamFn, getCapturedPayload } = createCapturingStreamFn();
    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now: NOW,
      sessionManager: makeSessionManager(entries),
      streamFn,
    });

    await invoke(wrapped, makeGoogleModel(), plainPromptContext);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchUrl(fetchMock)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/cachedContents/cache-_.!~*'()?updateMask=ttl",
    );
    expect(getCapturedPayload()?.cachedContent).toBe(cachedContent);
  });

  it.each([
    ["malformed JSON", "not-json{{{"],
    ["missing expiry", "{}"],
    ["nonfuture expiry", JSON.stringify({ expireTime: new Date(NOW).toISOString() })],
  ])("retains a valid existing cache after refresh returns %s", async (_name, body) => {
    const entries = [
      readyEntry({
        cachedContent: "cachedContents/existing",
        expireTime: new Date(NOW + 60_000).toISOString(),
      }),
    ];
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    const { streamFn, getCapturedPayload } = createCapturingStreamFn();
    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now: NOW,
      sessionManager: makeSessionManager(entries),
      streamFn,
    });

    await invoke(wrapped, makeGoogleModel(), plainPromptContext);
    expect(fetchUrl(fetchMock)).toContain("cachedContents/existing?updateMask=ttl");
    expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/existing");
    expect(entries).toHaveLength(1);
  });

  it("honors failed-cache backoff without another create attempt", async () => {
    const fetchMock = vi.fn();
    const innerStreamFn = vi.fn(() => "visible-output" as never);
    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now: NOW,
      sessionManager: makeSessionManager([failedEntry(NOW + 60_000)]),
      streamFn: innerStreamFn,
    });

    await expect(invoke(wrapped, makeGoogleModel(), plainPromptContext)).resolves.toBe(
      "visible-output",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not swallow primary stream failures after cache degradation", async () => {
    const primaryFailure = new Error("primary stream failed");
    const innerStreamFn = vi.fn(async () => {
      throw primaryFailure;
    }) as unknown as StreamFn;
    const wrapped = await preparePromptCacheStream({
      fetchMock: vi.fn(async () => new Response("denied", { status: 403 })),
      now: NOW,
      sessionManager: makeSessionManager(),
      streamFn: innerStreamFn,
    });

    await expect(invoke(wrapped)).rejects.toBe(primaryFailure);
  });

  it("continues through the guarded network path when cache creation is malformed", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      if (request.url?.endsWith("/cachedContents")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("not-json{{{");
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("visible-generation-output");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("loopback server did not expose a TCP address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/v1beta`;
      const model = attachModelProviderRequestTransport(
        { ...makeGoogleModel(), baseUrl },
        { allowPrivateNetwork: true },
      );
      const entries: SessionCustomEntry[] = [];
      const innerStreamFn = vi.fn(async () => {
        const response = await buildGuardedModelFetch(model)(
          `${baseUrl}/models/${model.id}:streamGenerateContent`,
          { method: "POST", body: "{}" },
        );
        return await response.text();
      }) as unknown as StreamFn;
      const wrapped = await preparePromptCacheStream({
        model,
        now: NOW,
        sessionManager: makeSessionManager(entries),
        streamFn: innerStreamFn,
      });

      await expect(invoke(wrapped, model)).resolves.toBe("visible-generation-output");
      expect(requests).toEqual([
        "/v1beta/cachedContents",
        `/v1beta/models/${model.id}:streamGenerateContent`,
      ]);
      expect(entries.at(-1)?.data).toMatchObject({ status: "failed" });
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
