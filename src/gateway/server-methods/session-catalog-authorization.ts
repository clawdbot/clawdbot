import {
  ErrorCodes,
  errorShape,
  type SessionCatalogLocator,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import {
  allowProcessHomeFallback,
  createSessionCatalogRequestNodeSnapshot,
  listSessionCatalogProvider,
} from "./session-catalog-provider-access.js";
import {
  isSessionCatalogThreadVisible,
  resolveSessionCatalogVisibility,
} from "./session-catalog-visibility.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export async function authorizeSessionCatalogThread(params: {
  access: "read" | "mutate";
  agentId: string;
  client: GatewayClient | null;
  context: GatewayRequestContext;
  provider: SessionCatalogProvider;
  request: SessionCatalogLocator;
  respond: RespondFn;
}): Promise<{ allowProcessHomeFallback: boolean } | null> {
  const config = params.context.getRuntimeConfig();
  const allowHomeFallback = allowProcessHomeFallback(params.context.logGateway);
  const visibility = resolveSessionCatalogVisibility(params.client, config);
  const visible = await isSessionCatalogThreadVisible({
    access: params.access,
    allowProcessHomeFallback: allowHomeFallback,
    client: params.client,
    config,
    fallbackAgentId: params.agentId,
    hostId: params.request.hostId,
    list: (request) =>
      listSessionCatalogProvider(params.provider, { ...request, agentId: params.agentId }),
    listNodes: createSessionCatalogRequestNodeSnapshot(),
    ...(params.request.sourceHomeId ? { sourceHomeId: params.request.sourceHomeId } : {}),
    threadId: params.request.threadId,
    visibility,
  });
  if (visible) {
    return { allowProcessHomeFallback: allowHomeFallback };
  }
  params.respond(
    false,
    undefined,
    errorShape(ErrorCodes.FORBIDDEN, "session catalog thread is not visible to this caller"),
  );
  return null;
}
