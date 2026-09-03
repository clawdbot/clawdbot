/** HTTP surface: `GET /plugins/geolocation/lookup?ip=<address>`. */
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import { isPrivateOrLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import type { GeolocationSettings } from "./config.js";
import type { GeolocationDatabase } from "./database-store.js";
import { projectGeolocationRecord } from "./lookup.js";

type RouteDeps = {
  loadDatabase: () => Promise<GeolocationDatabase>;
  settings: GeolocationSettings;
  logger?: { warn: (msg: string) => void };
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createGeolocationLookupHandler(deps: RouteDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.endsWith("/lookup")) {
      return false;
    }
    const ip = url.searchParams.get("ip")?.trim() ?? "";
    if (!net.isIP(ip)) {
      sendJson(res, 400, { error: "ip must be a valid IPv4 or IPv6 address" });
      return true;
    }
    // Private, loopback, link-local, and carrier-grade-NAT addresses are absent
    // from every geolocation database, so answering them here keeps a tailnet or
    // LAN-only deployment from ever downloading one.
    if (isPrivateOrLoopbackHost(ip)) {
      sendJson(res, 200, { found: false, attribution: deps.settings.attribution });
      return true;
    }
    try {
      const database = await deps.loadDatabase();
      const location = projectGeolocationRecord(database.lookup(ip));
      sendJson(res, 200, {
        found: Boolean(location),
        ...location,
        attribution: deps.settings.attribution,
      });
    } catch (err) {
      // A missing database is an availability problem, never a lookup answer:
      // reporting "not found" here would read as "this IP has no location".
      const message = err instanceof Error ? err.message : String(err);
      deps.logger?.warn(`geolocation: lookup unavailable: ${message}`);
      sendJson(res, 503, { error: "geolocation database unavailable" });
    }
    return true;
  };
}
