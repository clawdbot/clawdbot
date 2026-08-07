// Openai tests cover openai chatgpt oauth plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOpenAIOAuthTlsPreflight } from "./openai-chatgpt-oauth-preflight.runtime.js";
import {
  exchangeOpenAIAuthorizationCode,
  refreshOpenAIAccessToken,
} from "./openai-chatgpt-oauth-token.runtime.js";

describe("OpenAI Codex OAuth runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps oversized TLS preflight timeouts before creating an abort signal", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302 }));

    await expect(
      runOpenAIOAuthTlsPreflight({
        timeoutMs: Number.MAX_SAFE_INTEGER,
        fetchImpl,
      }),
    ).resolves.toEqual({ ok: true });

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels reachable TLS preflight response bodies", async () => {
    const response = new Response("reachable", { status: 302 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const fetchImpl = vi.fn(async () => response);

    await expect(
      runOpenAIOAuthTlsPreflight({
        timeoutMs: 20,
        fetchImpl,
      }),
    ).resolves.toEqual({ ok: true });

    expect(cancel).toHaveBeenCalledOnce();
  });
});

// Token exchange / refresh tests
const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ response: Response; release: () => Promise<void> }>>(),
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

function okJson(body: unknown): { response: Response; release: () => Promise<void> } {
  return {
    response: new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    release: vi.fn(async () => {}),
  };
}

function okText(body: string): { response: Response; release: () => Promise<void> } {
  return {
    response: new Response(body, { status: 200 }),
    release: vi.fn(async () => {}),
  };
}

describe("exchangeOpenAIAuthorizationCode", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("rejects JSON null response body during token exchange", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue(okJson(null));

    const result = await exchangeOpenAIAuthorizationCode("code", "verifier", "https://example.com");

    expect(result).toEqual({
      type: "failed",
      message: "OpenAI Codex token exchange failed: expected JSON object response",
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
  });

  it("rejects JSON array response body during token exchange", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue(okJson([]));

    const result = await exchangeOpenAIAuthorizationCode("code", "verifier", "https://example.com");

    expect(result).toEqual({
      type: "failed",
      message: "OpenAI Codex token exchange failed: expected JSON object response",
    });
  });

  it("rejects non-JSON response body during token exchange", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue(okText("not json"));

    // response.json() throws SyntaxError on non-JSON — the uncaught
    // error surfaces as a rejected promise from exchangeOpenAIAuthorizationCode.
    await expect(
      exchangeOpenAIAuthorizationCode("code", "verifier", "https://example.com"),
    ).rejects.toThrow();
  });

  it("returns success for a valid token exchange response", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue(
      okJson({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
    );

    const result = await exchangeOpenAIAuthorizationCode("code", "verifier", "https://example.com");

    expect(result).toEqual({
      type: "success",
      access: "at",
      refresh: "rt",
      expires: expect.any(Number),
    });
  });
});

describe("refreshOpenAIAccessToken", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("rejects JSON null response body during token refresh", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue(okJson(null));

    const result = await refreshOpenAIAccessToken("refresh-token");

    expect(result).toEqual({
      type: "failed",
      message: "OpenAI Codex token refresh failed: expected JSON object response",
    });
  });

  it("returns success for a valid token refresh response", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue(
      okJson({ access_token: "at2", refresh_token: "rt2", expires_in: 3600 }),
    );

    const result = await refreshOpenAIAccessToken("refresh-token");

    expect(result).toEqual({
      type: "success",
      access: "at2",
      refresh: "rt2",
      expires: expect.any(Number),
    });
  });
});
