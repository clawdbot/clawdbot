import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGoogleMeetAuthUrl,
  refreshGoogleMeetAccessToken,
  resolveGoogleMeetAccessToken,
} from "./oauth.js";

describe("Google Meet OAuth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
});
