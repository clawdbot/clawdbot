import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: {
      url: string;
      init?: RequestInit;
      signal?: AbortSignal;
    }) => ({
      response: await fetch(params.url, { ...params.init, signal: params.signal }),
      finalUrl: params.url,
      release: async () => {},
    }),
  };
});

const SEVENTEEN_MIB = 17 * 1024 * 1024;

describe("google-meet response body boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects an oversized spaces.get success response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array(SEVENTEEN_MIB), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { fetchGoogleMeetSpace } = await import("./meet.js");
    await expect(
      fetchGoogleMeetSpace({
        accessToken: "fake-token",
        meeting: "abc-defg-hij",
      }),
    ).rejects.toThrow("Google Meet spaces.get: JSON response exceeds");
  });
});
