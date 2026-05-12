import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeMattermost } from "./probe.js";

const { mockFetchGuard, mockRelease } = vi.hoisted(() => ({
  mockFetchGuard: vi.fn(),
  mockRelease: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const original = (await vi.importActual("openclaw/plugin-sdk/ssrf-runtime")) as Record<
    string,
    unknown
  >;
  return { ...original, fetchWithSsrFGuard: mockFetchGuard };
});

function requireFirstFetchCall() {
  const [call] = mockFetchGuard.mock.calls;
  if (!call) {
    throw new Error("expected Mattermost probe fetch call");
  }
  return call[0] as {
    url?: string;
    init?: { headers?: unknown; signal?: unknown };
    auditContext?: string;
    policy?: unknown;
  };
}

describe("probeMattermost", () => {
  beforeEach(() => {
    mockFetchGuard.mockReset();
    mockRelease.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns baseUrl missing for empty base URL", async () => {
    await expect(probeMattermost(" ", "token")).resolves.toEqual({
      ok: false,
      error: "baseUrl missing",
    });
    expect(mockFetchGuard).not.toHaveBeenCalled();
  });

  it("normalizes base URL and returns bot info", async () => {
    mockFetchGuard.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ id: "bot-1", username: "clawbot" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: mockRelease,
    });

    const result = await probeMattermost("https://mm.example.com/api/v4/", "bot-token");

    const fetchCall = requireFirstFetchCall();
    expect(fetchCall?.url).toBe("https://mm.example.com/api/v4/users/me");
    expect(fetchCall?.init?.headers).toStrictEqual({ Authorization: "Bearer bot-token" });
    expect(fetchCall?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchCall?.auditContext).toBe("mattermost-probe");
    expect(fetchCall?.policy).toBeUndefined();
    const { elapsedMs, ...stableResult } = result;
    expect(stableResult).toStrictEqual({
      ok: true,
      status: 200,
      bot: { id: "bot-1", username: "clawbot" },
    });
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("forwards allowPrivateNetwork to the SSRF guard policy", async () => {
    mockFetchGuard.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ id: "bot-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: mockRelease,
    });

    await probeMattermost("https://mm.example.com", "bot-token", 2500, true);

    const fetchCall = requireFirstFetchCall();
    expect(fetchCall?.policy).toStrictEqual({ allowPrivateNetwork: true });
  });

  it("returns API error details from JSON response", async () => {
    mockFetchGuard.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ message: "invalid auth token" }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" },
      }),
      release: mockRelease,
    });

    const result = await probeMattermost("https://mm.example.com", "bad-token");
    const { elapsedMs, ...stableResult } = result;
    expect(stableResult).toStrictEqual({
      ok: false,
      status: 401,
      error: "invalid auth token",
    });
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("falls back to statusText when error body is empty", async () => {
    mockFetchGuard.mockResolvedValueOnce({
      response: new Response("", {
        status: 403,
        statusText: "Forbidden",
        headers: { "content-type": "text/plain" },
      }),
      release: mockRelease,
    });

    const result = await probeMattermost("https://mm.example.com", "token");
    const { elapsedMs, ...stableResult } = result;
    expect(stableResult).toStrictEqual({
      ok: false,
      status: 403,
      error: "Forbidden",
    });
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("returns fetch error when request throws", async () => {
    mockFetchGuard.mockRejectedValueOnce(new Error("network down"));

    const result = await probeMattermost("https://mm.example.com", "token");
    const { elapsedMs, ...stableResult } = result;
    expect(stableResult).toStrictEqual({
      ok: false,
      status: null,
      error: "network down",
    });
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
