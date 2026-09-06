package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Deterministic streaming replay scenarios: a ScriptedGateway replays scripted
 * chat.event/chat.history sequences into ChatController under virtual time.
 */
@RunWith(RobolectricTestRunner::class)
class ChatControllerStreamReplayTest {
  private val json = Json { ignoreUnknownKeys = true }

  private fun TestScope.newController(gateway: ScriptedGateway): ChatController = ChatController(scope = this, commandOutbox = this.createChatCommandOutbox(), cacheScope = { ChatCacheScope("gateway-test", 1L) }, json = json, requestGateway = gateway::request)

  @OptIn(ExperimentalCoroutinesApi::class)
  private fun TestScope.loadController(gateway: ScriptedGateway): ChatController {
    gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
    return newController(gateway).also {
      it.load("main")
      runCurrent()
    }
  }

  private fun transcript(controller: ChatController): List<Pair<String, String?>> =
    controller.messages.value.map { message ->
      val text =
        message.content
          .firstOrNull { it.type == "text" }
          ?.text
      message.role to text
    }

  private fun sessionMessagePayload(
    sessionKey: String,
    agentId: String = "main",
  ): String = """{"sessionKey":"$sessionKey","agentId":"$agentId","messageId":"voice-4","messageSeq":4,"message":{"role":"assistant","content":[{"type":"text","text":"second answer"}],"__openclaw":{"id":"voice-4","seq":4}},"session":{"key":"$sessionKey","sessionId":"session-voice","agentId":"$agentId"}}"""

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun cleanRunStreamsV3AndV4DeltasThenConvergesToHistoryWithoutDuplicates() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("Hello there", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      assertEquals(1, controller.pendingRunCount.value)
      val optimisticUserId =
        controller.messages.value
          .single { it.role == "user" }
          .id

      // V3 deltas carry the accumulated message without v4's deltaText field.
      controller.handleGatewayEvent("chat", chatDeltaPayload("main", runId, 1, null, "Str"))
      assertEquals("Str", controller.streamingAssistantText.value)
      controller.handleGatewayEvent(
        "chat",
        chatDeltaPayload("main", runId, 2, "eamed reply.", "Streamed reply."),
      )
      assertEquals("Streamed reply.", controller.streamingAssistantText.value)

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-1",
          messages =
            listOf(
              ReplayHistoryMessage("user", "Hello there", 1_000, idempotencyKey = "$runId:user"),
              ReplayHistoryMessage("assistant", "Streamed reply.", 2_000),
            ),
        ),
      )
      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", runId, seq = 3, assistantText = "Streamed reply."),
      )
      advanceUntilIdle()

      assertEquals(
        listOf("user" to "Hello there", "assistant" to "Streamed reply."),
        transcript(controller),
      )
      // Gateway copy replaces the optimistic echo in place: same row identity, no duplicate.
      assertEquals(
        optimisticUserId,
        controller.messages.value
          .single { it.role == "user" }
          .id,
      )
      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)
      assertNull(controller.errorText.value)
      assertEquals("session-1", controller.sessionId.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun duplicateDeltaAndTerminalDeliveryProducesNoDuplicateRows() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("dedupe me", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)

      val delta = chatDeltaPayload("main", runId, 1, "Only once.", "Only once.")
      controller.handleGatewayEvent("chat", delta)
      controller.handleGatewayEvent("chat", delta)
      assertEquals("Only once.", controller.streamingAssistantText.value)

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-1",
          messages =
            listOf(
              ReplayHistoryMessage("user", "dedupe me", 1_000, idempotencyKey = "$runId:user"),
              ReplayHistoryMessage("assistant", "Only once.", 2_000),
            ),
        ),
      )
      val terminal = chatTerminalPayload("main", runId, seq = 2, assistantText = "Only once.")
      controller.handleGatewayEvent("chat", terminal)
      advanceUntilIdle()
      val idsAfterFirstTerminal = controller.messages.value.map { it.id }
      val historyCallsAfterFirstTerminal = gateway.callCount("chat.history")

      // Once ownership resolves, redelivered terminal events are ignored.
      controller.handleGatewayEvent("chat", terminal)
      advanceUntilIdle()

      assertEquals(historyCallsAfterFirstTerminal, gateway.callCount("chat.history"))
      assertEquals(
        listOf("user" to "dedupe me", "assistant" to "Only once."),
        transcript(controller),
      )
      // Row identities stay stable across the duplicate refresh.
      assertEquals(idsAfterFirstTerminal, controller.messages.value.map { it.id })
      assertEquals(0, controller.pendingRunCount.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun optimisticAckTimeoutDiscardsUserEchoUnderVirtualTime() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("never answered", "off", emptyList()))
      assertEquals(1, controller.pendingRunCount.value)

      // One virtual millisecond before the 120s ack deadline nothing changes.
      advanceTimeBy(119_999)
      runCurrent()
      assertEquals(1, controller.pendingRunCount.value)
      assertTrue(transcript(controller).contains("user" to "never answered"))
      assertNull(controller.errorText.value)

      advanceTimeBy(1)
      runCurrent()
      assertEquals(0, controller.pendingRunCount.value)
      assertFalse(transcript(controller).contains("user" to "never answered"))
      assertEquals("Timed out waiting for a reply; try again or refresh.", controller.errorText.value)
    }

  @Test
  fun failedTerminalKeepsAcceptedUserUntilHistoryConfirmsIt() = assertFailedTerminalRemainsVisible()

  @Test
  fun lifecycleErrorBeforeChatTerminalKeepsFailureVisible() = assertFailedTerminalRemainsVisible(priorTerminalEvent = "agent")

  @Test
  fun sessionTerminalBeforeChatTerminalKeepsFailureVisible() = assertFailedTerminalRemainsVisible(priorTerminalEvent = "sessions.changed")

  @Test
  fun rekeyedRunFailureRemainsVisibleAfterLifecycleRetirement() = assertFailedTerminalRemainsVisible(priorTerminalEvent = "agent", rekey = true)

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun adoptedRunFailureRemainsVisibleAfterLifecycleRetirement() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList(), inFlightRun = "restored-run" to ""))
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()
      assertEquals(1, controller.pendingRunCount.value)

      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"restored-run","seq":1,"stream":"lifecycle","data":{"phase":"error","error":"Preparation failed"}}""",
      )
      controller.handleGatewayEvent(
        "chat",
        """{"sessionKey":"main","runId":"restored-run","seq":2,"state":"error","errorMessage":"Preparation failed"}""",
      )
      runCurrent()

      assertEquals(0, controller.pendingRunCount.value)
      assertEquals("Preparation failed", controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun retiredRunFailureDoesNotOverrideNewerCompletedRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("first", "off", emptyList()))
      val firstRunId = requireNotNull(gateway.lastRunId)
      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"$firstRunId","seq":1,"stream":"lifecycle","data":{"phase":"error","error":"Preparation failed"}}""",
      )
      assertTrue(controller.sendMessageAwaitAcceptance("second", "off", emptyList()))
      val secondRunId = requireNotNull(gateway.lastRunId)
      gateway.respondWith(
        "chat.history",
        historyResponse(
          "session-1",
          listOf(
            ReplayHistoryMessage("user", "first", 1_000, idempotencyKey = "$firstRunId:user"),
            ReplayHistoryMessage("user", "second", 2_000, idempotencyKey = "$secondRunId:user"),
            ReplayHistoryMessage("assistant", "second done", 3_000),
          ),
        ),
      )
      controller.handleGatewayEvent("chat", chatTerminalPayload("main", secondRunId, seq = 1, assistantText = "second done"))
      runCurrent()

      controller.handleGatewayEvent(
        "chat",
        """{"sessionKey":"main","runId":"$firstRunId","seq":2,"state":"error","errorMessage":"Preparation failed"}""",
      )
      runCurrent()

      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.errorText.value)
      assertEquals(listOf("user" to "first", "user" to "second", "assistant" to "second done"), transcript(controller))
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  private fun assertFailedTerminalRemainsVisible(
    priorTerminalEvent: String? = null,
    rekey: Boolean = false,
  ) = runTest {
    val gateway = ScriptedGateway(json)
    gateway.respondChatSend(status = "started")
    var clientRunId: String? = null
    if (rekey) {
      gateway.respond("chat.send") { paramsJson ->
        clientRunId =
          json
            .parseToJsonElement(requireNotNull(paramsJson))
            .jsonObject
            .getValue("idempotencyKey")
            .jsonPrimitive.content
        """{"runId":"canonical-run","status":"started"}"""
      }
    }
    gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
    val controller = loadController(gateway)

    assertTrue(controller.sendMessageAwaitAcceptance("failed send", "off", emptyList()))
    val runId = if (rekey) "canonical-run" else requireNotNull(gateway.lastRunId)
    when (priorTerminalEvent) {
      "agent" -> {
        controller.handleGatewayEvent(
          "agent",
          """{"sessionKey":"main","runId":"$runId","seq":1,"stream":"lifecycle","data":{"phase":"error","error":"Preparation failed"}}""",
        )
      }

      "sessions.changed" -> {
        controller.handleGatewayEvent(
          "sessions.changed",
          """{"sessionKey":"main","agentId":"main","phase":"error","runId":"$runId","session":{"key":"main","agentId":"main","status":"failed","lastRunId":"$runId","lastRunError":"Preparation failed","hasActiveRun":false,"activeRunIds":[]}}""",
        )
      }
    }
    val terminal =
      if (priorTerminalEvent == null) {
        chatTerminalPayload("main", runId, seq = 2, state = "error")
      } else {
        """{"sessionKey":"main","runId":"$runId","seq":2,"state":"error","errorMessage":"Preparation failed"}"""
      }
    val expectedError = if (priorTerminalEvent == null) "Chat failed" else "Preparation failed"
    controller.handleGatewayEvent("chat", terminal)
    runCurrent()

    assertEquals(0, controller.pendingRunCount.value)
    assertTrue(transcript(controller).contains("user" to "failed send"))
    assertEquals(expectedError, controller.errorText.value)

    gateway.respondWith(
      "chat.history",
      historyResponse(
        "session-1",
        listOf(ReplayHistoryMessage("user", "failed send", 1_000, idempotencyKey = "${clientRunId ?: runId}:user")),
      ),
    )
    advanceTimeBy(750)
    runCurrent()
    assertEquals(listOf("user" to "failed send"), transcript(controller))
    assertEquals(expectedError, controller.errorText.value)
  }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun messageLessSuccessfulTerminalResolvesAfterUserPersists() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("no output", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      gateway.respondWith(
        "chat.history",
        historyResponse(
          "session-1",
          listOf(ReplayHistoryMessage("user", "no output", 1_000, idempotencyKey = "$runId:user")),
        ),
      )
      controller.handleGatewayEvent("chat", chatTerminalPayload("main", runId, seq = 1))
      runCurrent()

      assertEquals(listOf("user" to "no output"), transcript(controller))
      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.errorText.value)

      advanceTimeBy(120_000)
      runCurrent()
      assertEquals(listOf("user" to "no output"), transcript(controller))
      assertNull(controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectMidRunClearsTransientStateAndHistoryConverges() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("survive reconnect", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      val optimisticUserId =
        controller.messages.value
          .single { it.role == "user" }
          .id

      controller.handleGatewayEvent(
        "chat",
        chatDeltaPayload("main", runId, 1, "partial ans", "partial ans"),
      )
      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"$runId","seq":2,"ts":10,"stream":"tool","data":{"phase":"start","name":"exec","toolCallId":"tool-1"}}""",
      )
      assertEquals("partial ans", controller.streamingAssistantText.value)
      assertEquals(1, controller.pendingToolCalls.value.size)

      controller.onDisconnected("connection lost")
      assertNull(controller.streamingAssistantText.value)
      assertEquals(0, controller.pendingRunCount.value)
      assertTrue(controller.pendingToolCalls.value.isEmpty())
      assertNull(controller.sessionId.value)
      assertFalse(controller.healthOk.value)
      // The local echo stays rendered until the next history load resolves it.
      assertTrue(transcript(controller).contains("user" to "survive reconnect"))

      controller.handleGatewayEvent("health", null)
      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-1",
          messages =
            listOf(
              ReplayHistoryMessage("user", "survive reconnect", 1_000, idempotencyKey = "$runId:user"),
              ReplayHistoryMessage("assistant", "Recovered reply.", 2_000),
            ),
        ),
      )
      controller.refresh()
      advanceUntilIdle()

      assertEquals(
        listOf("user" to "survive reconnect", "assistant" to "Recovered reply."),
        transcript(controller),
      )
      assertEquals(
        optimisticUserId,
        controller.messages.value
          .single { it.role == "user" }
          .id,
      )
      assertEquals("session-1", controller.sessionId.value)

      // Disconnect cancelled the 120s ack timer: the converged transcript must not decay.
      advanceTimeBy(120_000)
      runCurrent()
      assertNull(controller.errorText.value)
      assertEquals(2, controller.messages.value.size)
    }

  @Test
  fun liveEditDiffCreatesAndUpdatesPendingToolUntilResult() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)
      assertTrue(controller.sendMessageAwaitAcceptance("edit the file", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)

      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"$runId","ts":10,"stream":"tool","data":{"phase":"input_delta","name":"edit","toolCallId":"tool-1","diff":{"added":4,"removed":1}}}""",
      )
      assertEquals(
        ChatDiffStat(added = 4, removed = 1),
        controller.pendingToolCalls.value
          .single()
          .liveDiff,
      )

      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"$runId","ts":11,"stream":"tool","data":{"phase":"input_delta","name":"edit","toolCallId":"tool-1","diff":{"added":8,"removed":2}}}""",
      )
      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"$runId","ts":12,"stream":"tool","data":{"phase":"start","name":"edit","toolCallId":"tool-1","args":{"path":"a.kt"}}}""",
      )
      assertEquals(
        ChatDiffStat(added = 8, removed = 2),
        controller.pendingToolCalls.value
          .single()
          .liveDiff,
      )

      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","runId":"$runId","ts":13,"stream":"tool","data":{"phase":"result","name":"edit","toolCallId":"tool-1"}}""",
      )
      assertTrue(controller.pendingToolCalls.value.isEmpty())
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun staleHistoryResponseIsDroppedByGenerationTracking() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = newController(gateway)

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("assistant", "main transcript", 1_000)),
        ),
      )
      controller.load("main")
      advanceUntilIdle()
      assertEquals(listOf("assistant" to "main transcript"), transcript(controller))

      // Gate the next "main" history fetch so its response arrives after a session switch.
      val staleMainGate = CompletableDeferred<Unit>()
      gateway.respond("chat.history") { paramsJson ->
        when (gateway.sessionKeyOf(paramsJson)) {
          "other" -> {
            historyResponse(
              sessionId = "session-other",
              messages = listOf(ReplayHistoryMessage("assistant", "other transcript", 3_000)),
            )
          }

          else -> {
            staleMainGate.await()
            historyResponse(
              sessionId = "session-main",
              messages = listOf(ReplayHistoryMessage("assistant", "stale main row", 9_000)),
            )
          }
        }
      }

      controller.handleGatewayEvent(
        "session.message",
        sessionMessagePayload("main"),
      )
      runCurrent() // history refetch for "main" is now suspended on the gate
      assertEquals(2, gateway.callCount("chat.history"))

      controller.switchSession("other")
      advanceUntilIdle()
      assertEquals(listOf("assistant" to "other transcript"), transcript(controller))
      assertEquals("session-other", controller.sessionId.value)

      staleMainGate.complete(Unit)
      advanceUntilIdle()

      // The stale "main" response resolved after the switch and must be dropped.
      assertEquals(listOf("assistant" to "other transcript"), transcript(controller))
      assertEquals("session-other", controller.sessionId.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun loadOfCurrentLiveSessionDoesNotRefreshOrMarkHistoryLoading() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = newController(gateway)

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("assistant", "main transcript", 1_000)),
        ),
      )
      controller.load("main")
      advanceUntilIdle()
      val historyCallsAfterLiveLoad = gateway.callCount("chat.history")
      assertFalse(controller.historyLoading.value)
      assertEquals(listOf("assistant" to "main transcript"), transcript(controller))

      gateway.respond("sessions.patch") { error("rename unavailable") }
      assertFalse(controller.patchSession(key = "main", label = "Renamed"))
      assertEquals("rename unavailable", controller.errorText.value)

      controller.loadCurrent("main")

      assertEquals("rename unavailable", controller.errorText.value)
      assertEquals(historyCallsAfterLiveLoad, gateway.callCount("chat.history"))
      assertFalse(controller.historyLoading.value)
      assertEquals(listOf("assistant" to "main transcript"), transcript(controller))
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun sameSessionLoadPreservesActionErrorWhileHistoryIsPending() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = newController(gateway)
      val releaseHistory = CompletableDeferred<Unit>()
      gateway.respond("chat.history") {
        releaseHistory.await()
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("assistant", "main transcript", 1_000)),
        )
      }
      gateway.respond("sessions.patch") { error("rename unavailable") }

      try {
        controller.load("main")
        runCurrent()
        assertTrue(controller.historyLoading.value)
        assertFalse(controller.patchSession(key = "main", label = "Renamed"))
        assertEquals("rename unavailable", controller.errorText.value)

        controller.load("main")
        assertEquals("rename unavailable", controller.errorText.value)
        releaseHistory.complete(Unit)
        advanceUntilIdle()

        assertFalse(controller.historyLoading.value)
        assertEquals(listOf("assistant" to "main transcript"), transcript(controller))
        assertEquals("rename unavailable", controller.errorText.value)

        controller.refresh()
        advanceUntilIdle()
        assertNull(controller.errorText.value)
      } finally {
        releaseHistory.complete(Unit)
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun automaticMainAdoptionRefreshPreservesActionError() =
    runTest {
      val key = "agent:main:node-device"
      val adoptionStarted = CompletableDeferred<Unit>()
      val releaseAdoption = CompletableDeferred<Unit>()
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-main", listOf(ReplayHistoryMessage("assistant", "main transcript", 1_000))))
      gateway.respond("sessions.describe") {
        adoptionStarted.complete(Unit)
        releaseAdoption.await()
        """{"session":{"key":"$key","sessionId":"session-main","agentId":"main","label":"OpenClaw App","archived":false}}"""
      }
      gateway.respond("sessions.patch") { error("rename unavailable") }
      val controller =
        createChatController(
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
          requestGateway = gateway::request,
        )
      try {
        controller.load(key)
        runCurrent()
        controller.onGatewayConnected(MainSessionBinding(key, "OpenClaw App"))
        runCurrent()
        assertTrue(adoptionStarted.isCompleted)
        assertFalse(controller.patchSession(key = key, label = "Renamed"))
        assertEquals("rename unavailable", controller.errorText.value)

        releaseAdoption.complete(Unit)
        runCurrent()

        assertEquals("rename unavailable", controller.errorText.value)
        assertEquals(2, gateway.callCount("chat.history"))
        assertFalse(controller.historyLoading.value)
        assertEquals(listOf("assistant" to "main transcript"), transcript(controller))
      } finally {
        releaseAdoption.complete(Unit)
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun explicitRefreshFetchesAfterSameSessionLoadGate() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = newController(gateway)

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("assistant", "main transcript", 1_000)),
        ),
      )
      controller.load("main")
      advanceUntilIdle()
      val historyCallsAfterLiveLoad = gateway.callCount("chat.history")

      controller.loadCurrent("main")
      assertEquals(historyCallsAfterLiveLoad, gateway.callCount("chat.history"))

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("assistant", "refreshed transcript", 2_000)),
        ),
      )
      controller.refresh()
      advanceUntilIdle()

      assertEquals(historyCallsAfterLiveLoad + 1, gateway.callCount("chat.history"))
      assertEquals(listOf("assistant" to "refreshed transcript"), transcript(controller))
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun loadOfCurrentUnhealthyLiveSessionRefreshesToRecoverHealth() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = newController(gateway)
      gateway.respond("health") { error("gateway down") }
      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("assistant", "main transcript", 1_000)),
        ),
      )

      controller.load("main")
      advanceUntilIdle()
      assertFalse(controller.healthOk.value)
      assertFalse(controller.historyLoading.value)

      controller.loadCurrent("main")

      assertTrue(controller.historyLoading.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun externalTranscriptEventsRefreshIdleHistory() =
    runTest {
      val sessionKey = "agent:main:node-voice-test"
      val initial =
        listOf(
          ReplayHistoryMessage("user", "first question", 1_000, entryId = "voice-1"),
          ReplayHistoryMessage("assistant", "first answer", 2_000, entryId = "voice-2"),
        )
      val updated =
        initial +
          listOf(
            ReplayHistoryMessage("user", "second question", 3_000, entryId = "voice-3"),
            ReplayHistoryMessage("assistant", "second answer", 4_000, entryId = "voice-4"),
          )
      val events =
        listOf(
          "session.message" to sessionMessagePayload(sessionKey),
          "session.message" to
            """{"sessionKey":"$sessionKey","agentId":"main","messageId":"voice-4","messageSeq":4,"message":{"role":"assistant","content":[{"type":"text","text":"second answer"}]}}""",
          "sessions.changed" to
            """{"sessionKey":"$sessionKey","agentId":"main","phase":"message","session":{"key":"$sessionKey","sessionId":"session-voice","agentId":"main"}}""",
          "sessions.changed" to """{"sessionKey":"$sessionKey","agentId":"main","phase":"message"}""",
          "chat" to chatTerminalPayload(sessionKey, "external-run", seq = 1, assistantText = "second answer"),
        )
      for ((event, payload) in events) {
        val gateway = ScriptedGateway(json)
        gateway.respondWith("chat.history", historyResponse("session-voice", initial))
        val controller = newController(gateway)
        controller.load(sessionKey)
        runCurrent()
        assertEquals(initial.map { it.role to it.text }, transcript(controller))
        val initialIds = controller.messages.value.map { it.id }

        gateway.respondWith("chat.history", historyResponse("session-voice", updated))
        controller.handleGatewayEvent(event, payload)
        runCurrent()

        assertEquals("$event must refresh the selected transcript", updated.map { it.role to it.text }, transcript(controller))
        assertEquals(
          initialIds,
          controller.messages.value
            .take(initial.size)
            .map { it.id },
        )
        assertNull(controller.errorText.value)
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun durableMessagesRefreshHistoryWithoutTakingOverLocalRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      val initial = listOf(ReplayHistoryMessage("assistant", "earlier reply", 1_000))
      gateway.respondWith("chat.history", historyResponse("session-global", initial))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      try {
        controller.load("global")
        runCurrent()

        assertTrue(controller.sendMessageAwaitAcceptance("local question", "off", emptyList()))
        val runId = requireNotNull(gateway.lastRunId)
        val optimisticId =
          controller.messages.value
            .last()
            .id
        controller.handleGatewayEvent("chat", chatDeltaPayload("global", runId, 1, "working", "working"))
        controller.handleGatewayEvent(
          "agent",
          """{"sessionKey":"global","runId":"$runId","stream":"tool","data":{"phase":"start","name":"exec","toolCallId":"local-tool"}}""",
        )
        val pendingTools = controller.pendingToolCalls.value
        assertEquals(1, pendingTools.size)
        val updated = initial + ReplayHistoryMessage("assistant", "second answer", 2_000, entryId = "voice-4")
        gateway.respondWith("chat.history", historyResponse("session-global", updated, inFlightRun = runId to "stale history text"))
        val historyRequests = gateway.callCount("chat.history")

        controller.handleGatewayEvent("session.message", sessionMessagePayload("global", agentId = "other"))
        controller.handleGatewayEvent("session.message", sessionMessagePayload("agent:main:other"))
        runCurrent()
        assertEquals(historyRequests, gateway.callCount("chat.history"))

        controller.handleGatewayEvent("session.message", sessionMessagePayload("global"))
        runCurrent()
        advanceTimeBy(750)
        runCurrent()

        assertEquals(updated.map { it.role to it.text } + ("user" to "local question"), transcript(controller))
        assertEquals(historyRequests + 1, gateway.callCount("chat.history"))
        assertEquals(
          optimisticId,
          controller.messages.value
            .last()
            .id,
        )
        assertEquals("working", controller.streamingAssistantText.value)
        assertEquals(pendingTools, controller.pendingToolCalls.value)
        assertEquals(1, controller.pendingRunCount.value)
        assertEquals("global", controller.sessionKey.value)
        assertNull(controller.errorText.value)
      } finally {
        controller.onDisconnected("test cleanup")
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun markdownFixtureStreamsByteIdenticalAndConvergesLosslessly() =
    runTest {
      val fixture =
        checkNotNull(javaClass.getResourceAsStream("/chat/markdown_stream_fixture.md")) {
          "missing markdown stream fixture resource"
        }.readBytes().toString(Charsets.UTF_8)
      val fixtureBytes = fixture.toByteArray(Charsets.UTF_8)

      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = loadController(gateway)

      assertTrue(controller.sendMessageAwaitAcceptance("render markdown shapes", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)

      // Odd chunk size on purpose so boundaries fall inside words, escapes, and emoji.
      val chunks = chunkPreservingCodePoints(fixture, chunkSize = 47)
      assertTrue("fixture should stream in many chunks", chunks.size > 10)
      var accumulated = ""
      for ((index, chunk) in chunks.withIndex()) {
        accumulated += chunk
        controller.handleGatewayEvent(
          "chat",
          chatDeltaPayload("main", runId, index + 1, chunk, accumulated),
        )
        assertEquals(accumulated, controller.streamingAssistantText.value)
      }

      val streamed = requireNotNull(controller.streamingAssistantText.value)
      assertArrayEquals(fixtureBytes, streamed.toByteArray(Charsets.UTF_8))

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-md",
          messages =
            listOf(
              ReplayHistoryMessage("user", "render markdown shapes", 1_000, idempotencyKey = "$runId:user"),
              ReplayHistoryMessage("assistant", fixture, 2_000),
            ),
        ),
      )
      controller.handleGatewayEvent(
        "chat",
        chatTerminalPayload("main", runId, seq = chunks.size + 1, assistantText = fixture),
      )
      advanceUntilIdle()

      val confirmed =
        controller.messages.value
          .single { it.role == "assistant" }
          .content
          .single { it.type == "text" }
          .text
      assertArrayEquals(fixtureBytes, requireNotNull(confirmed).toByteArray(Charsets.UTF_8))
      assertNull(controller.streamingAssistantText.value)
      assertEquals(0, controller.pendingRunCount.value)
    }
}
