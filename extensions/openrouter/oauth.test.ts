// Openrouter OAuth tests cover PKCE exchange and auth profile output.
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createOpenRouterOAuthAuthMethod } from "./oauth.js";

const OPENROUTER_OAUTH_REDIRECT_URI = "http://localhost:3000/openrouter-oauth/callback";
type OpenRouterOAuthLoginOptions = NonNullable<
  Parameters<typeof createOpenRouterOAuthAuthMethod>[0]
>;

function loginOpenRouterOAuth(ctx: ProviderAuthContext, options: OpenRouterOAuthLoginOptions = {}) {
  return createOpenRouterOAuthAuthMethod(options).run(ctx);
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function boundedTextErrorResponse(
  body: string,
  status = 502,
): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
  text: ReturnType<typeof vi.fn>;
} {
  const encoded = new TextEncoder().encode(body);
  let read = false;
  const cancel = vi.fn(async () => undefined);
  const releaseLock = vi.fn();
  const text = vi.fn(async () => {
    throw new Error("response.text() should not be called");
  });
  const response = {
    ok: false,
    status,
    headers: new Headers(),
    body: {
      getReader: () => ({
        read: async () => {
          if (read) {
            return { done: true, value: undefined };
          }
          read = true;
          return { done: false, value: encoded };
        },
        cancel,
        releaseLock,
      }),
    },
    text,
  } as unknown as Response;

  return { response, cancel, releaseLock, text };
}

