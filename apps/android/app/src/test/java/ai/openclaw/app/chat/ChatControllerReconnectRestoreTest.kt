package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
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
@OptIn(ExperimentalCoroutinesApi::class)
class ChatControllerReconnectRestoreTest {
  private val json = chatControllerTestJson
  private val ChatController.messageTexts: List<String?>
    get() = messages.value.map { it.content.single().text }

  // The controller runs on backgroundScope: while a restored run stays in flight the
  // pending-run watchdog keeps re-arming, so its timer must be cancelled by runTest
  // instead of counting as an uncompleted test coroutine.
  private fun TestScope.newController(gateway: ScriptedGateway): ChatController = backgroundScope.createChatController(requestGateway = gateway::request)

  private fun TestScope.newScopedController(gateway: ScriptedGateway): ChatController =
    backgroundScope.createChatController(
      requestGateway = gateway::request,
      requestGatewayForGateway = { _, method, paramsJson -> gateway.request(method, paramsJson) },
      cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
    )

  private fun TestScope.loadController(gateway: ScriptedGateway): ChatController =
    newController(gateway).also {
      it.load("main")
      runCurrent()
    }

  private fun TestScope.loadController(
    gateway: ScriptedGateway,
    history: String,
  ): ChatController {
    gateway.respondWith("chat.history", history)
    return loadController(gateway)
  }

  private fun TestScope.recoverSeqGap(controller: ChatController) {
    controller.handleGatewayEvent("seqGap", null)
    runCurrent()
  }

  private fun TestScope.connect(controller: ChatController) {
    controller.onGatewayConnected()
    runCurrent()
  }

  private fun TestScope.reconnect(controller: ChatController) {
    controller.onDisconnected("Reconnecting…")
    connect(controller)
  }

  private fun TestScope.advanceRecoveryRetry() {
    advanceTimeBy(750)
    runCurrent()
  }

  private fun history(
    messages: List<ReplayHistoryMessage>,
    inFlightRun: Pair<String, String>? = null,
    hasActiveRun: Boolean? = inFlightRun?.let { true },
    activeRunIds: List<String>? = inFlightRun?.let { listOf(it.first) },
  ): String = historyResponse("session-1", messages, inFlightRun, hasActiveRun, activeRunIds)

  private val userTurn = ReplayHistoryMessage("user", "keep working", 1_000)

