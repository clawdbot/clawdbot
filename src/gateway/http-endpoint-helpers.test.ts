/**
 * Unit tests for the shared POST JSON endpoint helper used by gateway HTTP surfaces.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";

vi.mock("./http-utils.js", () => {
  return {
    authorizeGatewayHttpRequestOrReply: vi.fn(),
    resolveTrustedHttpOperatorScopes: vi.fn(),
  };
});

vi.mock("./http-common.js", () => {
  return {
    readJsonBodyOrError: vi.fn(),
    sendJson: vi.fn(),
    sendMethodNotAllowed: vi.fn(),
    sendMissingScopeForbidden: vi.fn(),
  };
});

vi.mock("./method-scopes.js", () => {
  return {
    authorizeOperatorScopesForMethod: vi.fn(),
  };
});

const { readJsonBodyOrError, sendMethodNotAllowed, sendMissingScopeForbidden } =
  await import("./http-common.js");
const { authorizeGatewayHttpRequestOrReply, resolveTrustedHttpOperatorScopes } =
  await import("./http-utils.js");
const { authorizeOperatorScopesForMethod } = await import("./method-scopes.js");

type EndpointOptions = Parameters<typeof handleGatewayPostJsonEndpoint>[2];
type RequestOptions = {
  url?: string;
  method?: string;
  host?: string;
};

function request(options: RequestOptions = {}): IncomingMessage {
  return {
    url: options.url ?? "/v1/ok",
    method: options.method ?? "POST",
    headers: { host: options.host ?? "localhost" },
  } as unknown as IncomingMessage;
}

function response(): ServerResponse {
  return {} as unknown as ServerResponse;
}

function endpointOptions(overrides: Partial<EndpointOptions> = {}): EndpointOptions {
  return {
    pathname: "/v1/ok",
    auth: {} as unknown as ResolvedGatewayAuth,
    maxBodyBytes: 123,
    ...overrides,
  };
}

function handleEndpoint(
  options: {
    request?: RequestOptions;
    response?: ServerResponse;
    endpoint?: Partial<EndpointOptions>;
  } = {},
) {
  return handleGatewayPostJsonEndpoint(
    request(options.request),
    options.response ?? response(),
    endpointOptions(options.endpoint),
  );
}

describe("handleGatewayPostJsonEndpoint", () => {
  it("returns false when path does not match", async () => {
    const result = await handleEndpoint({ request: { url: "/nope" } });
    expect(result).toBe(false);
  });

  it("returns undefined and replies when method is not POST", async () => {
    const mockedSendMethodNotAllowed = vi.mocked(sendMethodNotAllowed);
    mockedSendMethodNotAllowed.mockClear();
    const result = await handleEndpoint({ request: { method: "GET" } });
    expect(result).toBeUndefined();
    expect(mockedSendMethodNotAllowed).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when auth fails", async () => {
    vi.mocked(authorizeGatewayHttpRequestOrReply).mockResolvedValue(null);
    const result = await handleEndpoint();
    expect(result).toBeUndefined();
  });

  it("returns body when auth succeeds and JSON parsing succeeds", async () => {
    vi.mocked(authorizeGatewayHttpRequestOrReply).mockResolvedValue({
      trustDeclaredOperatorScopes: true,
    });
    vi.mocked(readJsonBodyOrError).mockResolvedValue({ hello: "world" });
    const result = await handleEndpoint();
    expect(result).toEqual({
      body: { hello: "world" },
      requestAuth: { trustDeclaredOperatorScopes: true },
    });
  });

  it("matches paths without trusting malformed Host headers", async () => {
    vi.mocked(authorizeGatewayHttpRequestOrReply).mockResolvedValue({
      trustDeclaredOperatorScopes: true,
    });
    vi.mocked(readJsonBodyOrError).mockResolvedValue({ ok: true });

    const result = await handleEndpoint({ request: { host: "[" } });

    expect(result).toEqual({
      body: { ok: true },
      requestAuth: { trustDeclaredOperatorScopes: true },
    });
  });

  it("returns undefined and replies when required operator scope is missing", async () => {
    vi.mocked(authorizeGatewayHttpRequestOrReply).mockResolvedValue({
      trustDeclaredOperatorScopes: false,
    });
    vi.mocked(resolveTrustedHttpOperatorScopes).mockReturnValue(["operator.approvals"]);
    vi.mocked(authorizeOperatorScopesForMethod).mockReturnValue({
      allowed: false,
      missingScope: "operator.write",
    });
    const mockedSendMissingScopeForbidden = vi.mocked(sendMissingScopeForbidden);
    mockedSendMissingScopeForbidden.mockClear();
    vi.mocked(readJsonBodyOrError).mockClear();
    const res = response();

    const result = await handleEndpoint({
      response: res,
      endpoint: {
        requiredOperatorMethod: "chat.send",
      },
    });

    expect(result).toBeUndefined();
    expect(vi.mocked(authorizeOperatorScopesForMethod)).toHaveBeenCalledWith("chat.send", [
      "operator.approvals",
    ]);
    expect(mockedSendMissingScopeForbidden).toHaveBeenCalledWith(res, "operator.write");
    expect(vi.mocked(readJsonBodyOrError)).not.toHaveBeenCalled();
  });

  it("uses a custom operator scope resolver when provided", async () => {
    vi.mocked(authorizeGatewayHttpRequestOrReply).mockResolvedValue({
      authMethod: "token",
      trustDeclaredOperatorScopes: false,
    });
    vi.mocked(authorizeOperatorScopesForMethod).mockReturnValue({ allowed: true });
    vi.mocked(readJsonBodyOrError).mockResolvedValue({ ok: true });
    const resolveOperatorScopes = vi.fn(() => ["operator.admin", "operator.write"]);

    const result = await handleEndpoint({
      endpoint: {
        requiredOperatorMethod: "chat.send",
        resolveOperatorScopes,
      },
    });

    const [, requestAuth] = (resolveOperatorScopes.mock.calls.at(0) as unknown as
      | [IncomingMessage, { authMethod?: string; trustDeclaredOperatorScopes: boolean }]
      | undefined) ?? [undefined, undefined];
    expect(requestAuth?.authMethod).toBe("token");
    expect(requestAuth?.trustDeclaredOperatorScopes).toBe(false);
    expect(result).toEqual({
      body: { ok: true },
      requestAuth: { authMethod: "token", trustDeclaredOperatorScopes: false },
    });
  });
});
