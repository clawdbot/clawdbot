import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import {
  createFixedNodeProxyAgentPair,
  resolveEnvNodeProxyUrlForTarget,
  UNSUPPORTED_PROXY_PROTOCOL_MESSAGE,
} from "../../infra/net/node-proxy-agent.js";

export interface NodeHttpProxyAgents {
  httpAgent: HttpAgent;
  httpsAgent: HttpsAgent;
}

export { UNSUPPORTED_PROXY_PROTOCOL_MESSAGE };

export function resolveHttpProxyUrlForTarget(targetUrl: string | URL): URL | undefined {
  return resolveEnvNodeProxyUrlForTarget(targetUrl);
}

export function createHttpProxyAgentsForTarget(
  targetUrl: string | URL,
): NodeHttpProxyAgents | undefined {
  const proxyUrl = resolveHttpProxyUrlForTarget(targetUrl);
  if (!proxyUrl) {
    return undefined;
  }

  return createFixedNodeProxyAgentPair(proxyUrl) as NodeHttpProxyAgents;
}