function oversizedJsonResponse(): { response: Response; wasCanceled: () => boolean } {
  let canceled = false;
  const body = new TextEncoder().encode(`{"key":"${"x".repeat(16 * 1024 * 1024)}"}`);
  return {
    response: new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
    wasCanceled: () => canceled,
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function requestJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected JSON request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function createOpenRouterOAuthContext(params: {
  isRemote: boolean;
  onProgress?: (message: string) => void;
  redirectInput?: string;
  openUrl?: (url: string) => Promise<void>;
  signal?: AbortSignal;
}) {
  const progress = {
    update: vi.fn((message: string) => params.onProgress?.(message)),
    stop: vi.fn(),
  };
  const note = vi.fn<(message: string, title?: string) => Promise<void>>(async () => undefined);
  const text = vi.fn<(prompt: { message: string; placeholder?: string }) => Promise<string>>(
    async () =>
      params.redirectInput ?? `${OPENROUTER_OAUTH_REDIRECT_URI}?state=state-1&code=AUTHCODE`,
  );
  const log = vi.fn<(message: string) => void>();
  const openUrl = params.openUrl ?? vi.fn<(url: string) => Promise<void>>(async () => undefined);

  const ctx = {
    config: {},
    isRemote: params.isRemote,
    openUrl,
    signal: params.signal,
    prompter: {
      note,
      text,
      progress: vi.fn(() => progress),
    },
    runtime: {
      log,
      error: vi.fn(),
      exit: vi.fn(),
    },
    oauth: {
      createVpsAwareHandlers: vi.fn(),
    },
  } as unknown as ProviderAuthContext;

  return { ctx, progress, note, text, log, openUrl };
}

async function requestLocalOpenRouterOAuthCallback(
  query: string,
): Promise<{ callback: Promise<unknown>; response: Response; body: string }> {
  let markReady = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const controller = new AbortController();
  const redirectInput = `${OPENROUTER_OAUTH_REDIRECT_URI}?${query}`;
  const { ctx } = createOpenRouterOAuthContext({
    isRemote: false,
    onProgress: (message) => {
      if (message.startsWith("Waiting for OpenRouter OAuth callback")) {
        markReady();
      }
    },
    redirectInput,
    signal: controller.signal,
  });
  const callback = loginOpenRouterOAuth(ctx, {
    createPkce: () => ({ verifier: "verifier-1", challenge: "challenge-1" }),
    createState: () => "state-1",
    fetchImpl: vi.fn(async () => jsonResponse({ key: "sk-or-v1-test" })),
  });
  callback.catch(() => undefined);
  await Promise.race([
    ready,
    callback.then(
      () => {
        throw new Error("OpenRouter OAuth completed before callback server started");
      },
      (error: unknown) => {
        throw error;
      },
    ),
  ]);

  try {
    const response = await fetch(redirectInput, { headers: { Connection: "close" } });
    return { callback, response, body: await response.text() };
  } catch (error) {
    controller.abort();
    throw error;
  }
}

function runRemoteOpenRouterOAuthRedirect(redirectInput: string) {
  const { ctx } = createOpenRouterOAuthContext({ isRemote: true, redirectInput });
  return loginOpenRouterOAuth(ctx, {
    createPkce: () => ({ verifier: "verifier-1", challenge: "challenge-1" }),
    createState: () => "state-1",
    fetchImpl: vi.fn(async () => jsonResponse({ key: "sk-or-v1-test" })),
  });
}

describe("OpenRouter OAuth", () => {
  it("builds the documented PKCE authorize URL", async () => {
    const { ctx, openUrl } = createOpenRouterOAuthContext({ isRemote: true });
    await loginOpenRouterOAuth(ctx, {
      createPkce: () => ({ verifier: "verifier-1", challenge: "challenge-1" }),
      createState: () => "state-1",
      fetchImpl: vi.fn(async () => jsonResponse({ key: "sk-or-v1-test" })),
    });
    const openedUrl = (openUrl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (typeof openedUrl !== "string") {
      throw new Error("expected OpenRouter OAuth authorize URL");
    }
    const url = new URL(openedUrl);
    const callbackUrl = new URL(url.searchParams.get("callback_url") ?? "");

    expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
    expect(callbackUrl.origin + callbackUrl.pathname).toBe(OPENROUTER_OAUTH_REDIRECT_URI);
    expect(callbackUrl.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("parses state-bound OpenRouter redirect URLs and query strings", async () => {
    await expect(
      runRemoteOpenRouterOAuthRedirect(
        `${OPENROUTER_OAUTH_REDIRECT_URI}?state=state-1&code=AUTHCODE`,
      ),
    ).resolves.toMatchObject({ defaultModel: "openrouter/auto" });
    await expect(
      runRemoteOpenRouterOAuthRedirect("state=state-1&code=AUTHCODE"),
    ).resolves.toMatchObject({ defaultModel: "openrouter/auto" });
    await expect(
      runRemoteOpenRouterOAuthRedirect(
        `${OPENROUTER_OAUTH_REDIRECT_URI}?state=state-1&error=access_denied&error_description=Denied`,
      ),
    ).rejects.toThrow("OpenRouter OAuth error: access_denied: Denied");
    await expect(
      runRemoteOpenRouterOAuthRedirect(
        "state=state-1&error=access_denied&error_description=Denied",
      ),
    ).rejects.toThrow("OpenRouter OAuth error: access_denied: Denied");
    await expect(
      runRemoteOpenRouterOAuthRedirect(
        `${OPENROUTER_OAUTH_REDIRECT_URI}?error=access_denied&error_description=Denied`,
      ),
    ).rejects.toThrow("Missing OpenRouter OAuth state");
    await expect(
      runRemoteOpenRouterOAuthRedirect(
        `${OPENROUTER_OAUTH_REDIRECT_URI}?state=wrong&error=access_denied&error_description=Denied`,
      ),
    ).rejects.toThrow("OpenRouter OAuth state mismatch");
    await expect(
      runRemoteOpenRouterOAuthRedirect(`${OPENROUTER_OAUTH_REDIRECT_URI}?code=AUTHCODE`),
    ).rejects.toThrow("Missing OpenRouter OAuth state");
    await expect(
      runRemoteOpenRouterOAuthRedirect(
        `${OPENROUTER_OAUTH_REDIRECT_URI}?state=wrong&code=AUTHCODE`,
      ),
    ).rejects.toThrow("OpenRouter OAuth state mismatch");
    await expect(runRemoteOpenRouterOAuthRedirect("AUTHCODE")).rejects.toThrow(
      "Paste the full OpenRouter redirect URL",
    );
  });

  it("exchanges an authorization code for the issued OpenRouter API key", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(requestUrl(url)).toBe("https://openrouter.ai/api/v1/auth/keys");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(requestJsonBody(init)).toEqual({
        code: "AUTHCODE",
        code_verifier: "verifier-1",
        code_challenge_method: "S256",
      });
      return jsonResponse({ key: "sk-or-v1-test", user_id: "user-1" });
    });
    const { ctx } = createOpenRouterOAuthContext({ isRemote: true });

    await expect(
      loginOpenRouterOAuth(ctx, {
        createPkce: () => ({ verifier: "verifier-1", challenge: "challenge-1" }),
        createState: () => "state-1",
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      profiles: [
        {
          credential: {
            key: "sk-or-v1-test",
            metadata: { userId: "user-1" },
          },
        },
      ],
    });
  });

  it("bounds successful OpenRouter OAuth responses", async () => {
    const oversized = oversizedJsonResponse();
    const { ctx } = createOpenRouterOAuthContext({ isRemote: true });

    await expect(
      loginOpenRouterOAuth(ctx, {
        createPkce: () => ({ verifier: "verifier-1", challenge: "challenge-1" }),
        createState: () => "state-1",
        fetchImpl: vi.fn(async () => oversized.response),
      }),
    ).rejects.toThrow("OpenRouter OAuth key exchange: JSON response exceeds 16777216 bytes");
    expect(oversized.wasCanceled()).toBe(true);
  });

  it("surfaces OpenRouter OAuth exchange errors without credential material", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ error: "Invalid code or code_verifier" }, { status: 403 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "Invalid code", code: 400 } }, { status: 400 }),
      );
    const first = createOpenRouterOAuthContext({
      isRemote: true,
      redirectInput: `${OPENROUTER_OAUTH_REDIRECT_URI}?state=state-1&code=bad-code`,
    });
    const second = createOpenRouterOAuthContext({
      isRemote: true,
      redirectInput: `${OPENROUTER_OAUTH_REDIRECT_URI}?state=state-1&code=bad-code`,
    });

    await expect(
      loginOpenRouterOAuth(first.ctx, {
        createPkce: () => ({ verifier: "bad-verifier", challenge: "challenge-1" }),
        createState: () => "state-1",
        fetchImpl,
      }),
    ).rejects.toThrow("OpenRouter OAuth key exchange failed (403): Invalid code or code_verifier");
    await expect(
      loginOpenRouterOAuth(second.ctx, {
        createPkce: () => ({ verifier: "bad-verifier", challenge: "challenge-1" }),
        createState: () => "state-1",
        fetchImpl,
      }),
    ).rejects.toThrow("OpenRouter OAuth key exchange failed (400): Invalid code");
  });

  it("bounds OpenRouter OAuth exchange error bodies without requiring response.text()", async () => {
    const errorResponse = boundedTextErrorResponse(
      `${"openrouter denied ".repeat(1024)}tail-marker`,
      502,
    );
    const fetchImpl = vi.fn<typeof fetch>(async () => errorResponse.response);
    const { ctx } = createOpenRouterOAuthContext({
      isRemote: true,
      redirectInput: `${OPENROUTER_OAUTH_REDIRECT_URI}?state=state-1&code=bad-code`,
    });

    let error: unknown;
    try {
      await loginOpenRouterOAuth(ctx, {
        createPkce: () => ({ verifier: "bad-verifier", challenge: "challenge-1" }),
        createState: () => "state-1",
        fetchImpl,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("OpenRouter OAuth key exchange failed (502): openrouter denied");
    expect(message).not.toContain("tail-marker");
    expect(errorResponse.text).not.toHaveBeenCalled();
    expect(errorResponse.cancel).toHaveBeenCalledTimes(1);
    expect(errorResponse.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("stores a browser OAuth result as the default OpenRouter API-key profile", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ key: "sk-or-v1-test", user_id: "user-1" }),
    );
    const { ctx, progress, note, text, log, openUrl } = createOpenRouterOAuthContext({
      isRemote: true,
    });

    const result = await loginOpenRouterOAuth(ctx, {
      createPkce: () => ({ verifier: "verifier-1", challenge: "challenge-1" }),
      createState: () => "state-1",
      fetchImpl,
    });

    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining("https://openrouter.ai/auth?"));
    expect(log.mock.calls[0]?.[0]).toContain("https://openrouter.ai/auth?");
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("https://openrouter.ai/auth?"),
      "OpenRouter OAuth",
    );
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Paste the OpenRouter redirect URL",
      }),
    );
    expect(result.defaultModel).toBe("openrouter/auto");
    expect(result.profiles).toEqual([
      {
        profileId: "openrouter:default",
        credential: {
          type: "api_key",
          provider: "openrouter",
          key: "sk-or-v1-test",
          displayName: "OpenRouter user-1",
          metadata: {
            authFlow: "oauth-pkce",
            userId: "user-1",
          },
        },
      },
    ]);
    expect(progress.stop).toHaveBeenCalledWith("OpenRouter OAuth complete");
  });

  it("uses the local callback path before opening the browser locally", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ key: "sk-or-v1-test" }));
    const waitForCallback = vi.fn(async (_params: { expectedState: string }) => ({
      code: "AUTHCODE",
      state: "state-1",
    }));
    const { ctx, openUrl, text } = createOpenRouterOAuthContext({ isRemote: false });

    await loginOpenRouterOAuth(ctx, {
      createPkce: () => ({ verifier: "verifier-1", challenge: "challenge-1" }),
      createState: () => "state-1",
      fetchImpl,
      waitForCallback,
    });

    expect(waitForCallback).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: "state-1" }),
    );

    expect(waitForCallback.mock.invocationCallOrder[0]).toBeLessThan(
      (openUrl as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining("https://openrouter.ai/auth?"));
    expect(text).not.toHaveBeenCalled();
  });

  it("validates local callback state before surfacing OpenRouter OAuth errors", async () => {
    const denied = await requestLocalOpenRouterOAuthCallback(
      "state=state-1&error=access_denied&error_description=Denied",
    );
    expect(denied.response.status).toBe(400);
    expect(denied.body).toBe("OpenRouter authentication failed: access_denied: Denied");
    await expect(denied.callback).rejects.toThrow("OpenRouter OAuth error: access_denied: Denied");

    const missingState = await requestLocalOpenRouterOAuthCallback(
      "error=access_denied&error_description=Denied",
    );
    expect(missingState.response.status).toBe(400);
    expect(missingState.body).toBe("Invalid OAuth state");
    await expect(missingState.callback).rejects.toThrow("Missing OpenRouter OAuth state");

    const wrongState = await requestLocalOpenRouterOAuthCallback(
      "state=wrong&error=access_denied&error_description=Denied",
    );
    expect(wrongState.response.status).toBe(400);
    expect(wrongState.body).toBe("Invalid OAuth state");
    await expect(wrongState.callback).rejects.toThrow("OpenRouter OAuth state mismatch");
  });

  it("exposes stable auth choice metadata", () => {
    expect(createOpenRouterOAuthAuthMethod().wizard?.choiceId).toBe("openrouter-oauth");
  });
});
