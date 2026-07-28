// GitHub Copilot OAuth tests cover device flow polling and timeout behavior.
import { getEventListeners } from "node:events";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../../types.js";
import { githubCopilotOAuthProvider } from "./github-copilot.js";
import type { OAuthCredentials } from "./types.js";

type FetchImplementation = (...args: Parameters<typeof fetch>) => Promise<Response>;

function startGitHubCopilotLogin(enterpriseUrl = "", signal?: AbortSignal) {
  return githubCopilotOAuthProvider.login({
    onAuth: vi.fn(),
    onPrompt: vi.fn(async () => enterpriseUrl),
    signal,
  });
}

function deviceCodeResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      device_code: "device-code",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      interval: 0,
      expires_in: 300,
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function deviceTokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: "github-access-token" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function copilotTokenResponse(): Response {
  return new Response(
    JSON.stringify({
      token: "copilot-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function finishGitHubCopilotLogin(login: Promise<OAuthCredentials>) {
  const outcome = login.then(
    (credentials) => ({ credentials }) as const,
    (error: unknown) => ({ error }) as const,
  );
  await vi.advanceTimersByTimeAsync(1_200);
  const settled = await outcome;
  if ("error" in settled) {
    throw settled.error;
  }
  return settled.credentials;
}

function startGitHubCopilotLoginAtTokenExchange(
  tokenExchangeFetch: FetchImplementation,
  enterpriseUrl = "",
): {
  fetchMock: ReturnType<typeof vi.fn>;
  login: Promise<OAuthCredentials>;
} {
  vi.useFakeTimers();
  const fetchMock = vi
    .fn(tokenExchangeFetch)
    .mockResolvedValueOnce(deviceCodeResponse())
    .mockResolvedValueOnce(deviceTokenResponse());
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    login: finishGitHubCopilotLogin(startGitHubCopilotLogin(enterpriseUrl)),
  };
}

function abortListenerCount(signal: AbortSignal): number {
  return getEventListeners(signal, "abort").length;
}

function createHangingFetch(timeoutMs: number): FetchImplementation {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((actualTimeoutMs) => {
    expect(actualTimeoutMs).toBe(timeoutMs);
    const controller = new AbortController();
    queueMicrotask(() => {
      controller.abort(new DOMException("timed out", "TimeoutError"));
    });
    return controller.signal;
  });

  return vi.fn(
    (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing abort signal"));
          return;
        }

        const abort = () => {
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("aborted", "AbortError"),
          );
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
      }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GitHub Copilot OAuth model policy", () => {
  it("enables only eligible model ids returned by Copilot", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(deviceCodeResponse())
      .mockResolvedValueOnce(deviceTokenResponse())
      .mockResolvedValueOnce(copilotTokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { id: "claude-sonnet-4.6" },
              { id: "  gpt-5.5  " },
              { id: "embedding-model", capabilities: { type: "embeddings" } },
              { id: "accounts/example/router" },
              { id: "not-a-model", object: "assistant" },
              { id: "" },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(finishGitHubCopilotLogin(startGitHubCopilotLogin())).resolves.toMatchObject({
      access: "copilot-token",
    });
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).toContain("https://api.individual.githubcopilot.com/models");
    expect(urls).toContain(
      "https://api.individual.githubcopilot.com/models/claude-sonnet-4.6/policy",
    );
    expect(urls).toContain("https://api.individual.githubcopilot.com/models/gpt-5.5/policy");
    expect(urls.some((url) => url.includes("embedding-model"))).toBe(false);
    expect(urls.some((url) => url.includes("accounts/example/router"))).toBe(false);
  });

  it("treats model listing failures as optional policy setup", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(deviceCodeResponse())
      .mockResolvedValueOnce(deviceTokenResponse())
      .mockResolvedValueOnce(copilotTokenResponse())
      .mockResolvedValueOnce(new Response("nope", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(finishGitHubCopilotLogin(startGitHubCopilotLogin())).resolves.toMatchObject({
      access: "copilot-token",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("times out device code requests", async () => {
    vi.stubGlobal("fetch", createHangingFetch(30_000));

    await expect(startGitHubCopilotLogin()).rejects.toThrow(
      "GitHub Copilot device code request timed out after 30000ms",
    );
  });

  it("rejects unsafe device code lifetimes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            '{"device_code":"device-code","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","interval":0,"expires_in":1e309}',
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    await expect(startGitHubCopilotLogin()).rejects.toThrow("Invalid device code response fields");
  });

  it("times out token refresh requests", async () => {
    const { login } = startGitHubCopilotLoginAtTokenExchange(createHangingFetch(30_000));

    await expect(login).rejects.toThrow(
      "GitHub Copilot token refresh request timed out after 30000ms",
    );
  });

  it("rejects unsafe Copilot token expiry values", async () => {
    const { login } = startGitHubCopilotLoginAtTokenExchange(
      async () =>
        new Response('{"token":"copilot-token","expires_at":1e309}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(login).rejects.toThrow("Invalid Copilot token response fields");
  });

  it("cancels model enablement response bodies", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(deviceCodeResponse())
      .mockResolvedValueOnce(deviceTokenResponse())
      .mockResolvedValueOnce(copilotTokenResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4.6" }] }), { status: 200 }),
      )
      .mockResolvedValueOnce({ ok: true, body: { cancel } } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(finishGitHubCopilotLogin(startGitHubCopilotLogin())).resolves.toMatchObject({
      access: "copilot-token",
    });

    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub Copilot OAuth enterprise domain allowlist", () => {
  function fetchToken(): Promise<Response> {
    return Promise.resolve(copilotTokenResponse());
  }

  it("rejects an unlisted enterprise domain without sending any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(startGitHubCopilotLogin("attacker.example")).rejects.toThrow(
      'Unsupported GitHub Enterprise domain "attacker.example"',
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a data-residency ghe.com tenant for the refresh endpoint", async () => {
    const { fetchMock, login } = startGitHubCopilotLoginAtTokenExchange(fetchToken, "acme.ghe.com");

    await login;

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.acme.ghe.com/copilot_internal/v2/token",
      expect.anything(),
    );
  });

  it("defaults to public github.com when no enterprise domain is set", async () => {
    const { fetchMock, login } = startGitHubCopilotLoginAtTokenExchange(fetchToken);

    await login;

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/copilot_internal/v2/token",
      expect.anything(),
    );
  });
});

describe("GitHub Copilot OAuth model routing", () => {
  const models: Model[] = [
    { id: "gpt-5", provider: "github-copilot" } as Model,
    { id: "claude-sonnet-5", provider: "anthropic" } as Model,
  ];

  function credential(overrides: Partial<OAuthCredentials & { enterpriseUrl: string }>) {
    return {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000,
      ...overrides,
    } as OAuthCredentials;
  }

  it("exposes the durable GitHub token to provider runtime auth", () => {
    expect(githubCopilotOAuthProvider.getApiKey(credential({}))).toBe("refresh-token");
  });

  it("normalizes an expired legacy access token without exchanging it", async () => {
    const expired = credential({ expires: 1 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(githubCopilotOAuthProvider.refreshToken(expired)).resolves.toEqual({
      ...expired,
      access: "refresh-token",
      expires: MAX_DATE_TIMESTAMP_MS,
    });
    expect(expired).toMatchObject({ access: "access-token", expires: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops github-copilot models for an unsupported persisted enterprise domain", () => {
    const result = githubCopilotOAuthProvider.modifyModels?.(
      models,
      credential({ enterpriseUrl: "attacker.example" }),
    );

    expect(result?.map((m) => m.provider)).toEqual(["anthropic"]);
  });

  it("does not trust an off-allowlist proxy-ep without an enterprise domain", () => {
    const result = githubCopilotOAuthProvider.modifyModels?.(
      models,
      credential({
        access: "tid=x;proxy-ep=proxy.attacker.example;exp=1",
      }),
    );

    expect(result?.some((m) => m.provider === "github-copilot")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("attacker.example");
  });

  it("routes a data-residency ghe.com tenant to its copilot proxy", () => {
    const result = githubCopilotOAuthProvider.modifyModels?.(
      models,
      credential({ enterpriseUrl: "acme.ghe.com" }),
    );

    expect(result?.find((m) => m.provider === "github-copilot")?.baseUrl).toBe(
      "https://copilot-api.acme.ghe.com",
    );
  });

  it("quarantines unsupported credentials without affecting supported credentials", () => {
    const quarantined = githubCopilotOAuthProvider.modifyModels?.(
      models,
      credential({ enterpriseUrl: "attacker.example" }),
    );
    expect(quarantined?.some((m) => m.provider === "github-copilot")).toBe(false);

    const recovered = githubCopilotOAuthProvider.modifyModels?.(models, credential({}));

    expect(recovered?.find((m) => m.provider === "github-copilot")?.baseUrl).toBe(
      "https://api.individual.githubcopilot.com",
    );
  });
});

describe("GitHub Copilot OAuth bounded reads", () => {
  it("caps oversized OAuth JSON responses instead of buffering the full body", async () => {
    // 18 MiB body in 1 MiB chunks exceeds the 16 MiB default cap on
    // the shared readProviderJsonResponse reader.
    const CHUNK = 1024 * 1024;
    const CHUNK_COUNT = 18;
    let pulls = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls >= CHUNK_COUNT) {
          controller.close();
          return;
        }
        pulls += 1;
        controller.enqueue(encoder.encode("a".repeat(CHUNK)));
      },
    });
    const { login } = startGitHubCopilotLoginAtTokenExchange(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(login).rejects.toThrow(
      "GitHub Copilot token refresh request: JSON response exceeds 16777216 bytes",
    );
  });

  it("parses normal-size OAuth JSON responses under the byte cap", async () => {
    const { login } = startGitHubCopilotLoginAtTokenExchange(async () => copilotTokenResponse());

    const result = await login;
    expect(result.access).toBe("copilot-token");
    expect(typeof result.expires).toBe("number");
  });

  it("cancels the upstream body when the bounded reader overflows", async () => {
    const cancel = vi.fn(async () => undefined);
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode("a".repeat(1024 * 1024)));
      },
      cancel,
    });
    const { login } = startGitHubCopilotLoginAtTokenExchange(
      async () =>
        new Response(source, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(login).rejects.toThrow("GitHub Copilot token refresh request");

    expect(cancel).toHaveBeenCalled();
  });
});

describe("GitHub Copilot OAuth error responses", () => {
  const githubToken = `ghr_${"s".repeat(40)}`;

  function createOversizedOAuthErrorResponse(): {
    response: Response;
    cancel: ReturnType<typeof vi.fn>;
  } {
    const cancel = vi.fn();
    const payload =
      JSON.stringify({
        error: "invalid_grant",
        error_description: `refresh_token=${githubToken} was rejected`,
        refresh_token: githubToken,
      }) + " ".repeat(32 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
      },
      cancel,
    });
    return {
      response: new Response(body, {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "x-request-id": "copilot-request-id",
        },
      }),
      cancel,
    };
  }

  async function captureError(promise: Promise<unknown>): Promise<Error> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof Error) {
        return error;
      }
      throw error;
    }
    throw new Error("Expected request to fail");
  }

  function expectBoundedRedactedError(error: Error, label: string): void {
    expect(error).toMatchObject({
      name: "ProviderHttpError",
      status: 400,
      code: "invalid_grant",
      requestId: "copilot-request-id",
    });
    expect(error.message).toContain(`${label} (400):`);
    expect(error.message).toContain("[code=invalid_grant]");
    expect(error.message).toContain("[request_id=copilot-request-id]");
    expect(error.message).not.toContain("error_description");
    expect(error.message).not.toContain(githubToken);
    const errorBody = (error as Error & { errorBody?: string }).errorBody;
    expect(errorBody).toBeDefined();
    expect(errorBody).not.toContain(githubToken);
    expect(errorBody?.length).toBeLessThanOrEqual(500);
  }

  it("bounds and redacts device-code HTTP failures", async () => {
    const { response, cancel } = createOversizedOAuthErrorResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    const error = await captureError(startGitHubCopilotLogin());

    expectBoundedRedactedError(error, "GitHub Copilot device code request");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds and redacts device-token HTTP failures", async () => {
    vi.useFakeTimers();
    const { response, cancel } = createOversizedOAuthErrorResponse();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(deviceCodeResponse())
      .mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);

    const pending = captureError(startGitHubCopilotLogin());
    await vi.advanceTimersByTimeAsync(1_200);
    const error = await pending;

    expectBoundedRedactedError(error, "GitHub Copilot device token request");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds and redacts Copilot-token HTTP failures", async () => {
    const { response, cancel } = createOversizedOAuthErrorResponse();
    const { login } = startGitHubCopilotLoginAtTokenExchange(async () => response);

    const error = await captureError(login);

    expectBoundedRedactedError(error, "GitHub Copilot token refresh request");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds model-list HTTP failures before treating discovery as optional", async () => {
    vi.useFakeTimers();
    const { response, cancel } = createOversizedOAuthErrorResponse();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(deviceCodeResponse())
      .mockResolvedValueOnce(deviceTokenResponse())
      .mockResolvedValueOnce(copilotTokenResponse())
      .mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(finishGitHubCopilotLogin(startGitHubCopilotLogin())).resolves.toMatchObject({
      access: "copilot-token",
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("GitHub Copilot OAuth abortable polling sleep", () => {
  it("does not accumulate abort listeners across authorization_pending rounds", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pendingResponse = () =>
      new Response(JSON.stringify({ error: "authorization_pending" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(deviceCodeResponse())
        .mockResolvedValueOnce(pendingResponse())
        .mockResolvedValueOnce(pendingResponse())
        .mockResolvedValueOnce(pendingResponse())
        .mockResolvedValueOnce(deviceTokenResponse())
        .mockResolvedValueOnce(copilotTokenResponse())
        .mockResolvedValueOnce(new Response("nope", { status: 503 })),
    );

    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const pending = startGitHubCopilotLogin("", controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    const listenerCounts: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      listenerCounts.push(abortListenerCount(controller.signal));
      await vi.advanceTimersByTimeAsync(1_200);
    }

    await expect(pending).resolves.toMatchObject({ access: "copilot-token" });
    expect(abortListenerCount(controller.signal)).toBe(0);
    expect(Math.max(...listenerCounts)).toBe(1);
    const abortAdds = addSpy.mock.calls.filter((call) => call[0] === "abort").length;
    const abortRemoves = removeSpy.mock.calls.filter((call) => call[0] === "abort").length;
    expect(abortAdds).toBeGreaterThanOrEqual(4);
    expect(abortRemoves).toBe(abortAdds);
  });

  it("removes the abort listener when cancelled during sleep", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(deviceCodeResponse())
      .mockRejectedValue(new Error("poll fetch should not run after abort"));
    vi.stubGlobal("fetch", fetchMock);

    const pending = startGitHubCopilotLogin("", controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    expect(abortListenerCount(controller.signal)).toBe(1);
    controller.abort();
    await expect(pending).rejects.toThrow("Login cancelled");
    expect(abortListenerCount(controller.signal)).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects an already-aborted signal without registering a listener", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const fetchMock = vi.fn(async () => {
      throw new Error("poll fetch should not run for aborted signal");
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = startGitHubCopilotLogin("", controller.signal);

    await expect(pending).rejects.toThrow("Login cancelled");
    expect(addSpy.mock.calls.filter((call) => call[0] === "abort")).toHaveLength(0);
    expect(abortListenerCount(controller.signal)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