  @Test
  fun connectedRefreshUpsertsDeviceSessionBeforeLoadingHistory() =
    runTest {
      val sessionKey = "agent:main:node-device"
      val gateway = ScriptedGateway(json)
      gateway.respondWith("sessions.describe", """{"session":null}""")
      gateway.respondWith("sessions.patch", """{"ok":true,"key":"$sessionKey"}""")
      gateway.respondWith("chat.history", history(emptyList()))
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
  fun connectedRefreshContinuesWhenSessionAdoptionFails() =
    runTest {
      val sessionKey = "agent:main:node-device"
      val gateway = ScriptedGateway(json)
      gateway.respondWith("sessions.describe", """{"session":null}""")
      gateway.respond("sessions.patch") { error("patch unavailable") }
      gateway.respondWith("chat.history", history(emptyList()))
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
  fun agentSelectionAcknowledgesUnreadDeviceSession() =
    runTest {
      val sessionKey = "agent:main:node-device"
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "sessions.describe",
        """{"session":{"key":"$sessionKey","label":"OpenClaw App · Pixel · device"}}""",
      )
      gateway.respondWith("sessions.patch", """{"ok":true,"key":"$sessionKey"}""")
      gateway.respondWith("chat.history", history(emptyList()))
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
      gateway.respondWith("chat.history", history(emptyList()))
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
      gateway.respondWith("chat.history", history(emptyList()))
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
      gateway.respondWith("chat.history", history(emptyList()))
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
      gateway.respondWith("chat.history", history(emptyList()))
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
      gateway.respondWith("chat.history", history(emptyList()))
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
  fun reconnectAdoptsInFlightRunAndConsumesLiveEvents() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = loadController(gateway, history(listOf(userTurn)))
      assertEquals(0, controller.pendingRunCount.value)

      controller.onDisconnected("Reconnecting…")
      gateway.respondWith(
        "chat.history",
        history(listOf(userTurn), inFlightRun = "run-active" to "partial reply"),
      )
      connect(controller)

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
        history(
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
  fun reconnectHealthRefetchesProgressCard() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = loadController(gateway, history(emptyList()))
      gateway.respondWith(
        "progressCard.get",
        """{"card":{"sessionKey":"agent:main:main","revision":1,"updatedAt":10,"markdown":"First"}}""",
      )
      controller.handleGatewayEvent("progressCard.changed", """{"sessionKey":"main","revision":1}""")
      runCurrent()
      assertEquals("First", controller.progressCard.value?.markdown)

      controller.onDisconnected("Reconnecting…")
      gateway.respondWith(
        "progressCard.get",
        """{"card":{"sessionKey":"agent:main:main","revision":2,"updatedAt":20,"markdown":"Restored"}}""",
      )
      val cardRequestsBeforeHealth = gateway.callCount("progressCard.get")
      controller.handleGatewayEvent("health", null)
      runCurrent()

      assertEquals(cardRequestsBeforeHealth + 1, gateway.callCount("progressCard.get"))
      assertEquals("Restored", controller.progressCard.value?.markdown)
    }

  @Test
  fun reconnectWithoutInFlightRunStaysClean() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = loadController(gateway, history(listOf(userTurn)))
      val historyCallsAfterLoad = gateway.callCount("chat.history")
      val metadataCallsAfterLoad = gateway.callCount("chat.metadata")

      controller.onDisconnected("Offline")
      connect(controller)

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
  fun reconnectHistoryOmissionClearsStaleExactRunIds() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = loadController(gateway, history(emptyList()))
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"patch","session":{"key":"main","agentId":"main","hasActiveRun":true,"activeRunIds":["run-stale"]}}""",
      )
      assertEquals("run-stale", controller.selectedActiveRunPresentation.value.runId)

      gateway.respondWith(
        "chat.history",
        history(emptyList(), hasActiveRun = true, activeRunIds = null),
      )
      val pendingSessionList = CompletableDeferred<String>()
      gateway.respond("sessions.list") { pendingSessionList.await() }
      reconnect(controller)

      assertEquals(1, controller.selectedActiveRunPresentation.value.count)
      assertNull(controller.selectedActiveRunPresentation.value.runId)
    }

  @Test
  fun reconnectStaysUnhealthyUntilRecoveryHistoryApplies() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = loadController(gateway, history(emptyList()))

      val recoveryHistory = CompletableDeferred<String>()
      gateway.respond("chat.history") { recoveryHistory.await() }
      reconnect(controller)

      assertFalse(controller.healthOk.value)
      val healthCallsDuringRecovery = gateway.callCount("health")
      val historyCallsDuringRecovery = gateway.callCount("chat.history")
      controller.handleGatewayEvent("tick", null)
      runCurrent()
      assertFalse(controller.healthOk.value)
      assertEquals(healthCallsDuringRecovery, gateway.callCount("health"))
      assertEquals(historyCallsDuringRecovery + 1, gateway.callCount("chat.history"))

      recoveryHistory.complete(history(emptyList()))
      runCurrent()
      assertTrue(controller.healthOk.value)
    }

  @Test
  fun newerSameGenerationHistoryRequestCompletesReconnectHealth() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        history(listOf(userTurn), inFlightRun = "run-active" to "working"),
      )
      val controller = loadController(gateway)

      val reconnectHistoryStarted = CompletableDeferred<Unit>()
      val releaseReconnectHistory = CompletableDeferred<String>()
      var recoveryHistoryCalls = 0
      gateway.respond("chat.history") {
        recoveryHistoryCalls += 1
        if (recoveryHistoryCalls == 1) {
          reconnectHistoryStarted.complete(Unit)
          releaseReconnectHistory.await()
        } else {
          history(
            listOf(userTurn, ReplayHistoryMessage("assistant", "done", 2_000)),
          )
        }
      }

      reconnect(controller)
      reconnectHistoryStarted.await()
      assertFalse(controller.healthOk.value)

      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", "run-active", seq = 2, assistantText = "done"),
      )
      runCurrent()

      assertTrue(controller.healthOk.value)
      assertEquals(listOf("keep working", "done"), controller.messageTexts)

      releaseReconnectHistory.complete(history(emptyList()))
      runCurrent()
      assertTrue(controller.healthOk.value)
    }

  @Test
  fun transcriptInvalidationCanFinishPendingRecoveryWithoutReplayingItsOlderSnapshot() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = loadController(gateway, history(emptyList()))
      val olderHistory = CompletableDeferred<String>()
      gateway.respond("chat.history") { olderHistory.await() }
      reconnect(controller)
      assertFalse(controller.healthOk.value)

      gateway.respondWith("chat.history", history(listOf(userTurn), inFlightRun = "run-active" to "working"))
      controller.handleGatewayEvent("sessions.changed", """{"sessionKey":"main","agentId":"main","phase":"message"}""")
      runCurrent()

      assertTrue(controller.healthOk.value)
      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("working", controller.streamingAssistantText.value)
      olderHistory.complete(history(emptyList()))
      runCurrent()
      assertEquals(listOf("keep working"), controller.messageTexts)
      assertEquals(1, controller.pendingRunCount.value)
    }

  @Test
  fun delayedTranscriptCannotRestoreAnEndedRecoveredRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = loadController(gateway, history(emptyList()))
      val recoveryHistory = CompletableDeferred<String>()
      gateway.respond("chat.history") { recoveryHistory.await() }
      reconnect(controller)

      val transcriptHistory = CompletableDeferred<String>()
      gateway.respond("chat.history") { transcriptHistory.await() }
      controller.handleGatewayEvent("sessions.changed", """{"sessionKey":"main","agentId":"main","phase":"message"}""")
      runCurrent()
      val recoveryHealth = CompletableDeferred<String>()
      gateway.respond("health") { recoveryHealth.await() }
      recoveryHistory.complete(history(listOf(userTurn), inFlightRun = "run-active" to "working"))
      runCurrent()
      assertFalse(controller.healthOk.value)
      assertEquals(1, controller.pendingRunCount.value)

      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"run-active","seq":2,"stream":"lifecycle","data":{"phase":"end"}}""",
      )
      val messages = listOf(userTurn, ReplayHistoryMessage("assistant", "transcript update", 2_000))
      transcriptHistory.complete(history(messages, inFlightRun = "run-active" to "stale working"))
      runCurrent()

