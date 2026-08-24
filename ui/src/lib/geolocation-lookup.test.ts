import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupClientGeolocation } from "./geolocation-lookup.ts";

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
      city: "Vienna",
      region: "Vienna",
      country: "Austria",
      attribution: { text: "IP Geolocation by DB-IP", url: "https://db-ip.com" },
    });
  });

  it("resolves to null when the plugin is absent or its database is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "unavailable" }, false)),
    );
    await expect(lookupClientGeolocation("203.0.113.11")).resolves.toBeNull();
  });

  it("resolves to null rather than rejecting when the request fails outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(lookupClientGeolocation("203.0.113.12")).resolves.toBeNull();
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

    await expect(lookupClientGeolocation("203.0.113.14")).resolves.toEqual({ city: "Vienna" });
  });
});
