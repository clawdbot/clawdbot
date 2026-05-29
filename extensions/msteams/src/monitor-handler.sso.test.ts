import { describe, expect, it, vi } from "vitest";
import { createMSTeamsSsoTokenStoreMemory } from "./sso-token-store.js";
import {
  type MSTeamsSsoFetch,
  handleSigninTokenExchangeInvoke,
  handleSigninVerifyStateInvoke,
  parseSigninTokenExchangeValue,
  parseSigninVerifyStateValue,
} from "./sso.js";

function createSsoDeps(params: { fetchImpl: MSTeamsSsoFetch }) {
  const tokenStore = createMSTeamsSsoTokenStoreMemory();
  const tokenProvider = {
    getAccessToken: vi.fn(async () => "bf-service-token"),
  };
  return {
    sso: {
      tokenProvider,
      tokenStore,
      connectionName: "GraphConnection",
      fetchImpl: params.fetchImpl,
    },
    tokenStore,
    tokenProvider,
  };
}

function createFakeFetch(handlers: Array<(url: string, init?: unknown) => unknown>) {
  const calls: Array<{ url: string; init?: unknown }> = [];
  const fetchImpl: MSTeamsSsoFetch = async (url, init) => {
    calls.push({ url, init });
    const handler = handlers.shift();
    if (!handler) {
      throw new Error("unexpected fetch call");
    }
    const response = handler(url, init) as {
      ok: boolean;
      status: number;
      body: unknown;
    };
    const responseBody = response.body;
    const isTextBody = typeof responseBody === "string";
    return new Response(isTextBody ? responseBody : JSON.stringify(responseBody ?? ""), {
      status: response.status,
      headers: { "content-type": isTextBody ? "text/plain" : "application/json" },
    });
  };
  return { fetchImpl, calls };
}

describe("msteams signin invoke value parsers", () => {
  it("parses signin/tokenExchange values", () => {
    expect(
      parseSigninTokenExchangeValue({
        id: "flow-1",
        connectionName: "Graph",
        token: "eyJ...",
      }),
    ).toEqual({ id: "flow-1", connectionName: "Graph", token: "eyJ..." });
  });

  it("rejects non-object signin/tokenExchange values", () => {
    expect(parseSigninTokenExchangeValue(null)).toBeNull();
    expect(parseSigninTokenExchangeValue("nope")).toBeNull();
  });

  it("parses signin/verifyState values", () => {
    expect(parseSigninVerifyStateValue({ state: "123456" })).toEqual({ state: "123456" });
    expect(parseSigninVerifyStateValue({})).toEqual({ state: undefined });
    expect(parseSigninVerifyStateValue(null)).toBeNull();
  });
});

describe("handleSigninTokenExchangeInvoke", () => {
  it("exchanges the Teams token and persists the result", async () => {
    const { fetchImpl, calls } = createFakeFetch([
      () => ({
        ok: true,
        status: 200,
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          token: "delegated-graph-token",
          expiration: "2030-01-01T00:00:00Z",
        },
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });

    const result = await handleSigninTokenExchangeInvoke({
      value: { id: "flow-1", connectionName: "GraphConnection", token: "exchangeable-token" },
      user: { userId: "aad-user-guid", channelId: "msteams" },
      deps: sso,
    });

    expect(result).toEqual({
      ok: true,
      token: "delegated-graph-token",
      expiresAt: "2030-01-01T00:00:00Z",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/api/usertoken/exchange");
    expect(calls[0]?.url).toContain("userId=aad-user-guid");
    expect(calls[0]?.url).toContain("connectionName=GraphConnection");
    expect(calls[0]?.url).toContain("channelId=msteams");

    const init = calls[0]?.init as {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    expect(init?.method).toBe("POST");
    expect(init?.headers?.Authorization).toBe("Bearer bf-service-token");
    expect(JSON.parse(init?.body ?? "{}")).toEqual({ token: "exchangeable-token" });

    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored?.token).toBe("delegated-graph-token");
    expect(stored?.expiresAt).toBe("2030-01-01T00:00:00Z");
  });

  it("returns a service error when the User Token service rejects the exchange", async () => {
    const { fetchImpl } = createFakeFetch([
      () => ({ ok: false, status: 502, body: "bad gateway" }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });

    const result = await handleSigninTokenExchangeInvoke({
      value: { id: "flow-1", connectionName: "GraphConnection", token: "exchangeable-token" },
      user: { userId: "aad-user-guid", channelId: "msteams" },
      deps: sso,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("service_error");
      expect(result.status).toBe(502);
      expect(result.message).toContain("bad gateway");
    }
    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored).toBeNull();
  });

  it("refuses to exchange without a user id", async () => {
    const { fetchImpl, calls } = createFakeFetch([]);
    const { sso } = createSsoDeps({ fetchImpl });

    const result = await handleSigninTokenExchangeInvoke({
      value: { id: "flow-1", connectionName: "GraphConnection", token: "exchangeable-token" },
      user: { userId: "", channelId: "msteams" },
      deps: sso,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_user");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("handleSigninVerifyStateInvoke", () => {
  it("fetches the user token for the magic code and persists it", async () => {
    const { fetchImpl, calls } = createFakeFetch([
      () => ({
        ok: true,
        status: 200,
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          token: "delegated-token-2",
          expiration: "2031-02-03T04:05:06Z",
        },
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });

    const result = await handleSigninVerifyStateInvoke({
      value: { state: "654321" },
      user: { userId: "aad-user-guid", channelId: "msteams" },
      deps: sso,
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toContain("/api/usertoken/GetToken");
    expect(calls[0]?.url).toContain("code=654321");
    const init = calls[0]?.init as { method?: string };
    expect(init?.method).toBe("GET");

    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored?.token).toBe("delegated-token-2");
  });

  it("rejects invocations without a state code", async () => {
    const { fetchImpl, calls } = createFakeFetch([]);
    const { sso } = createSsoDeps({ fetchImpl });
    const result = await handleSigninVerifyStateInvoke({
      value: { state: "   " },
      user: { userId: "aad-user-guid", channelId: "msteams" },
      deps: sso,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_state");
    }
    expect(calls).toHaveLength(0);
  });
});
