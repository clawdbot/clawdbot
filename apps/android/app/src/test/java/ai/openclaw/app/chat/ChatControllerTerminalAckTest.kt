package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatControllerTerminalAckTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun composerOwnerMustMatchBeforeSendAdmission() =
    runTest {
      val requestedMethods = mutableListOf<String>()
      var defaultAgentId: String? = "main"
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            requestedMethods += method
            """{"runId":"run-started","status":"started"}"""
          },
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
          currentDefaultAgentId = { defaultAgentId },
        )
      controller.handleGatewayEvent("health", null)
      val ambiguousOwner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")
      assertFalse(controller.canSendForOwner(ambiguousOwner))
      assertFalse(
        controller.sendMessageForOwnerAwaitAcceptance(
          message = "unbound main alias",
          thinkingLevel = "off",
          attachments = emptyList(),
          expectedOwner = ambiguousOwner,
        ),
      )
      controller.prepareMainSessionKey("agent:main:node-test")
      controller.handleGatewayEvent("health", null)
      val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:node-test")
      assertTrue(controller.canSendForOwner(owner))
      assertFalse(controller.canSendForOwner(owner.copy(gatewayStableId = "gateway-b")))

      assertFalse(
        controller.sendMessageForOwnerAwaitAcceptance(
          message = "wrong gateway",
          thinkingLevel = "off",
          attachments = emptyList(),
          expectedOwner = owner.copy(gatewayStableId = "gateway-b"),
        ),
      )
      assertFalse(
        controller.sendMessageForOwnerAwaitAcceptance(
          message = "wrong session",
          thinkingLevel = "off",
          attachments = emptyList(),
          expectedOwner = owner.copy(sessionKey = "agent:other:main", agentId = "other"),
        ),
      )
      assertTrue(
        controller.sendMessageForOwnerAwaitAcceptance(
          message = "correct owner",
          thinkingLevel = "off",
          attachments = emptyList(),
          expectedOwner = owner,
        ),
      )
      assertEquals(1, requestedMethods.count { it == "chat.send" })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun composerOwnerIsRecheckedAfterPendingSettingsComplete() =
    runTest {
      val settingsStarted = CompletableDeferred<Unit>()
      val settingsGate = CompletableDeferred<Unit>()
      var defaultAgentId: String? = "main"
      var sendCount = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "sessions.patch" -> {
                settingsStarted.complete(Unit)
                settingsGate.await()
                "{}"
              }
              "chat.send" -> {
                sendCount += 1
                """{"runId":"run-started","status":"started"}"""
              }
              else -> "{}"
            }
          },
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
          currentDefaultAgentId = { defaultAgentId },
        )
      controller.prepareMainSessionKey("agent:main:node-test")
      controller.handleGatewayEvent("health", null)
      controller.setThinkingLevel("high")
      settingsStarted.await()

      val accepted =
        async {
          controller.sendMessageForOwnerAwaitAcceptance(
            message = "stale after settings",
            thinkingLevel = "high",
            attachments = emptyList(),
            expectedOwner =
              ChatComposerOwner(
                gatewayStableId = "gateway-a",
                agentId = "main",
                sessionKey = "agent:main:node-test",
              ),
          )
        }
      runCurrent()
      controller.switchSession("agent:other:main")
      settingsGate.complete(Unit)

      assertFalse(accepted.await())
      assertEquals(0, sendCount)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun unjournaledNotEnqueuedSendRemainsRejectedAfterOwnerChange() =
    runTest {
      val requestGate = CompletableDeferred<Unit>()
      var defaultAgentId: String? = "main"
      var defaultAgentRevision = 0L
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method == "chat.send") {
              requestGate.await()
              throw GatewayRequestNotEnqueued("not enqueued")
            }
            "{}"
          },
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
          currentDefaultAgentId = { defaultAgentId },
          currentDefaultAgentRevision = { defaultAgentRevision },
        )
      controller.prepareMainSessionKey("agent:main:node-test")
      controller.handleGatewayEvent("health", null)

      val accepted =
        async {
          controller.sendMessageForOwnerAwaitAcceptance(
            message = "keep my draft",
            thinkingLevel = "off",
            attachments = emptyList(),
            expectedOwner =
              ChatComposerOwner(
                gatewayStableId = "gateway-a",
                agentId = "main",
                sessionKey = "agent:main:node-test",
              ),
          )
        }
      runCurrent()
      controller.switchSession("agent:other:main")
      requestGate.complete(Unit)

      assertFalse(accepted.await())
      assertEquals(0, controller.pendingRunCount.value)
      assertTrue(controller.messages.value.none { message -> message.content.any { it.text == "keep my draft" } })
      assertNull(controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun terminalTimeoutAckRemovesOptimisticUserEchoAndSurfacesFailedAcceptance() =
    runTest {
      var requestedMethod: String? = null
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            requestedMethod = method
            """{"runId":"run-timeout","status":"timeout"}"""
          },
          currentDefaultAgentId = { "main" },
        )
      controller.handleGatewayEvent("health", null)

      val accepted =
        controller.sendMessageAwaitAcceptance(
          message = "message that times out before start",
          thinkingLevel = "off",
          attachments = emptyList(),
        )

      assertFalse(accepted)
      assertEquals("chat.send", requestedMethod)
      assertEquals(0, controller.pendingRunCount.value)
      assertEquals("Chat failed before the run started; try again.", controller.errorText.value)
      assertFalse(controller.messages.value.hasUserText("message that times out before start"))
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun nonTerminalStartedAckRetainsOptimisticUserEchoAndPendingRun() =
    runTest {
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> """{"runId":"run-started","status":"started"}""" },
          currentDefaultAgentId = { "main" },
        )
      controller.handleGatewayEvent("health", null)

      val accepted =
        controller.sendMessageAwaitAcceptance(
          message = "message that started",
          thinkingLevel = "off",
          attachments = emptyList(),
        )

      assertTrue(accepted)
      assertEquals(1, controller.pendingRunCount.value)
      assertNull(controller.errorText.value)
      assertTrue(controller.messages.value.hasUserText("message that started"))
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun canonicalAckRunIdPreservesClientHistoryIdentity() =
    runTest {
      var clientRunId: String? = null
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            when (method) {
              "chat.send" -> {
                clientRunId =
                  requireNotNull(paramsJson)
                    .let(json::parseToJsonElement)
                    .jsonObject["idempotencyKey"]
                    ?.jsonPrimitive
                    ?.content
                """{"runId":"canonical-run","status":"started"}"""
              }
              "chat.history" ->
                historyResponse(
                  "session-1",
                  listOf(
                    ReplayHistoryMessage("user", "canonical", 1_000, idempotencyKey = "$clientRunId:user"),
                    ReplayHistoryMessage("assistant", "done", 2_000),
                  ),
                )
              else -> "{}"
            }
          },
          currentDefaultAgentId = { "main" },
        )
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("canonical", "off", emptyList()))
      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", "canonical-run", seq = 2, assistantText = "done"),
      )
      advanceUntilIdle()

      assertEquals(0, controller.pendingRunCount.value)
      assertEquals(1, controller.messages.value.count { it.role == "user" })
      assertEquals(
        "$clientRunId:user",
        controller.messages.value
          .single { it.role == "user" }
          .idempotencyKey,
      )
      assertNull(controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun terminalOkAckClearsOptimisticUserEchoAndRefreshesHistory() =
    runTest {
      val requestedMethods = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            requestedMethods += method
            when (method) {
              "chat.send" -> """{"runId":"run-ok","status":"ok"}"""
              "chat.history" ->
                """
                {
                  "sessionId": "session-1",
                  "messages": [
                    { "role": "assistant", "content": "cached success reply", "timestamp": 1 }
                  ]
                }
                """.trimIndent()
              else -> "{}"
            }
          },
          currentDefaultAgentId = { "main" },
        )
      controller.handleGatewayEvent("health", null)

      val accepted =
        controller.sendMessageAwaitAcceptance(
          message = "message that already completed",
          thinkingLevel = "off",
          attachments = emptyList(),
        )
      advanceUntilIdle()

      assertTrue(accepted)
      assertEquals(
        listOf("chat.send", "chat.history"),
        requestedMethods.filter { method -> method == "chat.send" || method == "chat.history" },
      )
      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.errorText.value)
      assertFalse(controller.messages.value.hasUserText("message that already completed"))
      assertTrue(controller.messages.value.any { message -> message.role == "assistant" && message.content.any { part -> part.text == "cached success reply" } })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun terminalErrorAckRemovesOptimisticUserEchoAndSurfacesErrorText() =
    runTest {
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> """{"runId":"run-error","status":"error"}""" },
          currentDefaultAgentId = { "main" },
        )
      controller.handleGatewayEvent("health", null)

      val accepted =
        controller.sendMessageAwaitAcceptance(
          message = "message that errors before start",
          thinkingLevel = "off",
          attachments = emptyList(),
        )

      assertFalse(accepted)
      assertEquals(0, controller.pendingRunCount.value)
      assertEquals("Chat failed before the run started; try again.", controller.errorText.value)
      assertFalse(controller.messages.value.hasUserText("message that errors before start"))
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun definitiveRpcRejectionRestoresComposerOwnership() =
    runTest {
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ ->
            throw GatewayRequestRejected(GatewaySession.ErrorShape("INVALID_REQUEST", "message rejected"))
          },
          currentDefaultAgentId = { "main" },
        )
      controller.handleGatewayEvent("health", null)

      val accepted = controller.sendMessageAwaitAcceptance("rejected", "off", emptyList())

      assertFalse(accepted)
      assertEquals(0, controller.pendingRunCount.value)
      assertEquals("INVALID_REQUEST: message rejected", controller.errorText.value)
      assertFalse(controller.messages.value.hasUserText("rejected"))
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun requestNotEnqueuedRestoresComposerOwnership() =
    runTest {
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> throw GatewayRequestNotEnqueued("not connected") },
          currentDefaultAgentId = { "main" },
        )
      controller.handleGatewayEvent("health", null)

      val accepted = controller.sendMessageAwaitAcceptance("never sent", "off", emptyList())

      assertFalse(accepted)
      assertEquals(0, controller.pendingRunCount.value)
      assertEquals("not connected", controller.errorText.value)
      assertFalse(controller.messages.value.hasUserText("never sent"))
    }

  private fun List<ChatMessage>.hasUserText(text: String): Boolean =
    any { message ->
      message.role == "user" && message.content.any { part -> part.text == text }
    }
}
