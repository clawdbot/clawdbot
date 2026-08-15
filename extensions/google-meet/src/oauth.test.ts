// Google Meet tests cover oauth plugin behavior.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGoogleMeetAuthUrl,
  resolveGoogleMeetAccessToken,
  waitForGoogleMeetAuthCode,
} from "./oauth.js";

async function occupyPort(port: number): Promise<Server | null> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "localhost", () => {
        resolve();
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("EADDRINUSE")) {
      return null;
    }
    throw error;
  }
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

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

    const tokens = await resolveGoogleMeetAccessToken({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    });
    expect(tokens.accessToken).toBe("new-access-token");
    expect(tokens.refreshed).toBe(true);
    expect(Number.isFinite(tokens.expiresAt)).toBe(true);
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    const params = body as URLSearchParams;
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("refresh-token");
  });

  it("rejects oversized OAuth token responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(300 * 1024), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await expect(
      resolveGoogleMeetAccessToken({
        clientId: "client-id",
        refreshToken: "refresh-token",
      }),
    ).rejects.toThrow("Google OAuth token: JSON response exceeds 262144 bytes");
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

    const tokens = await resolveGoogleMeetAccessToken({
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

    const tokens = await resolveGoogleMeetAccessToken({
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

    const tokens = await resolveGoogleMeetAccessToken({
      clientId: "client-id",
      refreshToken: "refresh-token",
    });

    expect(tokens.expiresAt).toBe(Date.now());
  });

  it("falls back to manual paste when the local callback port is occupied", async () => {
    const blocker = await occupyPort(8085);
    try {
      const state = "state-token";
      const lines: string[] = [];
      const code = await waitForGoogleMeetAuthCode({
        state,
        manual: false,
        timeoutMs: 60_000,
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
        promptInput: async () =>
          `http://localhost:8085/oauth2callback?code=auth-code-123&state=${state}`,
        writeLine: (message) => lines.push(message),
      });
      expect(code).toBe("auth-code-123");
      expect(lines.some((line) => line.includes("Switching to manual mode"))).toBe(true);
    } finally {
      if (blocker) {
        await closeServer(blocker);
      }
    }
  });

  it("propagates non-listener callback failures without manual fallback", async () => {
    const promptInput = vi.fn(async () => "unused");
    await expect(
      waitForGoogleMeetAuthCode({
        state: "state-token",
        manual: false,
        timeoutMs: 1,
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
        promptInput,
        writeLine: () => {},
      }),
    ).rejects.toThrow(/timeout/i);
    expect(promptInput).not.toHaveBeenCalled();
  });
});
