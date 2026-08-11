package ai.openclaw.app.chat

import ai.openclaw.app.resolveAgentIdFromMainSessionKey

/** Identifies the gateway chat that owns transient composer state and async results. */
internal data class ChatComposerOwner(
  val gatewayStableId: String?,
  val agentId: String,
  val sessionKey: String,
  val routingVerified: Boolean = true,
)

/** Last routing owner proven for one gateway, retained while that gateway reconnects. */
internal data class GatewayDefaultAgentOwner(
  val gatewayStableId: String,
  val agentId: String,
)

internal fun resolveGatewayDefaultAgentId(
  gatewayStableId: String?,
  gatewayDefaultAgentId: String?,
  lastVerifiedOwner: GatewayDefaultAgentOwner?,
): String? =
  gatewayDefaultAgentId?.trim()?.takeIf { it.isNotEmpty() }
    ?: lastVerifiedOwner
      ?.takeIf { it.gatewayStableId == gatewayStableId }
      ?.agentId

internal fun resolveChatComposerOwner(
  gatewayStableId: String?,
  gatewayDefaultAgentId: String?,
  lastVerifiedOwner: GatewayDefaultAgentOwner? = null,
  sessionKey: String,
  mainSessionKey: String,
): ChatComposerOwner {
  val effectiveSessionKey = sessionKey.trim().ifEmpty { mainSessionKey.trim().ifEmpty { "main" } }
  val explicitAgentId = resolveAgentIdFromMainSessionKey(effectiveSessionKey)
  val effectiveDefaultAgentId = resolveGatewayDefaultAgentId(gatewayStableId, gatewayDefaultAgentId, lastVerifiedOwner)
  return ChatComposerOwner(
    gatewayStableId = gatewayStableId,
    agentId = explicitAgentId ?: effectiveDefaultAgentId ?: "main",
    sessionKey = effectiveSessionKey,
    routingVerified = explicitAgentId != null || effectiveDefaultAgentId != null,
  )
}

/** Returns an owner only when routing can be proven from the session key or gateway hello. */
internal fun resolveChatComposerRoutingOwner(
  gatewayStableId: String?,
  gatewayDefaultAgentId: String?,
  sessionKey: String,
  mainSessionKey: String,
): ChatComposerOwner? {
  val effectiveSessionKey = sessionKey.trim().ifEmpty { mainSessionKey.trim().ifEmpty { "main" } }
  val agentId =
    resolveAgentIdFromMainSessionKey(effectiveSessionKey)
      ?: gatewayDefaultAgentId?.trim()?.takeIf(String::isNotEmpty)
      ?: return null
  return ChatComposerOwner(
    gatewayStableId = gatewayStableId,
    agentId = agentId,
    sessionKey = effectiveSessionKey,
    routingVerified = true,
  )
}
