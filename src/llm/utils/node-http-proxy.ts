// Node HTTP proxy helpers build HTTP(S) agents from proxy settings.
import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import {
  createFixedNodeProxyAgentPair,
  resolveEnvNodeProxyUrlForTarget,
} from "../../infra/net/node-proxy-agent.js";

/** HTTP(S) agent pair for Node fetch/client integrations that accept explicit agents. */
interface NodeHttpProxyAgents {
  httpAgent: HttpAgent;
  httpsAgent: HttpsAgent;
}

/** Builds fixed HTTP and HTTPS proxy agents for a target URL, when env proxy config applies. */
export function createHttpProxyAgentsForTarget(
  targetUrl: string | URL,
): NodeHttpProxyAgents | undefined {
  const proxyUrl = resolveEnvNodeProxyUrlForTarget(targetUrl);
  if (!proxyUrl) {
    return undefined;
  }

  return createFixedNodeProxyAgentPair(proxyUrl) as NodeHttpProxyAgents;
}
