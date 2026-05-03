import { createServer, type Server } from "node:http";
import { fetch as undiciFetch } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeRequestBody } from "./rest-body.js";
import { RequestClient } from "./rest.js";
import { createDeferred, createJsonResponse } from "./test-builders.test-support.js";

describe("RequestClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks queued requests and enforces maxQueueSize", async () => {
    const firstResponse = createDeferred<Response>();
    const queuedResponses = [
      firstResponse.promise,
      Promise.resolve(createJsonResponse({ ok: true })),
    ];
    const fetchSpy = vi.fn(async () => {
      const response = queuedResponses.shift();
      if (!response) {
        throw new Error("unexpected request");
      }
      return await response;
    });
    const client = new RequestClient("test-token", {
      fetch: fetchSpy,
      maxQueueSize: 2,
    });

    const first = client.get("/users/@me");
    const second = client.get("/users/@me");

    expect(client.queueSize).toBe(2);
    await expect(client.get("/users/@me")).rejects.toThrow(/queue is full/);

    firstResponse.resolve(createJsonResponse({ id: "u1" }));

    await expect(first).resolves.toEqual({ id: "u1" });
    await expect(second).resolves.toEqual({ ok: true });
    expect(client.queueSize).toBe(0);
  });

  it("dispatches critical interaction callbacks before older background requests", async () => {
    const firstResponse = createDeferred<Response>();
    const responses = new Map<string, Promise<Response>>([
      ["/guilds/g1/roles", firstResponse.promise],
      ["/interactions/123/token/callback", Promise.resolve(createJsonResponse({ ok: "critical" }))],
      ["/guilds/g2/roles", Promise.resolve(createJsonResponse({ ok: "background" }))],
    ]);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(url).pathname.replace(/^\/api\/v\d+/, "");
      const response = responses.get(path);
      if (!response) {
        throw new Error(`unexpected request ${path}`);
      }
      return await response;
    });
    const client = new RequestClient("test-token", {
      fetch: fetchSpy,
      scheduler: { maxConcurrency: 1 },
    });

    const first = client.get("/guilds/g1/roles");
    const background = client.get("/guilds/g2/roles");
    const critical = client.post("/interactions/123/token/callback", { body: { type: 5 } });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    firstResponse.resolve(createJsonResponse({ ok: "first" }));

    await expect(first).resolves.toEqual({ ok: "first" });
    await expect(critical).resolves.toEqual({ ok: "critical" });
    await expect(background).resolves.toEqual({ ok: "background" });
    expect(fetchSpy.mock.calls.map(([input]) => new URL(readRequestUrl(input)).pathname)).toEqual([
      "/api/v10/guilds/g1/roles",
      "/api/v10/interactions/123/token/callback",
      "/api/v10/guilds/g2/roles",
    ]);
  });

  it("drops stale background requests instead of replaying obsolete reads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const firstResponse = createDeferred<Response>();
    const fetchSpy = vi.fn(async () => await firstResponse.promise);
    const client = new RequestClient("test-token", {
      fetch: fetchSpy,
      scheduler: {
        maxConcurrency: 1,
        lanes: { background: { staleAfterMs: 50 } },
      },
    });

    const first = client.get("/guilds/g1/roles");
    const stale = client.get("/guilds/g2/roles");
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(51);
    firstResponse.resolve(createJsonResponse({ ok: "first" }));

    await expect(first).resolves.toEqual({ ok: "first" });
    await expect(stale).rejects.toThrow(/Dropped stale background request/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(client.getSchedulerMetrics()).toEqual(
      expect.objectContaining({
        droppedByLane: expect.objectContaining({ background: 1 }),
        queueSize: 0,
      }),
    );
  });

  it("keeps standard mutations queued until Discord accepts or rejects them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const firstResponse = createDeferred<Response>();
    const fetchSpy = vi.fn(async () =>
      fetchSpy.mock.calls.length === 1
        ? await firstResponse.promise
        : createJsonResponse({ ok: true }),
    );
    const client = new RequestClient("test-token", {
      fetch: fetchSpy,
      scheduler: {
        maxConcurrency: 1,
        lanes: {
          background: { staleAfterMs: 50 },
          standard: { staleAfterMs: 50 },
        },
      },
    });

    const requests = [
      client.post("/channels/c1/messages", { body: { content: "send" } }),
      client.patch("/channels/c1/messages/m1", { body: { content: "edit" } }),
      client.delete("/channels/c1/messages/m2"),
      client.post("/webhooks/app/token", { body: { content: "webhook send" } }),
      client.patch("/webhooks/app/token/messages/@original", {
        body: { content: "webhook edit" },
      }),
      client.delete("/webhooks/app/token/messages/@original"),
      client.post("/applications/app/commands", { body: { name: "ping" } }),
    ];
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(51);
    firstResponse.resolve(createJsonResponse({ ok: true }));

    await expect(Promise.all(requests)).resolves.toEqual([
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: true },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(requests.length);
    expect(client.getSchedulerMetrics()).toEqual(
      expect.objectContaining({
        droppedByLane: expect.objectContaining({ standard: 0 }),
        queueSize: 0,
      }),
    );
  });

  it("drains same-bucket requests when the active request finishes without polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const firstResponse = createDeferred<Response>();
    const fetchSpy = vi.fn(async () =>
      fetchSpy.mock.calls.length === 1
        ? await firstResponse.promise
        : createJsonResponse({ id: "second" }),
    );
    const client = new RequestClient("test-token", {
      fetch: fetchSpy,
      scheduler: { maxConcurrency: 2 },
    });

    const first = client.get("/channels/c1/messages");
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const second = client.get("/channels/c1/messages");
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(20);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    firstResponse.resolve(createJsonResponse({ id: "first" }));

    await expect(first).resolves.toEqual({ id: "first" });
    await expect(second).resolves.toEqual({ id: "second" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs independent route buckets concurrently", async () => {
    const channelResponse = createDeferred<Response>();
    const guildResponse = createDeferred<Response>();
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return await (url.includes("/channels/") ? channelResponse.promise : guildResponse.promise);
    });
    const client = new RequestClient("test-token", {
      fetch: fetchSpy,
      scheduler: { maxConcurrency: 2 },
    });

    const channel = client.get("/channels/c1/messages");
    const guild = client.get("/guilds/g1/roles");

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    channelResponse.resolve(
      createJsonResponse(
        { id: "channel" },
        {
          headers: { "X-RateLimit-Bucket": "channel-messages", "X-RateLimit-Remaining": "1" },
        },
      ),
    );
    guildResponse.resolve(
      createJsonResponse(
        { id: "guild" },
        {
          headers: { "X-RateLimit-Bucket": "guild-roles", "X-RateLimit-Remaining": "1" },
        },
      ),
    );

    await expect(Promise.all([channel, guild])).resolves.toEqual([
      { id: "channel" },
      { id: "guild" },
    ]);
  });

  it("prunes idle route buckets and mappings after Discord bucket remapping", async () => {
    const client = new RequestClient("test-token", {
      fetch: async () =>
        createJsonResponse(
          { id: "first" },
          {
            headers: { "X-RateLimit-Bucket": "channel-messages" },
          },
        ),
    });

    await expect(client.get("/channels/c1/messages")).resolves.toEqual({ id: "first" });

    const metrics = client.getSchedulerMetrics();
    expect(metrics.activeBuckets).toBe(0);
    expect(metrics.routeBucketMappings).toBe(0);
    expect(metrics.buckets).toEqual([]);
  });

  it("waits for a learned bucket reset before dispatching the next request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const responses = [
      Promise.resolve(
        createJsonResponse(
          { id: "first" },
          {
            headers: {
              "X-RateLimit-Bucket": "channel-messages",
              "X-RateLimit-Limit": "1",
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset-After": "0.1",
            },
          },
        ),
      ),
      Promise.resolve(
        createJsonResponse(
          { id: "second" },
          {
            headers: {
              "X-RateLimit-Bucket": "channel-messages",
              "X-RateLimit-Limit": "1",
              "X-RateLimit-Remaining": "1",
            },
          },
        ),
      ),
    ];
    const fetchSpy = vi.fn(async () => {
      const response = responses.shift();
      if (!response) {
        throw new Error("unexpected request");
      }
      return await response;
    });
    const client = new RequestClient("test-token", { fetch: fetchSpy });

    await expect(client.get("/channels/c1/messages")).resolves.toEqual({ id: "first" });
    expect(client.getSchedulerMetrics().routeBucketMappings).toBe(1);

    const second = client.get("/channels/c1/messages");
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toEqual({ id: "second" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries queued rate limit responses after the learned reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const responses = [
      Promise.resolve(
        createJsonResponse(
          { message: "Rate limited", retry_after: 0.1, global: false },
          {
            status: 429,
            headers: {
              "X-RateLimit-Bucket": "channel-messages",
              "X-RateLimit-Limit": "1",
              "X-RateLimit-Remaining": "0",
            },
          },
        ),
      ),
      Promise.resolve(
        createJsonResponse(
          { id: "retried" },
          {
            headers: {
              "X-RateLimit-Bucket": "channel-messages",
              "X-RateLimit-Limit": "1",
              "X-RateLimit-Remaining": "1",
            },
          },
        ),
      ),
    ];
    const fetchSpy = vi.fn(async () => {
      const response = responses.shift();
      if (!response) {
        throw new Error("unexpected request");
      }
      return await response;
    });
    const client = new RequestClient("test-token", { fetch: fetchSpy });

    const request = client.get("/channels/c1/messages");
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(client.queueSize).toBe(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toEqual({ id: "retried" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(client.queueSize).toBe(0);
    expect(client.getSchedulerMetrics().buckets).toEqual([]);
  });

  it("honors maxRateLimitRetries for queued requests", async () => {
    const fetchSpy = vi.fn(async () =>
      createJsonResponse(
        { message: "Rate limited", retry_after: 0.1, global: false },
        {
          status: 429,
          headers: { "X-RateLimit-Bucket": "channel-messages" },
        },
      ),
    );
    const client = new RequestClient("test-token", {
      fetch: fetchSpy,
      scheduler: { maxRateLimitRetries: 0 },
    });

    await expect(client.get("/channels/c1/messages")).rejects.toMatchObject({
      name: "RateLimitError",
      retryAfter: 0.1,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(client.queueSize).toBe(0);
  });

  it("does not requeue an active rate limit after the queue is cleared", async () => {
    const response = createDeferred<Response>();
    const fetchSpy = vi.fn(async () => {
      if (fetchSpy.mock.calls.length > 1) {
        throw new Error("unexpected retry after clearQueue");
      }
      return await response.promise;
    });
    const client = new RequestClient("test-token", { fetch: fetchSpy });

    const request = client.get("/channels/c1/messages");
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(client.queueSize).toBe(1);

    client.clearQueue();
    expect(client.queueSize).toBe(1);

    response.resolve(
      createJsonResponse(
        { message: "Rate limited", retry_after: 0, global: false },
        {
          status: 429,
          headers: { "X-RateLimit-Bucket": "channel-messages" },
        },
      ),
    );

    await expect(request).rejects.toMatchObject({
      name: "RateLimitError",
      retryAfter: 0,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(client.queueSize).toBe(0);
  });

  it("retries queued global rate limits after Retry-After", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const responses = [
      Promise.resolve(
        createJsonResponse(
          { message: "Rate limited", retry_after: 0.1, global: true },
          {
            status: 429,
            headers: { "X-RateLimit-Global": "true" },
          },
        ),
      ),
      Promise.resolve(createJsonResponse({ id: "after-global" })),
    ];
    const fetchSpy = vi.fn(async () => {
      const response = responses.shift();
      if (!response) {
        throw new Error("unexpected request");
      }
      return await response;
    });
    const client = new RequestClient("test-token", { fetch: fetchSpy });

    const request = client.get("/channels/c1/messages");
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toEqual({ id: "after-global" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("preserves Discord error codes on rate limit errors", async () => {
    const client = new RequestClient("test-token", {
      queueRequests: false,
      fetch: async () =>
        new Response(
          JSON.stringify({
            message: "Max number of daily application command creates has been reached (200)",
            retry_after: 60,
            global: false,
            code: 30034,
          }),
          { status: 429 },
        ),
    });

    await expect(client.post("/applications/app/commands", { body: {} })).rejects.toMatchObject({
      name: "RateLimitError",
      discordCode: 30034,
      retryAfter: 60,
    });
  });

  it("parses HTTP-date Retry-After headers on rate limit errors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    const client = new RequestClient("test-token", {
      queueRequests: false,
      fetch: async () =>
        new Response(JSON.stringify({ message: "Slow down", global: false }), {
          status: 429,
          headers: { "Retry-After": "Fri, 01 May 2026 12:00:05 GMT" },
        }),
    });

    await expect(client.get("/channels/c1/messages")).rejects.toMatchObject({
      name: "RateLimitError",
      retryAfter: 5,
    });
  });

  it("falls back to Retry-After when the rate limit body value is malformed", async () => {
    const client = new RequestClient("test-token", {
      queueRequests: false,
      fetch: async () =>
        new Response(
          JSON.stringify({ message: "Slow down", retry_after: "not-a-number", global: false }),
          {
            status: 429,
            headers: { "Retry-After": "7" },
          },
        ),
    });

    await expect(client.get("/channels/c1/messages")).rejects.toMatchObject({
      name: "RateLimitError",
      retryAfter: 7,
    });
  });

  it("tracks invalid requests and exposes bucket scheduler metrics", async () => {
    const client = new RequestClient("test-token", {
      queueRequests: false,
      fetch: async () =>
        createJsonResponse(
          { message: "Forbidden", code: 50013 },
          {
            status: 403,
            headers: { "X-RateLimit-Bucket": "permissions" },
          },
        ),
    });

    await expect(client.get("/channels/c1/messages")).rejects.toMatchObject({ status: 403 });

    expect(client.getSchedulerMetrics()).toEqual(
      expect.objectContaining({
        invalidRequestCount: 1,
        invalidRequestCountByStatus: { 403: 1 },
      }),
    );
  });

  it("serializes message multipart uploads with payload_json", async () => {
    const headers = new Headers();
    const body = serializeRequestBody(
      {
        body: {
          content: "file",
          files: [{ name: "a.txt", data: new Uint8Array([1]), contentType: "text/plain" }],
        },
      },
      headers,
    );

    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("payload_json")).toBe(
      JSON.stringify({
        content: "file",
        attachments: [{ id: 0, filename: "a.txt" }],
      }),
    );
    expect(form.get("files[0]")).toBeInstanceOf(Blob);
  });

  it("dispatches multipart uploads with a multipart/form-data content type", async () => {
    const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toBeInstanceOf(Headers);
      expect((init?.headers as Headers).get("Content-Type")).toMatch(
        /^multipart\/form-data; boundary=/,
      );
      expect(init?.body).not.toBeInstanceOf(FormData);
      const request = new Request("https://discord.test/upload", {
        method: "POST",
        headers: init?.headers,
        body: init?.body,
      });
      expect(request.headers.get("Content-Type")).toMatch(/^multipart\/form-data; boundary=/);
      return new Response(JSON.stringify({ id: "msg" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = new RequestClient("test-token", { fetch: fetchSpy, queueRequests: false });

    await expect(
      client.post("/channels/c1/messages", {
        body: {
          content: "file",
          files: [{ name: "a.txt", data: new Uint8Array([1]), contentType: "text/plain" }],
        },
      }),
    ).resolves.toEqual({ id: "msg" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("dispatches multipart uploads through undici fetch with a multipart/form-data content type", async () => {
    const server = await new Promise<Server>((resolve) => {
      const srv = createServer((req, res) => {
        expect(req.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "msg" }));
        });
      });
      srv.listen(0, () => resolve(srv));
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind to a TCP port");
      }
      const client = new RequestClient("test-token", {
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiVersion: 10,
        fetch: undiciFetch as unknown as typeof fetch,
        queueRequests: false,
      });

      await expect(
        client.post("/channels/c1/messages", {
          body: {
            content: "file",
            files: [{ name: "a.txt", data: new Uint8Array([1]), contentType: "text/plain" }],
          },
        }),
      ).resolves.toEqual({ id: "msg" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("serializes form multipart uploads for sticker-style endpoints", () => {
    const headers = new Headers();
    const body = serializeRequestBody(
      {
        multipartStyle: "form",
        body: {
          name: "Sticker",
          tags: "tag",
          files: [
            {
              fieldName: "file",
              name: "sticker.png",
              data: new Uint8Array([1]),
              contentType: "image/png",
            },
          ],
        },
      },
      headers,
    );

    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("name")).toBe("Sticker");
    expect(form.get("tags")).toBe("tag");
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(form.get("payload_json")).toBeNull();
  });
});

function readRequestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}
