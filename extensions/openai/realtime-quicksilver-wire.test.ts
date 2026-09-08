import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import {
  buildOpenAIQuicksilverSession,
  buildOpenAIQuicksilverSessionUpdate,
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

describe("GPT-Live session history", () => {
  it.each([
    { name: "entry count", text: "short", retained: 16 },
    { name: "ASCII bytes and entry length", text: "x".repeat(1_000), retained: 9 },
    { name: "UTF-8 without splitting emoji", text: "🦞".repeat(1_000), retained: 2 },
    { name: "JSON quoting", text: '"\\\n'.repeat(400), retained: 4 },
    {
      name: "hostile delimiter expansion",
      text: "</shared_session_history>".repeat(50),
      retained: 7,
    },
  ])("bounds shared background including $name", ({ text, retained }) => {
    const initialItems = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `${index}:${text}`,
    }));
    const params = {
      model: "gpt-live-test",
      instructions: "Keep it brief.",
      hostControlsInput: true,
    };
    const empty = buildOpenAIQuicksilverSession(params);
    const session = buildOpenAIQuicksilverSession({ ...params, initialItems });
    const background = session.instructions.slice(empty.instructions.length);
    const records = background.match(
      /<shared_session_history>\n(.*)\n<\/shared_session_history>$/s,
    )?.[1];
    expect(records).toBeDefined();
    expect(JSON.parse(records!)).toEqual(
      initialItems.slice(-retained).map((item) => ({
        role: item.role,
        text: Array.from(item.text).slice(0, 800).join(""),
      })),
    );
    expect(records).not.toContain("</shared_session_history>");
    expect(Buffer.byteLength(background, "utf8")).toBeLessThanOrEqual(8_000);
    expect(session).not.toHaveProperty("initial_items");
    expect(buildOpenAIQuicksilverSession({ ...params, initialItems: [] })).toEqual(empty);
  });

  it("preserves explicit direct WebSocket role-bearing seeds", () => {
    expect(
      buildOpenAIQuicksilverSessionUpdate({
        model: "gpt-live-test",
        instructions: " Speak briefly. ",
        initialItems: [
          { role: "user", text: "Question" },
          { role: "assistant", text: "Answer" },
        ],
      }),
    ).toEqual({
      type: "session.update",
      session: {
        instructions: "Speak briefly.",
        audio: { output: { voice: "marin" } },
        delegation: { type: "client" },
        initial_items: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "Question" }] },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Answer" }],
          },
        ],
      },
    });
  });

  it("keeps released and unlisted routes on their own voice profiles", () => {
    expect(
      buildOpenAIQuicksilverSession({ model: "gpt-live-1-codex", voice: "SPRUCE" }).audio,
    ).toEqual({ output: { voice: "spruce" } });
    expect(buildOpenAIQuicksilverSession({ model: "gpt-live-1-codex" }).audio).toEqual({
      output: { voice: "cove" },
    });
    expect(
      buildOpenAIQuicksilverSession({ model: "gpt-live-test-canary", voice: "CEDAR" }).audio,
    ).toEqual({ output: { voice: "cedar" } });
    expect(buildOpenAIQuicksilverSession({ model: "gpt-live-test-canary" }).audio).toEqual({
      output: { voice: "marin" },
    });
  });
});

