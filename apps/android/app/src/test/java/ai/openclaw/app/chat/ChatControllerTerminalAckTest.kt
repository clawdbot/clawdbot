package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerTerminalAckTest {
  private val json = chatControllerTestJson

  @Test
  fun finalAssistantEventPublishesVerifiedRoutingOwnerOnce() =
    runTest {
      val finalized = mutableListOf<Triple<ChatComposerOwner, String, String>>()
      val controller =
        createChatController(
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
          currentDefaultAgentId = { "main" },
          onAssistantReplyFinalized = { owner, runId, text ->
            finalized += Triple(owner, runId, text)
          },
        ) { method, _ ->
          if (method == "chat.send") {
            """{"runId":"run-notify","status":"started"}"""
          } else {
            emptyChatGatewayResponse(method)
          }
        }
      controller.prepareMainSessionKey("agent:main:main")
      controller.load(controller.sessionKey.value)
      runCurrent()
      assertTrue(controller.sendMessageAwaitAcceptance("status", "off", emptyList()))
      val terminal = chatTerminalPayload("agent:main:main", "run-notify", seq = 2, assistantText = "Done")

      controller.handleGatewayEvent("chat", terminal)
      controller.handleGatewayEvent("chat", terminal)
      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("agent:main:main", "run-error", seq = 3, state = "error", assistantText = "Partial"),
      )

      assertEquals(
        listOf(
          Triple(
            ChatComposerOwner(
              gatewayStableId = "gateway-a",
              agentId = "main",
              sessionKey = "agent:main:main",
            ),
            "run-notify",
            "Done",
          ),
        ),
        finalized,
      )
    }

  @Test
  fun finalAssistantEventPublishesOriginalOwnerAfterSessionSwitch() =
    runTest {
      val finalized = mutableListOf<Triple<ChatComposerOwner, String, String>>()
      val controller =
        createChatController(
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
          currentDefaultAgentId = { "main" },
          onAssistantReplyFinalized = { owner, runId, text ->
            finalized += Triple(owner, runId, text)
          },
        ) { method, _ ->
          if (method == "chat.send") {
            """{"runId":"run-session-a","status":"started"}"""
          } else {
            emptyChatGatewayResponse(method)
          }
        }
      controller.prepareMainSessionKey("agent:main:session-a")
      controller.load(controller.sessionKey.value)
      runCurrent()
      assertTrue(controller.sendMessageAwaitAcceptance("status", "off", emptyList()))

      controller.switchSession("agent:other:session-b")
      assertEquals("agent:other:session-b", controller.sessionKey.value)
      val terminal =
        chatTerminalPayload(
          "agent:main:session-a",
          "run-session-a",
          seq = 2,
          assistantText = "Session A done",
        )

      controller.handleGatewayEvent("chat", terminal)
      controller.handleGatewayEvent("chat", terminal)

      assertEquals("agent:other:session-b", controller.sessionKey.value)
      assertEquals(
        listOf(
          Triple(
            ChatComposerOwner(
              gatewayStableId = "gateway-a",
              agentId = "main",
              sessionKey = "agent:main:session-a",
            ),
            "run-session-a",
            "Session A done",
          ),
        ),
        finalized,
      )
    }

  @Test
  fun finalAssistantEventPublishesVerifiedInactiveSessionWithoutLocalRun() =
    runTest {
      val finalized = mutableListOf<Triple<ChatComposerOwner, String, String>>()
      val controller =
        createChatController(
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
          currentDefaultAgentId = { "main" },
          onAssistantReplyFinalized = { owner, runId, text ->
            finalized += Triple(owner, runId, text)
          },
        ) { method, _ -> emptyChatGatewayResponse(method) }
      controller.prepareMainSessionKey("agent:main:session-b")
      controller.handleGatewayEvent("health", null)

      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("agent:other:session-a", "external-run", seq = 1, assistantText = "External done"),
      )

      assertEquals(
        listOf(
          Triple(
            ChatComposerOwner("gateway-a", "other", "agent:other:session-a"),
            "external-run",
            "External done",
          ),
        ),
        finalized,
      )
    }

  @Test
  fun finalAssistantEventDoesNotRebindProjectedRunAcrossGateways() =
    runTest {
      val finalized = mutableListOf<Triple<ChatComposerOwner, String, String>>()
      var gatewayId = "gateway-a"
      val controller =
        createChatController(
          cacheScope = { ChatCacheScope(gatewayId = gatewayId, connectionGeneration = 1) },
          currentDefaultAgentId = { "main" },
          onAssistantReplyFinalized = { owner, runId, text ->
            finalized += Triple(owner, runId, text)
          },
        ) { method, _ ->
          if (method == "chat.send") {
            """{"runId":"run-gateway-a","status":"started"}"""
          } else {
            emptyChatGatewayResponse(method)
          }
        }
      controller.prepareMainSessionKey("agent:main:session-a")
      controller.load(controller.sessionKey.value)
      runCurrent()
      assertTrue(controller.sendMessageAwaitAcceptance("status", "off", emptyList()))

      gatewayId = "gateway-b"
      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload(
          "agent:main:session-a",
          "run-gateway-a",
          seq = 2,
          assistantText = "Wrong gateway",
        ),
      )

      assertTrue(finalized.isEmpty())
    }

  @Test
  fun composerOwnerMustMatchBeforeSendAdmission() =
    runTest {
      val requestedMethods = mutableListOf<String>()
      var defaultAgentId: String? = "main"
      val controller =
        createChatController(
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
          currentDefaultAgentId = { defaultAgentId },
        ) { method, _ ->
          requestedMethods += method
          if (method == "chat.send") """{"runId":"run-started","status":"started"}""" else emptyChatGatewayResponse(method)
        }
      controller.handleGatewayEvent("health", null)
      val ambiguousOwner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")
      assertFalse(controller.isCurrentComposerOwner(ambiguousOwner))
      assertFalse(
        controller.sendMessageForOwnerAwaitAcceptance(
          message = "unbound main alias",
          thinkingLevel = "off",
          attachments = emptyList(),
          expectedOwner = ambiguousOwner,
        ),
      )
      controller.prepareMainSessionKey("agent:main:node-test")
      controller.load(controller.sessionKey.value)
      runCurrent()
      val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:node-test")
      assertTrue(controller.isCurrentComposerOwner(owner))
      assertFalse(controller.isCurrentComposerOwner(owner.copy(gatewayStableId = "gateway-b")))

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
  fun composerOwnerIsRecheckedAfterPendingSettingsComplete() =
    runTest {
      val settingsStarted = CompletableDeferred<Unit>()
      val settingsGate = CompletableDeferred<Unit>()
      var defaultAgentId: String? = "main"
      var sendCount = 0
      val controller =
        createChatController(
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
          currentDefaultAgentId = { defaultAgentId },
        ) { method, _ ->
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

            else -> {
              emptyChatGatewayResponse(method)
            }
          }
        }
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
  fun failedDirectSendRetainsDurableInputAndSurfacesError() =
    runTest {
      val outcomes =
        listOf<suspend () -> String>(
          { """{"runId":"run-timeout","status":"timeout"}""" },
          { """{"runId":"run-error","status":"error"}""" },
          { throw GatewayRequestRejected(GatewaySession.ErrorShape("INVALID_REQUEST", "message rejected")) },
        )
      for ((index, outcome) in outcomes.withIndex()) {
        val controller =
          createScriptedChatController {
            respond("chat.history", historyResponse("session-$index", emptyList()))
            respond("chat.send") { outcome() }
          }
        controller.load("main")
        runCurrent()

        val accepted = controller.sendMessageAwaitAcceptance("retained input", "off", emptyList())

        assertTrue(accepted)
        assertEquals(0, controller.pendingRunCount.value)
        assertEquals(
          if (index == 2) "INVALID_REQUEST: message rejected" else "Chat failed before the run started; try again.",
          controller.errorText.value,
        )
        assertFalse(controller.messages.value.hasUserText("retained input"))
        val row = controller.outboxItems.value.single()
        assertEquals("retained input", row.text)
        assertEquals(ChatOutboxStatus.Failed, row.status)
        assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, row.lastError)
      }
    }

  @Test
  fun nonTerminalStartedAckRetainsOptimisticUserEchoAndPendingRun() =
    runTest {
      val controller =
        createChatController { method, _ ->
          if (method == "chat.send") """{"runId":"run-started","status":"started"}""" else emptyChatGatewayResponse(method)
        }
      controller.load("main")
      runCurrent()

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
  fun canonicalAckRunIdPreservesClientHistoryIdentity() =
    runTest {
      var clientRunId: String? = null
      val controller =
        createChatController { method, paramsJson ->
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

            "chat.history" -> {
              historyResponse(
                "session-1",
                clientRunId
                  ?.let { id ->
                    listOf(
                      ReplayHistoryMessage("user", "canonical", 1_000, idempotencyKey = "$id:user"),
                      ReplayHistoryMessage("assistant", "done", 2_000),
                    )
                  }.orEmpty(),
              )
            }

            else -> {
              emptyChatGatewayResponse(method)
            }
          }
        }
      controller.load("main")
      runCurrent()

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
  fun terminalOkAckClearsOptimisticUserEchoAndRefreshesHistory() =
    runTest {
      val requestedMethods = mutableListOf<String>()
      val controller =
        createChatController { method, _ ->
          requestedMethods += method
          when (method) {
            "chat.send" -> {
              """{"runId":"run-ok","status":"ok"}"""
            }

            "chat.history" -> {
              """
              {
                "sessionId": "session-1",
                "messages": [
                  { "role": "assistant", "content": "cached success reply", "timestamp": 1 }
                ]
              }
              """.trimIndent()
            }

            else -> {
              emptyChatGatewayResponse(method)
            }
          }
        }
      controller.load("main")
      runCurrent()
      requestedMethods.clear()

      val accepted =
        controller.sendMessageAwaitAcceptance(
          message = "message that already completed",
          thinkingLevel = "off",
          attachments = emptyList(),
        )
      advanceUntilIdle()

      assertTrue(accepted)
      assertEquals(1, requestedMethods.count { it == "chat.send" })
      assertTrue(requestedMethods.indexOf("chat.history") > requestedMethods.indexOf("chat.send"))
      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.errorText.value)
      assertFalse(controller.messages.value.hasUserText("message that already completed"))
      assertTrue(controller.messages.value.any { message -> message.role == "assistant" && message.content.any { part -> part.text == "cached success reply" } })
    }

  private fun List<ChatMessage>.hasUserText(text: String): Boolean =
    any { message ->
      message.role == "user" && message.content.any { part -> part.text == text }
    }
}
