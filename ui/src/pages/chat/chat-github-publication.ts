import type { SessionGitHubPublicationResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { generateUUID } from "../../lib/uuid.ts";

export async function requestGitHubPublication(
  client: Pick<GatewayBrowserClient, "request">,
  params: { sessionKey: string; branch?: string },
): Promise<SessionGitHubPublicationResult> {
  return await client.request<SessionGitHubPublicationResult>("sessions.github.publish", {
    sessionKey: params.sessionKey,
    idempotencyKey: generateUUID(),
    ...(params.branch ? { title: `Publish ${params.branch}` } : {}),
  });
}
