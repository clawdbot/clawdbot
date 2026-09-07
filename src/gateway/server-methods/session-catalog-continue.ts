import type {
  ErrorShape,
  SessionsCatalogContinueParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { bindPluginSessionConversation } from "../../plugins/session-conversation-binding.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { recordSessionStateEvent } from "../../sessions/session-state-events.js";
import { upsertSessionUpstreamLink } from "../../sessions/session-upstream-links.js";
import { copySessionCatalogToGateway } from "./session-catalog-gateway-copy.js";
import type { CatalogRegistrationSnapshot } from "./session-catalog-provider-access.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export async function continueAuthorizedSessionCatalog(params: {
  request: SessionsCatalogContinueParams;
  registration: CatalogRegistrationSnapshot["registrations"][number];
  agentId: string;
  allowProcessHomeFallback: boolean;
  client: GatewayClient | null;
  context: GatewayRequestContext;
  commitGuard?: () => void;
}): Promise<{ ok: true; sessionKey: string } | { ok: false; error: ErrorShape }> {
  const { catalogId: _catalogId, ...providerRequest } = params.request;
  // Fail closed for unscoped callers: providers gate high-authority
  // continues (e.g. node-executing bindings) on these scopes.
  const clientScopes = Array.isArray(params.client?.connect?.scopes)
    ? params.client.connect.scopes
    : [];
  const providerContinueParams = {
    ...providerRequest,
    agentId: params.agentId,
    allowProcessHomeFallback: params.allowProcessHomeFallback,
    clientScopes,
  };
  const provider = params.registration.provider;
  if (provider.copyToGatewaySession) {
    return await copySessionCatalogToGateway({
      request: params.request,
      provider,
      providerContinueParams,
      agentId: params.agentId,
      clientScopes,
      client: params.client,
      context: params.context,
      commitGuard: params.commitGuard,
    });
  }
  const continueSession = provider.continueSession;
  if (!continueSession) {
    throw new Error("catalog cannot continue this session");
  }
  const result = await continueSession(providerContinueParams);
  if (result.conversationBinding) {
    // operator.write on Continue is the approval boundary. Per-turn plugin and
    // node command authorization still applies after this binding is installed.
    await bindPluginSessionConversation({
      pluginId: params.registration.pluginId,
      pluginName: params.registration.pluginName,
      pluginRoot: params.registration.rootDir?.trim() || params.registration.source,
      sessionKey: result.sessionKey,
      binding: result.conversationBinding,
      afterBind: result.afterConversationBound,
    });
  }
  // Session creation canonicalizes the adopted key with its resolved agent,
  // including non-default agents. Use the returned key's owner for links and events.
  const agentId = resolveAgentIdFromSessionKey(result.sessionKey);
  if (result.upstream) {
    // Links exist only for adoptions made on this version: pre-upgrade adopted
    // sessions are transient linkage with no shipped contract, and re-continuing
    // from the catalog establishes the link. No doctor backfill by design.
    upsertSessionUpstreamLink({
      sessionKey: result.sessionKey,
      agentId,
      catalogId: params.request.catalogId,
      hostId: params.request.hostId,
      threadId: params.request.threadId,
      upstreamKind: result.upstream.kind,
      upstreamRef: result.upstream.ref,
      marker: result.upstream.marker,
    });
  }
  recordSessionStateEvent({
    sessionKey: result.sessionKey,
    agentId,
    kind: "adopted",
    actorType: "human",
    dedupeKey: `adopted:${result.sessionKey}`,
    summary: `adopted from ${params.request.catalogId}`,
    payload: { catalogId: params.request.catalogId, hostId: params.request.hostId },
  });
  return { ok: true, sessionKey: result.sessionKey };
}
