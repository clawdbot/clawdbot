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
});
