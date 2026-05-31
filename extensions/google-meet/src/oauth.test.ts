import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGoogleMeetAuthUrl,
  refreshGoogleMeetAccessToken,
  resolveGoogleMeetAccessToken,
} from "./oauth.js";

describe("Google Meet OAuth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("builds auth URLs and prefers fresh cached access tokens", async () => {
    const url = new URL(
      buildGoogleMeetAuthUrl({
        clientId: "client-id",
        challenge: "challenge",
        state: "state",
      }),
    );
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toContain("meetings.space.created");
    expect(url.searchParams.get("scope")).toContain("meetings.conference.media.readonly");
    expect(url.searchParams.get("scope")).toContain("calendar.events.readonly");
    expect(url.searchParams.get("scope")).toContain("drive.meet.readonly");

    const cachedExpiresAt = Date.now() + 120_000;
    await expect(
      resolveGoogleMeetAccessToken({
        accessToken: "cached-token",
        expiresAt: cachedExpiresAt,
      }),
    ).resolves.toEqual({
      accessToken: "cached-token",
      expiresAt: cachedExpiresAt,
      refreshed: false,
    });
  });

  it("refreshes access tokens with a refresh-token grant", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          access_token: "new-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await refreshGoogleMeetAccessToken({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    });
    expect(tokens.accessToken).toBe("new-access-token");
    expect(tokens.refreshToken).toBeUndefined();
    expect(tokens.scope).toBeUndefined();
    expect(tokens.tokenType).toBe("Bearer");
    expect(Number.isFinite(tokens.expiresAt)).toBe(true);
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    const params = body as URLSearchParams;
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("refresh-token");
  });

  it("refreshes cached access tokens with Date-invalid expiries", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          access_token: "refreshed-token",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await resolveGoogleMeetAccessToken({
      clientId: "client-id",
      refreshToken: "refresh-token",
      accessToken: "cached-token",
      expiresAt: 8_700_000_000_000_000,
    });

    expect(tokens.accessToken).toBe("refreshed-token");
    expect(tokens.refreshed).toBe(true);
  });

  it("falls back when refreshed token lifetimes overflow safe milliseconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          access_token: "new-access-token",
          expires_in: Number.MAX_SAFE_INTEGER,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await refreshGoogleMeetAccessToken({
      clientId: "client-id",
      refreshToken: "refresh-token",
    });

    expect(tokens.expiresAt).toBe(Date.now() + 3600 * 1000);
  });

  it("bounds fallback token lifetimes when the process clock is invalid", async () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          access_token: "new-access-token",
          expires_in: Number.MAX_SAFE_INTEGER,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await refreshGoogleMeetAccessToken({
      clientId: "client-id",
      refreshToken: "refresh-token",
    });

    expect(tokens.expiresAt).toBe(3600 * 1000);
  });

  it("keeps explicit zero-second token lifetimes immediately stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          access_token: "new-access-token",
          expires_in: 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await refreshGoogleMeetAccessToken({
      clientId: "client-id",
      refreshToken: "refresh-token",
    });

    expect(tokens.expiresAt).toBe(Date.now());
  });
});
