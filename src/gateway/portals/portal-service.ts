import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { TlsOptions } from "node:tls";
import type {
  PortalOpenResult,
  PortalSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import { listenGatewayHttpServer } from "../server/http-listen.js";
import { handlePortalProxyRequest, handlePortalProxyUpgrade } from "./portal-http-proxy.js";

const PORTAL_PORT_ALLOCATION_ATTEMPTS = 10;

type PortalEntry = {
  id: string;
  title: string;
  description?: string;
  path?: string;
  targetPort: number;
  token: string;
  listenPort: number;
  createdAtMs: number;
};

type PortalRuntimeEntry = {
  portal: PortalEntry;
  servers: HttpServer[];
  upgradedSockets: Set<Duplex>;
};

type GatewayPortalOpenParams = {
  targetPort: number;
  title?: string;
  description?: string;
  path?: string;
};

export type GatewayPortalService = {
  open: (params: GatewayPortalOpenParams) => Promise<PortalOpenResult>;
  list: () => PortalSummary[];
  close: (id: string) => Promise<void>;
  closeAll: () => Promise<void>;
};

function removeServers(shared: HttpServer[], owned: readonly HttpServer[]): void {
  for (const server of owned) {
    const index = shared.indexOf(server);
    if (index >= 0) {
      shared.splice(index, 1);
    }
  }
}

async function closeServers(servers: readonly HttpServer[]): Promise<void> {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
}

function formatPortalHost(host: string): string {
  const openableHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return openableHost.includes(":") ? `[${openableHost}]` : openableHost;
}

/** Creates the gateway-lifetime registry and per-portal transport listeners. */
export function createGatewayPortalService(params: {
  httpBindHosts: readonly string[];
  tlsOptions?: TlsOptions;
  httpServers: HttpServer[];
}): GatewayPortalService {
  const entries = new Map<string, PortalRuntimeEntry>();
  const operations = new Map<string, Promise<void>>();
  let closed = false;

  const summarize = (portal: PortalEntry): PortalOpenResult => {
    const host = params.httpBindHosts[0];
    if (!host) {
      throw new Error("Gateway listener must start before opening a portal");
    }
    const scheme = params.tlsOptions ? "https" : "http";
    const tokenQuery = `openclaw_portal=${portal.token}`;
    const publicUrl = `${scheme}://${formatPortalHost(host)}:${portal.listenPort}${portal.path ?? "/"}`;
    const openableUrl = new URL(publicUrl);
    openableUrl.searchParams.set("openclaw_portal", portal.token);
    return {
      id: portal.id,
      title: portal.title,
      port: portal.targetPort,
      listenPort: portal.listenPort,
      tokenQuery,
      url: openableUrl.toString(),
      publicUrl,
      ...(portal.path ? { path: portal.path } : {}),
      ...(portal.description ? { description: portal.description } : {}),
      createdAtMs: portal.createdAtMs,
    };
  };

  const serialize = async <T>(id: string, operation: () => Promise<T>): Promise<T> => {
    const previous = operations.get(id) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    operations.set(id, completion);
    try {
      return await result;
    } finally {
      if (operations.get(id) === completion) {
        operations.delete(id);
      }
    }
  };

  const closeEntry = async (id: string): Promise<void> => {
    const runtime = entries.get(id);
    if (!runtime) {
      return;
    }
    // Remove authority before asynchronous teardown so no request can rediscover a closing portal.
    entries.delete(id);
    removeServers(params.httpServers, runtime.servers);
    for (const socket of runtime.upgradedSockets) {
      socket.destroy();
    }
    runtime.upgradedSockets.clear();
    await closeServers(runtime.servers);
  };

  return {
    open: async (input) => {
      const id = `p${input.targetPort}`;
      return await serialize(id, async () => {
        if (closed) {
          throw new Error("portals unavailable");
        }
        const existing = entries.get(id);
        if (existing) {
          existing.portal.title = input.title?.trim() || existing.portal.title;
          if (input.description !== undefined) {
            existing.portal.description = input.description;
          }
          if (input.path !== undefined) {
            existing.portal.path = input.path;
          }
          return summarize(existing.portal);
        }
        if (params.httpBindHosts.length === 0) {
          throw new Error("Gateway listener must start before opening a portal");
        }

        const portal: PortalEntry = {
          id,
          title: input.title?.trim() || `Port ${input.targetPort}`,
          ...(input.description ? { description: input.description } : {}),
          ...(input.path ? { path: input.path } : {}),
          targetPort: input.targetPort,
          token: randomBytes(32).toString("hex"),
          listenPort: 0,
          createdAtMs: Date.now(),
        };
        const upgradedSockets = new Set<Duplex>();
        const handler = (
          req: import("node:http").IncomingMessage,
          res: import("node:http").ServerResponse,
        ) =>
          handlePortalProxyRequest({ req, res, target: portal, tls: Boolean(params.tlsOptions) });
        const servers = params.httpBindHosts.map(() =>
          params.tlsOptions
            ? createHttpsServer(params.tlsOptions, handler)
            : createHttpServer(handler),
        );
        for (const server of servers) {
          server.on("upgrade", (req, socket, head) =>
            handlePortalProxyUpgrade({ req, socket, head, target: portal, upgradedSockets }),
          );
        }
        // Registration precedes every bind so whole-gateway cleanup owns partial startup.
        params.httpServers.push(...servers);
        try {
          const primaryServer = servers[0];
          const primaryHost = params.httpBindHosts[0];
          if (!primaryServer || !primaryHost) {
            throw new Error("Missing primary portal HTTP server");
          }
          for (let attempt = 0; attempt < PORTAL_PORT_ALLOCATION_ATTEMPTS; attempt += 1) {
            await listenGatewayHttpServer({
              httpServer: primaryServer,
              bindHost: primaryHost,
              port: 0,
              retryEaddrinuse: false,
              serviceName: "portal",
              endpointScheme: params.tlsOptions ? "https" : "http",
            });
            const address = primaryServer.address() as AddressInfo | null;
            if (!address || typeof address === "string") {
              throw new Error("Portal listener failed to resolve its port");
            }
            if (address.port !== portal.targetPort) {
              portal.listenPort = address.port;
              break;
            }
            // A proxy cannot share its target port: it would dial itself and fail auth.
            await closeServers([primaryServer]);
          }
          if (portal.listenPort === 0) {
            throw new Error(
              `Portal listener repeatedly allocated target port ${portal.targetPort}`,
            );
          }
          for (const [index, host] of params.httpBindHosts.entries()) {
            if (index === 0) {
              continue;
            }
            const server = servers[index];
            if (!server) {
              throw new Error(`Missing portal HTTP server for bind host ${host}`);
            }
            await listenGatewayHttpServer({
              httpServer: server,
              bindHost: host,
              port: portal.listenPort,
              retryEaddrinuse: false,
              serviceName: "portal",
              endpointScheme: params.tlsOptions ? "https" : "http",
            });
          }
        } catch (error) {
          removeServers(params.httpServers, servers);
          await closeServers(servers);
          throw error;
        }
        entries.set(id, { portal, servers, upgradedSockets });
        return summarize(portal);
      });
    },
    list: () =>
      [...entries.values()]
        .map(({ portal }) => summarize(portal))
        .toSorted(
          (left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id),
        ),
    close: async (id) => {
      await serialize(id, () => closeEntry(id));
    },
    closeAll: async () => {
      closed = true;
      const ids = new Set([...entries.keys(), ...operations.keys()]);
      await Promise.all([...ids].map((id) => serialize(id, () => closeEntry(id))));
    },
  };
}
