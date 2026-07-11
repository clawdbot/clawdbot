// Openai tests cover openai chatgpt device code plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { resolveCodexAccessTokenExpiry } from "./openai-chatgpt-auth-identity.js";
import { loginOpenAICodexDeviceCode } from "./openai-chatgpt-device-code.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function createJsonResponse(body: unknown, init?: { status?: number }) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

function fetchCall(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index: number) {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected fetch call ${index}`);
  }
  return call;
}

describe("loginOpenAICodexDeviceCode", () => {
  it("requests a device code, polls for authorization, and exchanges OAuth tokens", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    try {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          createJsonResponse({
            device_auth_id: "device-auth-123",
            user_code: "CODE-12345",
            interval: "0",
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(
          createJsonResponse({
            authorization_code: "authorization-code-123",
            code_challenge: "ignored",
            code_verifier: "code-verifier-123",
          }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            access_token: createJwt({
              exp: Math.floor(Date.now() / 1000) + 600,
              "https://api.openai.com/auth": {
                chatgpt_account_id: "acct_123",
              },
              "https://api.openai.com/profile": {
                email: "codex@example.com",
              },
            }),
            refresh_token: "refresh-token-123",
            id_token: createJwt({
              "https://api.openai.com/auth": {
                chatgpt_account_id: "acct_123",
              },
            }),
            expires_in: 600,
          }),
        );
      const onVerification = vi.fn(async () => {});
      const onProgress = vi.fn();

      const credentialsPromise = loginOpenAICodexDeviceCode({
        fetchFn: fetchMock as typeof fetch,
        onVerification,
        onProgress,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      const credentials = await credentialsPromise;

      const userCodeRequest = fetchCall(fetchMock, 0);
      expect(userCodeRequest[0]).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
      expect(userCodeRequest[1]?.method).toBe("POST");
      expect(userCodeRequest[1]?.headers).toEqual({
        "Content-Type": "application/json",
        originator: "openclaw",
        version: "2026.3.22",
        "User-Agent": "openclaw/2026.3.22",
      });

      const deviceTokenRequest = fetchCall(fetchMock, 1);
      expect(deviceTokenRequest[0]).toBe("https://auth.openai.com/api/accounts/deviceauth/token");
      expect(deviceTokenRequest[1]?.method).toBe("POST");
      expect(deviceTokenRequest[1]?.headers).toEqual({
        "Content-Type": "application/json",
        originator: "openclaw",
        version: "2026.3.22",
        "User-Agent": "openclaw/2026.3.22",
      });

      const oauthTokenRequest = fetchCall(fetchMock, 3);
      expect(oauthTokenRequest[0]).toBe("https://auth.openai.com/oauth/token");
      expect(oauthTokenRequest[1]?.method).toBe("POST");
      expect(oauthTokenRequest[1]?.headers).toEqual({
        "Content-Type": "application/x-www-form-urlencoded",
        originator: "openclaw",
        version: "2026.3.22",
        "User-Agent": "openclaw/2026.3.22",
      });
      expect(onVerification).toHaveBeenCalledWith({
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "CODE-12345",
        expiresInMs: 900_000,
      });
      expect(onProgress).toHaveBeenNthCalledWith(1, "Requesting device code…");
      expect(onProgress).toHaveBeenNthCalledWith(2, "Waiting for device authorization…");
      expect(onProgress).toHaveBeenNthCalledWith(3, "Exchanging device code…");
      expect(typeof credentials.access).toBe("string");
      expect(credentials.access.length).toBeGreaterThan(0);
      expect(credentials.refresh).toBe("refresh-token-123");
      expect(credentials).not.toHaveProperty("accountId");
      expect(credentials.expires).toBeGreaterThan(Date.now());
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("aborts device-code polling without another request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          createJsonResponse({
            device_auth_id: "device-auth-123",
            user_code: "CODE-12345",
            interval: "5",
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 404 }));

      const login = loginOpenAICodexDeviceCode({
        fetchFn: fetchMock,
        onVerification: async () => {},
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      controller.abort(new Error("cancelled"));
      await expect(login).rejects.toThrow("cancelled");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats JWT-derived expiry fallback as an absolute timestamp", async () => {
    const accessToken = createJwt({
      exp: Math.floor(Date.now() / 1000) + 600,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
      },
    });
    const expectedExpiry = resolveCodexAccessTokenExpiry(accessToken);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: "0",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          authorization_code: "authorization-code-123",
          code_verifier: "code-verifier-123",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          access_token: accessToken,
          refresh_token: "refresh-token-123",
        }),
      );

    const credentials = await loginOpenAICodexDeviceCode({
      fetchFn: fetchMock as typeof fetch,
      onVerification: async () => {},
    });

    if (expectedExpiry === undefined) {
      throw new Error("expected device-code expiry to be calculated");
    }
    expect(credentials.expires).toBe(expectedExpiry);
  });

  it("accepts token exchange JSON above the diagnostic preview limit", async () => {
    const accessToken = createJwt({
      exp: Math.floor(Date.now() / 1000) + 600,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: "0",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          authorization_code: "authorization-code-123",
          code_verifier: "code-verifier-123",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          access_token: accessToken,
          refresh_token: "refresh-token-123",
          id_token: "x".repeat(10_000),
        }),
      );

    const credentials = await loginOpenAICodexDeviceCode({
      fetchFn: fetchMock as typeof fetch,
      onVerification: async () => {},
    });

    expect(credentials.refresh).toBe("refresh-token-123");
  });

  it("falls back when device-code intervals and token lifetimes overflow safe milliseconds", async () => {
    vi.useFakeTimers();
    try {
      const accessToken = createJwt({
        exp: Math.floor(Date.now() / 1000) + 600,
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_123",
        },
      });
      const expectedExpiry = resolveCodexAccessTokenExpiry(accessToken);
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          createJsonResponse({
            device_auth_id: "device-auth-123",
            user_code: "CODE-12345",
            interval: Number.MAX_SAFE_INTEGER,
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(
          createJsonResponse({
            authorization_code: "authorization-code-123",
            code_verifier: "code-verifier-123",
          }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            access_token: accessToken,
            refresh_token: "refresh-token-123",
            expires_in: Number.MAX_SAFE_INTEGER,
          }),
        );

      const credentialsPromise = loginOpenAICodexDeviceCode({
        fetchFn: fetchMock as typeof fetch,
        onVerification: async () => {},
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      const credentials = await credentialsPromise;

      if (expectedExpiry === undefined) {
        throw new Error("expected device-code expiry to be calculated");
      }
      expect(credentials.expires).toBe(expectedExpiry);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces user-code request failures", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(`down\r\n\u001B[31mnow\u001B[0m`, {
        status: 503,
      }),
    );

    await expect(
      loginOpenAICodexDeviceCode({
        fetchFn: fetchMock as typeof fetch,
        onVerification: async () => {},
      }),
    ).rejects.toThrow("OpenAI device code request failed: HTTP 503 down now");
  });

  it("bounds user-code error bodies without using response.text()", async () => {
    const tracked = cancelTrackedResponse(`${"device code unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    const fetchMock = vi.fn().mockResolvedValueOnce(tracked.response);

    const error = await loginOpenAICodexDeviceCode({
      fetchFn: fetchMock as typeof fetch,
      onVerification: async () => {},
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /OpenAI device code request failed: HTTP 503 device code unavailable/,
    );
    expect((error as Error).message).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("surfaces device authorization failures with sanitized payload details", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: "0",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            error: "authorization_declined\r\n\u001B[31mspoofed\u001B[0m",
            error_description: "Denied\r\nnext line",
          },
          { status: 401 },
        ),
      );

    await expect(
      loginOpenAICodexDeviceCode({
        fetchFn: fetchMock as typeof fetch,
        onVerification: async () => {},
      }),
    ).rejects.toThrow(
      "OpenAI device authorization failed: authorization_declined spoofed (Denied next line)",
    );
  });

  it("strips C1 terminal controls from reflected device-code errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          device_auth_id: "device-auth-123",
          user_code: "CODE-12345",
          interval: "0",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            error: `authorization_declined${String.fromCharCode(0x9b)}spoofed`,
            error_description: `Denied${String.fromCharCode(0x9d)}next line`,
          },
          { status: 401 },
        ),
      );

    await expect(
      loginOpenAICodexDeviceCode({
        fetchFn: fetchMock as typeof fetch,
        onVerification: async () => {},
      }),
    ).rejects.toThrow(
      "OpenAI device authorization failed: authorization_declined spoofed (Denied next line)",
    );
  });
});
