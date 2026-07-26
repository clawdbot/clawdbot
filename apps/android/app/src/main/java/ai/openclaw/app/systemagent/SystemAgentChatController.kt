package ai.openclaw.app.systemagent

import ai.openclaw.app.gateway.GatewayMethod
import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.i18n.nativeString
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

internal data class SystemAgentGatewayAccess(
  val connected: Boolean,
  val hasAdminScope: Boolean,
  val supportsMethod: Boolean?,
  val gatewayId: String?,
)

enum class SystemAgentChatAccess {
  Disconnected,
  MissingAdminScope,
  CheckingGateway,
  GatewayUpdateRequired,
  Ready,
}

data class SystemAgentChatQuestionOption(
  val label: String,
  val description: String?,
  val reply: String?,
  val recommended: Boolean,
)

data class SystemAgentChatQuestion(
  val header: String,
  val question: String,
  val options: List<SystemAgentChatQuestionOption>,
)

data class SystemAgentChatMessage(
  val id: String = UUID.randomUUID().toString(),
  val role: Role,
  val text: String,
  val question: SystemAgentChatQuestion? = null,
) {
  enum class Role {
    Assistant,
    User,
  }
}

data class SystemAgentChatHandoff(
  val agentId: String?,
)

data class SystemAgentChatState(
  val access: SystemAgentChatAccess = SystemAgentChatAccess.Disconnected,
  val sessionId: String = newSystemAgentSessionId(),
  val messages: List<SystemAgentChatMessage> = emptyList(),
  val input: String = "",
  val sending: Boolean = false,
  val expectsSensitiveReply: Boolean = false,
  val errorText: String? = null,
  val dismissedQuestionIds: Set<String> = emptySet(),
  val retiredQuestionIds: Set<String> = emptySet(),
  val handoff: SystemAgentChatHandoff? = null,
)

private fun newSystemAgentSessionId(): String = "android-settings-openclaw-${UUID.randomUUID()}"

/**
 * Keeps the settings-only OpenClaw conversation outside ordinary chat/session state.
 * Every request captures a physical Gateway lease, so it cannot retarget a replacement connection.
 */
