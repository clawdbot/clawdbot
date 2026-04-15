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

    expect(mockFetchGuard).toHaveBeenCalledWith({
      url: "https://mm.example.com/api/v4/users/me",
      init: expect.objectContaining({
        headers: { Authorization: "Bearer bot-token" },
      }),
      auditContext: "mattermost-probe",
      policy: undefined,
    });
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        status: 200,
        bot: { id: "bot-1", username: "clawbot" },
      }),
    );
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
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

    expect(mockFetchGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: { allowPrivateNetwork: true },
      }),
    );
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

    await expect(probeMattermost("https://mm.example.com", "bad-token")).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        status: 401,
        error: "invalid auth token",
      }),
    );
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

    await expect(probeMattermost("https://mm.example.com", "token")).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        status: 403,
        error: "Forbidden",
      }),
    );
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("returns fetch error when request throws", async () => {
    mockFetchGuard.mockRejectedValueOnce(new Error("network down"));

    await expect(probeMattermost("https://mm.example.com", "token")).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        status: null,
        error: "network down",
      }),
    );
  });
});
