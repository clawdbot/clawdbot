// Anthropic OAuth tests cover token exchange and refresh behavior.
import { get } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuthProvider } from "./anthropic.js";

const ANTHROPIC_REDIRECT_URI = "http://localhost:53692/callback";

async function refreshThroughAnthropicProvider(refreshToken: string) {
  return await anthropicOAuthProvider.refreshToken({
    access: "expired-access-token",
    refresh: refreshToken,
    expires: 0,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function getLocalCallback(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = get(url, (response) => {
      response.resume();
      response.once("end", resolve);
    });
    request.once("error", reject);
  });
}

describe("Anthropic OAuth token responses", () => {
  it("cancels provider login before opening the OAuth flow", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      anthropicOAuthProvider.login({
        onAuth: vi.fn(),
        onPrompt: vi.fn(async () => "unused-code"),
        signal: controller.signal,
      }),
    ).rejects.toThrow("Login cancelled");
  });

  it("does not open the OAuth flow after cancellation during setup", async () => {
    const controller = new AbortController();
    const onAuth = vi.fn();
    const loginPromise = anthropicOAuthProvider.login({
      onAuth,
      onPrompt: vi.fn(async () => "unused-code"),
      signal: controller.signal,
    });

    controller.abort();

    await expect(loginPromise).rejects.toThrow("Login cancelled");
    expect(onAuth).not.toHaveBeenCalled();
  });

  it("does not echo token payload values when refresh JSON parsing fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"access_token":"secret-access-token","refresh_token":"secret-refresh"', {
            status: 200,
          }),
      ),
    );

    await expect(refreshThroughAnthropicProvider("old-refresh-token")).rejects.toThrow(
      "Anthropic token refresh returned invalid JSON.",
    );

    try {
      await refreshThroughAnthropicProvider("old-refresh-token");
      throw new Error("Expected refresh to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("secret-access-token");
      expect(message).not.toContain("secret-refresh");
      expect(message).not.toContain("access_token");
      expect(message).not.toContain("refresh_token");
      expect(message).toContain("bodyBytes=");
    }
  });

  it("rejects unsafe token lifetimes from refresh responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            '{"access_token":"new-access-token","refresh_token":"new-refresh-token","expires_in":1e309}',
            { status: 200 },
          ),
      ),
    );

    await expect(refreshThroughAnthropicProvider("old-refresh-token")).rejects.toThrow(
      "Anthropic token refresh returned invalid token fields.",
    );
  });

  it("rejects an oversized Anthropic token refresh response", async () => {
    let pullCount = 0;
    const cancel = vi.fn(async () => undefined);
    const oversizedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new Uint8Array(pullCount === 1 ? 16 * 1024 * 1024 + 1 : 1));
      },
      cancel,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(oversizedStream, { status: 200 })),
    );

    await expect(refreshThroughAnthropicProvider("old-refresh-token")).rejects.toThrow("too large");

    expect(pullCount).toBeLessThanOrEqual(2);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("Anthropic OAuth callback host", () => {
  it("rejects non-loopback callback bind hosts", async () => {
    vi.stubEnv("OPENCLAW_OAUTH_CALLBACK_HOST", "0.0.0.0");

    await expect(
      anthropicOAuthProvider.login({
        onAuth: vi.fn(),
        onPrompt: vi.fn(async () => "unused-code"),
      }),
    ).rejects.toThrow("Anthropic OAuth callback host must be localhost, 127.0.0.1, or ::1");
  });

  it("binds IPv4 loopback while keeping Anthropic's registered localhost redirect", async () => {
    vi.stubEnv("OPENCLAW_OAUTH_CALLBACK_HOST", "127.0.0.1");
    const tokenExchange = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") {
        throw new Error("token exchange did not send a JSON string body");
      }
      const body = JSON.parse(init.body) as { redirect_uri?: string };
      expect(body.redirect_uri).toBe(ANTHROPIC_REDIRECT_URI);
      return new Response(
        JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        }),
      );
    });
    vi.stubGlobal("fetch", tokenExchange);
    let callback: Promise<void> | undefined;

    const credentials = await anthropicOAuthProvider.login({
      onAuth: ({ url }) => {
        const authorizationUrl = new URL(url);
        expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(ANTHROPIC_REDIRECT_URI);
        const state = authorizationUrl.searchParams.get("state");
        if (!state) {
          throw new Error("authorization URL did not include OAuth state");
        }
        callback = getLocalCallback(
          `http://127.0.0.1:53692/callback?code=authorization-code&state=${state}`,
        );
      },
      onPrompt: async () => {
        throw new Error("callback server did not receive the authorization code");
      },
    });

    if (!callback) {
      throw new Error("authorization callback request was not started");
    }
    await callback;
    expect(credentials).toMatchObject({ access: "access-token", refresh: "refresh-token" });
    expect(tokenExchange).toHaveBeenCalledOnce();
  });
});
