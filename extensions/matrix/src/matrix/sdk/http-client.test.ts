// Matrix tests cover http client plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { performMatrixRequestMock } = vi.hoisted(() => ({
  performMatrixRequestMock: vi.fn(),
}));

vi.mock("./transport.js", () => ({
  performMatrixRequest: performMatrixRequestMock,
}));

let MatrixAuthedHttpClient: typeof import("./http-client.js").MatrixAuthedHttpClient;

describe("MatrixAuthedHttpClient", () => {
  beforeAll(async () => {
    ({ MatrixAuthedHttpClient } = await import("./http-client.js"));
  });

  beforeEach(() => {
    performMatrixRequestMock.mockReset();
  });

  it("parses JSON responses and forwards absolute-endpoint opt-in", async () => {
    performMatrixRequestMock.mockResolvedValue({
      response: new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      text: '{"ok":true}',
      buffer: Buffer.from('{"ok":true}', "utf8"),
    });

    const client = new MatrixAuthedHttpClient({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      ssrfPolicy: {
        allowPrivateNetwork: true,
      },
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://proxy.internal:8080",
      },
    });
    const result = await client.requestJson({
      method: "GET",
      endpoint: "https://matrix.example.org/_matrix/client/v3/account/whoami",
      timeoutMs: 5000,
      allowAbsoluteEndpoint: true,
    });

    expect(result).toEqual({ ok: true });
    expect(performMatrixRequestMock).toHaveBeenCalledWith({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      method: "GET",
      endpoint: "https://matrix.example.org/_matrix/client/v3/account/whoami",
      qs: undefined,
      body: undefined,
      timeoutMs: 5000,
      ssrfPolicy: { allowPrivateNetwork: true },
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://proxy.internal:8080",
      },
      allowAbsoluteEndpoint: true,
    });
  });

  it("parses JSON responses when the media type casing differs", async () => {
    performMatrixRequestMock.mockResolvedValue({
      response: new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "Application/JSON; charset=utf-8" },
      }),
      text: '{"ok":true}',
      buffer: Buffer.from('{"ok":true}', "utf8"),
    });

    const client = new MatrixAuthedHttpClient({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
    });
    const result = await client.requestJson({
      method: "GET",
      endpoint: "/_matrix/client/v3/account/whoami",
      timeoutMs: 5000,
    });

    expect(result).toEqual({ ok: true });
  });

  it.each(["application/json-seq", 'text/plain; profile="application/json"'])(
    "does not parse a non-JSON media type containing application/json (%s)",
    async (contentType) => {
      performMatrixRequestMock.mockResolvedValue({
        response: new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": contentType },
        }),
        text: '{"ok":true}',
        buffer: Buffer.from('{"ok":true}', "utf8"),
      });

      const client = new MatrixAuthedHttpClient({
        homeserver: "https://matrix.example.org",
        accessToken: "token",
      });
      const result = await client.requestJson({
        method: "GET",
        endpoint: "/_matrix/client/v3/account/whoami",
        timeoutMs: 5000,
      });

      expect(result).toBe('{"ok":true}');
    },
  );

  it("returns plain text when response is not JSON", async () => {
    performMatrixRequestMock.mockResolvedValue({
      response: new Response("pong", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
      text: "pong",
      buffer: Buffer.from("pong", "utf8"),
    });

    const client = new MatrixAuthedHttpClient({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
    });
    const result = await client.requestJson({
      method: "GET",
      endpoint: "/_matrix/client/v3/ping",
      timeoutMs: 5000,
    });

    expect(result).toBe("pong");
  });

  it("returns raw buffers for media requests", async () => {
    const payload = Buffer.from([1, 2, 3, 4]);
    performMatrixRequestMock.mockResolvedValue({
      response: new Response(payload, { status: 200 }),
      text: payload.toString("utf8"),
      buffer: payload,
    });

    const client = new MatrixAuthedHttpClient({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
    });
    const result = await client.requestRaw({
      method: "GET",
      endpoint: "/_matrix/media/v3/download/example/id",
      timeoutMs: 5000,
    });

    expect(result).toEqual(payload);
  });

  it("raises HTTP errors with status code metadata", async () => {
    performMatrixRequestMock.mockResolvedValue({
      response: new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
      text: JSON.stringify({ error: "forbidden" }),
      buffer: Buffer.from(JSON.stringify({ error: "forbidden" }), "utf8"),
    });

    const client = new MatrixAuthedHttpClient({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
    });
    let rejection: unknown;
    try {
      await client.requestJson({
        method: "GET",
        endpoint: "/_matrix/client/v3/rooms",
        timeoutMs: 5000,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    const httpError = rejection as Error & { statusCode?: unknown };
    expect(httpError.message).toBe("forbidden");
    expect(httpError.statusCode).toBe(403);
  });

  it("throws descriptive error on malformed JSON success response", async () => {
    performMatrixRequestMock.mockResolvedValue({
      response: new Response("NOT JSON {{{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      text: "NOT JSON {{{",
      buffer: Buffer.from("NOT JSON {{{", "utf8"),
    });

    const client = new MatrixAuthedHttpClient({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
    });
    let rejection: unknown;
    try {
      await client.requestJson({
        method: "GET",
        endpoint: "/_matrix/client/v3/sync",
        timeoutMs: 5000,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("malformed JSON");
  });
});
