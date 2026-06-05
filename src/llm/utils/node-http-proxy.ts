// Node HTTP proxy helpers build HTTP(S) agents from proxy settings.
import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import {
  createFixedNodeProxyAgentPair,
  resolveEnvNodeProxyUrlForTarget,
  UNSUPPORTED_PROXY_PROTOCOL_MESSAGE,
} from "../../infra/net/node-proxy-agent.js";

/** HTTP(S) agent pair for Node fetch/client integrations that accept explicit agents. */
export interface NodeHttpProxyAgents {
  httpAgent: HttpAgent;
  httpsAgent: HttpsAgent;
}

export { UNSUPPORTED_PROXY_PROTOCOL_MESSAGE };

/** Resolves the environment proxy URL that applies to a target URL. */
export function resolveHttpProxyUrlForTarget(targetUrl: string | URL): URL | undefined {
  return resolveEnvNodeProxyUrlForTarget(targetUrl);
}

/** Builds fixed HTTP and HTTPS proxy agents for a target URL, when env proxy config applies. */
export function createHttpProxyAgentsForTarget(
  targetUrl: string | URL,
): NodeHttpProxyAgents | undefined {
  const proxyUrl = resolveHttpProxyUrlForTarget(targetUrl);
  if (!proxyUrl) {
    return undefined;
  }

  return createFixedNodeProxyAgentPair(proxyUrl) as NodeHttpProxyAgents;
}
