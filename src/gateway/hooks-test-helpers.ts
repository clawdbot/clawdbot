// Gateway hook test fixtures.
// Builds resolved hook config and IncomingMessage-like requests for tests.
import type { IncomingMessage } from "node:http";
import type { HooksConfigResolved } from "./hooks.js";

/** Creates the default resolved hook config used by gateway hook tests. */
export function createHooksConfig(): HooksConfigResolved {
  return {
    basePath: "/hooks",
    token: "hook-secret",
    maxBodyBytes: 1024,
    mappings: [],
    agentPolicy: {
      defaultAgentId: "main",
      knownAgentIds: new Set(["main"]),
      allowedAgentIds: undefined,
    },
    sessionPolicy: {
      allowRequestSessionKey: false,
      defaultSessionKey: undefined,
      allowedSessionKeyPrefixes: undefined,
    },
  };
}

/** Builds an IncomingMessage-shaped request for hook handler tests. */
export function createGatewayRequest(params: {
  path: string;
  authorization?: string;
  method?: string;
  remoteAddress?: string;
  host?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const headers: Record<string, string> = {
    host: params.host ?? "localhost:18789",
    ...params.headers,
  };
  if (params.authorization) {
    headers.authorization = params.authorization;
  }
  return {
    method: params.method ?? "GET",
    url: params.path,
    headers,
    socket: { remoteAddress: params.remoteAddress ?? "127.0.0.1" },
  } as IncomingMessage;
}
