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
  val sessions: List<WearSessionSummary> = emptyList(),
  val models: List<WearModelSummary> = emptyList(),
  val modelControlsSupported: Boolean = false,
  val messages: List<WearChatMessage> = emptyList(),
  val streamingAssistantText: String? = null,
  val pendingRunCount: Int = 0,
  val selectedModelRef: String? = null,
  val failure: WearConversationFailure? = null,
  val realtimeTalk: WearRealtimeTalkSnapshot = WearRealtimeTalkSnapshot(),
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
    sessions =
      sessions.map { session ->
        WearSessionSummary(
          id = session.key,
          title = session.title,
          updatedAtEpochMillis = session.updatedAt,
          selected = session.key == selectedSession?.key,
        )
      },
    models =
      models.map { model ->
        WearModelSummary(
          ref = model.ref,
          name = model.name,
          selected = model.ref == selectedModelRef,
        )
      },
    modelControlsSupported = WearProxyCapability.ModelControls in proxyCapabilities,
    messages = messages,
    streamingAssistantText = streamText,
    pendingRunCount = if (activeRunId != null) 1 else 0,
    selectedModelRef = selectedModelRef,
    failure = failure,
    realtimeTalk = realtimeTalk,
  )
}
