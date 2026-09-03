package ai.openclaw.wear

import ai.openclaw.wear.shared.WearProxyCapability
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot

internal enum class WearGatewayState {
  CONNECTED,
  DISCONNECTED,
}

internal enum class WearChatRole {
  USER,
  ASSISTANT,
  SYSTEM,
}

internal val WearChatMessage.chatRole: WearChatRole
  get() =
    when (role.lowercase()) {
      "user" -> WearChatRole.USER
      "assistant" -> WearChatRole.ASSISTANT
      else -> WearChatRole.SYSTEM
    }

internal data class WearAgentSummary(
  val id: String,
  val name: String,
  val emoji: String?,
  val selected: Boolean,
)

internal data class WearSessionSummary(
  val id: String,
  val title: String?,
  val updatedAtEpochMillis: Long?,
  val selected: Boolean,
  val activeOnPhone: Boolean = false,
  val openOnWatch: Boolean = false,
)

internal data class WearModelSummary(
  val ref: String,
  val name: String,
  val selected: Boolean,
)

internal data class WearConversationSnapshot(
  val gatewayState: WearGatewayState,
  val activeAgentId: String? = null,
  val agents: List<WearAgentSummary> = emptyList(),
  val agentControlsSupported: Boolean = false,
  val gatewayControlsSupported: Boolean = false,
  val activeSessionId: String? = null,
  val phoneActiveSessionId: String? = null,
  val sessions: List<WearSessionSummary> = emptyList(),
  val sessionSearchQuery: String? = null,
  val sessionSearchResults: List<WearSessionSummary> = emptyList(),
  val sessionSearchHasMore: Boolean = false,
  val sessionSearchSupported: Boolean = false,
  val models: List<WearModelSummary> = emptyList(),
  val modelSearchQuery: String? = null,
  val modelSearchResults: List<WearModelSummary> = emptyList(),
  val modelControlsSupported: Boolean = false,
  val modelSearchSupported: Boolean = false,
  val messages: List<WearChatMessage> = emptyList(),
  val streamingAssistantText: String? = null,
  val pendingRunCount: Int = 0,
  val selectedModelRef: String? = null,
  val failure: WearConversationFailure? = null,
  val realtimeTalk: WearRealtimeTalkSnapshot = WearRealtimeTalkSnapshot(),
  val agentPulseSupported: Boolean = false,
  val agentPulse: WearAgentPulseSnapshot? = null,
  val agentPulseLoading: Boolean = false,
  val agentPulseFailure: WearConversationFailure? = null,
)

internal enum class WearConversationFailure {
  PHONE_UNAVAILABLE,
  PHONE_NOT_READY,
  GATEWAY_OFFLINE,
  NOT_FOUND,
  ACTION_REJECTED,
  INCOMPATIBLE,
  INTERNAL_ERROR,
}

internal enum class WearInteractionState {
  READY,
  LISTENING,
  TYPING,
  SENDING,
  AGENT_WORKING,
  ERROR,
}

internal fun WearUiState.toConversationSnapshot(): WearConversationSnapshot? {
  if (phoneNodeId == null) return null
  val pulseSupported =
    connected &&
      WearProxyCapability.AgentPulse in proxyCapabilities
  return WearConversationSnapshot(
    gatewayState = if (connected) WearGatewayState.CONNECTED else WearGatewayState.DISCONNECTED,
    activeAgentId = activeAgentId,
    agents =
      agents.map { agent ->
        WearAgentSummary(
          id = agent.id,
          name = agent.name,
          emoji = agent.emoji,
          selected = agent.id == activeAgentId,
        )
      },
    agentControlsSupported = WearProxyCapability.AgentControls in proxyCapabilities,
    gatewayControlsSupported = WearProxyCapability.GatewayControls in proxyCapabilities,
    activeSessionId = selectedSession?.key,
    phoneActiveSessionId = phoneActiveSessionKey,
    sessions =
      sessions.map { session ->
        WearSessionSummary(
          id = session.key,
          title = session.title,
          updatedAtEpochMillis = session.updatedAt,
          selected = session.key == selectedSession?.key,
          activeOnPhone = session.key == phoneActiveSessionKey,
          openOnWatch = session.key == selectedSession?.key,
        )
      },
    sessionSearchQuery = sessionSearchQuery,
    sessionSearchResults =
      sessionSearchResults.map { session ->
        WearSessionSummary(
          id = session.key,
          title = session.title,
          updatedAtEpochMillis = session.updatedAt,
          selected = session.key == selectedSession?.key,
          activeOnPhone = session.key == phoneActiveSessionKey,
          openOnWatch = session.key == selectedSession?.key,
        )
      },
    sessionSearchHasMore = sessionSearchHasMore,
    sessionSearchSupported = WearProxyCapability.SessionSearchPagination in proxyCapabilities,
    models =
      models.map { model ->
        WearModelSummary(
          ref = model.ref,
          name = model.name,
          selected = model.ref == selectedModelRef,
        )
      },
    modelControlsSupported = WearProxyCapability.ModelControls in proxyCapabilities,
    modelSearchSupported = WearProxyCapability.ModelCatalogSearch in proxyCapabilities,
    modelSearchQuery = modelSearchQuery,
    modelSearchResults =
      modelSearchResults.map { model ->
        WearModelSummary(
          ref = model.ref,
          name = model.name,
          selected = model.ref == selectedModelRef,
        )
      },
    messages = messages,
    streamingAssistantText = streamText,
    pendingRunCount = if (activeRunId != null) 1 else 0,
    selectedModelRef = selectedModelRef,
    failure = failure,
    realtimeTalk = realtimeTalk,
    agentPulseSupported = pulseSupported,
    agentPulse = agentPulse.takeIf { pulseSupported },
    agentPulseLoading = pulseSupported && agentPulseLoading,
    agentPulseFailure = agentPulseFailure.takeIf { pulseSupported },
  )
}
