import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupClientGeolocation } from "./geolocation-lookup.ts";
import { setAvatarGatewayOrigin } from "./identity-avatar.ts";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("client geolocation lookup", () => {
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
    setAvatarGatewayOrigin("https://other-gateway.example.test", "Bearer other-token");
    await lookupClientGeolocation("203.0.113.17");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    setAvatarGatewayOrigin(null);
  });
});