      assertEquals(listOf("keep working", "transcript update"), controller.messageTexts)
      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)
      recoveryHealth.complete("{}")
      runCurrent()
      assertTrue(controller.healthOk.value)
    }

  @Test
  fun transcriptRefreshCannotConfirmWatchdogRunState() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = loadController(gateway, history(listOf(userTurn), inFlightRun = "run-active" to "working"))
      val watchdogHistory = CompletableDeferred<String>()
      gateway.respond("chat.history") { watchdogHistory.await() }
      advanceTimeBy(120_000)
      runCurrent()

      gateway.respondWith("chat.history", history(listOf(userTurn)))
      controller.handleGatewayEvent("sessions.changed", """{"sessionKey":"main","agentId":"main","phase":"message"}""")
      runCurrent()
      watchdogHistory.complete(history(listOf(userTurn), inFlightRun = "run-active" to "working"))
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("working", controller.streamingAssistantText.value)
      assertNull(controller.errorText.value)
    }

  @Test
  fun lateHealthSuccessCannotOverrideNewerSelectionFailure() = runTest { verifyLateHealthAfterSelection(cancelOlder = false) }

  @Test
  fun forcedRefreshSurvivesNewerNonforcedRecovery() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = loadController(gateway, history(emptyList()))
      val healthRequests = gateway.callCount("health")
      gateway.respond("health") { error("health unavailable") }
      val refreshStarted = CompletableDeferred<Unit>()
      val releaseRefresh = CompletableDeferred<String>()
      var historyRequests = 0
      gateway.respond("chat.history") {
        if (historyRequests++ == 0) {
          refreshStarted.complete(Unit)
          releaseRefresh.await()
        } else {
          history(listOf(ReplayHistoryMessage("assistant", "newer history", 2)))
        }
      }
      controller.refresh()
      runCurrent()
      refreshStarted.await()
      recoverSeqGap(controller)

      assertEquals(listOf("newer history"), controller.messageTexts)
      assertEquals("Nonforced recovery must retain Refresh's forced health check", healthRequests + 1, gateway.callCount("health"))
      assertFalse(controller.healthOk.value)
      releaseRefresh.complete(history(listOf(ReplayHistoryMessage("assistant", "older history", 1))))
      runCurrent()
      assertEquals(listOf("newer history"), controller.messageTexts)
      assertEquals(healthRequests + 1, gateway.callCount("health"))
      assertFalse(controller.healthOk.value)
    }

  @Test
  fun failedSupersedingHistoryDoesNotStrandPeriodicHealth() = runTest { verifyHealthAfterSupersedingHistoryEnds(cancelHistory = false) }

  @Test
  fun cancelledSupersedingHistoryDoesNotStrandPeriodicHealth() = runTest { verifyHealthAfterSupersedingHistoryEnds(cancelHistory = true) }

  private suspend fun TestScope.verifyHealthAfterSupersedingHistoryEnds(cancelHistory: Boolean) {
    val gateway = ScriptedGateway(json)
    val releaseRefresh = CompletableDeferred<String>()
    val releaseMutationHistory = CompletableDeferred<String>()
    val mutationHistoryStarted = CompletableDeferred<Job>()
    var historyRequests = 0
    gateway.respond("chat.history") {
      if (historyRequests++ == 0) {
        releaseRefresh.await()
      } else {
        mutationHistoryStarted.complete(requireNotNull(currentCoroutineContext()[Job]))
        releaseMutationHistory.await()
      }
    }
    val controller = newScopedController(gateway)
    controller.handleGatewayEvent("health", null)
    runCurrent()
    controller.handleGatewayEvent("tick", null)
    runCurrent()
    assertEquals(1, gateway.callCount("health"))
    gateway.respond("health") { error("health unavailable") }
    controller.refresh()
    runCurrent()
    assertEquals(1, gateway.callCount("chat.history"))

    controller.handleGatewayEvent(
      "sessions.changed",
      """{"reason":"branch-switch","sessionKey":"main","agentId":"main"}""",
    )
    runCurrent()
    val mutationHistoryJob = mutationHistoryStarted.await()
    if (cancelHistory) {
      mutationHistoryJob.cancelAndJoin()
    } else {
      releaseMutationHistory.completeExceptionally(
        GatewayRequestRejected(GatewaySession.ErrorShape("UNAVAILABLE", "history unavailable")),
      )
      mutationHistoryJob.join()
    }
    releaseRefresh.complete(history(listOf(ReplayHistoryMessage("assistant", "superseded", 1))))
    runCurrent()

    assertEquals(2, gateway.callCount("chat.history"))
    assertTrue(controller.messages.value.isEmpty())
    assertTrue("History failure or cancellation is not a health result", controller.healthOk.value)
    controller.handleGatewayEvent("tick", null)
    runCurrent()

    assertEquals("A finished history request must retain Refresh's forced health poll", 2, gateway.callCount("health"))
    assertFalse(controller.healthOk.value)
  }

  @Test
  fun failedOlderHistoryDoesNotReleaseHealthWhileSameGenerationHistoryIsPending() = runTest { verifyPendingSiblingHistoryHealth(olderFails = true) }

  @Test
  fun failedNewerHistoryKeepsOlderHistoryHealthGate() = runTest { verifyPendingSiblingHistoryHealth(olderFails = false) }

  private fun TestScope.verifyPendingSiblingHistoryHealth(olderFails: Boolean) {
    val gateway = ScriptedGateway(json)
    val releaseRefresh = CompletableDeferred<String>()
    val releaseTerminalHistory = CompletableDeferred<String>()
    var historyRequests = 0
    gateway.respond("chat.history") {
      if (historyRequests++ == 0) releaseRefresh.await() else releaseTerminalHistory.await()
    }
    gateway.respondWith("sessions.branches.list", """{"branches":[]}""")
    gateway.respond("health") { error("health unavailable") }
    val controller = newScopedController(gateway)
    controller.handleGatewayEvent("health", null)
    runCurrent()
    controller.refresh()
    runCurrent()
    controller.handleGatewayEvent("chat", chatTerminalPayload("main", "external-run", seq = 1, assistantText = "newer history"))
    runCurrent()
    assertEquals(2, gateway.callCount("chat.history"))

    val failedHistory = if (olderFails) releaseRefresh else releaseTerminalHistory
    val pendingHistory = if (olderFails) releaseTerminalHistory else releaseRefresh
    failedHistory.completeExceptionally(IllegalStateException("history failed"))
    runCurrent()
    controller.handleGatewayEvent("tick", null)
    runCurrent()

    assertEquals("A failed request must not release its held sibling's health gate", 0, gateway.callCount("health"))
    assertTrue(controller.healthOk.value)
    pendingHistory.complete(history(listOf(ReplayHistoryMessage("assistant", "accepted history", 2))))
    runCurrent()

    assertEquals(listOf("accepted history"), controller.messageTexts)
    assertEquals(1, gateway.callCount("health"))
    assertFalse(controller.healthOk.value)
  }

  @Test
  fun cancelledNewChatHealthRecoversWithoutManualRefresh() = runTest { verifyCancelledNewRecovery(holdHistory = false) }

  @Test
  fun cancelledNewChatHistoryRecoversWithoutManualRefresh() = runTest { verifyCancelledNewRecovery(holdHistory = true) }

  private suspend fun TestScope.verifyCancelledNewRecovery(holdHistory: Boolean) {
    val key = "agent:main:health-fresh"
    val gateway = ScriptedGateway(json)
    val entered = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()
    gateway.respondWith("sessions.create", """{"ok":true,"key":"$key"}""")
    gateway.respond("chat.history") {
      if (holdHistory) {
        entered.complete(Unit)
        release.await()
      }
      historyResponse("fresh-session", emptyList())
    }
    gateway.respondWith("sessions.branches.list", """{"branches":[]}""")
    gateway.respond("health") {
      if (!holdHistory) {
        entered.complete(Unit)
        release.await()
      }
      "{}"
    }
    val controller = newScopedController(gateway)
    val create = async { controller.startNewChatAwait() }
    try {
      entered.await()
      assertEquals(key, controller.sessionKey.value)
      assertEquals(holdHistory, controller.historyLoading.value)
      assertFalse(controller.healthOk.value)

      create.cancelAndJoin()
      release.complete(Unit)
      controller.handleGatewayEvent("tick", null)
      runCurrent()

      assertTrue("Cancelled New must not strand the selected chat's recovery", controller.healthOk.value)
      assertEquals(key, controller.sessionKey.value)
      assertEquals("fresh-session", controller.sessionId.value)
      assertFalse(controller.historyLoading.value)
      assertEquals(1, gateway.callCount("sessions.create"))
    } finally {
      release.complete(Unit)
      create.cancelAndJoin()
    }
  }

  @Test
  fun cancelledHealthPollCannotOverrideNewerSelectionSuccess() = runTest { verifyLateHealthAfterSelection(cancelOlder = true) }

  private suspend fun TestScope.verifyLateHealthAfterSelection(cancelOlder: Boolean) {
    val gateway = ScriptedGateway(json)
    gateway.respond("chat.history") { params ->
      val key = requireNotNull(gateway.sessionKeyOf(params))
      historyResponse(key, listOf(ReplayHistoryMessage("assistant", key, 1)))
    }
    val controller = newScopedController(gateway)
    controller.load("main")
    runCurrent()
    assertTrue(controller.healthOk.value)

    val oldHealthStarted = CompletableDeferred<Job>()
    val releaseOldHealth = CompletableDeferred<String>()
    var healthRequests = 0
    gateway.respond("health") {
      if (healthRequests++ == 0) {
        oldHealthStarted.complete(requireNotNull(currentCoroutineContext()[Job]))
        releaseOldHealth.await()
      } else {
        check(cancelOlder) { "new selection health unavailable" }
        "{}"
      }
    }
    controller.refresh()
    runCurrent()
    val oldHealthJob = oldHealthStarted.await()
    val selectedKey = "agent:main:other"
    controller.switchSession(selectedKey)
    runCurrent()
    assertEquals(cancelOlder, controller.healthOk.value)

    if (cancelOlder) oldHealthJob.cancel()
    releaseOldHealth.complete("{}")
    oldHealthJob.join()
    runCurrent()
    assertEquals(selectedKey, controller.sessionKey.value)
    assertEquals(listOf(selectedKey), controller.messageTexts)
    assertEquals("A retired health request must not replace the new selection's result", cancelOlder, controller.healthOk.value)
  }

  @Test
  fun lateHealthSuccessAfterDisconnectDoesNotRestoreReadiness() = runTest { verifyLateHealthAfterDisconnect(periodic = false) }

  @Test
  fun latePeriodicHealthSuccessAfterDisconnectDoesNotRestoreReadiness() = runTest { verifyLateHealthAfterDisconnect(periodic = true) }

  private suspend fun TestScope.verifyLateHealthAfterDisconnect(periodic: Boolean) {
    val gateway = ScriptedGateway(json)
    gateway.respondWith("chat.history", history(emptyList()))
    val controller = newScopedController(gateway)
    if (periodic) controller.handleGatewayEvent("health", null) else controller.load("main")
    runCurrent()
    assertTrue(controller.healthOk.value)

    val healthStarted = CompletableDeferred<Unit>()
    val releaseHealth = CompletableDeferred<String>()
    gateway.respond("health") {
      healthStarted.complete(Unit)
      releaseHealth.await()
    }
    if (periodic) controller.handleGatewayEvent("tick", null) else controller.refresh()
    runCurrent()
    healthStarted.await()
    controller.onDisconnected("Offline")
    val metadataRequests = gateway.callCount("chat.metadata")
    releaseHealth.complete("{}")
    runCurrent()

    assertFalse(controller.healthOk.value)
    assertNull(controller.sessionId.value)
    assertEquals("Disconnected health must not trigger metadata requests", metadataRequests, gateway.callCount("chat.metadata"))
  }

  @Test
  fun healthFromRetiredConnectionCannotPublishBeforeDisconnectCallback() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondWith("sessions.branches.list", """{"branches":[]}""")
      val healthStarted = CompletableDeferred<Unit>()
      val releaseHealth = CompletableDeferred<String>()
      gateway.respond("health") {
        healthStarted.complete(Unit)
        releaseHealth.await()
      }
      val gatewayScope = ChatCacheScope("gateway-a", 1)
      var physicalConnection = 1
      val controller =
        backgroundScope.createChatController(
          cacheScope = { gatewayScope },
          captureRequestLease = { capturedScope ->
            val connection = physicalConnection
            GatewaySession.RequestLease(
              endpointStableId = requireNotNull(capturedScope).gatewayId,
              isCurrentImpl = { physicalConnection == connection },
            ) { method, params, _, withEnqueue ->
              withEnqueue {}
              gateway.request(method, params)
            }
          },
          requestGateway = gateway::request,
        )
      controller.load("main")
      runCurrent()
      healthStarted.await()
      assertFalse(controller.healthOk.value)

      // The socket owner retires first; the controller has not received its disconnect callback.
      physicalConnection += 1
      val metadataRequests = gateway.callCount("chat.metadata")
      releaseHealth.complete("{}")
      runCurrent()

      assertFalse("Health from a replaced socket must stay inert before the logical callback", controller.healthOk.value)
      assertEquals(metadataRequests, gateway.callCount("chat.metadata"))
    }

  @Test
  fun recoveredPendingRunRefreshesHistoryBeforeTimingOut() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        history(listOf(userTurn), inFlightRun = "run-active" to "working"),
      )
      val controller = loadController(gateway)
      assertEquals(1, controller.pendingRunCount.value)
      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"run-active","seq":2,"ts":10,"stream":"tool","data":{"phase":"start","name":"exec","toolCallId":"tool-1"}}""",
      )

      gateway.respondWith(
        "chat.history",
        history(
          listOf(userTurn, ReplayHistoryMessage("assistant", "completed while offline", 2_000)),
        ),
      )
      advanceTimeBy(120_000)
      runCurrent()

      assertEquals(0, controller.pendingRunCount.value)
      assertEquals(listOf("keep working", "completed while offline"), controller.messageTexts)
      assertNull(controller.errorText.value)
      assertNull(controller.streamingAssistantText.value)
      assertTrue(controller.pendingToolCalls.value.isEmpty())
    }

  @Test
  fun recoveredPendingRunStopsWatchdogWhenRefreshFails() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        history(listOf(userTurn), inFlightRun = "run-active" to "working"),
      )
      val controller = loadController(gateway)
      assertEquals(1, controller.pendingRunCount.value)

      gateway.respond("chat.history") { error("history unavailable") }
      advanceTimeBy(120_000)
      runCurrent()

      assertEquals(2, gateway.callCount("chat.history"))
      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)

      advanceTimeBy(120_000)
      runCurrent()
      assertEquals(2, gateway.callCount("chat.history"))
    }

  @Test
  fun newerRecoverySnapshotCanSupersedePendingRunWatchdogRefresh() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        history(listOf(userTurn), inFlightRun = "run-active" to "working"),
      )
      val controller = loadController(gateway)

      val watchdogRefreshStarted = CompletableDeferred<Unit>()
      val releaseWatchdogRefresh = CompletableDeferred<String>()
      val newerRefreshStarted = CompletableDeferred<Unit>()
      val releaseNewerRefresh = CompletableDeferred<String>()
      var refreshCalls = 0
      gateway.respond("chat.history") {
        refreshCalls += 1
        if (refreshCalls == 1) {
          watchdogRefreshStarted.complete(Unit)
          releaseWatchdogRefresh.await()
        } else {
          newerRefreshStarted.complete(Unit)
          releaseNewerRefresh.await()
        }
      }

      advanceTimeBy(120_000)
      runCurrent()
      watchdogRefreshStarted.await()
      controller.refresh()
      runCurrent()
      newerRefreshStarted.await()
      releaseWatchdogRefresh.complete(
        history(listOf(userTurn), inFlightRun = "run-active" to "stale working"),
      )
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("working", controller.streamingAssistantText.value)
      assertNull(controller.errorText.value)

      releaseNewerRefresh.complete(
        history(listOf(userTurn), inFlightRun = "run-active" to "still working"),
      )
      runCurrent()

      assertEquals(3, gateway.callCount("chat.history"))
      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("still working", controller.streamingAssistantText.value)
      assertNull(controller.errorText.value)
    }

  @Test
  fun explicitRefreshClearsPriorHistoryError() =
    runTest {
      for (automaticLoad in listOf(false, true)) {
        val gateway = ScriptedGateway(json)
        val controller = loadController(gateway, history(emptyList()))

        gateway.respond("chat.history") { error("history unavailable") }
        controller.refresh()
        runCurrent()
        assertEquals("history unavailable", controller.errorText.value)

        gateway.respondWith("chat.history", history(emptyList()))
        if (automaticLoad) {
          controller.load("main")
        } else {
          controller.refresh()
        }
        assertNull(controller.errorText.value)
        runCurrent()
        assertNull(controller.errorText.value)
        assertEquals(3, gateway.callCount("chat.history"))
      }
    }

  @Test
  fun disconnectInvalidatesLateHistoryError() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = loadController(gateway, history(emptyList()))

      val pendingHistory = CompletableDeferred<String>()
      gateway.respond("chat.history") { pendingHistory.await() }
      controller.refresh()
      runCurrent()
      controller.onDisconnected("Reconnecting…")
      pendingHistory.completeExceptionally(IllegalStateException("socket closed"))
      runCurrent()
      assertNull(controller.errorText.value)

      gateway.respondWith("chat.history", history(emptyList()))
      controller.onGatewayConnected()
      assertNull(controller.errorText.value)
      runCurrent()
      assertNull(controller.errorText.value)
    }

  @Test
  fun disconnectInvalidatesOlderHistorySnapshotBeforeOwnershipRestore() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)
      assertTrue(controller.sendMessageAwaitAcceptance("keep ownership", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)

      val staleHistory = CompletableDeferred<String>()
      gateway.respond("chat.history") { staleHistory.await() }
      controller.refresh()
      runCurrent()
      controller.onDisconnected("Reconnecting…")
      staleHistory.complete(history(emptyList()))
      runCurrent()

      gateway.respondWith(
        "chat.history",
        history(emptyList(), inFlightRun = runId to "working"),
      )
      connect(controller)

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("working", controller.streamingAssistantText.value)
      assertEquals(listOf("keep ownership"), controller.messageTexts)
    }

  @Test
  fun disconnectAfterGatewayAcceptancePreservesSendWhenAckIsLost() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = loadController(gateway, history(emptyList()))

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
      assertEquals(listOf("accepted before drop"), controller.messageTexts)
      assertNull(controller.errorText.value)

      gateway.respondWith(
        "chat.history",
        history(
          listOf(
            ReplayHistoryMessage("user", "accepted before drop", 1_000, idempotencyKey = "$runId:user"),
            ReplayHistoryMessage("assistant", "completed once", 2_000),
          ),
        ),
      )
      connect(controller)

      assertEquals(0, controller.pendingRunCount.value)
      assertEquals(listOf("accepted before drop", "completed once"), controller.messageTexts)
      assertNull(controller.errorText.value)
    }

  @Test
  fun lostAckAdoptsCanonicalRunWhilePreservingClientHistoryIdentity() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = loadController(gateway, history(emptyList()))

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
          history(emptyList())
        } else {
          history(
            listOf(ReplayHistoryMessage("user", "canonical recovery", 1_000, idempotencyKey = "$clientRunId:user")),
            inFlightRun = "canonical-run" to "working",
          )
        }
      }
      assertTrue(controller.sendMessageAwaitAcceptance("canonical recovery", "off", emptyList()))
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)

      advanceRecoveryRetry()

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
  fun repeatedReconnectsDoNotDuplicateRunOrRows() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        history(listOf(userTurn), inFlightRun = "run-active" to "partial"),
      )
      val controller = loadController(gateway)
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
  fun reconnectKeepsOptimisticUserWhileHistoryPersistenceLags() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("survive reconnect", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      controller.onDisconnected("Reconnecting…")
      gateway.respondWith(
        "chat.history",
        history(emptyList(), inFlightRun = runId to "working"),
      )
      connect(controller)

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("working", controller.streamingAssistantText.value)
      assertEquals(listOf("survive reconnect"), controller.messageTexts)
    }

  @Test
  fun reconnectStaleSnapshotCannotReplaceDisconnectedLocalRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("local work", "off", emptyList()))
      val localRunId = requireNotNull(gateway.lastRunId)
      controller.onDisconnected("Reconnecting…")
      gateway.respondWith(
        "chat.history",
        history(
          listOf(ReplayHistoryMessage("user", "local work", 1_000, idempotencyKey = "$localRunId:user")),
          inFlightRun = "run-stale" to "old text",
        ),
      )
      connect(controller)

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
      assertEquals(listOf("local work"), controller.messageTexts)
    }

  @Test
  fun reconnectRetiresPersistedLocalRunBeforeAdoptingOtherRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("local work", "off", emptyList()))
      val localRunId = requireNotNull(gateway.lastRunId)
      controller.onDisconnected("Reconnecting…")
      gateway.respondWith(
        "chat.history",
        history(
          listOf(
            ReplayHistoryMessage("user", "local work", 1_000, idempotencyKey = "$localRunId:user"),
            ReplayHistoryMessage("assistant", "local done", 2_000),
          ),
          inFlightRun = "run-other" to "other working",
        ),
      )
      connect(controller)

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("other working", controller.streamingAssistantText.value)
      assertEquals(listOf("local work", "local done"), controller.messageTexts)
      controller.handleGatewayEvent(
        "chat",
        chatDeltaPayload("main", localRunId, 1, "stale", "stale local"),
      )
      assertEquals("other working", controller.streamingAssistantText.value)
    }

  @Test
  fun reconnectReplacesPreviouslyAdoptedRunWithAuthoritativeSnapshotRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        history(emptyList(), inFlightRun = "run-a" to "old work"),
      )
      val controller = loadController(gateway)
      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("old work", controller.streamingAssistantText.value)

      controller.onDisconnected("Reconnecting…")
      gateway.respondWith(
        "chat.history",
        history(emptyList(), inFlightRun = "run-b" to "current work"),
      )
      connect(controller)

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("current work", controller.streamingAssistantText.value)
      controller.handleGatewayEvent("chat", chatDeltaPayload("main", "run-a", 1, " stale", "old work stale"))
      assertEquals("current work", controller.streamingAssistantText.value)
      controller.handleGatewayEvent("chat", chatDeltaPayload("main", "run-b", 1, " now", "current work now"))
      assertEquals("current work now", controller.streamingAssistantText.value)
    }

  @Test
  fun seqGapKeepsOptimisticUserWhileHistoryPersistenceLags() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("survive gap", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      gateway.respondWith(
        "chat.history",
        history(emptyList(), inFlightRun = runId to "working"),
      )
      recoverSeqGap(controller)

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("working", controller.streamingAssistantText.value)
      assertEquals(listOf("survive gap"), controller.messageTexts)
    }

  @Test
  fun sameSessionRefreshKeepsOptimisticRunOwnership() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("survive refresh", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      gateway.respondWith(
        "chat.history",
        history(emptyList(), inFlightRun = runId to "working"),
      )
      controller.refresh()
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("working", controller.streamingAssistantText.value)
      assertEquals(listOf("survive refresh"), controller.messageTexts)
    }

  @Test
  fun sameSessionRefreshClearsTransientUiForResolvedRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        history(listOf(userTurn), inFlightRun = "run-active" to "partial"),
      )
      val controller = loadController(gateway)
      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"run-active","seq":2,"ts":10,"stream":"tool","data":{"phase":"start","name":"exec","toolCallId":"tool-1"}}""",
      )
      assertEquals("partial", controller.streamingAssistantText.value)
      assertEquals(1, controller.pendingToolCalls.value.size)

      gateway.respondWith(
        "chat.history",
        history(
          listOf(userTurn, ReplayHistoryMessage("assistant", "complete", 2_000)),
        ),
      )
      controller.refresh()
      runCurrent()

      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)
      assertTrue(controller.pendingToolCalls.value.isEmpty())
      assertEquals(listOf("keep working", "complete"), controller.messageTexts)
    }

  @Test
  fun seqGapMissingRunClearsPendingButKeepsOptimisticUser() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("finished during gap", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      gateway.respondWith("chat.history", history(emptyList()))
      recoverSeqGap(controller)

      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)
      assertEquals(listOf("finished during gap"), controller.messageTexts)

      gateway.respondWith(
        "chat.history",
        history(
          listOf(
            ReplayHistoryMessage("user", "finished during gap", 1_000, idempotencyKey = "$runId:user"),
            ReplayHistoryMessage("assistant", "done", 2_000),
          ),
        ),
      )
      advanceRecoveryRetry()

      assertEquals(listOf("finished during gap", "done"), controller.messageTexts)
      assertNull(controller.errorText.value)
    }

  @Test
  fun recoveryRetriesWhenUserPersistsBeforeAssistantReply() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("await reply", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      val persistedUser = ReplayHistoryMessage("user", "await reply", 1_000, idempotencyKey = "$runId:user")
      gateway.respondWith("chat.history", history(listOf(persistedUser)))
      recoverSeqGap(controller)
      assertEquals(listOf("await reply"), controller.messageTexts)

      gateway.respondWith(
        "chat.history",
        history(
          listOf(persistedUser, ReplayHistoryMessage("assistant", "done", 2_000)),
        ),
      )
      advanceRecoveryRetry()

      assertEquals(listOf("await reply", "done"), controller.messageTexts)
    }

  @Test
  fun recoveryPerformsFinalRefreshWhenAssistantPersistsAfterFirstRetry() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("late reply", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      val persistedUser = ReplayHistoryMessage("user", "late reply", 1_000, idempotencyKey = "$runId:user")
      var historyCall = 0
      gateway.respond("chat.history") {
        historyCall += 1
        history(
          if (historyCall < 3) {
            listOf(persistedUser)
          } else {
            listOf(persistedUser, ReplayHistoryMessage("assistant", "eventually done", 2_000))
          },
        )
      }

      recoverSeqGap(controller)
      advanceRecoveryRetry()
      assertEquals(listOf("late reply"), controller.messageTexts)

      advanceTimeBy(119_250)
      runCurrent()
      assertEquals(listOf("late reply", "eventually done"), controller.messageTexts)
      assertNull(controller.errorText.value)
    }

  @Test
  fun newerRunReconciliationKeepsOlderUnresolvedReply() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("first", "off", emptyList()))
      val firstRunId = requireNotNull(gateway.lastRunId)
      val firstUser = ReplayHistoryMessage("user", "first", 1_000, idempotencyKey = "$firstRunId:user")
      gateway.respondWith("chat.history", history(listOf(firstUser)))
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
        history(listOf(firstUser, secondUser, secondReply)),
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
      assertEquals(listOf("first", "second", "second done"), controller.messageTexts)

      gateway.respondWith(
        "chat.history",
        history(
          listOf(
            firstUser,
            ReplayHistoryMessage("assistant", "first done", 1_500),
            secondUser,
            secondReply,
          ),
        ),
      )
      advanceRecoveryRetry()

      assertEquals(listOf("first", "first done", "second", "second done"), controller.messageTexts)
      assertNull(controller.errorText.value)
    }

  @Test
  fun newerRefreshCarriesUnresolvedReplyReconciliation() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("carry reply", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      val persistedUser = ReplayHistoryMessage("user", "carry reply", 1_000, idempotencyKey = "$runId:user")
      var historyCall = 0
      gateway.respond("chat.history") {
        historyCall += 1
        history(
          if (historyCall < 4) {
            listOf(persistedUser)
          } else {
            listOf(persistedUser, ReplayHistoryMessage("assistant", "carried done", 2_000))
          },
        )
      }

      recoverSeqGap(controller)
      advanceRecoveryRetry()
      controller.refresh()
      runCurrent()
      advanceRecoveryRetry()

      assertEquals(listOf("carry reply", "carried done"), controller.messageTexts)
      assertNull(controller.errorText.value)
    }

  @Test
  fun successfulRecoveryRetryClearsHistoryError() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("recover error", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      var historyCall = 0
      gateway.respond("chat.history") {
        historyCall += 1
        if (historyCall == 1) {
          error("history unavailable")
        }
        history(
          listOf(
            ReplayHistoryMessage("user", "recover error", 1_000, idempotencyKey = "$runId:user"),
            ReplayHistoryMessage("assistant", "recovered", 2_000),
          ),
        )
      }

      recoverSeqGap(controller)
      assertEquals("history unavailable", controller.errorText.value)
      advanceRecoveryRetry()

      assertNull(controller.errorText.value)
      assertEquals(listOf("recover error", "recovered"), controller.messageTexts)
    }

  @Test
  fun reconnectFailureStillExpiresUnconfirmedUser() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("never persisted", "off", emptyList()))
      controller.onDisconnected("Reconnecting…")
      gateway.respond("chat.history") { error("history unavailable") }
      connect(controller)

      assertEquals(listOf("never persisted"), controller.messageTexts)

      advanceTimeBy(120_000)
      runCurrent()

      assertTrue(controller.messages.value.isEmpty())
      assertEquals("Timed out waiting for a reply; try again or refresh.", controller.errorText.value)
    }

  @Test
  fun lateTerminalAfterTimeoutRefreshesHistoryWithoutClearingNewerRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

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
        history(
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
      assertEquals(listOf("slow first", "slow done", "newer work"), controller.messageTexts)
    }

  @Test
  fun staleRecoveryCompletionCannotCancelNewerReconciliation() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)
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

          2 -> {
            history(emptyList())
          }

          else -> {
            history(
              listOf(
                ReplayHistoryMessage("user", "ordered recovery", 1_000, idempotencyKey = "$runId:user"),
                ReplayHistoryMessage("assistant", "done", 2_000),
              ),
            )
          }
        }
      }

      recoverSeqGap(controller)
      firstRecoveryStarted.await()
      recoverSeqGap(controller)
      releaseFirstRecovery.complete(history(emptyList()))
      runCurrent()
      advanceRecoveryRetry()

      assertEquals(listOf("ordered recovery", "done"), controller.messageTexts)
      assertNull(controller.errorText.value)
    }

  @Test
  fun olderSameGenerationRetryCannotOverwriteTerminalHistory() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)
      assertTrue(controller.sendMessageAwaitAcceptance("ordered result", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)

      gateway.respondWith("chat.history", history(emptyList()))
      recoverSeqGap(controller)

      val retryStarted = CompletableDeferred<Unit>()
      val releaseRetry = CompletableDeferred<String>()
      var historyCall = 0
      gateway.respond("chat.history") {
        historyCall += 1
        if (historyCall == 1) {
          retryStarted.complete(Unit)
          releaseRetry.await()
        } else {
          history(
            listOf(
              ReplayHistoryMessage("user", "ordered result", 1_000, idempotencyKey = "$runId:user"),
              ReplayHistoryMessage("assistant", "done", 2_000),
            ),
          )
        }
      }
      advanceRecoveryRetry()
      retryStarted.await()
      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", runId, seq = 2, assistantText = "done"),
      )
      runCurrent()
      releaseRetry.complete(history(emptyList()))
      runCurrent()

      assertEquals(listOf("ordered result", "done"), controller.messageTexts)
    }

  @Test
  fun newerSameGenerationHistoryCompletionSuppressesOlderFailureAndClearsLoading() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)
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
          history(
            listOf(
              ReplayHistoryMessage("user", "ordered loading", 1_000, idempotencyKey = "$runId:user"),
              ReplayHistoryMessage("assistant", "done", 2_000),
            ),
          )
        }
      }

      recoverSeqGap(controller)
      recoveryStarted.await()
      assertTrue(controller.historyLoading.value)
      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", runId, seq = 2, assistantText = "done"),
      )
      runCurrent()

      assertFalse(controller.historyLoading.value)
      assertEquals(listOf("ordered loading", "done"), controller.messageTexts)

      releaseRecovery.completeExceptionally(IllegalStateException("older history failed"))
      runCurrent()
      assertFalse(controller.historyLoading.value)
      assertEquals(listOf("ordered loading", "done"), controller.messageTexts)
      assertNull(controller.errorText.value)
    }

  @Test
  fun seqGapStaleSnapshotCannotReplaceLocallyOwnedRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", history(emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("new work", "off", emptyList()))
      val localRunId = requireNotNull(gateway.lastRunId)
      gateway.respondWith(
        "chat.history",
        history(emptyList(), inFlightRun = "run-stale" to "old text"),
      )
      recoverSeqGap(controller)

      assertEquals(1, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)
      controller.handleGatewayEvent(
        "chat",
        chatDeltaPayload("main", localRunId, 1, "ours", "ours"),
      )
      assertEquals("ours", controller.streamingAssistantText.value)
      assertEquals(listOf("new work"), controller.messageTexts)
    }

  @Test
  fun seqGapRefetchesHistoryAndRestoresInFlightRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        history(listOf(userTurn), inFlightRun = "run-active" to "still going"),
      )
      val controller = loadController(gateway)
      assertEquals(1, controller.pendingRunCount.value)

      recoverSeqGap(controller)

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("still going", controller.streamingAssistantText.value)
      assertNull(controller.errorText.value)
      assertEquals(1, controller.messages.value.size)
    }
}
