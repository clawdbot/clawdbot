import { afterEach, describe, expect, it, vi } from "vitest";
import { sendA2aChannelText } from "./outbound.js";
import type { A2aCoreConfig, A2aPeerConfig } from "./types.js";

function createA2aOutboundConfig(peer: A2aPeerConfig): A2aCoreConfig {
  return {
    channels: {
      a2a: {
        enabled: true,
        peers: { hermes: peer },
      },
    },
  };
}

function createA2aJsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** Outbound A2A bodies are always serialized JSON strings; assert that before parsing. */
function parseA2aRequestBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new Error(`expected a serialized A2A request body, got ${typeof body}`);
  }
  return JSON.parse(body) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("A2A outbound channel delivery", () => {
  it("sends authenticated canonical A2A messages without following redirects", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createA2aJsonResponse({
        jsonrpc: "2.0",
        id: "request-id",
        result: { task: { id: "remote-task-1" } },
      }),
    );
    const cfg = createA2aOutboundConfig({
      token: "inbound-token",
      outboundToken: "outbound-token",
      url: "https://hermes.example/a2a/v1",
    });

    await expect(sendA2aChannelText({ cfg, to: "a2a:hermes", text: "hello" })).resolves.toEqual({
      to: "a2a:hermes",
      messageId: "remote-task-1",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://hermes.example/a2a/v1");
    expect(init).toMatchObject({
      method: "POST",
      // The SSRF guard inspects redirects itself instead of delegating to fetch.
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer outbound-token",
      },
      signal: expect.any(AbortSignal),
    });
    const body = parseA2aRequestBody(init?.body);
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: expect.any(String),
      method: "SendMessage",
      params: {
        message: {
          messageId: expect.any(String),
          role: "ROLE_USER",
          contextId: "ctx-oc-hermes",
          parts: [{ text: "hello" }],
        },
        configuration: { returnImmediately: true },
      },
    });
  });

  it("retries the legacy dotted method exactly once when canonical dispatch is unavailable", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        createA2aJsonResponse({
          jsonrpc: "2.0",
          error: { code: -32601, message: "Method not found" },
        }),
      )
      .mockResolvedValueOnce(
        createA2aJsonResponse({
          jsonrpc: "2.0",
          result: { task: { id: "legacy-task-1" } },
        }),
      );
    const cfg = createA2aOutboundConfig({
      token: "inbound-token",
      url: "https://hermes.example/a2a/v1",
    });

    await expect(sendA2aChannelText({ cfg, to: "hermes", text: "hello" })).resolves.toMatchObject({
      messageId: "legacy-task-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const methods = fetchMock.mock.calls.map(([, init]) => {
      const body = parseA2aRequestBody(init?.body) as { method: string };
      return body.method;
    });
    expect(methods).toEqual(["SendMessage", "message/send"]);
    const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(firstHeaders).not.toHaveProperty("authorization");
  });

  it("does not retry other JSON-RPC errors or retry the legacy alias repeatedly", async () => {
    const cfg = createA2aOutboundConfig({
      token: "inbound-token",
      url: "https://hermes.example/a2a/v1",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createA2aJsonResponse({
        jsonrpc: "2.0",
        error: { code: -32000, message: "peer unavailable" },
      }),
    );

    await expect(sendA2aChannelText({ cfg, to: "hermes", text: "hello" })).rejects.toThrow(
      "peer unavailable",
    );
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockClear().mockImplementation(async () =>
      createA2aJsonResponse({
        jsonrpc: "2.0",
        error: { code: -32601, message: "Method not found" },
      }),
    );
    await expect(sendA2aChannelText({ cfg, to: "hermes", text: "hello" })).rejects.toThrow(
      "Method not found",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns its generated message ID when the peer omits a task ID", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createA2aJsonResponse({
        jsonrpc: "2.0",
        result: {},
      }),
    );
    const cfg = createA2aOutboundConfig({
      token: "inbound-token",
      url: "https://hermes.example/a2a/v1",
    });

    const result = await sendA2aChannelText({ cfg, to: "hermes", text: "hello" });
    const request = parseA2aRequestBody(fetchMock.mock.calls[0]?.[1]?.body) as {
      params: { message: { messageId: string } };
    };
    expect(result.messageId).toBe(request.params.message.messageId);
  });

  it("rejects missing outbound peer URLs before making an HTTP request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const cfg = createA2aOutboundConfig({ token: "inbound-token" });

    await expect(sendA2aChannelText({ cfg, to: "hermes", text: "hello" })).rejects.toThrow(
      "peer hermes has no url configured for outbound A2A",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces transport and malformed peer-response failures", async () => {
    const cfg = createA2aOutboundConfig({
      token: "inbound-token",
      url: "https://hermes.example/a2a/v1",
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createA2aJsonResponse({}, { status: 503 }))
      .mockResolvedValueOnce(createA2aJsonResponse({ error: { code: "invalid" } }));

    await expect(sendA2aChannelText({ cfg, to: "hermes", text: "hello" })).rejects.toThrow(
      "HTTP 503",
    );
    await expect(sendA2aChannelText({ cfg, to: "hermes", text: "hello" })).rejects.toThrow(
      "invalid A2A JSON-RPC response",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
