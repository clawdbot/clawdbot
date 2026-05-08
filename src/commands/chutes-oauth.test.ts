import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { CHUTES_TOKEN_ENDPOINT, CHUTES_USERINFO_ENDPOINT } from "../agents/chutes-oauth.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { loginChutes } from "./chutes-oauth.js";

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("No TCP address")));
        return;
      }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

const urlToString = (url: Request | URL | string): string => {
  if (typeof url === "string") {
    return url;
  }
  return "url" in url ? url.url : String(url);
};

function createOAuthFetchFn(params: {
  accessToken: string;
  refreshToken: string;
  username: string;
  passthrough?: boolean;
}) {
  return withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlToString(input);
    if (url === CHUTES_TOKEN_ENDPOINT) {
      return new Response(
        JSON.stringify({
          access_token: params.accessToken,
          refresh_token: params.refreshToken,
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === CHUTES_USERINFO_ENDPOINT) {
      return new Response(JSON.stringify({ username: params.username }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (params.passthrough) {
      return fetch(input, init);
    }
    return new Response("not found", { status: 404 });
  });
}

describe("loginChutes", () => {
  it("captures local redirect and exchanges code for tokens", async () => {
    const port = await getFreePort();
    const redirectUri = `http://127.0.0.1:${port}/oauth-callback`;

    const fetchFn = createOAuthFetchFn({
      accessToken: "at_local",
      refreshToken: "rt_local",
      username: "local-user",
      passthrough: true,
    });

    const onPrompt = vi.fn(async () => {
      throw new Error("onPrompt should not be called for local callback");
    });

    const creds = await loginChutes({
      app: { clientId: "cid_test", redirectUri, scopes: ["openid"] },
      onAuth: async ({ url }) => {
        const state = new URL(url).searchParams.get("state");
        if (state === null) {
          throw new Error("expected OAuth state");
        }
        expect(state).toMatch(/\S/u);
        await fetch(`${redirectUri}?code=code_local&state=${state}`);
      },
      onPrompt,
      fetchFn,
    });

    expect(onPrompt).not.toHaveBeenCalled();
    expect(creds.access).toBe("at_local");
    expect(creds.refresh).toBe("rt_local");
    expect(creds.email).toBe("local-user");
  });

  it("supports manual flow with pasted redirect URL", async () => {
    const fetchFn = createOAuthFetchFn({
      accessToken: "at_manual",
      refreshToken: "rt_manual",
      username: "manual-user",
    });

    let capturedState: string | null = null;
    const creds = await loginChutes({
      app: {
        clientId: "cid_test",
        redirectUri: "http://127.0.0.1:1456/oauth-callback",
        scopes: ["openid"],
      },
      manual: true,
      onAuth: async ({ url }) => {
        capturedState = new URL(url).searchParams.get("state");
      },
      onPrompt: async () => {
        if (!capturedState) {
          throw new Error("missing state");
        }
        return `?code=code_manual&state=${capturedState}`;
      },
      fetchFn,
    });

    expect(creds.access).toBe("at_manual");
    expect(creds.refresh).toBe("rt_manual");
    expect(creds.email).toBe("manual-user");
  });

  it("does not reuse code_verifier as state", async () => {
    const fetchFn = createOAuthFetchFn({
      accessToken: "at_manual",
      refreshToken: "rt_manual",
      username: "manual-user",
    });

    const createPkce = () => ({
      verifier: "verifier_123",
      challenge: "chal_123",
    });
    const createState = () => "state_456";

    const creds = await loginChutes({
      app: {
        clientId: "cid_test",
        redirectUri: "http://127.0.0.1:1456/oauth-callback",
        scopes: ["openid"],
      },
      manual: true,
      createPkce,
      createState,
      onAuth: async ({ url }) => {
        const parsed = new URL(url);
        expect(parsed.searchParams.get("state")).toBe("state_456");
        expect(parsed.searchParams.get("state")).not.toBe("verifier_123");
      },
      onPrompt: async () => "?code=code_manual&state=state_456",
      fetchFn,
    });

    expect(creds.access).toBe("at_manual");
  });

  it("rejects pasted redirect URLs missing state", async () => {
    const fetchFn = withFetchPreconnect(async () => new Response("not found", { status: 404 }));

    await expect(
      loginChutes({
        app: {
          clientId: "cid_test",
          redirectUri: "http://127.0.0.1:1456/oauth-callback",
          scopes: ["openid"],
        },
        manual: true,
        createPkce: () => ({ verifier: "verifier_123", challenge: "chal_123" }),
        createState: () => "state_456",
        onAuth: async () => {},
        onPrompt: async () => "http://127.0.0.1:1456/oauth-callback?code=code_only",
        fetchFn,
      }),
    ).rejects.toThrow("Missing 'state' parameter");
  });
});