describe("Realtime call creation", () => {
  it("uses the ChatGPT JSON call route for OAuth and preserves the Platform multipart route", async () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.7.2-test");
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const resolvedUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      requests.push({ url: resolvedUrl, init });
      return createCallResponse("v=answer\r\n", `rtc_${requests.length}`);
    }) as unknown as typeof fetch;
    const session = buildOpenAIQuicksilverSession({
      model: "gpt-live-test-canary",
      instructions: "Speak briefly.",
      voice: "spruce",
    });

    await expect(
      createOpenAIQuicksilverCall(
        {
          auth: { type: "oauth", token: "oauth-token", accountId: "acct-1" },
          requestIds: createRequestIds("oauth"),
          sdp: "v=oauth-offer\r\n",
          session,
          fetchImpl,
        },
        openAIRealtimeHost,
      ),
    ).resolves.toEqual({
      kind: "gpt-live",
      status: 201,
      answerSdp: "v=answer\r\n",
      callId: "rtc_1",
      sidebandUrl: "wss://api.openai.com/v1/live/rtc_1",
    });
    expect(requests[0]?.url).toBe(
      "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
    );
    expect(requests[0]?.init?.headers).toEqual({
      Authorization: "Bearer oauth-token",
      "OpenAI-Alpha": "quicksilver=v2",
      "User-Agent": "openclaw/2026.7.2-test",
      "chatgpt-account-id": "acct-1",
      originator: "openclaw",
      "session-id": "oauth-session",
      "thread-id": "oauth-thread",
      version: "2026.7.2-test",
      "x-session-id": "oauth-realtime",
      "Content-Type": "application/json",
    });
    const oauthBody = requests[0]?.init?.body;
    if (typeof oauthBody !== "string") {
      throw new Error("Expected a JSON request body");
    }
    expect(JSON.parse(oauthBody)).toEqual({
      sdp: "v=oauth-offer\r\n",
      session,
    });

    await expect(
      createOpenAIQuicksilverCall(
        {
          auth: { type: "api-key", token: "platform-key" },
          requestIds: createRequestIds("api-key"),
          sdp: "v=api-offer\r\n",
          session,
          fetchImpl,
        },
        openAIRealtimeHost,
      ),
    ).resolves.toMatchObject({ status: 201, callId: "rtc_2" });
    expect(requests[1]?.url).toBe("https://api.openai.com/v1/live");
    expect(requests[1]?.init?.headers).toMatchObject({
      Authorization: "Bearer platform-key",
      "session-id": "api-key-session",
      "thread-id": "api-key-thread",
      "x-session-id": "api-key-realtime",
    });
    expect(requests[1]?.init?.headers).not.toHaveProperty("chatgpt-account-id");

    for (const request of requests.slice(1)) {
      expect(request.url).not.toContain("?");
      const headers = request.init?.headers as Record<string, string> | undefined;
      const boundary = headers?.["Content-Type"]?.split("boundary=")[1];
      const body = request.init?.body;
      expect(boundary).toBeTruthy();
      expect(typeof body).toBe("string");
      expect(body).toContain(`--${boundary}\r\n`);
      expect(body).toContain('name="sdp"\r\nContent-Type: application/sdp');
      expect(body).toContain('name="session"\r\nContent-Type: application/json');
      expect(body).toContain(JSON.stringify(session));
    }
  });

  it.each(["gpt-realtime-2.1", "gpt-realtime-2.1-mini", "gpt-realtime-2"])(
    "uses multipart session initialization without a sideband for %s OAuth",
    async (model) => {
      vi.stubEnv("OPENCLAW_VERSION", "2026.7.2-test");
      let capturedUrl: string | undefined;
      let capturedInit: RequestInit | undefined;
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        capturedInit = init;
        return new Response("v=ga-answer\r\n", { status: 201 });
      });
      const session = {
        type: "realtime",
        model,
        instructions: "Use tools.",
        tools: [{ type: "function", name: "openclaw_agent_consult", parameters: {} }],
        tool_choice: "auto",
      };

      await expect(
        createOpenAIQuicksilverCall(
          {
            auth: { type: "oauth", token: "oauth-token", accountId: "acct-1" },
            requestIds: createRequestIds("ga-oauth"),
            sdp: "v=ga-offer\r\n",
            session,
            fetchImpl: fetchImpl as unknown as typeof fetch,
          },
          openAIRealtimeHost,
        ),
      ).resolves.toEqual({
        kind: "ga-realtime",
        status: 201,
        answerSdp: "v=ga-answer\r\n",
      });
      expect(capturedUrl).toBe("https://api.openai.com/v1/realtime/calls");
      expect(capturedInit?.method).toBe("POST");
      const headers = capturedInit?.headers as Record<string, string> | undefined;
      expect(headers).toMatchObject({
        Authorization: "Bearer oauth-token",
        "User-Agent": "openclaw/2026.7.2-test",
        "chatgpt-account-id": "acct-1",
        originator: "openclaw",
        "session-id": "ga-oauth-session",
        "thread-id": "ga-oauth-thread",
        version: "2026.7.2-test",
        "x-session-id": "ga-oauth-realtime",
        "Content-Type": expect.stringMatching(/^multipart\/form-data; boundary=/),
      });
      expect(headers).not.toHaveProperty("OpenAI-Alpha");
      const boundary = headers?.["Content-Type"]?.split("boundary=")[1];
      expect(boundary).toBeTruthy();
      expect(typeof capturedInit?.body).toBe("string");
      expect(capturedInit?.body).toContain('name="sdp"\r\nContent-Type: application/sdp');
      expect(capturedInit?.body).toContain('name="session"\r\nContent-Type: application/json');
      expect(capturedInit?.body).toContain(JSON.stringify(session));
    },
  );

  it.each([
    {
      name: "overloaded rejection",
      status: 403,
      body: "Voice session access denied.",
      message:
        "GPT-Live rejected the session (403). Verify the selected OpenAI account, model, and GPT-Live voice; this response alone does not identify which was denied.",
    },
    {
      name: "Platform model access denial",
      status: 400,
      body: '{"error":{"code":"model_not_found","message":"The model does not exist or you do not have access"}}',
      message:
        "OpenAI Platform API-key access is unavailable for the selected GPT-Live model. Verify the selected model and Platform account access.",
    },
    {
      name: "unsupported route model",
      status: 400,
      body: "Field `session.model` is not allowed for this Codex realtime session",
      message:
        "The GPT-Live model value is not permitted. Choose a supported GPT-Live model in Settings > Talk.",
    },
  ])("maps $name", async ({ status, body, message }) => {
    const fetchImpl = vi.fn(async () => new Response(body, { status }));
    const promise = createOpenAIQuicksilverCall(
      {
        auth: { type: "api-key", token: "platform-key" },
        requestIds: createRequestIds("error"),
        sdp: "v=offer\r\n",
        session: buildOpenAIQuicksilverSession({ model: "gpt-live-test-canary" }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      openAIRealtimeHost,
    );
    await expect(promise).rejects.toMatchObject({
      name: "OpenAIQuicksilverCallError",
      status,
      message,
    });
  });

  it("omits private provider detail from call creation errors", async () => {
    const model = "gpt-live-test-canary";
    const sensitiveDetail = "sensitive-route sensitive-session sensitive-transcript";
    const fetchImpl = vi.fn(
      async () => new Response(`provider rejected ${model} ${sensitiveDetail}`, { status: 422 }),
    );
    const promise = createOpenAIQuicksilverCall(
      {
        auth: { type: "api-key", token: "platform-key" },
        requestIds: createRequestIds("model-redaction"),
        sdp: "v=offer\r\n",
        session: buildOpenAIQuicksilverSession({ model }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      openAIRealtimeHost,
    );

    await expect(promise).rejects.toMatchObject({
      name: "OpenAIQuicksilverCallError",
      status: 422,
      message: "GPT-Live call creation failed (422)",
    });
  });

  it.each([
    {
      name: "GPT-Live",
      model: "gpt-live-test-canary",
      expectedMessage: "GPT-Live call creation failed (429)",
    },
    {
      name: "GA realtime",
      model: "gpt-realtime-2.1",
      expectedMessage: "OpenAI Realtime call creation failed (429)",
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
      const promise = createOpenAIQuicksilverCall(
        {
          auth: { type: "api-key", token: "platform-key" },
          requestIds: createRequestIds(`streaming-error-${testCase.name}`),
          sdp: "v=offer\r\n",
          session: buildOpenAIQuicksilverSession({ model: testCase.model }),
          signal: controller.signal,
          fetchImpl,
        },
        openAIRealtimeHost,
      );
      await expect(promise).rejects.toMatchObject({
        name: "OpenAIQuicksilverCallError",
        status: 429,
        message: testCase.expectedMessage,
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
      createOpenAIQuicksilverCall(
        {
          auth: { type: "oauth", token: "oauth-token", accountId: "acct-1" },
          requestIds: createRequestIds("header-fallback"),
          sdp: "v=offer\r\n",
          session: buildOpenAIQuicksilverSession({ model: "gpt-live-test-canary" }),
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
        openAIRealtimeHost,
      ),
    ).resolves.toMatchObject({ callId });
  });

  it("accepts a UUID call id from Location", async () => {
    const callId = "019eb97d-8e9a-7ff3-94b0-ea019babd5d7";
    const fetchImpl = vi.fn(async () => createCallResponse("v=answer\r\n", callId));

    await expect(
      createOpenAIQuicksilverCall(
        {
          auth: { type: "oauth", token: "oauth-token", accountId: "acct-1" },
          requestIds: createRequestIds("uuid-location"),
          sdp: "v=offer\r\n",
          session: buildOpenAIQuicksilverSession({ model: "gpt-live-test-canary" }),
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
        openAIRealtimeHost,
      ),
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
      createOpenAIQuicksilverCall(
        {
          auth: { type: "oauth", token: "oauth-token", accountId: "acct-1" },
          requestIds: createRequestIds("empty-answer"),
          sdp: "v=offer\r\n",
          session: buildOpenAIQuicksilverSession({ model: "gpt-live-test-canary" }),
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
        openAIRealtimeHost,
      ),
    ).rejects.toMatchObject({
      name: "OpenAIQuicksilverCallError",
      status: 201,
      message: "GPT-Live call creation returned an empty SDP answer",
    });
  });

  it.each([
    {
      label: "GPT-Live",
      auth: { type: "oauth" as const, token: "oauth-token", accountId: "acct-1" },
      model: "gpt-live-test-canary",
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
      createOpenAIQuicksilverCall(
        {
          auth: testCase.auth,
          requestIds: createRequestIds(`oversized-answer-${testCase.label}`),
          sdp: "v=offer\r\n",
          session: buildOpenAIQuicksilverSession({ model: testCase.model }),
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
        openAIRealtimeHost,
      ),
    ).rejects.toThrow(`${testCase.label} SDP answer: text response exceeds 262144 bytes`);
  });
});
