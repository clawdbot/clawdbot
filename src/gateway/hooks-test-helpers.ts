// Gateway hook test fixtures.
// Builds resolved hook config and IncomingMessage-like requests for tests.
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { HooksConfigResolved } from "./hooks.js";

/** Creates the default resolved hook config used by gateway hook tests. */
export function createHooksConfig(): HooksConfigResolved {
  return {
    basePath: "/hooks",
    token: "hook-secret",
    maxBodyBytes: 1024,
    maxBodyBytesByPath: new Map(),
    mappings: [],
    agentPolicy: {
      defaultAgentId: "main",
      globalSessionStoreOwner: { kind: "none" },
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
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: params.remoteAddress ?? "127.0.0.1" });
  return Object.assign(new IncomingMessage(socket), {
    method: params.method ?? "GET",
    url: params.path,
    headers,
  });
}
