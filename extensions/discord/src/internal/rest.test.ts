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