internal class SystemAgentChatController(
  private val scope: CoroutineScope,
  private val access: () -> SystemAgentGatewayAccess,
  private val captureLease: (gatewayId: String?) -> GatewaySession.RequestLease?,
  private val json: Json,
) {
  private val generation = AtomicLong(0)
  private var activeGatewayId: String? = null
  private var requestJob: Job? = null
  private val _state = MutableStateFlow(SystemAgentChatState())
  val state: StateFlow<SystemAgentChatState> = _state.asStateFlow()

  fun refresh(startIfNeeded: Boolean = true) {
    val next = access()
    val nextAccess = next.toChatAccess()
    val current = state.value
    val gatewayChanged = activeGatewayId != next.gatewayId
    if (gatewayChanged) {
      invalidateRequest()
      activeGatewayId = next.gatewayId
      _state.value = SystemAgentChatState(access = nextAccess)
    } else if (nextAccess == SystemAgentChatAccess.Ready) {
      _state.update { it.copy(access = nextAccess) }
    } else {
      val conversationStarted = current.messages.isNotEmpty() || current.sending || current.errorText != null
      if (current.sending) invalidateRequest()
      _state.update {
        it.copy(
          access = nextAccess,
          input = "",
          sending = false,
          expectsSensitiveReply =
            if (nextAccess == SystemAgentChatAccess.CheckingGateway) {
              it.expectsSensitiveReply
            } else {
              false
            },
          errorText =
            when {
              nextAccess == SystemAgentChatAccess.CheckingGateway -> it.errorText
              conversationStarted -> routeChangedMessage()
              else -> null
            },
          handoff = if (nextAccess == SystemAgentChatAccess.CheckingGateway) it.handoff else null,
        )
      }
    }

    val refreshed = state.value
    if (
      refreshed.access == SystemAgentChatAccess.Ready &&
      refreshed.messages.isEmpty() &&
      !refreshed.sending &&
      startIfNeeded &&
      refreshed.errorText == null &&
      refreshed.handoff == null
    ) {
      request(message = null)
    }
  }

  fun restart() {
    val next = access()
    if (next.toChatAccess() != SystemAgentChatAccess.Ready) {
      refresh()
      return
    }
    invalidateRequest()
    activeGatewayId = next.gatewayId
    _state.value = SystemAgentChatState(access = SystemAgentChatAccess.Ready)
    request(message = null)
  }

  fun setInput(value: String) {
    _state.update { current ->
      if (current.access == SystemAgentChatAccess.Ready && current.handoff == null) {
        current.copy(input = value)
      } else {
        current
      }
    }
  }

  fun clearInputForBackground() {
    _state.update { it.copy(input = "") }
  }

  fun sendInput() {
    val current = state.value
    if (current.input.trim().isEmpty()) return
    request(message = if (current.expectsSensitiveReply) current.input else current.input.trim())
  }

  fun answerQuestion(
    messageId: String,
    optionLabel: String,
  ) {
    val current = state.value
    val message = current.messages.firstOrNull { it.id == messageId } ?: return
    if (!current.canAnswer(message)) return
    val option = message.question?.options?.firstOrNull { it.label == optionLabel } ?: return
    request(message = option.reply ?: option.label, displayText = option.label)
  }

  fun skipQuestion(messageId: String) {
    val current = state.value
    val message = current.messages.firstOrNull { it.id == messageId } ?: return
    if (!current.canAnswer(message)) return
    request(
      message = "Skip for now",
      displayText = nativeString("Skip for now"),
      dismissedQuestionId = messageId,
    )
  }

  fun openHandoff(): SystemAgentChatHandoff? {
    val handoff = state.value.handoff ?: return null
    _state.update { it.copy(handoff = null) }
    return handoff
  }

  private fun request(
    message: String?,
    displayText: String? = null,
    dismissedQuestionId: String? = null,
  ) {
    val current = state.value
    if (
      current.access != SystemAgentChatAccess.Ready ||
      current.sending ||
      current.errorText != null ||
      current.handoff != null
    ) {
      return
    }
    val gateway = access()
    if (gateway.toChatAccess() != SystemAgentChatAccess.Ready || gateway.gatewayId != activeGatewayId) {
      refresh()
      return
    }
    val requestGeneration = generation.incrementAndGet()
    val lease = captureLease(gateway.gatewayId)
    if (lease == null) {
      markRouteChanged(requestGeneration)
      return
    }

    val retired =
      if (message == null) {
        current.retiredQuestionIds
      } else {
        current.retiredQuestionIds + current.messages.filter { it.question != null }.map { it.id }
      }
    val localMessage =
      message?.let {
        SystemAgentChatMessage(
          role = SystemAgentChatMessage.Role.User,
          text = displayText ?: if (current.expectsSensitiveReply) nativeString("<redacted secret>") else it,
        )
      }
    val admitted =
      lease.commitIfCurrent {
        if (!isCurrent(requestGeneration)) return@commitIfCurrent
        _state.update {
          it.copy(
            messages = if (localMessage == null) it.messages else it.messages + localMessage,
            input = "",
            sending = true,
            dismissedQuestionIds = it.dismissedQuestionIds + listOfNotNull(dismissedQuestionId),
            retiredQuestionIds = retired,
          )
        }
      }
    if (!admitted) {
      markRouteChanged(requestGeneration)
      return
    }
    if (!isCurrent(requestGeneration)) return

    requestJob =
      scope.launch {
        try {
          if (!isCurrent(requestGeneration) || !lease.isCurrent()) return@launch
          val payload =
            buildJsonObject {
              put("sessionId", JsonPrimitive(current.sessionId))
              message?.let { put("message", JsonPrimitive(it)) }
            }
          val response = lease.request(GatewayMethod.OpenclawChat.rawValue, payload.toString(), 190_000)
          if (!isCurrent(requestGeneration)) return@launch
          if (!lease.isCurrent()) {
            markRouteChanged(requestGeneration)
            return@launch
          }
          val result = parseResult(json.parseToJsonElement(response).jsonObject)
          if (!isCurrent(requestGeneration)) return@launch
          if (!lease.isCurrent()) {
            markRouteChanged(requestGeneration)
            return@launch
          }
          val committed =
            lease.commitIfCurrent {
              if (!isCurrent(requestGeneration)) return@commitIfCurrent
              _state.update {
                it.copy(
                  messages =
                    it.messages +
                      SystemAgentChatMessage(
                        role = SystemAgentChatMessage.Role.Assistant,
                        text = result.reply,
                        question = parseQuestion(result.question),
                      ),
                  sending = false,
                  expectsSensitiveReply = result.sensitive == true,
                  errorText = null,
                  handoff = if (result.action == "open-agent") SystemAgentChatHandoff(result.agentId) else null,
                )
              }
            }
          if (!committed) markRouteChanged(requestGeneration)
        } catch (err: CancellationException) {
          throw err
        } catch (_: GatewayRequestNotEnqueued) {
          markRouteChanged(requestGeneration)
        } catch (err: GatewayRequestRejected) {
          if (!isCurrent(requestGeneration)) return@launch
          val message =
            err.gatewayError.message
              .trim()
              .ifEmpty { nativeString("OpenClaw request failed.") }
          commitRequestError(requestGeneration, lease, message)
        } catch (_: Throwable) {
          if (!isCurrent(requestGeneration)) return@launch
          commitRequestError(requestGeneration, lease, nativeString("OpenClaw request failed."))
        }
      }
  }

  private fun commitRequestError(
    requestGeneration: Long,
    lease: GatewaySession.RequestLease,
    message: String,
  ) {
    val committed =
      lease.commitIfCurrent {
        if (!isCurrent(requestGeneration)) return@commitIfCurrent
        _state.update { it.copy(sending = false, errorText = message) }
      }
    if (!committed) markRouteChanged(requestGeneration)
  }

  private fun invalidateRequest() {
    generation.incrementAndGet()
    requestJob?.cancel()
    requestJob = null
  }

  private fun isCurrent(requestGeneration: Long): Boolean = generation.get() == requestGeneration

  private fun markRouteChanged(requestGeneration: Long? = null) {
    if (requestGeneration == null) {
      invalidateRequest()
    } else if (!generation.compareAndSet(requestGeneration, requestGeneration + 1)) {
      return
    }
    _state.update {
      it.copy(
        input = "",
        sending = false,
        expectsSensitiveReply = false,
        errorText = routeChangedMessage(),
        handoff = null,
      )
    }
  }

  private data class Result(
    val reply: String,
    val action: String,
    val sensitive: Boolean?,
    val agentId: String?,
    val question: JsonElement?,
  )

  private fun parseResult(root: JsonObject): Result =
    Result(
      reply = root["reply"]?.jsonPrimitive?.contentOrNull ?: "",
      action = root["action"]?.jsonPrimitive?.contentOrNull ?: "none",
      sensitive = root["sensitive"]?.jsonPrimitive?.booleanOrNull,
      agentId = root["agentId"]?.jsonPrimitive?.contentOrNull,
      question = root["question"],
    )

  private fun parseQuestion(value: JsonElement?): SystemAgentChatQuestion? {
    val root = value as? JsonObject ?: return null
    val header =
      root["header"]
        ?.jsonPrimitive
        ?.contentOrNull
        ?.trim()
        .orEmpty()
    val question =
      root["question"]
        ?.jsonPrimitive
        ?.contentOrNull
        ?.trim()
        .orEmpty()
    val options = root["options"] as? JsonArray ?: return null
    if (header.isEmpty() || question.isEmpty() || options.size !in 2..4) return null
    val parsed =
      options.mapNotNull { element ->
        val option = element as? JsonObject ?: return null
        val label =
          option["label"]
            ?.jsonPrimitive
            ?.contentOrNull
            ?.trim()
            .orEmpty()
        if (label.isEmpty()) return null
        SystemAgentChatQuestionOption(
          label = label,
          description =
            option["description"]
              ?.jsonPrimitive
              ?.contentOrNull
              ?.trim()
              ?.ifEmpty { null },
          reply =
            option["reply"]
              ?.jsonPrimitive
              ?.contentOrNull
              ?.trim()
              ?.ifEmpty { null },
          recommended = option["recommended"]?.jsonPrimitive?.booleanOrNull == true,
        )
      }
    if (parsed.size != options.size || parsed.map { it.label.lowercase() }.toSet().size != parsed.size) return null
    if (parsed.count { it.recommended } > 1) return null
    return SystemAgentChatQuestion(header = header, question = question, options = parsed)
  }
}

private fun SystemAgentChatState.canAnswer(message: SystemAgentChatMessage): Boolean =
  access == SystemAgentChatAccess.Ready &&
    !sending &&
    errorText == null &&
    handoff == null &&
    message.question != null &&
    message.id !in dismissedQuestionIds &&
    message.id !in retiredQuestionIds

private fun SystemAgentGatewayAccess.toChatAccess(): SystemAgentChatAccess =
  when {
    !connected -> SystemAgentChatAccess.Disconnected
    !hasAdminScope -> SystemAgentChatAccess.MissingAdminScope
    supportsMethod == null -> SystemAgentChatAccess.CheckingGateway
    !supportsMethod -> SystemAgentChatAccess.GatewayUpdateRequired
    else -> SystemAgentChatAccess.Ready
  }

private fun routeChangedMessage(): String = nativeString("The Gateway connection changed. Restart OpenClaw to reconnect.")
