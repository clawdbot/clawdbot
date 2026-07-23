package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatControllerUsageStreamTest {
  private val json = Json { ignoreUnknownKeys = true }

  private data class StartedRun(
    val controller: ChatController,
    val gateway: ScriptedGateway,
    val runId: String,
  )

  private suspend fun TestScope.startRun(): StartedRun {
    val gateway = ScriptedGateway(json)
    gateway.respondChatSend(status = "started")
    gateway.respondWith("question.list", """{"questions":[]}""")
    val controller = ChatController(scope = backgroundScope, json = json, requestGateway = gateway::request)
    controller.handleGatewayEvent("health", null)
    assertTrue(controller.sendMessageAwaitAcceptance("count this", "off", emptyList()))
    return StartedRun(controller, gateway, requireNotNull(gateway.lastRunId))
  }

  private fun usagePayload(
    runId: String,
    sequence: Long,
    outputTokens: String,
  ): String = """{"sessionKey":"main","runId":"$runId","seq":$sequence,"ts":10,"stream":"usage","data":{"outputTokens":$outputTokens}}"""

  private fun lifecyclePayload(
    runId: String,
    sequence: Long,
    phase: String,
  ): String = """{"sessionKey":"main","runId":"$runId","seq":$sequence,"ts":11,"stream":"lifecycle","data":{"phase":"$phase"}}"""

  private fun advertise(vararg runIds: String): String = """{"reason":"patch","session":{"key":"main","agentId":"main","hasActiveRun":${runIds.isNotEmpty()},"activeRunIds":[${runIds.joinToString(",") { "\"$it\"" }}]}}"""

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun usageRequiresOwnershipAndKeepsHighestSequenceAndCumulativeMaximum() =
    runTest {
      val (controller, _, runId) = startRun()

      controller.handleGatewayEvent("agent", usagePayload(runId, 2L, "12"))
      controller.handleGatewayEvent("agent", usagePayload(runId, 1L, "90"))
      controller.handleGatewayEvent("agent", usagePayload(runId, 3L, "8"))
      controller.handleGatewayEvent("agent", usagePayload(runId, 4L, "0"))
      controller.handleGatewayEvent("agent", usagePayload("foreign", 5L, "99"))

      assertEquals(12L, controller.selectedActiveRunPresentation.value.outputTokens)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun unsequencedTerminalWithoutRunIdSettlesSoleLocalRun() =
    runTest {
      val (controller, _, _) = startRun()

      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","stream":"lifecycle","data":{"phase":"end"}}""",
      )

      assertEquals(0, controller.pendingRunCount.value)
      assertEquals(0, controller.selectedActiveRunPresentation.value.count)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun unsequencedForeignTerminalDoesNotSettleSoleLocalRun() =
    runTest {
      val (controller, _, localRunId) = startRun()

      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"foreign-run","stream":"lifecycle","data":{"phase":"end"}}""",
      )

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals(localRunId, controller.selectedActiveRunPresentation.value.runId)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun activeBooleanWithoutRunIdUsesStableSessionFallback() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = ChatController(scope = backgroundScope, json = json, requestGateway = gateway::request)
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"patch","session":{"key":"main","agentId":"main","hasActiveRun":true,"activeRunIds":[]}}""",
      )

      val presentation = controller.selectedActiveRunPresentation.value
      assertEquals(1, presentation.count)
      assertNull(presentation.runId)
      assertEquals("main:active", presentation.clockKey)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun idlessReplacementRunGetsANewStartedAtClockKey() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = ChatController(scope = backgroundScope, json = json, requestGateway = gateway::request)
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"patch","session":{"key":"main","agentId":"main","status":"running","hasActiveRun":true,"activeRunIds":[],"startedAt":100}}""",
      )
      val firstClockKey = controller.selectedActiveRunPresentation.value.clockKey

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"patch","session":{"key":"main","agentId":"main","status":"running","hasActiveRun":true,"activeRunIds":[],"startedAt":200}}""",
      )

      assertEquals("main:active:100", firstClockKey)
      assertEquals("main:active:200", controller.selectedActiveRunPresentation.value.clockKey)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun terminalTombstoneIgnoresLaterStartAndUsageUntilOwnershipRemoval() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = ChatController(scope = backgroundScope, json = json, requestGateway = gateway::request)
      controller.handleGatewayEvent("sessions.changed", advertise("server-run"))
      controller.handleGatewayEvent("agent", usagePayload("server-run", 1L, "20"))
      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"server-run","seq":2,"ts":10,"stream":"assistant","data":{"text":"foreign"}}""",
      )
      assertNull(controller.streamingAssistantText.value)
      controller.handleGatewayEvent("agent", lifecyclePayload("server-run", 2L, "end"))
      controller.handleGatewayEvent("agent", lifecyclePayload("server-run", 3L, "start"))
      controller.handleGatewayEvent("agent", usagePayload("server-run", 4L, "40"))

      assertEquals(0, controller.selectedActiveRunPresentation.value.count)
      assertNull(controller.selectedActiveRunPresentation.value.outputTokens)

      controller.handleGatewayEvent("sessions.changed", advertise())
      controller.handleGatewayEvent("sessions.changed", advertise("server-run"))
      controller.handleGatewayEvent("agent", usagePayload("server-run", 1L, "40"))

      assertEquals(1, controller.selectedActiveRunPresentation.value.count)
      assertEquals(40L, controller.selectedActiveRunPresentation.value.outputTokens)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun sequenceGapForConcurrentAdvertisedRunPreservesLocalPendingOwnership() =
    runTest {
      val (controller, gateway, localRunId) = startRun()
      controller.handleGatewayEvent("sessions.changed", advertise("server-run"))
      controller.handleGatewayEvent("agent", usagePayload(localRunId, 1L, "15"))
      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"$localRunId","seq":2,"ts":10,"stream":"assistant","data":{"text":"partial"}}""",
      )
      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-1",
          messages = emptyList(),
          inFlightRun = "server-run" to "",
        ),
      )

      controller.handleGatewayEvent("seqGap", null)
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals(localRunId, controller.selectedActiveRunPresentation.value.runId)
      assertNull(controller.selectedActiveRunPresentation.value.outputTokens)
      assertNull(controller.streamingAssistantText.value)
      assertTrue(gateway.callCount("chat.history") > 0)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun ackRekeyPreservesOptimisticClockIdentity() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("question.list", """{"questions":[]}""")
      val requestSeen = CompletableDeferred<String>()
      val releaseAck = CompletableDeferred<Unit>()
      gateway.respond("chat.send") { paramsJson ->
        val clientRunId =
          json
            .parseToJsonElement(requireNotNull(paramsJson))
            .jsonObject["idempotencyKey"]!!
            .jsonPrimitive
            .content
        requestSeen.complete(clientRunId)
        releaseAck.await()
        """{"runId":"server-run","status":"started"}"""
      }
      val controller = ChatController(scope = backgroundScope, json = json, requestGateway = gateway::request)
      controller.handleGatewayEvent("health", null)
      val send = async { controller.sendMessageAwaitAcceptance("hello", "off", emptyList()) }
      val clientRunId = requestSeen.await()
      runCurrent()
      val before = controller.selectedActiveRunPresentation.value

      releaseAck.complete(Unit)
      assertTrue(send.await())
      val after = controller.selectedActiveRunPresentation.value

      assertEquals(clientRunId, before.runId)
      assertEquals("server-run", after.runId)
      assertNotNull(before.clockKey)
      assertEquals(before.clockKey, after.clockKey)
    }
}
