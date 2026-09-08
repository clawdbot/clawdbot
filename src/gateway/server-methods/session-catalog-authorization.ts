import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionCatalogLocator,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
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

export async function authorizeSessionCatalogRequest(params: {
  access: "read" | "mutate";
  request: SessionCatalogLocator & { agentId?: string };
  provider: SessionCatalogProvider;
  respond: RespondFn;
  context: GatewayRequestContext;
  client: GatewayClient | null;
}): Promise<
  | ({ agentId: string } & NonNullable<Awaited<ReturnType<typeof authorizeSessionCatalogThread>>>)
  | null
> {
  const resolvedAgent = resolveAgentIdOrRespondError({
    rawAgentId: params.request.agentId,
    respond: params.respond,
    cfg: params.context.getRuntimeConfig(),
    normalize: normalizeOptionalString,
  });
  if (!resolvedAgent) {
    return null;
  }
  const authorization = await authorizeSessionCatalogThread({
    access: params.access,
    agentId: resolvedAgent.agentId,
    client: params.client,
    context: params.context,
    provider: params.provider,
    request: params.request,
    respond: params.respond,
  });
  return authorization ? { agentId: resolvedAgent.agentId, ...authorization } : null;
}

export async function authorizeSessionCatalogThread(params: {
  access: "read" | "mutate";
  agentId: string;
  client: GatewayClient | null;
  context: GatewayRequestContext;
  provider: SessionCatalogProvider;
  request: SessionCatalogLocator;
  respond: RespondFn;
}): Promise<{
  allowProcessHomeFallback: boolean;
  revalidateBeforePublish?: () => Promise<boolean>;
} | null> {
  const allowHomeFallback = allowProcessHomeFallback(params.context.logGateway);
  const visible = await isSessionCatalogThreadVisible({
    access: params.access,
    allowProcessHomeFallback: allowHomeFallback,
    audience: params.provider.audience,
    client: params.client,
    getConfig: () => params.context.getRuntimeConfig(),
    fallbackAgentId: params.agentId,
    hostId: params.request.hostId,
    list: (request) =>
      listSessionCatalogProvider(params.provider, { ...request, agentId: params.agentId }),
    listNodes: createSessionCatalogRequestNodeSnapshot(),
    ...(params.request.sourceHomeId ? { sourceHomeId: params.request.sourceHomeId } : {}),
    threadId: params.request.threadId,
  });
  if (visible) {
    const visibility = resolveSessionCatalogVisibility(
      params.client,
      params.context.getRuntimeConfig(),
    );
    const requiresReadRevalidation =
      params.access === "read" &&
      visibility.kind === "restricted-unprofiled" &&
      visibility.gatewayOwner &&
      typeof params.provider.audience === "object" &&
      params.provider.audience.kind === "gateway-owner-local";
    return {
      allowProcessHomeFallback: allowHomeFallback,
      ...(requiresReadRevalidation
        ? {
            revalidateBeforePublish: async () =>
              Boolean(await authorizeSessionCatalogThread(params)),
          }
        : {}),
    };
  }
  params.respond(
    false,
    undefined,
    errorShape(ErrorCodes.FORBIDDEN, "session catalog thread is not visible to this caller"),
  );
  return null;
}
