import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenAIQuicksilverSession,
  createOpenAIQuicksilverCall,
} from "./realtime-quicksilver-wire.js";

function createCallResponse(answer = "v=answer\r\n", callId = "rtc_test"): Response {
  return new Response(answer, {
    status: 201,
    headers: { Location: `/v1/live/${callId}?source=test` },
  });
}

function createRequestIds(label: string) {
  return {
    realtimeSessionId: `${label}-realtime`,
    sessionId: `${label}-session`,
    threadId: `${label}-thread`,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GPT-Live call creation", () => {
  it("uses multipart /v1/live for Platform API keys", async () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.7.2-test");
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const resolvedUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      requests.push({ url: resolvedUrl, init });
      return createCallResponse("v=answer\r\n", `rtc_${requests.length}`);
    }) as unknown as typeof fetch;
    const session = buildOpenAIQuicksilverSession({
      model: "gpt-live-1-boulder-alpha",
      instructions: "Speak briefly.",
      voice: "marin",
    });

    await expect(
      createOpenAIQuicksilverCall({
        auth: { type: "api-key", token: "platform-key" },
        requestIds: createRequestIds("api-key"),
        sdp: "v=api-offer\r\n",
        session,
        fetchImpl,
      }),
    ).resolves.toMatchObject({ status: 201, callId: "rtc_1" });
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/live");
    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer platform-key",
      "session-id": "api-key-session",
      "thread-id": "api-key-thread",
      "x-session-id": "api-key-realtime",
    });
    expect(requests[0]?.init?.headers).not.toHaveProperty("chatgpt-account-id");

    const apiHeaders = requests[0]?.init?.headers as Record<string, string> | undefined;
    const boundary = apiHeaders?.["Content-Type"]?.split("boundary=")[1];
    const apiBody = requests[0]?.init?.body;
    expect(boundary).toBeTruthy();
    expect(typeof apiBody).toBe("string");
    expect(apiBody).toContain(`--${boundary}\r\n`);
    expect(apiBody).toContain('name="sdp"\r\nContent-Type: application/sdp');
    expect(apiBody).toContain('name="session"\r\nContent-Type: application/json');
    expect(apiBody).toContain(JSON.stringify(session));
  });

  it("rejects GPT-Live OAuth before creating a cross-registry call", async () => {
    const fetchImpl = vi.fn();
    const promise = createOpenAIQuicksilverCall({
      auth: { type: "oauth", token: "oauth-token", accountId: "acct-1" },
      requestIds: createRequestIds("oauth"),
      sdp: "v=oauth-offer\r\n",
      session: buildOpenAIQuicksilverSession({ model: "gpt-live-1-boulder-alpha" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(promise).rejects.toThrow(
      "GPT-Live ChatGPT OAuth is disabled until the upstream sideband join is proven",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["gpt-realtime-2.1", "gpt-realtime-2.1-mini", "gpt-realtime-2"])(
    "uses raw SDP with the model query and no quicksilver alpha header for %s OAuth",
    async (model) => {
      vi.stubEnv("OPENCLAW_VERSION", "2026.7.2-test");
      let capturedHeaders: HeadersInit | undefined;
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers;
        return new Response("v=ga-answer\r\n", { status: 201 });
      });

      await expect(
        createOpenAIQuicksilverCall({
          auth: { type: "oauth", token: "oauth-token", accountId: "acct-1" },
          requestIds: createRequestIds("ga-oauth"),
          sdp: "v=ga-offer\r\n",
          session: buildOpenAIQuicksilverSession({ model }),
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ).resolves.toEqual({
        kind: "ga-realtime",
        status: 201,
        answerSdp: "v=ga-answer\r\n",
      });
      expect(fetchImpl).toHaveBeenCalledWith(
        `https://api.openai.com/v1/realtime/calls?model=${model}`,
        expect.objectContaining({
          method: "POST",
          body: "v=ga-offer\r\n",
          headers: {
            Authorization: "Bearer oauth-token",
            "User-Agent": "openclaw/2026.7.2-test",
            "chatgpt-account-id": "acct-1",
            originator: "openclaw",
            "session-id": "ga-oauth-session",
            "thread-id": "ga-oauth-thread",
            version: "2026.7.2-test",
            "x-session-id": "ga-oauth-realtime",
            "Content-Type": "application/sdp",
          },
        }),
      );
      expect(capturedHeaders).not.toHaveProperty("OpenAI-Alpha");
    },
  );

  it.each([
    {
      name: "overloaded rejection",
      status: 403,
      body: "Voice session access denied.",
      message:
        "GPT-Live rejected the Platform session (403). Verify API-key access, voice, and model for /v1/live. Accepted voices: alloy, ash, ballad, cedar, coral, echo, marin, sage, shimmer, verse. Accepted model: gpt-live-1-boulder-alpha.",
    },
    {
      name: "Platform waitlist denial",
      status: 400,
      body: '{"error":{"code":"model_not_found","message":"The model does not exist or you do not have access"}}',
      message:
        "OpenAI Platform API-key access to /v1/live is waitlist-gated. Request access at https://openai.com/form/gpt-live-1-in-the-api/",
    },
    {
      name: "unsupported route model",
      status: 400,
      body: "Field `session.model` is not allowed for this Codex realtime session",
      message:
        "The GPT-Live model value is not permitted on /v1/live. Accepted value: gpt-live-1-boulder-alpha.",
    },
  ])("maps $name", async ({ status, body, message }) => {
    const fetchImpl = vi.fn(async () => new Response(body, { status }));
    const promise = createOpenAIQuicksilverCall({
      auth: { type: "api-key", token: "platform-key" },
      requestIds: createRequestIds("error"),
      sdp: "v=offer\r\n",
      session: buildOpenAIQuicksilverSession({ model: "gpt-live-1-boulder-alpha" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(promise).rejects.toMatchObject({
      name: "OpenAIQuicksilverCallError",
      status,
      message,
    });
  });

  it.each([
    {
      name: "GPT-Live",
      model: "gpt-live-1-boulder-alpha",
      expectedMessage: "GPT-Live call creation failed (429): provider diagnostic:",
    },
    {
      name: "GA realtime",
      model: "gpt-realtime-2.1",
      expectedMessage: "OpenAI Realtime call creation failed (429): provider diagnostic:",
    },
  ])("bounds and cancels an oversized streaming $name error response", async (testCase) => {
    const detailPrefix = "provider diagnostic: ";
    let resolveResponseClosed: (() => void) | undefined;
    const responseClosed = new Promise<void>((resolve) => {
      resolveResponseClosed = resolve;
    });
    const server = createServer((_request, response) => {
      response.once("close", () => resolveResponseClosed?.());
      response.writeHead(429, { "Content-Type": "text/plain" });
      response.write(detailPrefix + "x".repeat(32 * 1024));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test HTTP server did not bind a TCP port");
    }

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 2_000);
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${address.port}/realtime-call`, {
        ...init,
        signal: controller.signal,
      })) as typeof fetch;

    try {
      const promise = createOpenAIQuicksilverCall({
        auth: { type: "api-key", token: "platform-key" },
        requestIds: createRequestIds(`streaming-error-${testCase.name}`),
        sdp: "v=offer\r\n",
        session: buildOpenAIQuicksilverSession({ model: testCase.model }),
        signal: controller.signal,
        fetchImpl,
      });
      await expect(promise).rejects.toMatchObject({
        name: "OpenAIQuicksilverCallError",
        status: 429,
        message: expect.stringContaining(testCase.expectedMessage),
      });
      await responseClosed;
      expect(controller.signal.aborted).toBe(false);
    } finally {
      clearTimeout(abortTimer);
      controller.abort();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each([
    { location: null, callId: "rtc_header_fallback" },
    { location: null, callId: "019eb97d-8e9a-7ff3-94b0-ea019babd5d7" },
    { location: "http://[invalid", callId: "rtc_malformed_location_fallback" },
    { location: "/v1/live/not-a-call", callId: "rtc_invalid_path_fallback" },
  ])("falls back to openai-session-id for Location $location", async ({ location, callId }) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("v=answer\r\n", {
          status: 201,
          headers: {
            ...(location ? { Location: location } : {}),
            "openai-session-id": callId,
          },
        }),
    );

    await expect(
      createOpenAIQuicksilverCall({
        auth: { type: "api-key", token: "platform-key" },
        requestIds: createRequestIds("header-fallback"),
        sdp: "v=offer\r\n",
        session: buildOpenAIQuicksilverSession({ model: "gpt-live-1-boulder-alpha" }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ callId });
  });

  it("accepts a UUID call id from Location", async () => {
    const callId = "019eb97d-8e9a-7ff3-94b0-ea019babd5d7";
    const fetchImpl = vi.fn(async () => createCallResponse("v=answer\r\n", callId));

    await expect(
      createOpenAIQuicksilverCall({
        auth: { type: "api-key", token: "platform-key" },
        requestIds: createRequestIds("uuid-location"),
        sdp: "v=offer\r\n",
        session: buildOpenAIQuicksilverSession({ model: "gpt-live-1-boulder-alpha" }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({
      callId,
      sidebandUrl: `wss://api.openai.com/v1/live/${callId}`,
    });
  });

  it("rejects an empty SDP answer", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("", {
          status: 201,
          headers: { Location: "/v1/live/rtc_empty_answer" },
        }),
    );
    await expect(
      createOpenAIQuicksilverCall({
        auth: { type: "api-key", token: "platform-key" },
        requestIds: createRequestIds("empty-answer"),
        sdp: "v=offer\r\n",
        session: buildOpenAIQuicksilverSession({ model: "gpt-live-1-boulder-alpha" }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "OpenAIQuicksilverCallError",
      status: 201,
      message: "GPT-Live call creation returned an empty SDP answer",
    });
  });

  it.each([
    {
      label: "GPT-Live",
      auth: { type: "api-key" as const, token: "platform-key" },
      model: "gpt-live-1-boulder-alpha",
      location: "/v1/live/rtc_oversized_answer",
    },
    {
      label: "OpenAI Realtime",
      auth: { type: "api-key" as const, token: "platform-key" },
      model: "gpt-realtime-2.1",
      location: undefined,
    },
  ])("rejects an oversized streaming $label SDP answer", async (testCase) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(`v=answer\r\n${"x".repeat(256 * 1024)}`, {
          status: 201,
          headers: testCase.location ? { Location: testCase.location } : undefined,
        }),
    );

    await expect(
      createOpenAIQuicksilverCall({
        auth: testCase.auth,
        requestIds: createRequestIds(`oversized-answer-${testCase.label}`),
        sdp: "v=offer\r\n",
        session: buildOpenAIQuicksilverSession({ model: testCase.model }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(`${testCase.label} SDP answer: text response exceeds 262144 bytes`);
  });
});
