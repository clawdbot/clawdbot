import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { resolveGeolocationSettings } from "./config.js";
import { createGeolocationLookupHandler } from "./lookup-route.js";

function fakeResponse() {
  const chunks: string[] = [];
  let status = 0;
  const res = {
    writeHead: (code: number) => {
      status = code;
      return res;
    },
    end: (body?: string) => {
      if (body) {
        chunks.push(body);
      }
    },
  };
  return {
    res: res as unknown as ServerResponse,
    get status() {
      return status;
    },
    get body() {
      return chunks.length > 0 ? JSON.parse(chunks.join("")) : undefined;
    },
  };
}

const settings = resolveGeolocationSettings(undefined);

describe("geolocation lookup route", () => {
  it("answers with the placement and the credit its license requires", async () => {
    const handler = createGeolocationLookupHandler({
      settings,
      loadDatabase: async () => ({
        lookup: () => ({
          city: { names: { en: "Vienna" } },
          subdivisions: [{ names: { en: "Vienna" } }],
          country: { iso_code: "AT", names: { en: "Austria" } },
        }),
      }),
    } as never);
    const out = fakeResponse();

    await handler({ url: "/plugins/geolocation/lookup?ip=203.0.113.7" } as never, out.res);

    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      found: true,
      city: "Vienna",
      country: "Austria",
      countryCode: "AT",
      attribution: { text: "IP Geolocation by DB-IP", url: "https://db-ip.com" },
    });
  });

  it("reports a database outage as an outage, never as a located-nowhere answer", async () => {
    const warn = vi.fn();
    const handler = createGeolocationLookupHandler({
      settings,
      logger: { warn },
      loadDatabase: async () => {
        throw new Error("download failed");
      },
    } as never);
    const out = fakeResponse();

    await handler({ url: "/plugins/geolocation/lookup?ip=203.0.113.7" } as never, out.res);

    expect(out.status).toBe(503);
    expect(out.body).not.toHaveProperty("found");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("distinguishes an address the database does not place from an outage", async () => {
    const handler = createGeolocationLookupHandler({
      settings,
      loadDatabase: async () => ({ lookup: () => null }),
    } as never);
    const out = fakeResponse();

    await handler({ url: "/plugins/geolocation/lookup?ip=203.0.113.7" } as never, out.res);

    expect(out.status).toBe(200);
    expect(out.body.found).toBe(false);
  });

  it("rejects a non-address instead of handing it to the database", async () => {
    const lookup = vi.fn();
    const handler = createGeolocationLookupHandler({
      settings,
      loadDatabase: async () => ({ lookup }),
    } as never);
    const out = fakeResponse();

    await handler({ url: "/plugins/geolocation/lookup?ip=not-an-ip" } as never, out.res);

    expect(out.status).toBe(400);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("answers unresolvable ranges without consulting the database", async () => {
    // A tailnet or LAN-only deployment must never trigger the download: CGNAT,
    // private, loopback, and link-local addresses are absent from every
    // geolocation database, so there is nothing to load.
    const loadDatabase = vi.fn();
    const handler = createGeolocationLookupHandler({ settings, loadDatabase } as never);

    for (const ip of ["100.64.1.5", "192.168.1.20", "10.0.0.4", "127.0.0.1", "169.254.1.1"]) {
      const out = fakeResponse();
      await handler({ url: `/plugins/geolocation/lookup?ip=${ip}` } as never, out.res);
      expect(out.status, ip).toBe(200);
      expect(out.body.found, ip).toBe(false);
    }

    expect(loadDatabase).not.toHaveBeenCalled();
  });

  it("still consults the database for a routable address", async () => {
    const loadDatabase = vi.fn(async () => ({ lookup: () => null }));
    const handler = createGeolocationLookupHandler({ settings, loadDatabase } as never);
    const out = fakeResponse();

    await handler({ url: "/plugins/geolocation/lookup?ip=8.8.8.8" } as never, out.res);

    expect(loadDatabase).toHaveBeenCalledOnce();
  });
});
