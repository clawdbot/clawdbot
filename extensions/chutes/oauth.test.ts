// Chutes tests cover oauth plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginChutes } from "./oauth.js";

const CHUTES_TOKEN_ENDPOINT = "https://api.chutes.ai/idp/token";
const CHUTES_USERINFO_ENDPOINT = "https://api.chutes.ai/idp/userinfo";
const REDIRECT_URI = "http://127.0.0.1:1456/oauth-callback";

function boundedErrorResponse(
  body: string,
  status = 500,
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

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function rejectWhenAborted(init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  if (!signal) {
    return Promise.reject(new Error("missing OAuth request signal"));
  }
  return new Promise((_, reject) => {
    const rejectWithReason = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error("OAuth request aborted"));
    if (signal.aborted) {
      rejectWithReason();
      return;
    }
    signal.addEventListener("abort", rejectWithReason, { once: true });
  });
}

function useImmediateOAuthDeadline() {
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
    expect(delay).toBe(30_000);
    return AbortSignal.abort(new DOMException("OAuth request timed out", "TimeoutError"));
  });
}

function loginWithFetch(fetchFn: typeof fetch) {
  return loginChutes({
    app: {
      clientId: "cid_test",
      redirectUri: REDIRECT_URI,
      scopes: ["openid"],
    },
    manual: true,
    createState: () => "state_test",
    onAuth: vi.fn(async () => {}),
    onPrompt: vi.fn(async () => `${REDIRECT_URI}?code=code_test&state=state_test`),
    fetchFn,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chutes plugin OAuth", () => {
  it("rejects unsafe token lifetimes before storing credentials", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.chutes.ai/idp/token") {
        return new Response(
          '{"access_token":"at_unsafe","refresh_token":"rt_unsafe","expires_in":1e309}',
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      loginChutes({
        app: {
          clientId: "cid_test",
          redirectUri: "http://127.0.0.1:1456/oauth-callback",
          scopes: ["openid"],
        },
        manual: true,
        createState: () => "state_test",
        onAuth: vi.fn(async () => {}),
        onPrompt: vi.fn(
          async () => "http://127.0.0.1:1456/oauth-callback?code=code_test&state=state_test",
        ),
        fetchFn,
      }),
    ).rejects.toThrow("Chutes token exchange returned invalid expires_in");
  });

  it("bounds token exchange error bodies without requiring response.text()", async () => {
    const leakedClientSecret = "oauth-client-secret-1234567890";
    const errorResponse = boundedErrorResponse(
      `${`client_secret=${leakedClientSecret}&reason=unavailable `.repeat(1024)}tail-marker`,
      502,
    );
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.chutes.ai/idp/token") {
        return errorResponse.response;
      }
      return new Response("not found", { status: 404 });
    });

    let error: unknown;
    try {
      await loginChutes({
        app: {
          clientId: "cid_test",
          redirectUri: "http://127.0.0.1:1456/oauth-callback",
          scopes: ["openid"],
        },
        manual: true,
        createState: () => "state_test",
        onAuth: vi.fn(async () => {}),
        onPrompt: vi.fn(
          async () => "http://127.0.0.1:1456/oauth-callback?code=code_test&state=state_test",
        ),
        fetchFn,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(error).toMatchObject({ name: "ProviderHttpError", status: 502 });
    expect(message).toContain("Chutes token exchange failed (502): client_secret=");
    expect(message).not.toContain(leakedClientSecret);
    expect(message).not.toContain("tail-marker");
    expect((error as { errorBody?: string }).errorBody).not.toContain(leakedClientSecret);
    expect(errorResponse.text).not.toHaveBeenCalled();
    expect(errorResponse.cancel).toHaveBeenCalledTimes(1);
    expect(errorResponse.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("cancels oversized token exchange JSON body via the 16 MiB provider cap", async () => {
    const ONE_MIB = 1024 * 1024;
    const TOTAL_CHUNKS = 32;
    const chunk = new Uint8Array(ONE_MIB);

    let bytesPulled = 0;
    let canceled = false;
    const oversizedTokenJson = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (bytesPulled >= TOTAL_CHUNKS * ONE_MIB) {
            controller.close();
            return;
          }
          bytesPulled += chunk.length;
          controller.enqueue(chunk);
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.chutes.ai/idp/userinfo") {
        return new Response(JSON.stringify({ login: "test", name: "Test" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://api.chutes.ai/idp/token") {
        return oversizedTokenJson;
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      loginChutes({
        app: {
          clientId: "cid_test",
          redirectUri: "http://127.0.0.1:1456/oauth-callback",
          scopes: ["openid"],
        },
        manual: true,
        createState: () => "state_test",
        onAuth: vi.fn(async () => {}),
        onPrompt: vi.fn(
          async () => "http://127.0.0.1:1456/oauth-callback?code=code_test&state=state_test",
        ),
        fetchFn,
      }),
    ).rejects.toThrow(/Chutes token exchange: JSON response exceeds 16777216 bytes/);

    expect(canceled).toBe(true);
    expect(bytesPulled).toBeLessThan(TOTAL_CHUNKS * ONE_MIB);
  });

  it("uses the fixed deadline for token exchange requests", async () => {
    const timeoutSpy = useImmediateOAuthDeadline();
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return await rejectWhenAborted(init);
    });

    await expect(loginWithFetch(fetchFn)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeoutSpy).toHaveBeenCalledOnce();
  });

  it("keeps issued tokens when userinfo exceeds the fixed deadline", async () => {
    const timeoutSpy = useImmediateOAuthDeadline();
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = fetchInputUrl(input);
      if (url === CHUTES_TOKEN_ENDPOINT) {
        return new Response(
          '{"access_token":"at_timeout","refresh_token":"rt_timeout","expires_in":3600}',
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === CHUTES_USERINFO_ENDPOINT) {
        return await rejectWhenAborted(init);
      }
      return new Response("not found", { status: 404 });
    });

    const credentials = await loginWithFetch(fetchFn);

    expect(credentials).toMatchObject({ access: "at_timeout", refresh: "rt_timeout" });
    expect(credentials.email).toBeUndefined();
    expect(credentials.accountId).toBeUndefined();
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
  });

  it("cancels the userinfo error response body when profile lookup fails", async () => {
    let canceled = false;
    let bytesPulled = 0;
    const userInfoResponse = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (bytesPulled > 0) {
            controller.close();
            return;
          }
          bytesPulled += 1;
          controller.enqueue(new TextEncoder().encode("temporarily unavailable"));
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 503 },
    );
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = fetchInputUrl(input);
      if (url === CHUTES_TOKEN_ENDPOINT) {
        return new Response(
          '{"access_token":"at_123","refresh_token":"rt_123","expires_in":3600}',
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === CHUTES_USERINFO_ENDPOINT) {
        return userInfoResponse;
      }
      return new Response("not found", { status: 404 });
    });

    const credentials = await loginWithFetch(fetchFn);

    expect(canceled).toBe(true);
    expect(credentials.access).toBe("at_123");
    expect(credentials.email).toBeUndefined();
    expect(credentials.accountId).toBeUndefined();
  });

  it("cancels authentication when the caller aborts during userinfo", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = fetchInputUrl(input);
      if (url === CHUTES_TOKEN_ENDPOINT) {
        return new Response(
          '{"access_token":"at_cancel","refresh_token":"rt_cancel","expires_in":3600}',
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === CHUTES_USERINFO_ENDPOINT) {
        controller.abort(reason);
        return await rejectWhenAborted(init);
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      loginChutes({
        app: { clientId: "cid_test", redirectUri: REDIRECT_URI, scopes: ["openid"] },
        manual: true,
        createState: () => "state_test",
        onAuth: vi.fn(async () => {}),
        onPrompt: vi.fn(async () => `${REDIRECT_URI}?code=code_test&state=state_test`),
        fetchFn,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });
});
