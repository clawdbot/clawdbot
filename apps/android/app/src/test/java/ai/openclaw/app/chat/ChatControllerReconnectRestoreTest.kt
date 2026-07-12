package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
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

/**
 * Reconnect recovery scenarios: after a gateway disconnect, the next health event
 * refetches chat.history and re-adopts the run the gateway still reports in flight
 * (`inFlightRun`), matching the reconnect snapshot contract the TUI consumes.
 */
class ChatControllerReconnectRestoreTest {
  private val json = Json { ignoreUnknownKeys = true }

  private fun TestScope.newController(gateway: ScriptedGateway): ChatController = ChatController(scope = this, json = json, requestGateway = gateway::request)

  private fun TestScope.newScopedController(gateway: ScriptedGateway): ChatController =
    ChatController(
      scope = this,
      json = json,
      requestGateway = gateway::request,
      requestGatewayForGateway = { _, method, paramsJson -> gateway.request(method, paramsJson) },
      cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
    )

  private val userTurn = ReplayHistoryMessage("user", "keep working", 1_000)

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun connectedRefreshUpsertsDeviceSessionBeforeLoadingHistory() =
    runTest {
      val sessionKey = "agent:main:node-device"
      val gateway = ScriptedGateway(json)
      gateway.respondWith("sessions.describe", """{"session":null}""")
      gateway.respondWith("sessions.patch", """{"ok":true,"key":"$sessionKey"}""")
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      val controller = newScopedController(gateway)

      controller.load("agent:main:custom")
      runCurrent()
      gateway.calls.clear()
      controller.prepareAndSelectMainSessionKey(sessionKey)
      controller.onGatewayConnected(MainSessionBinding(sessionKey, "OpenClaw App · Pixel · device"))
      runCurrent()

      val describeIndex = gateway.calls.indexOfFirst { it.method == "sessions.describe" }
      val patchIndex = gateway.calls.indexOfFirst { it.method == "sessions.patch" }
      val historyIndex = gateway.calls.indexOfFirst { it.method == "chat.history" }
      assertTrue(describeIndex >= 0)
      assertTrue(patchIndex > describeIndex)
      assertTrue(historyIndex > patchIndex)
      assertEquals(sessionKey, controller.sessionKey.value)
      val patchParams = json.parseToJsonElement(gateway.calls[patchIndex].paramsJson.orEmpty()).jsonObject
      assertEquals(sessionKey, patchParams["key"]?.jsonPrimitive?.content)
      assertEquals("OpenClaw App · Pixel · device", patchParams["label"]?.jsonPrimitive?.content)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun connectedRefreshContinuesWhenSessionAdoptionFails() =
    runTest {
      val sessionKey = "agent:main:node-device"
      val gateway = ScriptedGateway(json)
      gateway.respondWith("sessions.describe", """{"session":null}""")
      gateway.respond("sessions.patch") { error("patch unavailable") }
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      val controller = newScopedController(gateway)

      controller.prepareMainSessionKey(sessionKey)
      controller.onGatewayConnected(MainSessionBinding(sessionKey, "OpenClaw App · Pixel · device"))
      runCurrent()

      assertEquals(1, gateway.callCount("sessions.patch"))
      assertEquals(1, gateway.callCount("chat.history"))
      assertEquals(sessionKey, controller.sessionKey.value)
      assertNull(controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun connectedRefreshLabelsExistingSessionWithoutRecreatingIt() =
    runTest {
      val sessionKey = "agent:main:node-device"
      val gateway = ScriptedGateway(json)
      gateway.respondWith("sessions.describe", """{"session":{"key":"$sessionKey"}}""")
      gateway.respondWith("sessions.patch", """{"ok":true,"key":"$sessionKey"}""")
      gateway.respondWith("chat.history", historyResponse("existing-session", listOf(userTurn)))
      val controller = newScopedController(gateway)

      controller.prepareMainSessionKey(sessionKey)
      controller.onGatewayConnected(MainSessionBinding(sessionKey, "OpenClaw App · Pixel · device"))
      runCurrent()

      assertEquals(0, gateway.callCount("sessions.create"))
      val patchIndex = gateway.calls.indexOfFirst { it.method == "sessions.patch" }
      val historyIndex = gateway.calls.indexOfFirst { it.method == "chat.history" }
      assertTrue(patchIndex >= 0)
      assertTrue(historyIndex > patchIndex)
      val patchParams = json.parseToJsonElement(gateway.calls[patchIndex].paramsJson.orEmpty()).jsonObject
      assertEquals(sessionKey, patchParams["key"]?.jsonPrimitive?.content)
      assertEquals("OpenClaw App · Pixel · device", patchParams["label"]?.jsonPrimitive?.content)
      assertEquals(listOf("keep working"), controller.messages.value.map { it.content.first().text })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun agentSelectionAcknowledgesUnreadDeviceSession() =
    runTest {
      val sessionKey = "agent:main:node-device"
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "sessions.describe",
        """{"session":{"key":"$sessionKey","label":"OpenClaw App · Pixel · device"}}""",
      )
      gateway.respondWith("sessions.patch", """{"ok":true,"key":"$sessionKey"}""")
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      val controller = newScopedController(gateway)
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"patch","sessionKey":"$sessionKey","session":{"key":"$sessionKey","unread":true}}""",
      )

      controller.prepareAndSelectMainSessionKey(sessionKey)
      controller.onGatewayConnected(MainSessionBinding(sessionKey, "OpenClaw App · Pixel · device"))
      runCurrent()

      val patchParams =
        gateway.calls
          .first { it.method == "sessions.patch" }
          .paramsJson
          .orEmpty()
      assertTrue(patchParams.contains("\"key\":\"$sessionKey\""))
      assertTrue(patchParams.contains("\"unread\":false"))
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectRevalidatesWithoutOverwritingExistingLabel() =
    runTest {
      val sessionKey = "agent:main:node-device"
      val gateway = ScriptedGateway(json)
      var storedLabel: String? = null
      gateway.respond("sessions.describe") {
        storedLabel?.let { """{"session":{"key":"$sessionKey","label":"$it"}}""" }
          ?: """{"session":null}"""
      }
      gateway.respond("sessions.patch") { paramsJson ->
        storedLabel =
          json
            .parseToJsonElement(paramsJson.orEmpty())
            .jsonObject["label"]
            ?.jsonPrimitive
            ?.content
        """{"ok":true,"key":"$sessionKey"}"""
      }
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      val controller = newScopedController(gateway)
      val binding = MainSessionBinding(sessionKey, "OpenClaw App · Pixel · device")

      controller.prepareMainSessionKey(sessionKey)
      controller.onGatewayConnected(binding)
      runCurrent()
      controller.onDisconnected("Reconnecting…")
      controller.onGatewayConnected(binding)
      runCurrent()

      assertEquals(1, gateway.callCount("sessions.patch"))
      assertEquals(2, gateway.callCount("sessions.describe"))
      assertEquals(2, gateway.callCount("chat.history"))

      storedLabel = "My Android session"
      controller.onGatewayConnected(binding.copy(label = "OpenClaw App · Renamed · device"))
      runCurrent()

      assertEquals(1, gateway.callCount("sessions.patch"))
      assertEquals(3, gateway.callCount("sessions.describe"))
      assertEquals(3, gateway.callCount("chat.history"))
      assertEquals("My Android session", storedLabel)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun agentSwitchWaitsForTheLatestSessionAdoption() =
    runTest {
      val firstDescribe = CompletableDeferred<String>()
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.describe") { paramsJson ->
        val key =
          json
            .parseToJsonElement(paramsJson.orEmpty())
            .jsonObject["key"]
            ?.jsonPrimitive
            ?.content
        if (key == "agent:first:node-device") firstDescribe.await() else """{"session":null}"""
      }
      gateway.respond("sessions.patch") { paramsJson ->
        val key =
          json
            .parseToJsonElement(paramsJson.orEmpty())
            .jsonObject["key"]
            ?.jsonPrimitive
            ?.content
        """{"ok":true,"key":"$key"}"""
      }
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      val controller = newScopedController(gateway)

      controller.prepareAndSelectMainSessionKey("agent:first:node-device")
      controller.onGatewayConnected(MainSessionBinding("agent:first:node-device", "OpenClaw App · Pixel · device"))
      runCurrent()
      controller.prepareAndSelectMainSessionKey("agent:second:node-device")
      controller.onGatewayConnected(MainSessionBinding("agent:second:node-device", "OpenClaw App · Pixel · device"))
      controller.refresh()
      runCurrent()

      val patchCalls = gateway.calls.withIndex().filter { it.value.method == "sessions.patch" }
      val patchIndex = patchCalls.single().index
      val historyCalls = gateway.calls.withIndex().filter { it.value.method == "chat.history" }
      val patchParams =
        patchCalls
          .single()
          .value
          .paramsJson
          .orEmpty()
      val patchedKey =
        json
          .parseToJsonElement(patchParams)
          .jsonObject["key"]
          ?.jsonPrimitive
          ?.content
      assertEquals("agent:second:node-device", patchedKey)
      assertTrue(historyCalls.isNotEmpty())
      assertTrue(historyCalls.all { it.index > patchIndex })
      assertTrue(historyCalls.all { gateway.sessionKeyOf(it.value.paramsJson) == "agent:second:node-device" })
      assertEquals("agent:second:node-device", controller.sessionKey.value)

      // The cancelled response must remain inert even if its server-side work completes later.
      firstDescribe.complete("""{"session":null}""")
      runCurrent()
      assertEquals(1, gateway.callCount("sessions.patch"))
      assertTrue(gateway.calls.none { it.method == "chat.history" && gateway.sessionKeyOf(it.paramsJson) == "agent:first:node-device" })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectRecoveryWaitsForSessionReadiness() =
    runTest {
      val sessionKey = "agent:main:node-device"
      val reconnectDescribe = CompletableDeferred<String>()
      var reconnecting = false
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.describe") {
        if (reconnecting) {
          reconnectDescribe.await()
        } else {
          """{"session":{"key":"$sessionKey","label":"OpenClaw App · Pixel · device"}}"""
        }
      }
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      val controller = newScopedController(gateway)
      val binding = MainSessionBinding(sessionKey, "OpenClaw App · Pixel · device")

      controller.prepareMainSessionKey(sessionKey)
      controller.onGatewayConnected(binding)
      runCurrent()
      val historyCallsBeforeReconnect = gateway.callCount("chat.history")
      controller.onDisconnected("Reconnecting…")
      reconnecting = true
      controller.onGatewayConnected(binding)
      controller.handleGatewayEvent("tick", null)
      runCurrent()

      assertEquals(historyCallsBeforeReconnect, gateway.callCount("chat.history"))
      reconnectDescribe.complete(
        """{"session":{"key":"$sessionKey","label":"OpenClaw App · Pixel · device"}}""",
      )
      runCurrent()
      assertTrue(gateway.callCount("chat.history") > historyCallsBeforeReconnect)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectCancelsStaleAdoptionAndRetriesOnTheNewTransport() =
    runTest {
      val sessionKey = "agent:main:node-device"
      val staleDescribe = CompletableDeferred<String>()
      var describeCalls = 0
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.describe") {
        describeCalls += 1
        if (describeCalls == 1) {
          staleDescribe.await()
        } else {
          """{"session":{"key":"$sessionKey","label":"OpenClaw App · Pixel · device"}}"""
        }
      }
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      val controller = newScopedController(gateway)
      val binding = MainSessionBinding(sessionKey, "OpenClaw App · Pixel · device")

      controller.prepareMainSessionKey(sessionKey)
      controller.onGatewayConnected(binding)
      runCurrent()
      assertEquals(1, describeCalls)

      controller.onDisconnected("Reconnecting…")
      controller.onGatewayConnected(binding)
      runCurrent()

      assertEquals(2, describeCalls)
      assertEquals(1, gateway.callCount("chat.history"))
      assertEquals(sessionKey, controller.sessionKey.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectUpsertsSessionDeletedWhileDisconnected() =
    runTest {
      val sessionKey = "agent:main:node-device"
      val gateway = ScriptedGateway(json)
      var sessionExists = false
      gateway.respond("sessions.describe") {
        if (sessionExists) {
          """{"session":{"key":"$sessionKey","label":"OpenClaw App · Pixel · device"}}"""
        } else {
          """{"session":null}"""
        }
      }
      gateway.respond("sessions.patch") {
        sessionExists = true
        """{"ok":true,"key":"$sessionKey"}"""
      }
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      val controller = newScopedController(gateway)
      val binding = MainSessionBinding(sessionKey, "OpenClaw App · Pixel · device")

      controller.prepareMainSessionKey(sessionKey)
      controller.onGatewayConnected(binding)
      runCurrent()
      sessionExists = false
      controller.onDisconnected("Reconnecting…")
      controller.onGatewayConnected(binding)
      runCurrent()

      assertEquals(2, gateway.callCount("sessions.describe"))
      assertEquals(2, gateway.callCount("sessions.patch"))
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectAdoptsInFlightRunAndConsumesLiveEvents() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", listOf(userTurn)))
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()
      assertEquals(0, controller.pendingRunCount.value)

      controller.onDisconnected("Reconnecting…")
      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", listOf(userTurn), inFlightRun = "run-active" to "partial reply"),
      )
      controller.onGatewayConnected()
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("partial reply", controller.streamingAssistantText.value)
      assertEquals(1, controller.messages.value.size)

      // The adopted run keeps consuming live deltas and its terminal event.
      controller.handleGatewayEvent(
        "chat",
        chatDeltaPayload("main", "run-active", 5, " more", "partial reply more"),
      )
      assertEquals("partial reply more", controller.streamingAssistantText.value)
      gateway.respondWith(
        "chat.history",
        historyResponse(
          "session-1",
          listOf(userTurn, ReplayHistoryMessage("assistant", "partial reply more", 2_000)),
        ),
      )
      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", "run-active", seq = 6, assistantText = "partial reply more"),
      )
      runCurrent()

      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)
      assertEquals(2, controller.messages.value.size)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectWithoutInFlightRunStaysClean() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", listOf(userTurn)))
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()
      val historyCallsAfterLoad = gateway.callCount("chat.history")
      val metadataCallsAfterLoad = gateway.callCount("chat.metadata")

      controller.onDisconnected("Offline")
      controller.onGatewayConnected()
      runCurrent()

      // Reconnect refetched history once and restored nothing.
      assertEquals(historyCallsAfterLoad + 1, gateway.callCount("chat.history"))
      assertEquals(metadataCallsAfterLoad + 1, gateway.callCount("chat.metadata"))
      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)
      assertNull(controller.errorText.value)
      assertTrue(controller.healthOk.value)
      assertEquals(1, controller.messages.value.size)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectStaysUnhealthyUntilRecoveryHistoryApplies() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      val recoveryHistory = CompletableDeferred<String>()
      gateway.respond("chat.history") { recoveryHistory.await() }
      controller.onDisconnected("Reconnecting…")
      controller.onGatewayConnected()
      runCurrent()

      assertFalse(controller.healthOk.value)
      val healthCallsDuringRecovery = gateway.callCount("health")
      val historyCallsDuringRecovery = gateway.callCount("chat.history")
      controller.handleGatewayEvent("tick", null)
      runCurrent()
      assertFalse(controller.healthOk.value)
      assertEquals(healthCallsDuringRecovery, gateway.callCount("health"))
      assertEquals(historyCallsDuringRecovery + 1, gateway.callCount("chat.history"))

      recoveryHistory.complete(historyResponse("session-1", emptyList()))
      runCurrent()
      assertTrue(controller.healthOk.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun newerSameGenerationHistoryRequestCompletesReconnectHealth() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", listOf(userTurn), inFlightRun = "run-active" to "working"),
      )
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      val reconnectHistoryStarted = CompletableDeferred<Unit>()
      val releaseReconnectHistory = CompletableDeferred<String>()
      var recoveryHistoryCalls = 0
      gateway.respond("chat.history") {
        recoveryHistoryCalls += 1
        if (recoveryHistoryCalls == 1) {
          reconnectHistoryStarted.complete(Unit)
          releaseReconnectHistory.await()
        } else {
          historyResponse(
            "session-1",
            listOf(userTurn, ReplayHistoryMessage("assistant", "done", 2_000)),
          )
        }
      }

      controller.onDisconnected("Reconnecting…")
      controller.onGatewayConnected()
      runCurrent()
      reconnectHistoryStarted.await()
      assertFalse(controller.healthOk.value)

      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", "run-active", seq = 2, assistantText = "done"),
      )
      runCurrent()

      assertTrue(controller.healthOk.value)
      assertEquals(listOf("keep working", "done"), controller.messages.value.map { it.content.single().text })

      releaseReconnectHistory.complete(historyResponse("session-1", emptyList()))
      runCurrent()
      assertTrue(controller.healthOk.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun recoveredPendingRunRefreshesHistoryBeforeTimingOut() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", listOf(userTurn), inFlightRun = "run-active" to "working"),
      )
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()
      assertEquals(1, controller.pendingRunCount.value)
      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"run-active","seq":2,"ts":10,"stream":"tool","data":{"phase":"start","name":"exec","toolCallId":"tool-1"}}""",
      )

      gateway.respondWith(
        "chat.history",
        historyResponse(
          "session-1",
          listOf(userTurn, ReplayHistoryMessage("assistant", "completed while offline", 2_000)),
        ),
      )
      advanceTimeBy(120_000)
      runCurrent()

      assertEquals(0, controller.pendingRunCount.value)
      assertEquals(
        listOf("keep working", "completed while offline"),
        controller.messages.value.map { it.content.single().text },
      )
      assertNull(controller.errorText.value)
      assertNull(controller.streamingAssistantText.value)
      assertTrue(controller.pendingToolCalls.value.isEmpty())
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun explicitRefreshClearsPriorHistoryError() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      gateway.respond("chat.history") { error("history unavailable") }
      controller.refresh()
      runCurrent()
      assertEquals("history unavailable", controller.errorText.value)

      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      controller.refresh()
      assertNull(controller.errorText.value)
      runCurrent()
      assertNull(controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun disconnectInvalidatesLateHistoryError() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      val pendingHistory = CompletableDeferred<String>()
      gateway.respond("chat.history") { pendingHistory.await() }
      controller.refresh()
      runCurrent()
      controller.onDisconnected("Reconnecting…")
      pendingHistory.completeExceptionally(IllegalStateException("socket closed"))
      runCurrent()
      assertNull(controller.errorText.value)

      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      controller.onGatewayConnected()
      assertNull(controller.errorText.value)
      runCurrent()
      assertNull(controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun disconnectInvalidatesOlderHistorySnapshotBeforeOwnershipRestore() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()
      assertTrue(controller.sendMessageAwaitAcceptance("keep ownership", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)

      val staleHistory = CompletableDeferred<String>()
      gateway.respond("chat.history") { staleHistory.await() }
      controller.refresh()
      runCurrent()
      controller.onDisconnected("Reconnecting…")
      staleHistory.complete(historyResponse("session-1", emptyList()))
      runCurrent()

      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", emptyList(), inFlightRun = runId to "working"),
      )
      controller.onGatewayConnected()
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("working", controller.streamingAssistantText.value)
      assertEquals(listOf("keep ownership"), controller.messages.value.map { it.content.single().text })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun disconnectAfterGatewayAcceptancePreservesSendWhenAckIsLost() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      val sendStarted = CompletableDeferred<Unit>()
      val releaseSend = CompletableDeferred<String>()
      gateway.respond("chat.send") {
        sendStarted.complete(Unit)
        releaseSend.await()
      }
      val sendResult = async { controller.sendMessageAwaitAcceptance("accepted before drop", "off", emptyList()) }
      sendStarted.await()
      val runId =
        json
          .parseToJsonElement(requireNotNull(gateway.calls.last { it.method == "chat.send" }.paramsJson))
          .jsonObject
          .getValue("idempotencyKey")
          .jsonPrimitive
          .content

      controller.onDisconnected("Reconnecting…")
      releaseSend.completeExceptionally(GatewayRequestOutcomeUnknown("socket closed before ACK"))
      assertTrue(sendResult.await())
      assertEquals(listOf("accepted before drop"), controller.messages.value.map { it.content.single().text })
      assertNull(controller.errorText.value)

      gateway.respondWith(
        "chat.history",
        historyResponse(
          "session-1",
          listOf(
            ReplayHistoryMessage("user", "accepted before drop", 1_000, idempotencyKey = "$runId:user"),
            ReplayHistoryMessage("assistant", "completed once", 2_000),
          ),
        ),
      )
      controller.onGatewayConnected()
      runCurrent()

      assertEquals(0, controller.pendingRunCount.value)
      assertEquals(
        listOf("accepted before drop", "completed once"),
        controller.messages.value.map { it.content.single().text },
      )
      assertNull(controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun lostAckAdoptsCanonicalRunWhilePreservingClientHistoryIdentity() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      gateway.respond("chat.send") { throw GatewayRequestOutcomeUnknown("ACK lost") }
      var clientRunId: String? = null
      var recoveryHistoryCalls = 0
      gateway.respond("chat.history") {
        recoveryHistoryCalls += 1
        clientRunId =
          json
            .parseToJsonElement(requireNotNull(gateway.calls.last { it.method == "chat.send" }.paramsJson))
            .jsonObject
            .getValue("idempotencyKey")
            .jsonPrimitive
            .content
        if (recoveryHistoryCalls == 1) {
          historyResponse("session-1", emptyList())
        } else {
          historyResponse(
            "session-1",
            listOf(ReplayHistoryMessage("user", "canonical recovery", 1_000, idempotencyKey = "$clientRunId:user")),
            inFlightRun = "canonical-run" to "working",
          )
        }
      }
      assertTrue(controller.sendMessageAwaitAcceptance("canonical recovery", "off", emptyList()))
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)

      advanceTimeBy(750)
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("working", controller.streamingAssistantText.value)
      assertEquals(
        "$clientRunId:user",
        controller.messages.value
          .single { it.role == "user" }
          .idempotencyKey,
      )
      controller.handleGatewayEvent(
        "chat",
        chatDeltaPayload("main", "canonical-run", 1, " now", "working now"),
      )
      assertEquals("working now", controller.streamingAssistantText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun repeatedReconnectsDoNotDuplicateRunOrRows() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", listOf(userTurn), inFlightRun = "run-active" to "partial"),
      )
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()
      assertEquals(1, controller.pendingRunCount.value)

      repeat(2) {
        controller.onDisconnected("Reconnecting…")
        assertEquals(0, controller.pendingRunCount.value)
        controller.onGatewayConnected()
        runCurrent()
      }

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("partial", controller.streamingAssistantText.value)
      assertEquals(1, controller.messages.value.size)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectKeepsOptimisticUserWhileHistoryPersistenceLags() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      assertTrue(controller.sendMessageAwaitAcceptance("survive reconnect", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      controller.onDisconnected("Reconnecting…")
      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", emptyList(), inFlightRun = runId to "working"),
      )
      controller.onGatewayConnected()
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("working", controller.streamingAssistantText.value)
      assertEquals(listOf("survive reconnect"), controller.messages.value.map { it.content.single().text })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectStaleSnapshotCannotReplaceDisconnectedLocalRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      assertTrue(controller.sendMessageAwaitAcceptance("local work", "off", emptyList()))
      val localRunId = requireNotNull(gateway.lastRunId)
      controller.onDisconnected("Reconnecting…")
      gateway.respondWith(
        "chat.history",
        historyResponse(
          "session-1",
          listOf(ReplayHistoryMessage("user", "local work", 1_000, idempotencyKey = "$localRunId:user")),
          inFlightRun = "run-stale" to "old text",
        ),
      )
      controller.onGatewayConnected()
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)
      controller.handleGatewayEvent(
        "chat",
        chatDeltaPayload("main", localRunId, 1, "ours", "ours"),
      )
      assertEquals("ours", controller.streamingAssistantText.value)
      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"run-stale","seq":2,"stream":"assistant","data":{"text":"stale agent"}}""",
      )
      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"run-stale","seq":3,"ts":10,"stream":"tool","data":{"phase":"start","name":"exec","toolCallId":"stale-tool"}}""",
      )
      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", "run-stale", seq = 4, state = "error"),
      )
      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("ours", controller.streamingAssistantText.value)
      assertTrue(controller.pendingToolCalls.value.isEmpty())
      assertNull(controller.errorText.value)
      assertEquals(listOf("local work"), controller.messages.value.map { it.content.single().text })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectRetiresPersistedLocalRunBeforeAdoptingOtherRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      assertTrue(controller.sendMessageAwaitAcceptance("local work", "off", emptyList()))
      val localRunId = requireNotNull(gateway.lastRunId)
      controller.onDisconnected("Reconnecting…")
      gateway.respondWith(
        "chat.history",
        historyResponse(
          "session-1",
          listOf(
            ReplayHistoryMessage("user", "local work", 1_000, idempotencyKey = "$localRunId:user"),
            ReplayHistoryMessage("assistant", "local done", 2_000),
          ),
          inFlightRun = "run-other" to "other working",
        ),
      )
      controller.onGatewayConnected()
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("other working", controller.streamingAssistantText.value)
      assertEquals(listOf("local work", "local done"), controller.messages.value.map { it.content.single().text })
      controller.handleGatewayEvent(
        "chat",
        chatDeltaPayload("main", localRunId, 1, "stale", "stale local"),
      )
      assertEquals("other working", controller.streamingAssistantText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectReplacesPreviouslyAdoptedRunWithAuthoritativeSnapshotRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", emptyList(), inFlightRun = "run-a" to "old work"),
      )
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()
      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("old work", controller.streamingAssistantText.value)

      controller.onDisconnected("Reconnecting…")
      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", emptyList(), inFlightRun = "run-b" to "current work"),
      )
      controller.onGatewayConnected()
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("current work", controller.streamingAssistantText.value)
      controller.handleGatewayEvent("chat", chatDeltaPayload("main", "run-a", 1, " stale", "old work stale"))
      assertEquals("current work", controller.streamingAssistantText.value)
      controller.handleGatewayEvent("chat", chatDeltaPayload("main", "run-b", 1, " now", "current work now"))
      assertEquals("current work now", controller.streamingAssistantText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun seqGapKeepsOptimisticUserWhileHistoryPersistenceLags() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      assertTrue(controller.sendMessageAwaitAcceptance("survive gap", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", emptyList(), inFlightRun = runId to "working"),
      )
      controller.handleGatewayEvent("seqGap", null)
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("working", controller.streamingAssistantText.value)
      assertEquals(listOf("survive gap"), controller.messages.value.map { it.content.single().text })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun sameSessionRefreshKeepsOptimisticRunOwnership() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      assertTrue(controller.sendMessageAwaitAcceptance("survive refresh", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", emptyList(), inFlightRun = runId to "working"),
      )
      controller.refresh()
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("working", controller.streamingAssistantText.value)
      assertEquals(listOf("survive refresh"), controller.messages.value.map { it.content.single().text })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun sameSessionRefreshClearsTransientUiForResolvedRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", listOf(userTurn), inFlightRun = "run-active" to "partial"),
      )
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()
      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"run-active","seq":2,"ts":10,"stream":"tool","data":{"phase":"start","name":"exec","toolCallId":"tool-1"}}""",
      )
      assertEquals("partial", controller.streamingAssistantText.value)
      assertEquals(1, controller.pendingToolCalls.value.size)

      gateway.respondWith(
        "chat.history",
        historyResponse(
          "session-1",
          listOf(userTurn, ReplayHistoryMessage("assistant", "complete", 2_000)),
        ),
      )
      controller.refresh()
      runCurrent()

      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)
      assertTrue(controller.pendingToolCalls.value.isEmpty())
      assertEquals(listOf("keep working", "complete"), controller.messages.value.map { it.content.single().text })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun seqGapMissingRunClearsPendingButKeepsOptimisticUser() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      assertTrue(controller.sendMessageAwaitAcceptance("finished during gap", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      controller.handleGatewayEvent("seqGap", null)
      runCurrent()

      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)
      assertEquals(listOf("finished during gap"), controller.messages.value.map { it.content.single().text })

      gateway.respondWith(
        "chat.history",
        historyResponse(
          "session-1",
          listOf(
            ReplayHistoryMessage("user", "finished during gap", 1_000, idempotencyKey = "$runId:user"),
            ReplayHistoryMessage("assistant", "done", 2_000),
          ),
        ),
      )
      advanceTimeBy(750)
      runCurrent()

      assertEquals(listOf("finished during gap", "done"), controller.messages.value.map { it.content.single().text })
      assertNull(controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun recoveryRetriesWhenUserPersistsBeforeAssistantReply() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      assertTrue(controller.sendMessageAwaitAcceptance("await reply", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      val persistedUser = ReplayHistoryMessage("user", "await reply", 1_000, idempotencyKey = "$runId:user")
      gateway.respondWith("chat.history", historyResponse("session-1", listOf(persistedUser)))
      controller.handleGatewayEvent("seqGap", null)
      runCurrent()
      assertEquals(listOf("await reply"), controller.messages.value.map { it.content.single().text })

      gateway.respondWith(
        "chat.history",
        historyResponse(
          "session-1",
          listOf(persistedUser, ReplayHistoryMessage("assistant", "done", 2_000)),
        ),
      )
      advanceTimeBy(750)
      runCurrent()

      assertEquals(listOf("await reply", "done"), controller.messages.value.map { it.content.single().text })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun recoveryPerformsFinalRefreshWhenAssistantPersistsAfterFirstRetry() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      assertTrue(controller.sendMessageAwaitAcceptance("late reply", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      val persistedUser = ReplayHistoryMessage("user", "late reply", 1_000, idempotencyKey = "$runId:user")
      var historyCall = 0
      gateway.respond("chat.history") {
        historyCall += 1
        historyResponse(
          "session-1",
          if (historyCall < 3) {
            listOf(persistedUser)
          } else {
            listOf(persistedUser, ReplayHistoryMessage("assistant", "eventually done", 2_000))
          },
        )
      }

      controller.handleGatewayEvent("seqGap", null)
      runCurrent()
      advanceTimeBy(750)
      runCurrent()
      assertEquals(listOf("late reply"), controller.messages.value.map { it.content.single().text })

      advanceTimeBy(119_250)
      runCurrent()
      assertEquals(listOf("late reply", "eventually done"), controller.messages.value.map { it.content.single().text })
      assertNull(controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun newerRunReconciliationKeepsOlderUnresolvedReply() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      assertTrue(controller.sendMessageAwaitAcceptance("first", "off", emptyList()))
      val firstRunId = requireNotNull(gateway.lastRunId)
      val firstUser = ReplayHistoryMessage("user", "first", 1_000, idempotencyKey = "$firstRunId:user")
      gateway.respondWith("chat.history", historyResponse("session-1", listOf(firstUser)))
      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", firstRunId, seq = 2, assistantText = "first done"),
      )
      runCurrent()

      assertTrue(controller.sendMessageAwaitAcceptance("second", "off", emptyList()))
      val secondRunId = requireNotNull(gateway.lastRunId)
      controller.handleGatewayEvent(
        "chat",
        chatDeltaPayload("main", secondRunId, 1, "new", "second working"),
      )
      val secondUser = ReplayHistoryMessage("user", "second", 2_000, idempotencyKey = "$secondRunId:user")
      val secondReply = ReplayHistoryMessage("assistant", "second done", 3_000)
      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", listOf(firstUser, secondUser, secondReply)),
      )
      controller.handleGatewayEvent("chat", chatTerminalPayload("main", firstRunId, seq = 3, state = "error"))
      runCurrent()
      assertEquals("second working", controller.streamingAssistantText.value)
      assertNull(controller.errorText.value)
      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", secondRunId, seq = 2, assistantText = "second done"),
      )
      runCurrent()
      assertEquals(listOf("first", "second", "second done"), controller.messages.value.map { it.content.single().text })

      gateway.respondWith(
        "chat.history",
        historyResponse(
          "session-1",
          listOf(
            firstUser,
            ReplayHistoryMessage("assistant", "first done", 1_500),
            secondUser,
            secondReply,
          ),
        ),
      )
      advanceTimeBy(750)
      runCurrent()

      assertEquals(
        listOf("first", "first done", "second", "second done"),
        controller.messages.value.map { it.content.single().text },
      )
      assertNull(controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun newerRefreshCarriesUnresolvedReplyReconciliation() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      assertTrue(controller.sendMessageAwaitAcceptance("carry reply", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      val persistedUser = ReplayHistoryMessage("user", "carry reply", 1_000, idempotencyKey = "$runId:user")
      var historyCall = 0
      gateway.respond("chat.history") {
        historyCall += 1
        historyResponse(
          "session-1",
          if (historyCall < 4) {
            listOf(persistedUser)
          } else {
            listOf(persistedUser, ReplayHistoryMessage("assistant", "carried done", 2_000))
          },
        )
      }

      controller.handleGatewayEvent("seqGap", null)
      runCurrent()
      advanceTimeBy(750)
      runCurrent()
      controller.refresh()
      runCurrent()
      advanceTimeBy(750)
      runCurrent()

      assertEquals(listOf("carry reply", "carried done"), controller.messages.value.map { it.content.single().text })
      assertNull(controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun successfulRecoveryRetryClearsHistoryError() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      assertTrue(controller.sendMessageAwaitAcceptance("recover error", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      var historyCall = 0
      gateway.respond("chat.history") {
        historyCall += 1
        if (historyCall == 1) {
          error("history unavailable")
        }
        historyResponse(
          "session-1",
          listOf(
            ReplayHistoryMessage("user", "recover error", 1_000, idempotencyKey = "$runId:user"),
            ReplayHistoryMessage("assistant", "recovered", 2_000),
          ),
        )
      }

      controller.handleGatewayEvent("seqGap", null)
      runCurrent()
      assertEquals("history unavailable", controller.errorText.value)
      advanceTimeBy(750)
      runCurrent()

      assertNull(controller.errorText.value)
      assertEquals(listOf("recover error", "recovered"), controller.messages.value.map { it.content.single().text })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectFailureStillExpiresUnconfirmedUser() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      assertTrue(controller.sendMessageAwaitAcceptance("never persisted", "off", emptyList()))
      controller.onDisconnected("Reconnecting…")
      gateway.respond("chat.history") { error("history unavailable") }
      controller.onGatewayConnected()
      runCurrent()

      assertEquals(listOf("never persisted"), controller.messages.value.map { it.content.single().text })

      advanceTimeBy(120_000)
      runCurrent()

      assertTrue(controller.messages.value.isEmpty())
      assertEquals("Timed out waiting for a reply; try again or refresh.", controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun lateTerminalAfterTimeoutRefreshesHistoryWithoutClearingNewerRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      assertTrue(controller.sendMessageAwaitAcceptance("slow first", "off", emptyList()))
      val firstRunId = requireNotNull(gateway.lastRunId)
      advanceTimeBy(120_000)
      runCurrent()
      assertEquals("Timed out waiting for a reply; try again or refresh.", controller.errorText.value)

      assertTrue(controller.sendMessageAwaitAcceptance("newer work", "off", emptyList()))
      val secondRunId = requireNotNull(gateway.lastRunId)
      controller.handleGatewayEvent(
        "chat",
        chatDeltaPayload("main", secondRunId, 1, "new", "new reply"),
      )
      gateway.respondWith(
        "chat.history",
        historyResponse(
          "session-1",
          listOf(
            ReplayHistoryMessage("user", "slow first", 1_000, idempotencyKey = "$firstRunId:user"),
            ReplayHistoryMessage("assistant", "slow done", 2_000),
          ),
        ),
      )

      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", firstRunId, seq = 2, assistantText = "slow done"),
      )
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("new reply", controller.streamingAssistantText.value)
      assertNull(controller.errorText.value)
      assertEquals(
        listOf("slow first", "slow done", "newer work"),
        controller.messages.value.map { it.content.single().text },
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun staleRecoveryCompletionCannotCancelNewerReconciliation() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()
      assertTrue(controller.sendMessageAwaitAcceptance("ordered recovery", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)

      val firstRecoveryStarted = CompletableDeferred<Unit>()
      val releaseFirstRecovery = CompletableDeferred<String>()
      var recoveryCall = 0
      gateway.respond("chat.history") {
        recoveryCall += 1
        when (recoveryCall) {
          1 -> {
            firstRecoveryStarted.complete(Unit)
            releaseFirstRecovery.await()
          }
          2 -> historyResponse("session-1", emptyList())
          else ->
            historyResponse(
              "session-1",
              listOf(
                ReplayHistoryMessage("user", "ordered recovery", 1_000, idempotencyKey = "$runId:user"),
                ReplayHistoryMessage("assistant", "done", 2_000),
              ),
            )
        }
      }

      controller.handleGatewayEvent("seqGap", null)
      runCurrent()
      firstRecoveryStarted.await()
      controller.handleGatewayEvent("seqGap", null)
      runCurrent()
      releaseFirstRecovery.complete(historyResponse("session-1", emptyList()))
      runCurrent()
      advanceTimeBy(750)
      runCurrent()

      assertEquals(listOf("ordered recovery", "done"), controller.messages.value.map { it.content.single().text })
      assertNull(controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun olderSameGenerationRetryCannotOverwriteTerminalHistory() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()
      assertTrue(controller.sendMessageAwaitAcceptance("ordered result", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)

      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      controller.handleGatewayEvent("seqGap", null)
      runCurrent()

      val retryStarted = CompletableDeferred<Unit>()
      val releaseRetry = CompletableDeferred<String>()
      var historyCall = 0
      gateway.respond("chat.history") {
        historyCall += 1
        if (historyCall == 1) {
          retryStarted.complete(Unit)
          releaseRetry.await()
        } else {
          historyResponse(
            "session-1",
            listOf(
              ReplayHistoryMessage("user", "ordered result", 1_000, idempotencyKey = "$runId:user"),
              ReplayHistoryMessage("assistant", "done", 2_000),
            ),
          )
        }
      }
      advanceTimeBy(750)
      runCurrent()
      retryStarted.await()
      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", runId, seq = 2, assistantText = "done"),
      )
      runCurrent()
      releaseRetry.complete(historyResponse("session-1", emptyList()))
      runCurrent()

      assertEquals(listOf("ordered result", "done"), controller.messages.value.map { it.content.single().text })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun newerSameGenerationHistoryCompletionSuppressesOlderFailureAndClearsLoading() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()
      assertTrue(controller.sendMessageAwaitAcceptance("ordered loading", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)

      val recoveryStarted = CompletableDeferred<Unit>()
      val releaseRecovery = CompletableDeferred<String>()
      var historyCall = 0
      gateway.respond("chat.history") {
        historyCall += 1
        if (historyCall == 1) {
          recoveryStarted.complete(Unit)
          releaseRecovery.await()
        } else {
          historyResponse(
            "session-1",
            listOf(
              ReplayHistoryMessage("user", "ordered loading", 1_000, idempotencyKey = "$runId:user"),
              ReplayHistoryMessage("assistant", "done", 2_000),
            ),
          )
        }
      }

      controller.handleGatewayEvent("seqGap", null)
      runCurrent()
      recoveryStarted.await()
      assertTrue(controller.historyLoading.value)
      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", runId, seq = 2, assistantText = "done"),
      )
      runCurrent()

      assertFalse(controller.historyLoading.value)
      assertEquals(listOf("ordered loading", "done"), controller.messages.value.map { it.content.single().text })

      releaseRecovery.completeExceptionally(IllegalStateException("older history failed"))
      runCurrent()
      assertFalse(controller.historyLoading.value)
      assertEquals(listOf("ordered loading", "done"), controller.messages.value.map { it.content.single().text })
      assertNull(controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun seqGapStaleSnapshotCannotReplaceLocallyOwnedRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      assertTrue(controller.sendMessageAwaitAcceptance("new work", "off", emptyList()))
      val localRunId = requireNotNull(gateway.lastRunId)
      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", emptyList(), inFlightRun = "run-stale" to "old text"),
      )
      controller.handleGatewayEvent("seqGap", null)
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)
      controller.handleGatewayEvent(
        "chat",
        chatDeltaPayload("main", localRunId, 1, "ours", "ours"),
      )
      assertEquals("ours", controller.streamingAssistantText.value)
      assertEquals(listOf("new work"), controller.messages.value.map { it.content.single().text })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun seqGapRefetchesHistoryAndRestoresInFlightRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", listOf(userTurn), inFlightRun = "run-active" to "still going"),
      )
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()
      assertEquals(1, controller.pendingRunCount.value)

      controller.handleGatewayEvent("seqGap", null)
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("still going", controller.streamingAssistantText.value)
      assertNull(controller.errorText.value)
      assertEquals(1, controller.messages.value.size)
    }
}
