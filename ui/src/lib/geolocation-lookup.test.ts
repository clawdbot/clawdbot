import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { lookupClientGeolocation } from "./geolocation-lookup.ts";
import { setAvatarGatewayOrigin } from "./identity-avatar-context.ts";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => body } as Response;
}

afterEach(() => {
  setAvatarGatewayOrigin(null);
  vi.unstubAllGlobals();
});

describe("client geolocation lookup", () => {
  it.each([401, 403])(
    "recovers a rejected credential (%s) with the saved password",
    async (status) => {
      setAvatarGatewayOrigin("https://gateway.example.test", ["device-token", "saved-password"]);
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(jsonResponse({ found: true, city: "Vienna" }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(lookupClientGeolocation("203.0.113.18")).resolves.toEqual({
        status: "located",
        location: { city: "Vienna" },
      });
      expect(fetchMock.mock.calls.map((call) => call[1]?.headers)).toEqual([
        { Authorization: "Bearer device-token" },
        { Authorization: "Bearer saved-password" },
      ]);
    },
  );

  it("keeps the new Gateway's cached answer when an old request finishes late", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["device-token", "old-password"]);
    const oldRequest = createDeferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValue(jsonResponse({ found: true, city: "Vienna" }));
    vi.stubGlobal("fetch", fetchMock);
    const oldLookup = lookupClientGeolocation("203.0.113.19");
    setAvatarGatewayOrigin("https://gateway.example.test", ["device-token", "new-password"]);
    const currentLookup = lookupClientGeolocation("203.0.113.19");
    await expect(currentLookup).resolves.toEqual({
      status: "located",
      location: { city: "Vienna" },
    });
    oldRequest.resolve(new Response(null, { status: 401 }));
    await expect(oldLookup).resolves.toEqual({ status: "unavailable" });
    await lookupClientGeolocation("203.0.113.19");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the placement and its attribution", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          found: true,
          city: "Vienna",
          region: "Vienna",
          country: "Austria",
          attribution: { text: "IP Geolocation by DB-IP", url: "https://db-ip.com" },
        }),
      ),
    );

    await expect(lookupClientGeolocation("203.0.113.10")).resolves.toEqual({
      status: "located",
      location: {
        city: "Vienna",
        region: "Vienna",
        country: "Austria",
        attribution: { text: "IP Geolocation by DB-IP", url: "https://db-ip.com" },
      },
    });
  });

  it("reports an unavailable database as retryable rather than as a placement", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "unavailable" }, false)),
    );
    await expect(lookupClientGeolocation("203.0.113.11")).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("reports a failed request as unavailable rather than rejecting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(lookupClientGeolocation("203.0.113.12")).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("shares one request across repeat lookups of the same address", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ found: true, city: "Vienna" }));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      lookupClientGeolocation("203.0.113.13"),
      lookupClientGeolocation("203.0.113.13"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops an attribution that is missing its link so no bare credit renders", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ found: true, city: "Vienna", attribution: { text: "Data by X" } }),
      ),
    );

    await expect(lookupClientGeolocation("203.0.113.14")).resolves.toEqual({
      status: "located",
      location: { city: "Vienna" },
    });
  });

  it("does not cache an unavailable answer, so a later attempt can still succeed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "downloading" }, false))
      .mockResolvedValueOnce(jsonResponse({ found: true, city: "Vienna" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(lookupClientGeolocation("203.0.113.15")).resolves.toEqual({
      status: "unavailable",
    });
    await expect(lookupClientGeolocation("203.0.113.15")).resolves.toEqual({
      status: "located",
      location: { city: "Vienna" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps caching definitive not-found answers", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ found: false }));
    vi.stubGlobal("fetch", fetchMock);

    await lookupClientGeolocation("203.0.113.16");
    await expect(lookupClientGeolocation("203.0.113.16")).resolves.toEqual({ status: "absent" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops cached placements when the Gateway context changes", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ found: true, city: "Vienna" }));
    vi.stubGlobal("fetch", fetchMock);

    await lookupClientGeolocation("203.0.113.17");
    setAvatarGatewayOrigin("https://other-gateway.example.test", ["other-token"]);
    await lookupClientGeolocation("203.0.113.17");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    setAvatarGatewayOrigin(null);
  });
});
